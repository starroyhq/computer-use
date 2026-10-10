using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Windows.Forms.Integration;

namespace ComputerUse.WindowsFixture;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var options = FixtureOptions.Parse(args);
        ApplicationConfiguration.Initialize();
        if (options.MultiWindow) Application.Run(new FixtureApplicationContext(options));
        else Application.Run(new FixtureForm(options.Mode, options.ResultDirectory, options.WindowLabel));
    }
}

internal enum ProbeMode { WinForms, Win32, Wpf }

internal sealed record FixtureOptions(ProbeMode Mode, string? ResultDirectory, string? WindowLabel, bool MultiWindow)
{
    internal static FixtureOptions Parse(string[] args)
    {
        var win32 = false;
        var wpf = false;
        var multiWindow = false;
        string? resultDirectory = null;
        string? windowLabel = null;
        for (var index = 0; index < args.Length; index++)
        {
            string Value()
            {
                if (++index >= args.Length || string.IsNullOrWhiteSpace(args[index]) || args[index].StartsWith("--", StringComparison.Ordinal))
                    throw new ArgumentException("Expected a value after the fixture option.");
                return args[index];
            }
            switch (args[index].ToLowerInvariant())
            {
                case "--win32": win32 = true; break;
                case "--wpf": wpf = true; break;
                case "--multi-window": multiWindow = true; break;
                case "--result-dir": resultDirectory = Value(); break;
                case "--window-label": windowLabel = Value(); break;
                default: throw new ArgumentException($"Unknown fixture option: {args[index]}");
            }
        }
        if (resultDirectory is not null && !Path.IsPathFullyQualified(resultDirectory))
            throw new ArgumentException("--result-dir must be an absolute path to a disposable test directory.");
        if (multiWindow && resultDirectory is null)
            throw new ArgumentException("--multi-window requires --result-dir so each test window has isolated evidence.");
        return new FixtureOptions(win32 ? ProbeMode.Win32 : wpf ? ProbeMode.Wpf : ProbeMode.WinForms,
            resultDirectory, windowLabel, multiWindow);
    }
}

// Keep every window in the same process, including windows created after the initial pairing.
internal sealed class FixtureApplicationContext : ApplicationContext
{
    private readonly FixtureOptions options;
    private int nextWindowNumber;
    private int openWindows;

    internal FixtureApplicationContext(FixtureOptions options)
    {
        this.options = options;
        OpenWindow();
    }

    private void OpenWindow()
    {
        var number = ++nextWindowNumber;
        var window = new FixtureForm(options.Mode, options.ResultDirectory, options.WindowLabel, number,
            OpenWindow, showWithoutActivation: number > 1);
        openWindows++;
        window.FormClosed += (_, _) => { if (--openWindows == 0) ExitThread(); };
        window.Show();
    }
}

internal sealed class FixtureForm : Form
{
    private readonly Control inputHost;
    private readonly Func<string> readText;
    private readonly Action clearText;
    private readonly Action focusInput;
    private readonly Label status = new() { AutoSize = true, Text = "Ready" };
    private readonly string resultPath;
    private readonly bool showWithoutActivation;
    private readonly bool includeWindowEvidence;
    private readonly int? windowNumber;
    private int recordCount;
    private readonly List<TextChange> textChanges = [];
    private readonly long startedAt = Stopwatch.GetTimestamp();

    internal FixtureForm(ProbeMode mode, string? resultDirectory = null, string? windowLabel = null,
        int? windowNumber = null, Action? newWindow = null, bool showWithoutActivation = false)
    {
        this.showWithoutActivation = showWithoutActivation;
        this.windowNumber = windowNumber;
        includeWindowEvidence = resultDirectory is not null || windowLabel is not null || windowNumber is not null;
        Text = mode == ProbeMode.WinForms ? "Computer Use Fixture" : $"Computer Use Fixture {mode}";
        if (windowLabel is not null) Text += $" — {windowLabel}";
        if (windowNumber is not null) Text += $" — Window {windowNumber}";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, newWindow is null ? 260 : 310);
        MinimumSize = new Size(420, newWindow is null ? 250 : 300);
        var fileName = windowNumber is not null ? $"{mode.ToString().ToLowerInvariant()}-window-{windowNumber}-result.json"
            : mode == ProbeMode.WinForms ? "result.json" : $"{mode.ToString().ToLowerInvariant()}-result.json";
        resultPath = Path.Combine(resultDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Computer Use Fixture"), fileName);

        var title = new Label
        {
            AutoSize = true,
            Text = $"Computer Use — {mode} input fixture",
            Location = new Point(24, 30),
        };
        if (mode == ProbeMode.Win32)
        {
            var edit = new NativeEditHost();
            inputHost = edit;
            readText = () => edit.Value;
            clearText = edit.Clear;
            focusInput = edit.FocusEdit;
            edit.ValueChanged += RecordTextChange;
        }
        else if (mode == ProbeMode.Wpf)
        {
            var edit = new System.Windows.Controls.TextBox();
            System.Windows.Automation.AutomationProperties.SetName(edit, "Probe input");
            inputHost = new ElementHost { Child = edit };
            readText = () => edit.Text;
            clearText = edit.Clear;
            focusInput = () => edit.Focus();
            edit.TextChanged += (_, _) => RecordTextChange();
        }
        else
        {
            var edit = new TextBox { AccessibleName = "Probe input" };
            inputHost = edit;
            readText = () => edit.Text;
            clearText = edit.Clear;
            focusInput = () => edit.Focus();
            edit.TextChanged += (_, _) => RecordTextChange();
        }
        inputHost.Location = new Point(24, 82);
        inputHost.Size = new Size(470, 30);
        inputHost.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        var record = new Button
        {
            Text = "Record",
            AccessibleName = "Record",
            Location = new Point(24, 130),
            Size = new Size(100, 34),
        };
        record.Click += (_, _) =>
        {
            recordCount++;
            Persist("recorded");
        };
        var reset = new Button
        {
            Text = "Reset",
            AccessibleName = "Reset",
            Location = new Point(140, 130),
            Size = new Size(100, 34),
        };
        reset.Click += (_, _) =>
        {
            clearText();
            textChanges.Clear();
            recordCount = 0;
            Persist("reset");
        };
        // A fixed dummy value used only to check that observations never expose password-field contents.
        var secret = new TextBox
        {
            AccessibleName = "Probe secret",
            UseSystemPasswordChar = true,
            Text = "fixture-secret-8431",
            Location = new Point(256, 132),
            Size = new Size(238, 30),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        };
        if (newWindow is not null)
        {
            var createWindow = new Button
            {
                Text = "New Window", AccessibleName = "New Window",
                Location = new Point(24, 184), Size = new Size(150, 34),
            };
            createWindow.Click += (_, _) => newWindow();
            Controls.Add(createWindow);
        }
        status.Location = new Point(24, newWindow is null ? 190 : 250);
        status.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
        Controls.AddRange([title, inputHost, record, reset, secret, status]);
        Shown += (_, _) => { if (!showWithoutActivation) focusInput(); };

        // Clear stale evidence from a previous run before any automation begins.
        Persist("ready");
    }

    protected override bool ShowWithoutActivation => showWithoutActivation;

    private void RecordTextChange() => textChanges.Add(new TextChange(
        DateTimeOffset.UtcNow, Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, readText().Length));

    private void Persist(string state)
    {
        var temporaryPath = resultPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(resultPath)!);
            var result = new FixtureResult(state, readText(), recordCount, DateTimeOffset.UtcNow,
                textChanges.ToArray(), includeWindowEvidence ? Environment.ProcessId : null,
                includeWindowEvidence ? Text : null, windowNumber);
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(result,
                new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                }), new UTF8Encoding(false));
            File.Move(temporaryPath, resultPath, overwrite: true);
            status.Text = state == "recorded" ? $"Recorded {recordCount}" : "Ready";
        }
        catch (Exception)
        {
            status.Text = "Unable to write fixture evidence";
        }
        finally
        {
            try
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
            catch (IOException) { /* The visible status already reports a failed write. */ }
            catch (UnauthorizedAccessException) { /* The visible status already reports a failed write. */ }
        }
    }

    private sealed record TextChange(DateTimeOffset AtUtc, double ElapsedMilliseconds, int Length);
    private sealed record FixtureResult(string State, string Text, int RecordCount,
        DateTimeOffset UpdatedAtUtc, TextChange[] TextChanges, int? ProcessId, string? WindowTitle, int? WindowNumber);
}

// A raw Win32 EDIT HWND, intentionally separate from WinForms TextBox's wrapper.
internal sealed class NativeEditHost : Panel
{
    private IntPtr editHandle;
    internal event Action? ValueChanged;
    internal string Value
    {
        get
        {
            if (editHandle == IntPtr.Zero) return "";
            var buffer = new StringBuilder(GetWindowTextLengthW(editHandle) + 1);
            GetWindowTextW(editHandle, buffer, buffer.Capacity);
            return buffer.ToString();
        }
    }

    internal void Clear() { if (editHandle != IntPtr.Zero) SetWindowTextW(editHandle, ""); }
    internal void FocusEdit() { if (editHandle != IntPtr.Zero) SetFocus(editHandle); }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        const uint style = 0x40000000 | 0x10000000 | 0x00010000 | 0x00800000 | 0x00000080;
        editHandle = CreateWindowExW(0, "EDIT", "", style, 0, 0, Width, Height, Handle,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (editHandle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        if (editHandle != IntPtr.Zero) { DestroyWindow(editHandle); editHandle = IntPtr.Zero; }
        base.OnHandleDestroyed(e);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (editHandle != IntPtr.Zero) MoveWindow(editHandle, 0, 0, Width, Height, true);
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == 0x0111 && ((long)m.WParam >> 16 & 0xffff) == 0x0300) ValueChanged?.Invoke();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowTextW(IntPtr window, string text);
}

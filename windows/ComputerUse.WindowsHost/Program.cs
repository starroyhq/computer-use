using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace ComputerUse.WindowsHost;

internal static class Program
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ErrorInsufficientBuffer = 122;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--process-paths")
        {
            PrintProcessPaths(args[1]);
            return 0;
        }
        // 运行时调用的辅助模式：截图文字识别、粘贴时的剪贴板会话、用户最近一次输入距今的时间。
        if (args.Length == 1 && args[0] == NativeHelpers.RecognizeArgument) return NativeHelpers.RecognizeText();
        if (args.Length == 1 && args[0] == NativeHelpers.PasteArgument) return NativeHelpers.PasteSession();
        if (args.Length == 1 && args[0] == NativeHelpers.IdleArgument) return NativeHelpers.InputIdle();
        // 安装与卸载程序用：请当前会话里正在运行的托盘程序停止服务后退出，并等它退出。
        if (args.Length == 1 && args[0] == QuitArgument) return QuitRunningInstance();
        if (args.Length == 1 && args[0] is HostStartup.EnsureArgument or HostStartup.RecoverArgument)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var ensureSuffix = InstanceSuffix();
            return HostStartup.EnsureRunning(MutexName(ensureSuffix), SignalName("Ensure", ensureSuffix),
                args[0] == HostStartup.RecoverArgument ? SignalName("Recover", ensureSuffix) : null);
        }
        // 登录时启动项带 --background：只在托盘运行，不打开设置窗口。
        var background = args.Length == 1 && args[0] == LaunchAtLogin.BackgroundArgument;
        if (args.Length != 0 && !background) return 2;
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return 1;
        var suffix = InstanceSuffix();
        using var singleton = new Mutex(true, MutexName(suffix), out var created);
        using var showSignal = OpenSignal(SignalName("Show", suffix));
        if (!created)
        {
            // 已在运行：请已运行的实例打开设置窗口，与 macOS 再次打开 App 的行为一致。
            if (background) return 0;
            if (showSignal is null || !showSignal.Set())
                MessageBox.Show(L10n.T(Msg.AlreadyRunning), "Computer Use", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        using var quitSignal = OpenSignal(SignalName("Quit", suffix));
        using var recoverSignal = OpenSignal(SignalName("Recover", suffix));
        var startup = new HostStartupStore();
        var previous = startup.Read();
        // Manual/login launches have the same old-worker fence as the helper.
        // Do not replace its persisted identity until all descendants are gone.
        if (previous is not null)
        {
            var waiting = Stopwatch.StartNew();
            while (!RuntimeProcessGroup.PreviousHasExited(previous.ProcessId, previous.ProcessStartTimeUtcTicks))
            {
                if (waiting.Elapsed >= TimeSpan.FromSeconds(5))
                {
                    if (!background) MessageBox.Show("Computer Use is still stopping its previous runtime. Wait before reopening the app.",
                        "Computer Use", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
                Thread.Sleep(50);
            }
        }
        // HostApplication restores a persisted pause/stop without starting a
        // worker, so login/update launches still expose the local recovery UI.
        ApplicationConfiguration.Initialize();
        Application.Run(new HostApplication(showWindow: !background, showSignal: showSignal, quitSignal: quitSignal,
            startup: startup, recoverSignal: recoverSignal));
        return 0;
    }

    internal const string QuitArgument = "--quit";

    // 名称含当前用户 SID 的哈希，放在会话内的 Local 命名空间：只针对本用户本会话的托盘程序。
    private static string InstanceSuffix()
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Cannot identify current user.");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..20];
    }

    private static string MutexName(string suffix) => $@"Local\ComputerUse.WindowsHost.{suffix}";
    private static string SignalName(string purpose, string suffix) => $@"Local\ComputerUse.WindowsHost.{purpose}.{suffix}";

    // 触发 Show 只会让托盘程序打开设置窗口；触发 Quit 与用户在托盘菜单里选择退出相同。
    private static EventWaitHandle? OpenSignal(string name)
    {
        try { return new EventWaitHandle(false, EventResetMode.AutoReset, name); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or WaitHandleCannotBeOpenedException) { return null; }
    }

    // 0：没有实例在运行，或它已退出；1：仍在运行（不支持 --quit 的旧版本，或 30 秒内没有退出）。
    private static int QuitRunningInstance()
    {
        var suffix = InstanceSuffix();
        using var mutex = new Mutex(false, MutexName(suffix));
        if (Acquire(mutex, TimeSpan.Zero))
        {
            mutex.ReleaseMutex();
            return 0;
        }
        if (!EventWaitHandle.TryOpenExisting(SignalName("Quit", suffix), out var signal)) return 1;
        using (signal) signal.Set();
        if (!Acquire(mutex, TimeSpan.FromSeconds(30))) return 1;
        mutex.ReleaseMutex();
        return 0;
    }

    private static bool Acquire(Mutex mutex, TimeSpan timeout)
    {
        try { return mutex.WaitOne(timeout); }
        // 持有者退出时没有释放互斥体（进程结束时的正常情况），同样说明它已不在运行。
        catch (AbandonedMutexException) { return true; }
    }

    private static void PrintProcessPaths(string values)
    {
        var paths = new SortedDictionary<int, string>();
        foreach (var value in values.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(512))
        {
            if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid <= 0 || paths.ContainsKey(pid))
                continue;
            var path = ProcessPath(pid);
            if (path is not null) paths.Add(pid, path);
        }
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine(JsonSerializer.Serialize(paths));
    }

    private static string? ProcessPath(int pid)
    {
        using var process = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
        if (process.IsInvalid) return null;
        for (var capacity = 260; capacity <= 32768; capacity *= 2)
        {
            var path = new StringBuilder(capacity);
            var length = (uint)capacity;
            if (QueryFullProcessImageName(process, 0, path, ref length)) return path.ToString();
            if (Marshal.GetLastWin32Error() != ErrorInsufficientBuffer) return null;
        }
        return null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder path, ref uint size);
}

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
        // 登录时启动项带 --background：只在托盘运行，不打开设置窗口。
        var background = args.Length == 1 && args[0] == LaunchAtLogin.BackgroundArgument;
        if (args.Length != 0 && !background) return 2;
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return 1;
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Cannot identify current user.");
        var suffix = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..20];
        using var singleton = new Mutex(true, $@"Local\ComputerUse.WindowsHost.{suffix}", out var created);
        using var showSignal = OpenShowSignal(suffix);
        if (!created)
        {
            // 已在运行：请已运行的实例打开设置窗口，与 macOS 再次打开 App 的行为一致。
            if (background) return 0;
            if (showSignal is null || !showSignal.Set())
                MessageBox.Show(L10n.T(Msg.AlreadyRunning), "Computer Use", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new HostApplication(showWindow: !background, showSignal: showSignal));
        return 0;
    }

    // 会话内的命名事件（Local 命名空间，名称含当前用户 SID 的哈希）；触发它只会让托盘程序打开设置窗口。
    private static EventWaitHandle? OpenShowSignal(string suffix)
    {
        try { return new EventWaitHandle(false, EventResetMode.AutoReset, $@"Local\ComputerUse.WindowsHost.Show.{suffix}"); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or WaitHandleCannotBeOpenedException) { return null; }
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

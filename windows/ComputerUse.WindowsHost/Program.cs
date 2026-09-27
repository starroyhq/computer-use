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
        if (args.Length != 0) return 2;
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return 1;
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Cannot identify current user.");
        var suffix = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid)))[..20];
        using var singleton = new Mutex(true, $@"Local\ComputerUse.WindowsHost.{suffix}", out var created);
        if (!created)
        {
            MessageBox.Show("Computer Use 已在当前用户会话中运行。", "Computer Use", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new HostApplication());
        return 0;
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

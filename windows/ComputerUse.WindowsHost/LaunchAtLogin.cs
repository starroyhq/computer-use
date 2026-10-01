using Microsoft.Win32;

namespace ComputerUse.WindowsHost;

internal enum LaunchState { Off, On, OtherLocation, DisabledBySystem }

/// <summary>
/// 登录时启动：当前用户的 Run 项，指向本程序并带 --background（启动时不打开窗口）。
/// 便携目录移动后旧项会指向不存在的位置，界面据此提示重新勾选。
/// </summary>
internal static class LaunchAtLogin
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    internal const string ValueName = "Computer Use";
    internal const string BackgroundArgument = "--background";

    internal static string Command(string executable) => $"\"{executable}\" {BackgroundArgument}";

    /// <summary>Run 项里记录的程序路径（去掉引号与参数）；没有该项时为 null。</summary>
    internal static string? RegisteredExecutable(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        var text = command.Trim();
        if (text.StartsWith('"'))
        {
            var end = text.IndexOf('"', 1);
            return end > 1 ? text[1..end] : null;
        }
        var space = text.IndexOf(' ');
        return space < 0 ? text : text[..space];
    }

    internal static (LaunchState State, string? Path) Read()
    {
        using var run = Registry.CurrentUser.OpenSubKey(RunKey);
        if (run?.GetValue(ValueName) is not string command) return (LaunchState.Off, null);
        var registered = RegisteredExecutable(command);
        var current = Environment.ProcessPath;
        if (current is null || !string.Equals(command, Command(current), StringComparison.OrdinalIgnoreCase))
            return (LaunchState.OtherLocation, registered);
        using var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey);
        // 用户在“设置 > 应用 > 启动”或任务管理器里关闭后，这个值的首字节为奇数（启用时为偶数）。
        if (approved?.GetValue(ValueName) is byte[] { Length: > 0 } data && (data[0] & 1) == 1)
            return (LaunchState.DisabledBySystem, registered);
        return (LaunchState.On, registered);
    }

    internal static void Enable()
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot determine the program path.");
        using (var run = Registry.CurrentUser.CreateSubKey(RunKey, writable: true))
            run.SetValue(ValueName, Command(executable), RegistryValueKind.String);
        // 用户在本程序里重新勾选，视为希望恢复系统设置里被关闭的启动项。
        using var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey, writable: true);
        approved?.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    internal static void Disable()
    {
        using var run = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        run?.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

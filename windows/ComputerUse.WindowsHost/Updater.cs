using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Win32;

namespace ComputerUse.WindowsHost;

internal sealed record UpdateAsset(string Name, long Size, string? Sha256);

/// <summary><c>update check</c> 的输出。Asset 是便携 ZIP，Installer 是安装程序（v0.6.0 起的发布才有）。</summary>
internal sealed record UpdateCheck(string Current, string Latest, bool Available, string Platform, string Tag, string Url,
    string? PublishedAt, string Notes, UpdateAsset? Asset, UpdateAsset? Installer = null)
{
    /// <summary>只打开本项目的 GitHub 发布页。</summary>
    internal Uri? ReleasePage =>
        Url.StartsWith($"https://github.com/{UpdateService.Repository}/releases/", StringComparison.Ordinal) &&
        Uri.TryCreate(Url, UriKind.Absolute, out var uri) ? uri : null;
}

/// <summary><c>update download</c> 的输出：安装包已通过 SHA-256 与发布元数据校验。</summary>
internal sealed record UpdateDownload(string Version, string Platform, string Path, string Sha256, long Bytes, string Signing, string Commit);

internal sealed class UpdateFailure(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;

    // 与 src/update.ts 的错误文案对应；未列出的文案原样附在通用提示后面。
    private static readonly (string Prefix, Msg Key)[] Known =
    [
        ("Cannot reach the update server", Msg.UpdateErrorNetwork),
        ("GitHub rate limit reached", Msg.UpdateErrorRateLimit),
        ("The latest release changed", Msg.UpdateErrorChanged),
        ("The latest release has no package", Msg.UpdateErrorNoPackage),
        ("The latest release has no installer", Msg.UpdateErrorNoPackage),
        ("This build is already up to date", Msg.UpdateErrorUpToDate),
    ];

    internal string Describe()
    {
        if (Code == "launch") return L10n.T(Msg.UpdateErrorLaunch);
        if (Code == "output") return L10n.T(Msg.UpdateErrorOutput);
        if (Code == "timeout") return L10n.T(Msg.UpdateErrorTimeout);
        foreach (var (prefix, key) in Known)
            if (Message.StartsWith(prefix, StringComparison.Ordinal)) return L10n.T(key);
        return L10n.F(Msg.UpdateErrorGeneric, Message.Length > 300 ? Message[..300] : Message);
    }
}

/// <summary>发布版本号 MAJOR.MINOR.PATCH，按数值比较。</summary>
internal static class ReleaseVersion
{
    internal static bool TryParse(string? text, out (int Major, int Minor, int Patch) version)
    {
        version = default;
        var parts = (text ?? "").Split('.');
        if (parts.Length != 3) return false;
        var numbers = new int[3];
        for (var i = 0; i < 3; i++)
        {
            var part = parts[i];
            if (part.Length is 0 or > 9 || (part.Length > 1 && part[0] == '0') || !part.All(char.IsAsciiDigit)) return false;
            numbers[i] = int.Parse(part, NumberStyles.None, CultureInfo.InvariantCulture);
        }
        version = (numbers[0], numbers[1], numbers[2]);
        return true;
    }

    /// <summary>两者都合法时返回比较结果，否则返回 null。</summary>
    internal static int? Compare(string? left, string? right) =>
        TryParse(left, out var a) && TryParse(right, out var b) ? a.CompareTo(b) : null;
}

/// <summary>通过便携包内置的 CLI 检查与下载更新：检查逻辑只在 TypeScript 里实现一次，两个宿主共用。</summary>
internal sealed class UpdateCommand(string node, string cli)
{
    internal static UpdateCommand ForPackage(string root) =>
        new(Path.Combine(root, "bin", "node.exe"), Path.Combine(root, "runtime", "cli.js"));

    internal async Task<UpdateCheck> CheckAsync(CancellationToken cancellation)
    {
        var check = await RunAsync<UpdateCheck>(["update", "check"], null, cancellation);
        if (string.IsNullOrEmpty(check.Latest) || string.IsNullOrEmpty(check.Current) || check.Url is null || check.Notes is null)
            throw new UpdateFailure("output", "");
        return check;
    }

    /// <summary>下载用户确认过的版本到已存在的私有目录；最新版在此期间变化时由 CLI 拒绝。</summary>
    /// <param name="installer">下载安装程序（安装版）而不是便携 ZIP。</param>
    internal async Task<UpdateDownload> DownloadAsync(string version, string directory, IProgress<(long Downloaded, long Total)> progress,
        CancellationToken cancellation, bool installer = false)
    {
        string[] arguments = installer
            ? ["update", "download", "--out", directory, "--release", version, "--installer", "--progress"]
            : ["update", "download", "--out", directory, "--release", version, "--progress"];
        var download = await RunAsync<UpdateDownload>(arguments, progress, cancellation);
        var expected = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        if (download.Version != version || string.IsNullOrEmpty(download.Path) ||
            !string.Equals(Path.GetDirectoryName(Path.GetFullPath(download.Path)), expected, StringComparison.OrdinalIgnoreCase))
            throw new UpdateFailure("output", "");
        return download;
    }

    private Task<T> RunAsync<T>(string[] arguments, IProgress<(long, long)>? progress, CancellationToken cancellation) =>
        new PackageCommand(node, cli).RunJsonAsync<T>(arguments, cancellation, progress);
}

internal enum UpdatePhase { Idle, Checking, UpToDate, Available, Downloading, Downloaded, Failed }

/// <summary>
/// 检查与下载更新的状态机。这里只下载并校验：安装版由用户运行下载的安装程序（普通安装向导），
/// 便携版在资源管理器中显示 ZIP，由用户手动替换文件夹。
/// 所有方法在界面线程调用，Changed 也在界面线程触发。
/// </summary>
internal sealed class UpdateService : IDisposable
{
    internal const string Repository = "starroyhq/computer-use";
    internal static readonly Uri ReleasesPage = new($"https://github.com/{Repository}/releases");
    internal static readonly Uri ProjectPage = new($"https://github.com/{Repository}");
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    private readonly UpdateCommand _command;
    private readonly HostSettingsStore _settings;
    private readonly string _stages;
    private readonly System.Windows.Forms.Timer _hourly = new() { Interval = 60 * 60 * 1000 };
    private readonly System.Windows.Forms.Timer _first = new() { Interval = 60 * 1000 };
    private CancellationTokenSource? _operation;
    private bool _cancelRequested;

    /// <param name="installed">测试程序用来指定安装版或便携版；托盘程序按卸载登记判断。</param>
    internal UpdateService(string packageRoot, HostSettingsStore settings, UpdateCommand? command = null, bool? installed = null)
    {
        _command = command ?? UpdateCommand.ForPackage(packageRoot);
        _settings = settings;
        _stages = Path.Combine(settings.DirectoryPath, "Updates");
        Version = ReadVersion(packageRoot);
        Installed = installed ?? IsInstalledAt(RegisteredInstallLocation(), packageRoot);
        _hourly.Tick += (_, _) => CheckIfDue();
        _first.Tick += (_, _) =>
        {
            _first.Stop();
            CheckIfDue();
        };
    }

    internal event Action? Changed;
    internal string? Version { get; }
    internal UpdatePhase Phase { get; private set; }
    internal UpdateCheck? Check { get; private set; }
    internal UpdateDownload? Download { get; private set; }
    internal (long Downloaded, long Total) Progress { get; private set; }
    internal string? Error { get; private set; }
    /// <summary>检查发现、且用户没有跳过的新版本；托盘菜单据此显示更新项。</summary>
    internal UpdateCheck? Announced { get; private set; }
    internal HostSettings Settings => _settings.Current;
    internal bool IsSkipped => Check is { } check && Phase == UpdatePhase.Available && _settings.Current.SkippedVersion == check.Latest;
    internal bool CanCheck => Phase is not (UpdatePhase.Checking or UpdatePhase.Downloading or UpdatePhase.Downloaded);
    /// <summary>这份程序由安装程序安装：更新下载安装程序；否则是便携版，下载 ZIP。</summary>
    internal bool Installed { get; }
    /// <summary>本机这份程序要下载的更新包；最新版没有对应的包时为空。</summary>
    internal UpdateAsset? Package => Installed ? Check?.Installer : Check?.Asset;

    // 与安装脚本 windows/installer/ComputerUse.iss 的 AppId 一致；安装程序把卸载信息登记在当前用户下。
    internal const string InstallerAppId = "{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}";

    internal static string? RegisteredInstallLocation()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{InstallerAppId}_is1");
            return key?.GetValue("InstallLocation") as string;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }

    /// <summary>登记的安装位置就是程序所在目录（不区分大小写，忽略末尾的分隔符）。</summary>
    internal static bool IsInstalledAt(string? installLocation, string directory)
    {
        if (string.IsNullOrWhiteSpace(installLocation) || string.IsNullOrWhiteSpace(directory)) return false;
        try { return string.Equals(NormalizeDirectory(installLocation), NormalizeDirectory(directory), StringComparison.OrdinalIgnoreCase); }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }

    private static string NormalizeDirectory(string path) =>
        Path.GetFullPath(path.Trim().Trim('"')).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    internal void Start()
    {
        RemoveInstalledStages();
        _hourly.Start();
        // 启动一分钟后再检查，不和服务启动争抢资源。
        _first.Start();
    }

    internal static bool IsDue(DateTimeOffset? lastCheck, DateTimeOffset now) =>
        lastCheck is not { } last || last > now || now - last >= Interval;

    private void CheckIfDue()
    {
        if (!_settings.Current.AutomaticUpdateChecks || !CanCheck || !IsDue(_settings.Current.LastUpdateCheck, DateTimeOffset.UtcNow)) return;
        _ = CheckAsync(manual: false);
    }

    internal void SetAutomatic(bool enabled)
    {
        _settings.Update(settings => settings.AutomaticUpdateChecks = enabled);
        Changed?.Invoke();
        if (enabled) CheckIfDue();
    }

    internal async Task CheckAsync(bool manual)
    {
        if (!CanCheck) return;
        var previous = (Phase, Check, Error);
        Phase = UpdatePhase.Checking;
        Error = null;
        Changed?.Invoke();
        using var operation = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        _operation = operation;
        try
        {
            var check = await _command.CheckAsync(operation.Token);
            _settings.Update(settings => settings.LastUpdateCheck = DateTimeOffset.UtcNow);
            Check = check;
            Phase = check.Available ? UpdatePhase.Available : UpdatePhase.UpToDate;
            Announced = check.Available && (manual || check.Latest != _settings.Current.SkippedVersion) ? check : null;
        }
        catch (Exception error)
        {
            // 自动检查失败不打扰用户，一小时后再试；手动检查显示原因。
            if (manual)
            {
                Phase = UpdatePhase.Failed;
                Error = Describe(error);
            }
            else (Phase, Check, Error) = previous;
        }
        finally
        {
            _operation = null;
            Changed?.Invoke();
        }
    }

    internal void Skip()
    {
        if (Phase != UpdatePhase.Available || Check is not { } check) return;
        _settings.Update(settings => settings.SkippedVersion = check.Latest);
        Announced = null;
        Changed?.Invoke();
    }

    internal async Task DownloadAsync()
    {
        if (Phase != UpdatePhase.Available || Check is not { } check) return;
        if (Package is not { } package)
        {
            Phase = UpdatePhase.Failed;
            Error = L10n.T(Msg.UpdatesNoPackage);
            Changed?.Invoke();
            return;
        }
        var stage = Path.Combine(_stages, $"{check.Latest}-{Guid.NewGuid():N}");
        _cancelRequested = false;
        Phase = UpdatePhase.Downloading;
        Progress = (0, package.Size);
        Changed?.Invoke();
        using var operation = new CancellationTokenSource(TimeSpan.FromMinutes(25));
        _operation = operation;
        var progress = new Progress<(long Downloaded, long Total)>(value =>
        {
            if (Phase != UpdatePhase.Downloading) return;
            Progress = value;
            Changed?.Invoke();
        });
        try
        {
            Directory.CreateDirectory(stage);
            Download = await _command.DownloadAsync(check.Latest, stage, progress, operation.Token, installer: Installed);
            Phase = UpdatePhase.Downloaded;
            // 便携版需要手动替换文件夹，直接在资源管理器中显示；安装版等用户点“运行安装程序”。
            if (!Installed) Reveal();
        }
        catch (Exception error)
        {
            TryDelete(stage);
            if (error is OperationCanceledException && _cancelRequested) Phase = UpdatePhase.Available;
            else
            {
                Phase = UpdatePhase.Failed;
                Error = error is OperationCanceledException ? L10n.T(Msg.UpdateErrorTimeout) : Describe(error);
            }
        }
        finally
        {
            _operation = null;
            Changed?.Invoke();
        }
    }

    internal void CancelDownload()
    {
        if (Phase != UpdatePhase.Downloading) return;
        _cancelRequested = true;
        _operation?.Cancel();
    }

    internal void Reveal()
    {
        if (Download is not { } download || !File.Exists(download.Path)) return;
        try { Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{download.Path}\"") { UseShellExecute = false }); }
        catch { }
    }

    /// <summary>
    /// 打开下载并校验过的安装程序，由用户按向导完成。用户点“安装”后，安装程序才用 --quit 请托盘程序
    /// 停止服务并退出；在此之前取消，托盘程序照常运行。
    /// </summary>
    internal void RunInstaller()
    {
        if (!Installed || Phase != UpdatePhase.Downloaded || Download is not { } download || !File.Exists(download.Path)) return;
        try { Process.Start(new ProcessStartInfo(download.Path) { UseShellExecute = true }); }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException)
        {
            Phase = UpdatePhase.Failed;
            Error = L10n.F(Msg.UpdateErrorGeneric, error.Message);
            Changed?.Invoke();
        }
    }

    internal void OpenReleasePage() => Open(Check?.ReleasePage ?? ReleasesPage);

    internal static void Open(Uri uri)
    {
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch { }
    }

    private static string Describe(Exception error) => error switch
    {
        UpdateFailure failure => failure.Describe(),
        OperationCanceledException => L10n.T(Msg.UpdateErrorTimeout),
        _ => L10n.F(Msg.UpdateErrorGeneric, error.Message),
    };

    /// <summary>删除已安装（不比当前新）的旧下载；更新的版本保留，用户可能还没替换。</summary>
    private void RemoveInstalledStages()
    {
        try
        {
            if (!Directory.Exists(_stages)) return;
            foreach (var directory in Directory.EnumerateDirectories(_stages))
            {
                var name = Path.GetFileName(directory);
                var dash = name.IndexOf('-');
                var comparison = ReleaseVersion.Compare(dash > 0 ? name[..dash] : name, Version);
                if (comparison is null or <= 0) TryDelete(directory);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            var info = new DirectoryInfo(directory);
            if (!info.Exists) return;
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) info.Delete();
            else info.Delete(recursive: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private static string? ReadVersion(string root)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "package.json")));
            return document.RootElement.TryGetProperty("version", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    public void Dispose()
    {
        _operation?.Cancel();
        _hourly.Dispose();
        _first.Dispose();
    }
}

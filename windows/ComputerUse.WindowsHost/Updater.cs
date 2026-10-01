using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal sealed record UpdateAsset(string Name, long Size, string? Sha256);

/// <summary><c>update check</c> 的输出。</summary>
internal sealed record UpdateCheck(string Current, string Latest, bool Available, string Platform, string Tag, string Url,
    string? PublishedAt, string Notes, UpdateAsset? Asset)
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
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

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
    internal async Task<UpdateDownload> DownloadAsync(string version, string directory, IProgress<(long Downloaded, long Total)> progress,
        CancellationToken cancellation)
    {
        var download = await RunAsync<UpdateDownload>(["update", "download", "--out", directory, "--release", version, "--progress"],
            progress, cancellation);
        var expected = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        if (download.Version != version || string.IsNullOrEmpty(download.Path) ||
            !string.Equals(Path.GetDirectoryName(Path.GetFullPath(download.Path)), expected, StringComparison.OrdinalIgnoreCase))
            throw new UpdateFailure("output", "");
        return download;
    }

    private async Task<T> RunAsync<T>(string[] arguments, IProgress<(long, long)>? progress, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(cli)) ?? AppContext.BaseDirectory
        };
        start.ArgumentList.Add(cli);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        // 与运行时相同：Agent 可控的环境变量不能改变 Node 或驱动的行为。
        foreach (var key in start.Environment.Keys.Where(key =>
            key.StartsWith("CUA_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)).ToArray())
            start.Environment.Remove(key);

        Process process;
        try { process = Process.Start(start) ?? throw new UpdateFailure("launch", ""); }
        catch (Exception error) when (error is not UpdateFailure) { throw new UpdateFailure("launch", error.Message); }
        using (process)
        {
            process.StandardInput.Close();
            using var registration = cancellation.Register(() =>
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            });
            var output = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
            string? code = null, message = null;
            var errors = Task.Run(async () =>
            {
                while (await process.StandardError.ReadLineAsync() is { } line)
                {
                    if (line.Length > 65536) continue;
                    try
                    {
                        using var document = JsonDocument.Parse(line);
                        var root = document.RootElement;
                        if (root.ValueKind != JsonValueKind.Object) continue;
                        if (root.TryGetProperty("event", out var kind) && kind.ValueKind == JsonValueKind.String && kind.GetString() == "progress")
                            progress?.Report((root.GetProperty("downloaded").GetInt64(), root.GetProperty("total").GetInt64()));
                        else if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
                        {
                            code = error.GetProperty("code").GetString();
                            message = error.GetProperty("message").GetString();
                        }
                    }
                    catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or KeyNotFoundException) { }
                }
            });
            await process.WaitForExitAsync(CancellationToken.None);
            var text = await output;
            await errors;
            cancellation.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw code is null ? new UpdateFailure("output", "") : new UpdateFailure(code, message ?? "");
            try { return JsonSerializer.Deserialize<T>(text, Json) ?? throw new UpdateFailure("output", ""); }
            catch (JsonException) { throw new UpdateFailure("output", ""); }
        }
    }
}

internal enum UpdatePhase { Idle, Checking, UpToDate, Available, Downloading, Downloaded, Failed }

/// <summary>
/// 检查与下载更新的状态机。Windows 包未签名，这里只下载并校验，然后在资源管理器中显示，由用户手动替换。
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

    internal UpdateService(string packageRoot, HostSettingsStore settings, UpdateCommand? command = null)
    {
        _command = command ?? UpdateCommand.ForPackage(packageRoot);
        _settings = settings;
        _stages = Path.Combine(settings.DirectoryPath, "Updates");
        Version = ReadVersion(packageRoot);
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
        if (check.Asset is null)
        {
            Phase = UpdatePhase.Failed;
            Error = L10n.T(Msg.UpdatesNoPackage);
            Changed?.Invoke();
            return;
        }
        var stage = Path.Combine(_stages, $"{check.Latest}-{Guid.NewGuid():N}");
        _cancelRequested = false;
        Phase = UpdatePhase.Downloading;
        Progress = (0, check.Asset.Size);
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
            Download = await _command.DownloadAsync(check.Latest, stage, progress, operation.Token);
            Phase = UpdatePhase.Downloaded;
            Reveal();
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

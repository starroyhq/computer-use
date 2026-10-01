using System.Text.Json;

namespace ComputerUse.WindowsHost;

/// <summary>托盘程序自己的偏好（不含凭据）。本机 HTTP 开关按设计只在本次运行有效，不保存。</summary>
internal sealed class HostSettings
{
    public bool AutomaticUpdateChecks { get; set; } = true;
    public DateTimeOffset? LastUpdateCheck { get; set; }
    public string? SkippedVersion { get; set; }
}

/// <summary>保存在私有数据目录的 host-settings.json；写入先写临时文件再替换。</summary>
internal sealed class HostSettingsStore
{
    private const int MaxBytes = 64 * 1024;
    private readonly string _path;

    internal HostSettingsStore(string directory)
    {
        DirectoryPath = directory;
        _path = Path.Combine(directory, "host-settings.json");
        Current = Load();
    }

    internal string DirectoryPath { get; }
    internal HostSettings Current { get; }

    private HostSettings Load()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length > MaxBytes) return new HostSettings();
            return JsonSerializer.Deserialize<HostSettings>(File.ReadAllText(_path)) ?? new HostSettings();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            // 设置文件损坏时使用默认值，不影响服务启动。
            return new HostSettings();
        }
    }

    /// <summary>修改并保存；保存失败只影响下次启动时的偏好，不中断当前操作。</summary>
    internal void Update(Action<HostSettings> change)
    {
        change(Current);
        try { Save(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private void Save()
    {
        Directory.CreateDirectory(DirectoryPath);
        if (File.Exists(_path) && File.GetAttributes(_path).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("The settings file must not be a reparse point.");
        var temporary = Path.Combine(DirectoryPath, $"host-settings.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.WriteThrough
            }))
            {
                JsonSerializer.Serialize(stream, Current);
                stream.Flush(true);
            }
            File.Move(temporary, _path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

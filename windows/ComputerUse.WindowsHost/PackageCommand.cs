using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

/// <summary>异步执行包内 CLI；更新、预检和 Skill 导出共用参数隔离与取消逻辑。</summary>
internal sealed class PackageCommand(string node, string cli)
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    private const int OutputLimit = 4 * 1024 * 1024;

    internal static PackageCommand ForPackage(string root) =>
        new(Path.Combine(root, "bin", "node.exe"), Path.Combine(root, "runtime", "cli.js"));

    internal ProcessStartInfo StartInfo(string[] arguments)
    {
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(cli)) is { Length: > 0 } directory
                ? directory : AppContext.BaseDirectory
        };
        start.ArgumentList.Add(cli);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("CUA_", StringComparison.OrdinalIgnoreCase)
            || key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
        return start;
    }

    internal async Task<T> RunJsonAsync<T>(string[] arguments, CancellationToken cancellation, IProgress<(long, long)>? progress = null)
    {
        var text = await RunAsync(arguments, cancellation, progress);
        try { return JsonSerializer.Deserialize<T>(text, Json) ?? throw new UpdateFailure("output", ""); }
        catch (JsonException) { throw new UpdateFailure("output", ""); }
    }

    internal async Task<string> RunAsync(string[] arguments, CancellationToken cancellation, IProgress<(long, long)>? progress = null)
    {
        cancellation.ThrowIfCancellationRequested();
        Process process;
        try { process = Process.Start(StartInfo(arguments)) ?? throw new UpdateFailure("launch", ""); }
        catch (Exception error) when (error is not UpdateFailure) { throw new UpdateFailure("launch", error.Message); }
        using (process)
        {
            void Kill() { try { process.Kill(entireProcessTree: true); } catch { } }
            process.StandardInput.Close();
            using var registration = cancellation.Register(Kill);
            var output = ReadOutputAsync(process.StandardOutput, Kill);
            string? code = null, message = null;
            var errors = ReadErrorsAsync();
            try { await Task.WhenAll(output, errors, process.WaitForExitAsync(CancellationToken.None)); }
            catch { cancellation.ThrowIfCancellationRequested(); throw; }
            var text = await output;
            cancellation.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw code is null ? new UpdateFailure("output", "") : new UpdateFailure(code, message ?? "");
            return text;

            async Task ReadErrorsAsync()
            {
                while (await process.StandardError.ReadLineAsync() is { } line)
                {
                    if (line.Length > 65536) { Kill(); throw new UpdateFailure("output", ""); }
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
            }
        }
    }

    private static async Task<string> ReadOutputAsync(StreamReader reader, Action kill)
    {
        var result = new StringBuilder();
        var buffer = new char[8192];
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
        {
            if (result.Length + count > OutputLimit) { kill(); throw new UpdateFailure("output", ""); }
            result.Append(buffer, 0, count);
        }
        return result.ToString();
    }
}

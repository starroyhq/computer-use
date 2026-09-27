using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal sealed class HostRuntime : IAsyncDisposable
{
    private const int MaxLineBytes = 32 * 1024 * 1024;
    private readonly Action<JsonElement> _event;
    private readonly SemaphoreSlim _inputLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly ConcurrentDictionary<Guid, NamedPipeServerStream> _connections = new();
    private readonly CancellationTokenSource _pipesCancellation = new();
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? _process;
    private Task? _reader;
    private Task? _listener;
    private bool _closing;
    private readonly string _pipeShortName = "computer-use-" + Guid.NewGuid().ToString("N");
    internal string PipeName => @"\\.\pipe\" + _pipeShortName;

    internal HostRuntime(Action<JsonElement> onEvent) => _event = onEvent;

    internal async Task StartAsync()
    {
        PrivateData.EnsureDirectory();
        var root = AppContext.BaseDirectory;
        var node = Path.Combine(root, "bin", "node.exe");
        var host = Path.Combine(root, "runtime", "host.js");
        var driver = Path.Combine(root, "bin", "cua-driver.exe");
        foreach (var file in new[] { node, host, driver })
            if (!File.Exists(file)) throw new FileNotFoundException("Portable package is missing a runtime component.", file);

        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = root
        };
        foreach (var argument in new[] { host, "--windows", "--driver-binary", driver, "--data-dir", PrivateData.DirectoryPath })
            start.ArgumentList.Add(argument);
        foreach (var key in start.Environment.Keys.Cast<string>().Where(key =>
            key.StartsWith("CUA_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase) ||
            key.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase)).ToArray())
            start.Environment.Remove(key);
        start.Environment["CUA_DRIVER_EMBEDDED"] = "1";
        start.Environment["CUA_DRIVER_PERMISSION_MODE"] = "standard";
        start.Environment["CUA_DRIVER_RS_TELEMETRY_ENABLED"] = "false";
        start.Environment["CUA_DRIVER_RS_UPDATE_CHECK"] = "false";
        start.Environment["DO_NOT_TRACK"] = "1";

        _process = Process.Start(start) ?? throw new IOException("Could not launch Node runtime.");
        _process.BeginErrorReadLine(); // Diagnostics may contain desktop content; deliberately discard.
        _reader = ReadWorkerAsync(_process.StandardOutput.BaseStream);
        try
        {
            await _ready.Task.WaitAsync(TimeSpan.FromSeconds(30));
            _listener = AcceptConnectionsAsync(_pipesCancellation.Token);
            PrivateData.WriteDiscovery(PipeName);
        }
        catch
        {
            await StopAsync();
            throw;
        }
    }

    private async Task ReadWorkerAsync(Stream stdout)
    {
        var reader = new BoundedLineReader(stdout, MaxLineBytes);
        try
        {
            while (!_closing)
            {
                var line = await reader.ReadAsync(CancellationToken.None);
                if (line is null) throw new IOException("Runtime closed its event stream.");
                using var document = JsonDocument.Parse(line);
                var message = document.RootElement;
                var kind = RequiredString(message, "event", 80);
                if (kind == "rpc_response")
                {
                    var id = RequiredString(message, "id", 100);
                    if (_pending.TryRemove(id, out var completion)) completion.TrySetResult(message.Clone());
                }
                else
                {
                    if (kind == "ready") _ready.TrySetResult();
                    _event(message.Clone());
                }
            }
        }
        catch (Exception error)
        {
            _ready.TrySetException(error);
            if (!_closing)
                _event(JsonSerializer.SerializeToElement(new { @event = "fatal", message = "运行时连接已断开；动作不会重放。" }));
        }
        finally
        {
            foreach (var pending in _pending.Values) pending.TrySetException(new IOException("Runtime exited."));
            _pending.Clear();
        }
    }

    internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null)
    {
        var message = new Dictionary<string, string> { ["command"] = command };
        if (clientId is not null) message["clientId"] = clientId;
        if (sessionId is not null) message["sessionId"] = sessionId;
        return WriteWorkerAsync(JsonSerializer.Serialize(message));
    }

    private async Task WriteWorkerAsync(string json)
    {
        if (_closing || _process is null || _process.HasExited) throw new IOException("Runtime is not running.");
        if (Encoding.UTF8.GetByteCount(json) > MaxLineBytes) throw new IOException("Runtime request exceeds transport limit.");
        await _inputLock.WaitAsync();
        try
        {
            await _process.StandardInput.WriteLineAsync(json);
            await _process.StandardInput.FlushAsync();
        }
        finally { _inputLock.Release(); }
    }

    private async Task AcceptConnectionsAsync(CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var pipe = new NamedPipeServerStream(_pipeShortName, PipeDirection.InOut, 64,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
                    64 * 1024, 64 * 1024);
                try { await pipe.WaitForConnectionAsync(cancellation); }
                catch { pipe.Dispose(); throw; }
                var id = Guid.NewGuid();
                _connections[id] = pipe;
                _ = HandleConnectionAsync(id, pipe, cancellation);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { }
        catch
        {
            if (!_closing)
                _event(JsonSerializer.SerializeToElement(new { @event = "fatal", message = "当前用户命名管道已停止；请重启服务。" }));
        }
    }

    private async Task HandleConnectionAsync(Guid connectionId, NamedPipeServerStream pipe, CancellationToken cancellation)
    {
        var act = false;
        var publicId = "";
        try
        {
            using var document = JsonDocument.Parse(await new BoundedLineReader(pipe, MaxLineBytes).ReadAsync(cancellation)
                ?? throw new IOException("Empty pipe request."));
            var request = document.RootElement;
            if (request.GetProperty("version").GetInt32() != 1) throw new FormatException("Unsupported IPC version.");
            publicId = RequiredString(request, "id", 100);
            var method = RequiredString(request, "method", 80);
            act = method == "act";
            string? token = null;
            if (request.TryGetProperty("token", out var tokenValue) && tokenValue.ValueKind != JsonValueKind.Null)
                token = RequiredString(request, "token", 512);
            var parameters = request.TryGetProperty("params", out var value) ? value.Clone() : JsonSerializer.SerializeToElement(new { });
            var internalId = Guid.NewGuid().ToString("N");
            var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_pending.TryAdd(internalId, completion)) throw new IOException("Duplicate internal request.");
            try
            {
                var workerRequest = new Dictionary<string, object?>
                {
                    ["command"] = "rpc_request", ["id"] = internalId,
                    ["method"] = method, ["params"] = parameters
                };
                if (token is not null) workerRequest["token"] = token;
                await WriteWorkerAsync(JsonSerializer.Serialize(workerRequest));
                var response = await completion.Task.WaitAsync(TimeSpan.FromSeconds(65), cancellation);
                var hasResult = response.TryGetProperty("result", out var result);
                var hasError = response.TryGetProperty("error", out var error);
                if (hasResult == hasError) throw new IOException("Invalid runtime response.");
                await WriteResponseAsync(pipe, hasResult
                    ? JsonSerializer.Serialize(new { id = publicId, result })
                    : JsonSerializer.Serialize(new { id = publicId, error }), cancellation);
            }
            finally { _pending.TryRemove(internalId, out _); }
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellation.IsCancellationRequested)
        {
            var code = error is FormatException or JsonException or KeyNotFoundException or InvalidOperationException ? "invalid_request"
                : act ? "unknown_outcome" : "unavailable";
            var message = code == "unknown_outcome"
                ? "Connection failed after dispatch; query action_status with the original requestId before acting again."
                : code == "invalid_request" ? "Malformed IPC request." : "Runtime unavailable.";
            try { await WriteResponseAsync(pipe, JsonSerializer.Serialize(new { id = publicId, error = new { code, message } }), cancellation); }
            catch { }
        }
        finally
        {
            _connections.TryRemove(connectionId, out _);
            pipe.Dispose();
        }
    }

    private static async Task WriteResponseAsync(Stream stream, string response, CancellationToken cancellation)
    {
        var bytes = Encoding.UTF8.GetBytes(response + "\n");
        if (bytes.Length > MaxLineBytes) throw new IOException("Runtime response exceeds transport limit.");
        await stream.WriteAsync(bytes, cancellation);
        await stream.FlushAsync(cancellation);
    }

    private static string RequiredString(JsonElement value, string property, int maxLength)
    {
        var text = value.GetProperty(property).GetString();
        if (string.IsNullOrEmpty(text) || text.Length > maxLength) throw new FormatException("Invalid IPC field.");
        return text;
    }

    internal async Task StopAsync()
    {
        if (_closing) return;
        try { await SendControlAsync("stop").WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
        _closing = true;
        _pipesCancellation.Cancel();
        foreach (var pipe in _connections.Values) pipe.Dispose();
        PrivateData.RemoveDiscovery(PipeName);
        if (_process is not null)
        {
            try { _process.StandardInput.Close(); } catch { }
            try { await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
            if (!_process.HasExited)
            {
                try { _process.Kill(entireProcessTree: true); } catch { }
                try { await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            }
            _process.Dispose();
            _process = null;
        }
        foreach (var pending in _pending.Values) pending.TrySetException(new IOException("Runtime stopped."));
        _pending.Clear();
        if (_listener is not null) try { await _listener.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        if (_reader is not null) try { await _reader.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _inputLock.Dispose();
        _pipesCancellation.Dispose();
    }
}

internal sealed class BoundedLineReader(Stream stream, int maxBytes)
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private int _start;
    private int _end;

    internal async Task<string?> ReadAsync(CancellationToken cancellation)
    {
        using var line = new MemoryStream();
        while (true)
        {
            for (var i = _start; i < _end; i++)
            {
                if (_buffer[i] != (byte)'\n') continue;
                line.Write(_buffer, _start, i - _start);
                _start = i + 1;
                if (line.Length > maxBytes) throw new IOException("IPC line exceeds transport limit.");
                return new UTF8Encoding(false, true).GetString(line.ToArray());
            }
            line.Write(_buffer, _start, _end - _start);
            if (line.Length > maxBytes) throw new IOException("IPC line exceeds transport limit.");
            _start = 0;
            _end = await stream.ReadAsync(_buffer, cancellation);
            if (_end == 0) return line.Length == 0 ? null : throw new IOException("Incomplete IPC line.");
        }
    }
}

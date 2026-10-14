using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal sealed class HostRuntime : IAsyncDisposable
{
    private const int MaxLineBytes = 32 * 1024 * 1024;
    private const int MaxPipeInstances = 64;
    // CLI 连接后立即写入请求；迟迟不发请求的连接会占住管道实例，限时后关闭。
    private static readonly TimeSpan RequestReadTimeout = TimeSpan.FromSeconds(10);
    private readonly Action<JsonElement> _event;
    private readonly SemaphoreSlim _inputLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly ConcurrentDictionary<Guid, NamedPipeServerStream> _connections = new();
    private readonly CancellationTokenSource _pipesCancellation = new();
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? _process;
    private RuntimeProcessGroup? _processGroup;
    private bool _workerAssigned;
    private Task? _reader;
    private Task? _listener;
    private bool _closing;
    private bool _disposed;
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
        // Do not import the worker (which may launch a desktop driver) until its
        // process is inside the kill-on-close job. EOF before that point leaves
        // no worker running if the GUI exits in the launch/assignment gap.
        const string bootstrap = "const eof=()=>process.exit(1);process.stdin.once('end',eof);process.stdin.once('data',()=>{process.stdin.removeListener('end',eof);process.stdin.pause();void import(require('node:url').pathToFileURL(process.argv[1]).href)});";
        foreach (var argument in new[] { "--input-type=commonjs", "--eval", bootstrap, host, "--windows", "--driver-binary", driver, "--data-dir", PrivateData.DirectoryPath })
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

        try
        {
            _processGroup = new RuntimeProcessGroup();
            _process = Process.Start(start) ?? throw new IOException("Could not launch Node runtime.");
            _process.BeginErrorReadLine(); // Diagnostics may contain desktop content; deliberately discard.
            _processGroup.Assign(_process);
            _workerAssigned = true;
            _reader = ReadWorkerAsync(_process.StandardOutput.BaseStream);
            await _process.StandardInput.WriteLineAsync("computer-use-start");
            await _process.StandardInput.FlushAsync();
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

    internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null, bool? allApps = null, string? requestId = null)
    {
        var message = new Dictionary<string, object> { ["command"] = command };
        if (clientId is not null) message["clientId"] = clientId;
        if (sessionId is not null) message["sessionId"] = sessionId;
        if (allApps is not null) message["allApps"] = allApps.Value;
        if (requestId is not null) message["requestId"] = requestId;
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
        // Reserve one of the 64 instances for the next listener. In particular,
        // an EOF-only readiness probe must not close the last named-pipe handle
        // before a successor exists, or the next CreateFile can see ENOENT.
        using var slots = new SemaphoreSlim(MaxPipeInstances - 1, MaxPipeInstances - 1);
        var handlers = new List<Task>();
        NamedPipeServerStream? listener = null;
        Task? accepting = null;
        try
        {
            listener = CreatePipe();
            accepting = ArmListener(listener, cancellation);
            while (!cancellation.IsCancellationRequested)
            {
                await slots.WaitAsync(cancellation);
                NamedPipeServerStream? connected = null;
                var handedOff = false;
                try
                {
                    try { await accepting; }
                    catch (IOException error) when (error.HResult == unchecked((int)0x800700E8))
                    {
                        // ERROR_NO_DATA: a client connected and closed before
                        // ConnectNamedPipe could arm. No request was dispatched.
                        // Replace it before disposal so the name never vanishes.
                        var abandoned = listener;
                        listener = null;
                        try
                        {
                            listener = CreatePipe();
                            accepting = ArmListener(listener, cancellation);
                        }
                        finally { abandoned.Dispose(); }
                        continue;
                    }
                    connected = listener;
                    listener = null;
                    // Create the successor before dispatch: handling an already
                    // disconnected probe can complete synchronously, including Dispose.
                    listener = CreatePipe();
                    accepting = ArmListener(listener, cancellation);
                    var id = Guid.NewGuid();
                    _connections[id] = connected;
                    handlers.RemoveAll(task => task.IsCompletedSuccessfully);
                    handlers.Add(HandleConnectionWithSlotAsync(id, connected, slots, cancellation));
                    handedOff = true;
                }
                finally
                {
                    if (!handedOff)
                    {
                        connected?.Dispose();
                        slots.Release();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { }
        catch
        {
            if (!_closing)
                _event(JsonSerializer.SerializeToElement(new { @event = "fatal", message = "当前用户命名管道已停止；请重启服务。" }));
        }
        finally
        {
            listener?.Dispose();
            // Disposing the pending instance completes its overlapped wait. Observe
            // that completion as well, including cancellation and a final probe EOF.
            if (accepting is not null) try { await accepting; } catch { }
            // Keep the semaphore alive until every handler has released its slot.
            await Task.WhenAll(handlers);
        }
    }

    private NamedPipeServerStream CreatePipe() => new(_pipeShortName, PipeDirection.InOut, MaxPipeInstances,
        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 64 * 1024, 64 * 1024);

    private static Task ArmListener(NamedPipeServerStream pipe, CancellationToken cancellation)
    {
        try { return pipe.WaitForConnectionAsync(cancellation); }
        catch (IOException error) { return Task.FromException(error); }
    }

    private async Task HandleConnectionWithSlotAsync(Guid id, NamedPipeServerStream pipe, SemaphoreSlim slots,
        CancellationToken cancellation)
    {
        try { await HandleConnectionAsync(id, pipe, cancellation); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        finally { slots.Release(); }
    }

    private async Task HandleConnectionAsync(Guid connectionId, NamedPipeServerStream pipe, CancellationToken cancellation)
    {
        var act = false;
        var publicId = "";
        try
        {
            using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            readTimeout.CancelAfter(RequestReadTimeout);
            using var document = JsonDocument.Parse(await new BoundedLineReader(pipe, MaxLineBytes).ReadAsync(readTimeout.Token)
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
            // 外部 cancellation 未触发时的取消只可能来自请求读取超时：请求尚未解析，不会送达运行时。
            var code = error is FormatException or JsonException or KeyNotFoundException or InvalidOperationException
                or OperationCanceledException ? "invalid_request"
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
        if (_disposed) return;
        if (!_closing)
        {
            // An unassigned bootstrap must receive EOF, never a control line:
            // its first line would release the worker outside the process job.
            if (_workerAssigned) try { await SendControlAsync("stop").WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
            _closing = true;
            _pipesCancellation.Cancel();
            foreach (var pipe in _connections.Values) pipe.Dispose();
            PrivateData.RemoveDiscovery(PipeName);
        }
        if (_process is not null)
        {
            try { _process.StandardInput.Close(); } catch { }
            try { await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
            if (!_process.HasExited)
            {
                try { _process.Kill(entireProcessTree: true); } catch { }
                try { await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            }
        }
        // The Node parent may already have exited while a native driver remains.
        // Job emptiness, rather than Node exit alone, establishes safe recovery.
        if (_processGroup is not null) await _processGroup.StopAsync();
        // A failed assignment leaves a bootstrap-only Node outside the job.
        // Always stop the job first, even when Node's individual kill failed, so
        // an uncertain parent exit cannot leave its driver descendants running.
        if (_process is not null && !_process.HasExited)
            throw new IOException("Runtime has not exited; recovery is blocked.");
        _process?.Dispose();
        _process = null;
        _processGroup?.Dispose();
        _processGroup = null;
        foreach (var pending in _pending.Values) pending.TrySetException(new IOException("Runtime stopped."));
        _pending.Clear();
        if (_listener is not null) try { await _listener.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        if (_reader is not null) try { await _reader.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync();
        _inputLock.Dispose();
        _pipesCancellation.Dispose();
        _disposed = true;
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

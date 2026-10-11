using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using ComputerUse.WindowsHost;

internal static class Program
{
    private const int FileNotFound = 2;
    private const int PipeBusy = 231;

    private static async Task Main()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Real Windows named pipes are required.");
        await ProbeThenRequest();
        await ConcurrentProbes();
        await CapacityAndIdleTimeout();
        await CancellationAtCapacity();
        await ListenerCreationFailure();
        Console.WriteLine("PASS: all real Windows transport regressions (no worker, desktop or private user data)");
    }

    private static async Task ProbeThenRequest()
    {
        await using var server = new Server();
        for (var index = 0; index < 500; index++)
        {
            // CreateFile is deliberately called directly: NamedPipeClientStream.Connect
            // retries a missing name and would hide the regression under test.
            using (var probe = Connect(server.Name)) { }
            using var request = Connect(server.Name);
            await request.WriteAsync(Encoding.UTF8.GetBytes("{\"version\":2}\n"));
            using var reader = new StreamReader(request, Encoding.UTF8, leaveOpen: true);
            var response = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(3));
            using var json = JsonDocument.Parse(response ?? throw new IOException("Request unexpectedly closed."));
            Check(json.RootElement.GetProperty("error").GetProperty("code").GetString() == "invalid_request",
                "Malformed input stays rejected without a worker dispatch.");
            if ((index + 1) % 100 == 0) Console.WriteLine($"Probe/request: {index + 1}/500");
        }
        Check(server.Events.IsEmpty, "Probes and malformed requests must not stop the listener.");
        Console.WriteLine("PASS: EOF probe followed by immediate raw CreateFile request");
    }

    private static async Task ConcurrentProbes()
    {
        await using var server = new Server();
        // Synchronous CreateFile clients need their own threads; otherwise a small
        // ThreadPool can be occupied by clients while the listener needs it to run.
        await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Factory.StartNew(() =>
        {
            for (var index = 0; index < 250; index++) using (var probe = Connect(server.Name)) { }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)));
        Check(server.Events.IsEmpty, "Concurrent probe disconnects must not cause fatal events.");
        Console.WriteLine("PASS: 1,000 concurrent EOF probes without a missing pipe name");
    }

    private static async Task CapacityAndIdleTimeout()
    {
        await using var server = new Server();
        var clients = new List<NamedPipeClientStream>();
        try
        {
            for (var index = 0; index < 64; index++) clients.Add(Connect(server.Name));
            await Until(() => server.ConnectionCount == 63, TimeSpan.FromSeconds(3));
            using (var extra = Open(server.Name))
                Check(extra.IsInvalid && Marshal.GetLastWin32Error() == PipeBusy,
                    "At capacity the reserved listener keeps the name present and reports busy, not missing.");
            Console.WriteLine("Capacity: 63 request handlers + 1 reserved instance; waiting for idle timeout");
            using var reader = new StreamReader(clients[0], Encoding.UTF8, leaveOpen: true);
            var response = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(13));
            using var json = JsonDocument.Parse(response ?? throw new IOException("Idle request response missing."));
            Check(json.RootElement.GetProperty("error").GetProperty("code").GetString() == "invalid_request",
                "A connected client that sends no request must be bounded by the read timeout.");
            using var afterTimeout = Connect(server.Name);
            Check(server.Events.IsEmpty, "Saturation and idle timeouts must not be fatal.");
        }
        finally { foreach (var client in clients) client.Dispose(); }
        Console.WriteLine("PASS: bounded capacity and idle-client recovery");
    }

    private static async Task CancellationAtCapacity()
    {
        var server = new Server();
        var clients = new List<NamedPipeClientStream>();
        try
        {
            for (var index = 0; index < 64; index++) clients.Add(Connect(server.Name));
            await Until(() => server.ConnectionCount == 63, TimeSpan.FromSeconds(3));
            await server.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(4));
            Check(server.ConnectionCount == 0 && server.Listener.IsCompletedSuccessfully,
                "Cancellation drains handlers and the reserved listener without faults.");
            Check(server.Events.IsEmpty, "Normal cancellation must not emit fatal events.");
        }
        finally
        {
            foreach (var client in clients) client.Dispose();
            await server.DisposeAsync();
        }
        using var missing = Open(server.Name);
        Check(missing.IsInvalid && Marshal.GetLastWin32Error() == FileNotFound, "Cancellation releases every server handle.");
        Console.WriteLine("PASS: cancel at capacity releases handlers and listener");
    }

    private static async Task ListenerCreationFailure()
    {
        await using var server = new Server();
        var occupied = new List<NamedPipeServerStream>();
        try
        {
            // Simulate exhaustion outside this loop so successor creation itself fails.
            for (var index = 0; index < 63; index++)
                occupied.Add(new NamedPipeServerStream(server.Name[9..], PipeDirection.InOut, 64,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 65536, 65536));
            using var probe = Connect(server.Name);
            await Until(() => !server.Events.IsEmpty, TimeSpan.FromSeconds(3));
            Check(server.Events.Single().GetProperty("event").GetString() == "fatal", "Unexpected creation failure is reported once.");
            await server.Listener.WaitAsync(TimeSpan.FromSeconds(3));
            Check(server.ConnectionCount == 0, "The accepted connection is disposed when successor creation fails.");
        }
        finally { foreach (var pipe in occupied) pipe.Dispose(); }
        Console.WriteLine("PASS: successor creation failure reports fatal and releases its accepted pipe");
    }

    private static NamedPipeClientStream Connect(string name)
    {
        var timer = Stopwatch.StartNew();
        do
        {
            var handle = Open(name);
            var error = Marshal.GetLastWin32Error();
            if (!handle.IsInvalid) return new NamedPipeClientStream(PipeDirection.InOut, true, true, handle);
            handle.Dispose();
            if (error == FileNotFound) throw new IOException("ENOENT: pipe name disappeared between readiness probe and connection.");
            if (error != PipeBusy) throw new System.ComponentModel.Win32Exception(error);
            Thread.Yield(); // Retry only saturation. Never retry a missing name.
        } while (timer.Elapsed < TimeSpan.FromSeconds(3));
        throw new TimeoutException("Pipe remained busy.");
    }

    private static SafePipeHandle Open(string name) => CreateFile(name, 0xC0000000, 0, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    private static async Task Until(Func<bool> predicate, TimeSpan timeout)
    {
        var timer = Stopwatch.StartNew();
        while (!predicate())
        {
            if (timer.Elapsed >= timeout) throw new TimeoutException("Transport condition did not complete.");
            await Task.Delay(10);
        }
    }

    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }

    private sealed class Server : IAsyncDisposable
    {
        private readonly HostRuntime _runtime;
        private bool _disposed;
        internal readonly ConcurrentQueue<JsonElement> Events = new();
        internal string Name => _runtime.PipeName;
        internal Task Listener { get; }
        internal int ConnectionCount => ((ConcurrentDictionary<Guid, NamedPipeServerStream>)Field("_connections")!).Count;
        private object? Field(string name) => typeof(HostRuntime).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(_runtime);
        internal Server()
        {
            _runtime = new HostRuntime(message => Events.Enqueue(message));
            var cancellation = ((CancellationTokenSource)Field("_pipesCancellation")!).Token;
            Listener = (Task)typeof(HostRuntime).GetMethod("AcceptConnectionsAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(_runtime, [cancellation])!;
            typeof(HostRuntime).GetField("_listener", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_runtime, Listener);
        }
        public async ValueTask DisposeAsync()
        {
            if (_disposed) return;
            _disposed = true;
            await _runtime.DisposeAsync();
        }
    }
}

namespace ComputerUse.WindowsHost
{
    // Transport tests never call StartAsync or access the user's runtime/credentials.
    internal static class PrivateData
    {
        internal static string DirectoryPath => throw new InvalidOperationException("Worker startup is forbidden in transport tests.");
        internal static void EnsureDirectory() => throw new InvalidOperationException("Private data access is forbidden in transport tests.");
        internal static void WriteDiscovery(string pipeName) => throw new InvalidOperationException("Discovery writes are forbidden in transport tests.");
        internal static void RemoveDiscovery(string pipeName) { }
    }
}

using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal sealed record HostStartupState(int Version, int ProcessId, long ProcessStartTimeUtcTicks,
    int SessionId, string State, bool AutoStartBlocked, string? PipeName);

internal sealed class HostStartupStore
{
    private readonly string _path;
    private readonly HostStartupState _identity;
    private readonly bool _readOnly;

    internal HostStartupStore(string? directory = null, bool readOnly = false)
    {
        directory ??= PrivateData.DirectoryPath;
        _readOnly = readOnly;
        if (readOnly) PrivateData.ValidateDirectory(directory);
        else PrivateData.EnsureDirectory(directory);
        _path = Path.Combine(directory, "host-state.json");
        using var process = Process.GetCurrentProcess();
        _identity = new(1, process.Id, process.StartTime.ToUniversalTime().Ticks, process.SessionId, "starting", false, null);
    }

    internal HostStartupState? Read()
    {
        var state = PrivateData.ReadPrivateJson<HostStartupState>(_path);
        if (state is not null && (state.Version != 1 || state.ProcessId <= 0 || state.ProcessStartTimeUtcTicks <= 0
            || state.SessionId < 0 || state.State is not ("starting" or "ready" or "paused" or "stopped" or "failed" or "exited")))
            throw new IOException("Computer Use startup state is invalid.");
        return state;
    }

    internal void Write(string state, bool blocked, string? pipeName = null)
    {
        if (_readOnly) throw new InvalidOperationException("Read-only startup state cannot be changed.");
        PrivateData.WritePrivateJson(_path, _identity with { State = state, AutoStartBlocked = blocked, PipeName = pipeName });
    }
}

internal static class HostStartup
{
    internal const string EnsureArgument = "--ensure-running";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(35);

    // A pause or emergency stop survives process exit. A failed/dead process may be
    // cold-started again; a live failed process requires an explicit local restart.
    internal static string? BlockingCode(HostStartupState? state, bool sameLiveProcess)
    {
        if (state?.AutoStartBlocked == true) return state.State == "paused" ? "paused" : "stopped";
        if (sameLiveProcess && state?.State is "paused" or "stopped" or "failed") return state.State;
        return null;
    }

    internal static bool MatchesProcess(HostStartupState state, int processId, long startTimeUtcTicks,
        int sessionId, string executable, string expectedExecutable) =>
        state.ProcessId == processId && state.ProcessStartTimeUtcTicks == startTimeUtcTicks
        && state.SessionId == sessionId && string.Equals(executable, expectedExecutable, StringComparison.OrdinalIgnoreCase);

    private static bool IsLive(HostStartupState state, string executable)
    {
        try
        {
            using var process = Process.GetProcessById(state.ProcessId);
            return !process.HasExited && MatchesProcess(state, process.Id, process.StartTime.ToUniversalTime().Ticks,
                process.SessionId, process.MainModule?.FileName ?? "", executable);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception
            or NotSupportedException) { return false; }
    }

    internal static int EnsureRunning(string mutexName, string gateName)
    {
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0)
            return Failure("non_interactive", "Open Computer Use in the signed-in user's interactive desktop session.");
        var elapsed = Stopwatch.StartNew();
        try
        {
            using var gate = new Mutex(false, gateName);
            if (!Acquire(gate, Timeout)) return Failure("timeout", "Timed out waiting for Computer Use startup.");
            try { return EnsureCore(mutexName, elapsed); }
            finally { gate.ReleaseMutex(); }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException
            or InvalidOperationException or System.ComponentModel.Win32Exception or WaitHandleCannotBeOpenedException)
        {
            return Failure("launch_failed", StartupFailureMessage(error));
        }
    }

    internal static string StartupFailureMessage(Exception error)
    {
        var code = $"{error.GetType().Name}, HRESULT=0x{unchecked((uint)error.HResult):X8}";
        if (error is System.ComponentModel.Win32Exception native) code += $", Win32={native.NativeErrorCode}";
        // Exception messages may contain private paths or user data; only fixed
        // exception identity and numeric error codes belong in helper output.
        return $"Computer Use could not be started ({code}). Open the installed app and check its status.";
    }

    private static int EnsureCore(string mutexName, Stopwatch elapsed)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Executable path is unavailable.");
        var session = Process.GetCurrentProcess().SessionId;
        var store = new HostStartupStore(readOnly: true);
        Process? child = null;
        var launched = false;
        try
        {
            while (elapsed.Elapsed < Timeout)
            {
                var state = store.Read();
                var live = state is not null && IsLive(state, executable);
                var blocked = BlockingCode(state, live);
                if (blocked is not null) return Failure(blocked, blocked switch
                {
                    "paused" => "Computer Use is paused. Resume it in the local app.",
                    "stopped" => "Computer Use was stopped. Restart services in the local app.",
                    _ => "Computer Use failed to start or stopped after an error. Check the local app and restart services."
                });
                if (live && state!.SessionId != session)
                    return Failure("launch_failed", "Computer Use is running in another Windows session. Use its interactive session.");
                if (live && state!.State == "ready" && CanConnect(state.PipeName))
                {
                    // A pause/stop may arrive while the pipe probe is completing.
                    var after = store.Read();
                    if (after == state)
                    {
                        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, state = "ready" }));
                        return 0;
                    }
                    continue;
                }
                if (!launched && !InstanceExists(mutexName))
                {
                    PreventStandardHandleInheritance();
                    var start = new ProcessStartInfo(executable)
                    {
                        UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppContext.BaseDirectory,
                        // Give the GUI its own standard streams as well as preventing
                        // inheritance of the helper's original handles above.
                        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true
                    };
                    start.ArgumentList.Add(LaunchAtLogin.BackgroundArgument);
                    child = Process.Start(start) ?? throw new IOException("Host launch failed.");
                    child.BeginOutputReadLine();
                    child.BeginErrorReadLine();
                    launched = true;
                }
                if (child?.HasExited == true && !InstanceExists(mutexName))
                    return Failure("launch_failed", "Computer Use exited before becoming ready. Open the installed app and check its status.");
                Thread.Sleep(100);
            }
            return Failure("timeout", "Computer Use did not become ready within 35 seconds. Check its status in the local app.");
        }
        finally { child?.Dispose(); }
    }

    internal static void PreventStandardHandleInheritance()
    {
        const uint inherit = 1;
        foreach (var standardHandle in new[] { -10, -11, -12 })
        {
            var handle = GetStdHandle(standardHandle);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) continue;
            if (!GetHandleInformation(handle, out var flags))
            {
                var error = Marshal.GetLastWin32Error();
                // Console-less GUI launches may expose non-null invalid handles.
                if (error == 6) continue; // ERROR_INVALID_HANDLE
                throw new System.ComponentModel.Win32Exception(error);
            }
            // Process.Start uses CreateProcess(bInheritHandles: true). Redirecting
            // hStdOutput does not exclude the original handle from that inheritance;
            // a GUI retaining it would keep the caller waiting for stdout EOF.
            if ((flags & inherit) != 0 && !SetHandleInformation(handle, inherit, 0))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    private static bool CanConnect(string? pipeName)
    {
        const string prefix = @"\\.\pipe\computer-use-";
        if (pipeName is null || !pipeName.StartsWith(prefix, StringComparison.Ordinal)
            || pipeName.Length != prefix.Length + 32 || !pipeName[prefix.Length..].All(Uri.IsHexDigit)) return false;
        try
        {
            var discovery = PrivateData.ReadPrivateJson<JsonElement>(PrivateData.DiscoveryPath);
            if (!discovery.TryGetProperty("pipeName", out var name) || name.GetString() != pipeName) return false;
            using var pipe = new NamedPipeClientStream(".", pipeName[9..], PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            pipe.Connect(100);
            return true;
        }
        catch (Exception error) when (error is IOException or TimeoutException or UnauthorizedAccessException or JsonException
            or InvalidOperationException) { return false; }
    }

    private static bool InstanceExists(string name)
    {
        if (!Mutex.TryOpenExisting(name, out var mutex)) return false;
        using (mutex)
        {
            if (!Acquire(mutex, TimeSpan.Zero)) return true;
            mutex.ReleaseMutex();
            return false;
        }
    }

    private static bool Acquire(Mutex mutex, TimeSpan timeout)
    {
        try { return mutex.WaitOne(timeout); }
        catch (AbandonedMutexException) { return true; }
    }

    private static int Failure(string code, string message)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, code, message }));
        return 1;
    }
}

using System.Drawing;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using ComputerUse.WindowsHost;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--cli-fixture") { CliFixture(args[1]); return; }
        ApplicationConfiguration.Initialize();
        if (args.Length == 1 && args[0] == "--startup-state-checks")
        {
            CheckStandardHandleInheritance();
            CheckStartupState();
            return;
        }
        if (args.Length == 2 && args[0] == "--live-update")
        {
            LiveUpdate(args[1]);
            return;
        }
        // 装好（或卸载）安装程序之后，人工验证托盘程序按卸载登记识别安装版。
        if (args.Length == 2 && args[0] == "--installed")
        {
            CheckInstalled(args[1]);
            return;
        }
        if (args.Length == 1 && args[0] == "--not-installed")
        {
            Check(UpdateService.RegisteredInstallLocation() is null, "no install location is registered");
            Console.WriteLine("PASS: no installation is registered for the current user");
            return;
        }
        var screenshots = args.Length == 2 && args[0] == "--screenshots" ? args[1] : null;
        CheckTranslations();
        CheckHelpers();
        CheckPackageCommand();
        CheckStandardHandleInheritance();
        CheckStartupState();
        CheckStartupLifecycle();
        CheckFaultRecovery();
        var data = Path.Combine(Path.GetTempPath(), "cu-host-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            CheckSettingsStore(data);
            using var host = new HostApplication(showWindow: true, dataDirectory: data);
            Pump();
            try
            {
                CheckAuthorizationLifecycle(host);
                CheckPairingScopes(host);
                CheckSettingsWindow(host);
                CheckGrantAllApps(host);
                CheckGrantRevocation(host);
                CheckSettingsInteractions(host);
                CheckSkillConnection(host);
                CheckSettingsLayouts(host);
                CheckUpdatePage(host);
                if (screenshots is not null) Screenshots(host, screenshots);
            }
            finally { Invoke(host, "ExitAsync").GetAwaiter().GetResult(); }
        }
        finally
        {
            try { Directory.Delete(data, recursive: true); } catch { }
        }
    }

    private static void CheckStandardHandleInheritance()
    {
        using var input = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var output = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        using var error = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        var kinds = new[] { -10, -11, -12 };
        var original = kinds.Select(GetStdHandle).ToArray();
        var temporary = new[] { input.SafePipeHandle.DangerousGetHandle(), output.SafePipeHandle.DangerousGetHandle(),
            error.SafePipeHandle.DangerousGetHandle() };
        try
        {
            for (var index = 0; index < kinds.Length; index++)
            {
                Check(SetHandleInformation(temporary[index], 1, 1), "test standard handle can be made inheritable");
                Check(SetStdHandle(kinds[index], temporary[index]), "test standard handle can be installed");
            }
            HostStartup.PreventStandardHandleInheritance();
            for (var index = 0; index < kinds.Length; index++)
            {
                Check(GetStdHandle(kinds[index]) == temporary[index], "startup does not replace standard handles");
                Check(GetHandleInformation(temporary[index], out var flags) && (flags & 1) == 0,
                    "startup clears inheritance without closing the standard handle");
            }
            output.WriteByte(0x41);
            output.Flush();
            HostStartup.PreventStandardHandleInheritance();
            Check(SetStdHandle(-10, IntPtr.Zero) && SetStdHandle(-12, new IntPtr(-1)), "install absent GUI standard handles");
            HostStartup.PreventStandardHandleInheritance();
            Check(GetHandleInformation(temporary[1], out _), "absent stdin/stderr do not prevent usable JSON stdout");
        }
        finally
        {
            // Restore native handles before any harness logging or error reporting.
            for (var index = 0; index < kinds.Length; index++)
                if (!SetStdHandle(kinds[index], original[index])) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        Console.WriteLine("PASS: startup prevents inherited standard handles without closing or replacing them");
    }

    private static void CliFixture(string mode)
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        switch (mode)
        {
            case "preflight": Console.Write(JsonSerializer.Serialize(new
            {
                schemaVersion = 1, version = "0.6.1", platform = "windows-arm64", host = new { state = "paused" },
                profiles = new[] { "default", "work_agent" }, profile = new { name = "work_agent", state = "unverified" }
            })); break;
            case "skill": Console.Write("请为我安装 Computer Use Skill 并完成连接。\n"); break;
            case "error":
                Console.Error.WriteLine("{\"error\":{\"code\":\"invalid_request\",\"message\":\"fixture error\"}}");
                Environment.ExitCode = 17;
                break;
            case "oversize": Console.Write(new string('x', 4 * 1024 * 1024 + 1)); break;
            case "slow": Thread.Sleep(TimeSpan.FromSeconds(30)); break;
            default: Console.Write("invalid output"); break;
        }
    }

    private static void CheckPackageCommand()
    {
        var runner = new PackageCommand(Environment.ProcessPath!, "--cli-fixture");
        var command = new AgentCommand(runner);
        var profile = command.PreflightAsync("work_agent", CancellationToken.None).GetAwaiter().GetResult();
        Check(profile.Host.State == "paused" && profile.Profile.State == "unverified"
            && profile.Profiles.SequenceEqual(new[] { "default", "work_agent" }), "preflight preserves inactive states and profile names without starting a host");
        Check(command.SetupPromptAsync("work_agent", CancellationToken.None).GetAwaiter().GetResult().Contains("安装 Computer Use Skill"),
            "package command preserves UTF-8 setup prompt output");
        var failed = false;
        try { _ = runner.RunAsync(["error"], CancellationToken.None).GetAwaiter().GetResult(); }
        catch (UpdateFailure error) { failed = error.Code == "invalid_request"; }
        Check(failed, "shared CLI runner preserves nonzero CLI errors");
        failed = false;
        try { _ = runner.RunAsync(["oversize"], CancellationToken.None).GetAwaiter().GetResult(); }
        catch (UpdateFailure error) { failed = error.Code == "output"; }
        Check(failed, "shared CLI runner bounds its output");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var cancelled = false;
        try { _ = runner.RunAsync(["slow"], cancellation.Token).GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { cancelled = true; }
        Check(cancelled && watch.Elapsed < TimeSpan.FromSeconds(10), "cancel kills the isolated CLI process promptly");
        var start = PackageCommand.ForPackage(@"C:\O'Brien\$tools`").StartInfo(["skill", "prompt", "--profile", "work_agent"]);
        Check(!start.UseShellExecute && start.CreateNoWindow && start.ArgumentList.SequenceEqual(new[]
        { @"C:\O'Brien\$tools`\runtime\cli.js", "skill", "prompt", "--profile", "work_agent" }),
            "package commands use exact argument boundaries and the bundled executable");
        Check(!start.Environment.Keys.Any(key => key.StartsWith("CUA_", StringComparison.OrdinalIgnoreCase)
            || key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)), "package commands remove Node/runtime overrides");
        Check(AgentCommand.ValidProfile("work_agent-2") && !AgentCommand.ValidProfile("new\n")
            && !AgentCommand.ValidProfile("bad'profile") && !AgentCommand.ValidProfile(new string('a', 65)), "profile validation rejects ambiguous or shell-like names");
        Console.WriteLine("PASS: shared package CLI runner, profile contract, cancellation and bounded output");
    }

    private static void CheckSkillConnection(HostApplication host)
    {
        var language = L10n.Chinese;
        try
        {
            foreach (var chinese in new[] { true, false })
            {
                L10n.Chinese = chinese;
                var command = new FakeAgentCommand();
                var copied = new List<string>();
                var copySucceeds = true;
                using var window = new SettingsForm(host, command, text => { if (copySucceeds) copied.Add(text); return copySucceeds; });
                window.ShowPage(SettingsPage.Connect);
                Pump();
                var profiles = ControlField<ComboBox>(window, "_profile");
                var copy = ControlField<Button>(window, "_copySetupPrompt");
                var status = ControlField<Label>(window, "_setupPromptStatus");
                Check(profiles.Text == "default" && !profiles.Visible && !ControlField<Button>(window, "_copyPair").Visible
                    && !ControlField<Button>(window, "_copyStdio").Visible && !ControlField<CheckBox>(window, "_http").Visible,
                    "first connection screen hides profile and manual connection choices by default");
                Check(copy.Visible && copy.Text == L10n.T(Msg.ConnectCopySetupPrompt) && command.PreflightCalls == 0,
                    "first connection screen offers setup prompt without probing or requiring a profile decision");
                copy.PerformClick(); AwaitUi(window.SetupPromptTask);
                Check(copied.Single() == FakeAgentCommand.Prompt && command.PromptedProfiles.Single() == "default"
                    && status.Text == L10n.T(Msg.ConnectSetupPromptCopied), "primary copy returns the CLI setup prompt with default profile");

                var advanced = Descendants(window).OfType<Button>().Single(button => button.Text == L10n.T(Msg.ConnectAdvanced));
                advanced.PerformClick(); AwaitUi(window.ProfileLoadTask);
                Check(profiles.Visible && profiles.Items.Cast<string>().SequenceEqual(new[] { "default", "work_agent" }),
                    "advanced connection loads existing names only when expanded");
                profiles.Text = "work_agent";
                Check(ControlField<TextBox>(window, "_pairCommand").Text == SettingsForm.PairCommand(host.PackageRoot, "work_agent"),
                    "pairing command follows the editable profile");
                using (var config = JsonDocument.Parse(SettingsForm.StdioConfiguration(host.PackageRoot, profiles.Text)))
                    Check(config.RootElement.GetProperty("mcpServers").GetProperty("computer-use").GetProperty("args")[4].GetString() == "work_agent",
                        "MCP config uses the same selected profile");
                profiles.Text = "invalid profile";
                Check(!copy.Enabled && !ControlField<Button>(window, "_copyPair").Enabled
                    && !ControlField<Button>(window, "_copyStdio").Enabled, "invalid profile disables generated connection content");
                profiles.Text = "work_agent";
                copy.PerformClick(); AwaitUi(window.SetupPromptTask);
                Check(copied.Count == 2 && command.PromptedProfiles.Last() == "work_agent", "setup prompt honors an advanced profile override");
                command.PromptGate = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                copy.PerformClick();
                Check(!window.SetupPromptTask.IsCompleted && !profiles.Enabled && !copy.Enabled
                    && ControlField<Button>(window, "_cancelSetupPrompt").Visible, "pending prompt keeps UI responsive and prevents duplicate generation");
                ControlField<Button>(window, "_cancelSetupPrompt").PerformClick(); AwaitUi(window.SetupPromptTask);
                Check(copied.Count == 2 && profiles.Enabled && copy.Enabled && status.Text == L10n.T(Msg.ConnectSetupPromptCancelled),
                    "cancel restores controls without copying partial content");
                command.PromptGate = null;
                command.PromptError = true;
                copy.PerformClick(); AwaitUi(window.SetupPromptTask);
                Check(status.Text == L10n.T(Msg.ConnectSetupPromptFailed) && copied.Count == 2,
                    "CLI failure preserves clipboard without displaying raw errors");
                command.PromptError = false;
                copySucceeds = false;
                copy.PerformClick(); AwaitUi(window.SetupPromptTask);
                Check(status.Text == L10n.T(Msg.CommonCopyFailed) && copied.Count == 2, "clipboard failure is reported without claiming success");
                command.PreflightGate = new TaskCompletionSource<AgentPreflight>(TaskCreationOptions.RunContinuationsAsynchronously);
                ControlField<Button>(window, "_refreshProfiles").PerformClick();
                profiles.Text = "new_agent";
                command.PreflightGate.SetResult(command.Result("work_agent"));
                AwaitUi(window.ProfileLoadTask);
                Check(profiles.Text == "new_agent" && ControlField<TextBox>(window, "_pairCommand").Text.EndsWith("--profile 'new_agent'", StringComparison.Ordinal),
                    "late preflight never changes a profile edited while loading");
                advanced.PerformClick(); Pump();
                Check(!profiles.Visible && copy.Visible, "advanced choices collapse without hiding the primary setup action");
            }
        }
        finally { L10n.Chinese = language; }
        Console.WriteLine("PASS: bilingual setup prompt copy, advanced profile consistency, async cancellation and clipboard errors");
    }

    private static void AwaitUi(Task task)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!task.IsCompleted && DateTime.UtcNow < deadline) { Pump(); Thread.Sleep(1); }
        Check(task.IsCompleted, "isolated asynchronous UI operation completes within its test deadline");
        task.GetAwaiter().GetResult();
    }

    private sealed class FakeAgentCommand : IAgentCommand
    {
        internal const string Prompt = "请安装 Computer Use Skill 并完成连接。 Use the bundled CLI and ask me to approve first-time pairing.\n";
        internal readonly List<string> PromptedProfiles = [];
        internal TaskCompletionSource<string>? PromptGate;
        internal TaskCompletionSource<AgentPreflight>? PreflightGate;
        internal bool PromptError;
        internal int PreflightCalls;
        internal AgentPreflight Result(string profile) => new(1, "0.6.1", "windows-arm64", new("paused"),
            ["default", "work_agent"], new(profile, "unverified"));
        public Task<AgentPreflight> PreflightAsync(string profile, CancellationToken cancellation)
        {
            PreflightCalls++;
            return PreflightGate?.Task.WaitAsync(cancellation) ?? Task.FromResult(Result(profile));
        }
        public Task<string> SetupPromptAsync(string profile, CancellationToken cancellation)
        {
            PromptedProfiles.Add(profile);
            if (PromptError) throw new IOException("sensitive fixture error must not reach UI");
            return PromptGate?.Task.WaitAsync(cancellation) ?? Task.FromResult(Prompt);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetStdHandle(int standardHandle, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    private static void CheckStartupState()
    {
        var failure = HostStartup.StartupFailureMessage(new FileNotFoundException("private-path-sentinel"));
        Check(failure.Contains("FileNotFoundException, HRESULT=0x80070002") && !failure.Contains("private-path-sentinel"),
            "startup diagnosis includes an error code without the exception message");
        var nativeFailure = HostStartup.StartupFailureMessage(new System.ComponentModel.Win32Exception(5, "private-path-sentinel"));
        Check(nativeFailure.Contains("Win32Exception, HRESULT=0x") && nativeFailure.Contains("Win32=5")
            && !nativeFailure.Contains("private-path-sentinel"), "startup diagnosis retains the native code without private content");
        var data = Path.Combine(Path.GetTempPath(), "cu-startup-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new HostStartupStore(data);
            Check(store.Read() is null, "missing startup state permits a first launch");
            var missingData = Path.Combine(data, "not-created");
            Check(new HostStartupStore(missingData, readOnly: true).Read() is null && !Directory.Exists(missingData),
                "read-only startup permits a first launch without creating its data directory");
            store.Write("paused", blocked: true);
            var paused = store.Read()!;
            Check(HostStartup.BlockingCode(paused, sameLiveProcess: false) == "paused", "pause blocks cold start after host exit");
            store.Write("stopped", blocked: true);
            Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: false) == "stopped", "emergency stop blocks cold start after host exit");
            store.Write("failed", blocked: false);
            Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: true) == "failed", "live failed host requires local restart");
            Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: true, recoverFault: true) is null,
                "explicit recovery permits a fault without changing normal startup policy");
            Check(HostStartup.BlockingCode(paused, sameLiveProcess: true, recoverFault: true) == "paused"
                && HostStartup.BlockingCode(paused with { State = "stopped" }, false, recoverFault: true) == "stopped"
                && HostStartup.BlockingCode(paused with { State = "failed" }, true, recoverFault: true) == "stopped",
                "fault recovery cannot bypass live or persisted user holds even after a subsequent failure");
            Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: false) is null, "dead failed host does not permanently block launch");
            store.Write("exited", blocked: false);
            Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: false) is null, "normal exit permits cold start");
            var recoveryTime = DateTimeOffset.UtcNow;
            Check(HostRecoveryBudget.TryConsume(data, recoveryTime) && HostRecoveryBudget.TryConsume(data, recoveryTime)
                && HostRecoveryBudget.TryConsume(data, recoveryTime) && !HostRecoveryBudget.TryConsume(data, recoveryTime),
                "automatic recovery is limited to three attempts per minute across store instances");
            Check(!HostRecoveryBudget.TryConsume(data, recoveryTime.AddSeconds(-1))
                && HostRecoveryBudget.TryConsume(data, recoveryTime.AddSeconds(60)),
                "a backward clock cannot reset recovery allowance and the cooldown expires");
            var statePath = Path.Combine(data, "host-state.json");
            Check(PrivateData.FileLockName(statePath).StartsWith(@"Global\ComputerUse.PrivateData.")
                && PrivateData.FileLockName(statePath) == PrivateData.FileLockName(statePath.ToUpperInvariant()),
                "private state lock is global and normalizes Windows path casing");
            var beforeAccess = new DirectoryInfo(data).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)
                .GetSecurityDescriptorBinaryForm();
            using (var busyTemporary = new FileStream(Path.Combine(data, "unrelated.tmp"), FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var readOnly = new HostStartupStore(data, readOnly: true);
                Check(readOnly.Read() is { State: "exited" }, "helper reads state without scanning a busy unrelated temporary file");
                var rejectedWrite = false;
                try { readOnly.Write("ready", blocked: false); } catch (InvalidOperationException) { rejectedWrite = true; }
                Check(rejectedWrite, "read-only startup cannot change a persisted stop");
            }
            Check(beforeAccess.SequenceEqual(new DirectoryInfo(data).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)
                .GetSecurityDescriptorBinaryForm()), "read-only startup preserves the data directory ACL");
            using (var publishing = new FileStream(statePath, FileMode.Open, FileAccess.ReadWrite,
                FileShare.ReadWrite | FileShare.Delete))
            using (var reader = PrivateData.OpenPrivateRead(statePath))
            {
                Check(JsonSerializer.Deserialize<HostStartupState>(reader, new JsonSerializerOptions(JsonSerializerDefaults.Web))
                    is { State: "exited", AutoStartBlocked: false },
                    "a reader shares the destination access held during atomic publication");
            }
            using (var reader = PrivateData.OpenPrivateRead(statePath))
            {
                // Exercise both ACL maintenance and the writer's owner check
                // while the same reader used by startup discovery stays open.
                PrivateData.EnsureDirectory(data);
                store.Write("stopped", blocked: true);
                var beforeReplace = JsonSerializer.Deserialize<HostStartupState>(reader, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                Check(beforeReplace is { State: "exited", AutoStartBlocked: false },
                    "an open reader retains the complete old startup state after atomic replacement");
                Check(store.Read() is { State: "stopped", AutoStartBlocked: true },
                    "ACL checks and atomic replacement publish the stop while another reader is open");
            }
            var writer = Task.Run(() =>
            {
                for (var index = 0; index < 250; index++) store.Write(index % 2 == 0 ? "paused" : "stopped", blocked: true);
            });
            var reading = Task.Run(() =>
            {
                for (var index = 0; index < 1_000 || !writer.IsCompleted; index++)
                {
                    var observed = store.Read();
                    Check(observed is { State: "paused" or "stopped", AutoStartBlocked: true },
                        $"concurrent publication exposes a complete blocked state (state={observed?.State ?? "absent"}, blocked={observed?.AutoStartBlocked})");
                }
            });
            Task.WhenAll(writer, reading).GetAwaiter().GetResult();
            using (var held = new ManualResetEventSlim())
            using (var release = new ManualResetEventSlim())
            {
                var holding = Task.Run(() =>
                {
                    using var mutex = new Mutex(false, PrivateData.FileLockName(statePath));
                    mutex.WaitOne();
                    try { held.Set(); release.Wait(); }
                    finally { mutex.ReleaseMutex(); }
                });
                try
                {
                    Check(held.Wait(TimeSpan.FromSeconds(5)), "test owns the private state lock");
                    var timedOut = false;
                    try { _ = store.Read(); }
                    catch (IOException error) when (error.HResult == unchecked((int)0x800705B4)) { timedOut = true; }
                    Check(timedOut, "private state lock timeout fails explicitly instead of treating state as absent");
                }
                finally { release.Set(); holding.GetAwaiter().GetResult(); }
            }
            const string executable = @"C:\Apps\ComputerUse.WindowsHost.exe";
            Check(HostStartup.MatchesProcess(paused, paused.ProcessId, paused.ProcessStartTimeUtcTicks, paused.SessionId,
                executable, executable.ToLowerInvariant()), "Windows executable identity is case insensitive");
            Check(!HostStartup.MatchesProcess(paused, paused.ProcessId, paused.ProcessStartTimeUtcTicks + 1, paused.SessionId,
                executable, executable), "reused PID cannot validate stale startup state");
            Check(!HostStartup.MatchesProcess(paused, paused.ProcessId + 1, paused.ProcessStartTimeUtcTicks, paused.SessionId,
                executable, executable), "different PID cannot validate ready state");
            Check(!HostStartup.MatchesProcess(paused, paused.ProcessId, paused.ProcessStartTimeUtcTicks, paused.SessionId + 1,
                executable, executable), "another Windows session cannot validate ready state");
            Check(!HostStartup.MatchesProcess(paused, paused.ProcessId, paused.ProcessStartTimeUtcTicks, paused.SessionId,
                executable, @"C:\Other\ComputerUse.WindowsHost.exe"), "another executable cannot validate ready state");
            File.WriteAllText(statePath, "{}");
            var rejected = false;
            try { _ = store.Read(); } catch (IOException) { rejected = true; }
            Check(rejected, "invalid state fails closed instead of clearing a stop");
        }
        finally { Directory.Delete(data, recursive: true); }
        Console.WriteLine("PASS: Windows startup state identity and persistence");
    }

    private static void CheckStartupLifecycle()
    {
        foreach (var pause in new[] { true, false })
        {
            var data = Path.Combine(Path.GetTempPath(), "cu-startup-lifecycle-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (var host = new HostApplication(showWindow: false, dataDirectory: data))
                {
                    Pump();
                    var runtime = HostRuntime.Last!;
                    var store = new HostStartupStore(data);
                    Check(store.Read()!.State == "ready", "completed startup publishes ready");
                    if (pause) host.TogglePauseAsync().GetAwaiter().GetResult();
                    else host.EmergencyStopAsync().GetAwaiter().GetResult();
                    runtime.Emit(new { @event = "ready" });
                    Pump();
                    Check(pause ? host.IsPaused : !host.IsRunning, "late worker ready cannot undo pause or stop");
                    Invoke(host, "ExitAsync").GetAwaiter().GetResult();
                    Check(HostStartup.BlockingCode(store.Read(), sameLiveProcess: false) == (pause ? "paused" : "stopped"),
                        "exit preserves the earlier user block");
                }
                foreach (var showWindow in new[] { false, true })
                {
                    var starts = HostRuntime.StartCount;
                    using var reopened = new HostApplication(showWindow: showWindow, dataDirectory: data);
                    Pump();
                    var window = (SettingsForm)Field(reopened, "_window")!;
                    window.ShowPage(SettingsPage.Status);
                    Event(reopened, new { @event = "ready" });
                    Pump();
                    Check(!reopened.IsRunning && reopened.IsPaused == pause && HostRuntime.StartCount == starts
                        && HostStartup.BlockingCode(new HostStartupStore(data).Read(), sameLiveProcess: false) == (pause ? "paused" : "stopped"),
                        "manual, background/login/update and existing-window opens preserve the user block without starting a worker");
                    Check(ControlField<Button>(window, "_pause").Enabled == pause
                        && ControlField<Button>(window, "_restart").Enabled, "persisted block exposes the appropriate local recovery controls");
                    Invoke(reopened, "ExitAsync").GetAwaiter().GetResult();
                }
                using (var recovered = new HostApplication(showWindow: false, dataDirectory: data))
                {
                    Pump();
                    if (pause) recovered.TogglePauseAsync().GetAwaiter().GetResult();
                    else recovered.RestartServicesAsync().GetAwaiter().GetResult();
                    Pump();
                    Check(recovered.IsRunning && !recovered.IsPaused
                        && new HostStartupStore(data).Read() is { State: "ready", AutoStartBlocked: false },
                        "only the local Resume or Restart action clears a persisted user block");
                    Invoke(recovered, "ExitAsync").GetAwaiter().GetResult();
                }
            }
            finally { Directory.Delete(data, recursive: true); }
        }
        var raceData = Path.Combine(Path.GetTempPath(), "cu-startup-race-" + Guid.NewGuid().ToString("N"));
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        HostRuntime.NextStart = gate.Task;
        try
        {
            using var host = new HostApplication(showWindow: false, dataDirectory: raceData);
            Pump();
            var runtime = HostRuntime.Last!;
            runtime.Emit(new { @event = "ready" });
            Pump();
            Check(!host.IsRunning && new HostStartupStore(raceData).Read()!.State == "starting",
                "worker ready cannot publish readiness before full runtime startup");
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            Check(new HostStartupStore(raceData).Read() is { State: "stopped", AutoStartBlocked: true },
                "emergency stop persists while startup is still pending");
            gate.SetResult();
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (host.IsBusy && DateTime.UtcNow < deadline) Pump();
            Check(!host.IsBusy && !host.IsRunning && new HostStartupStore(raceData).Read() is { State: "stopped", AutoStartBlocked: true },
                "completion after emergency stop never publishes ready");
            host.RestartServicesAsync().GetAwaiter().GetResult();
            runtime.Emit(new { @event = "ready" });
            Pump();
            Check(host.IsRunning && !host.IsPaused && new HostStartupStore(raceData).Read() is { State: "ready", AutoStartBlocked: false },
                "local restart recovers and ignores an old runtime's ready event");
            host.TogglePauseAsync().GetAwaiter().GetResult();
            var controlGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HostRuntime.NextControl = controlGate.Task;
            var resuming = host.TogglePauseAsync();
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            controlGate.SetResult();
            AwaitUi(resuming);
            Check(!host.IsRunning && host.ServiceStatus == L10n.T(Msg.StatusEmergencyStopped)
                && new HostStartupStore(raceData).Read() is { State: "stopped", AutoStartBlocked: true },
                "a late Resume control completion cannot overwrite emergency stop or its visible state");
            host.RestartServicesAsync().GetAwaiter().GetResult();
            var disposeGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HostRuntime.NextDispose = disposeGate.Task;
            var starts = HostRuntime.StartCount;
            var restarting = host.RestartServicesAsync();
            Check(host.IsBusy, "restart waits for disposal before launching another worker");
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            disposeGate.SetResult();
            deadline = DateTime.UtcNow.AddSeconds(5);
            while (!restarting.IsCompleted && DateTime.UtcNow < deadline) Pump();
            Check(restarting.IsCompleted, "restart disposal completes");
            restarting.GetAwaiter().GetResult();
            Check(!host.IsRunning && HostRuntime.StartCount == starts
                && new HostStartupStore(raceData).Read() is { State: "stopped", AutoStartBlocked: true },
                "emergency stop during restart wins without starting a replacement");
            Invoke(host, "ExitAsync").GetAwaiter().GetResult();
            Check(HostStartup.BlockingCode(new HostStartupStore(raceData).Read(), sameLiveProcess: false) == "stopped",
                "emergency stop during restart remains blocked across exit");
        }
        finally
        {
            HostRuntime.NextStart = null;
            HostRuntime.NextDispose = null;
            HostRuntime.NextControl = null;
            Directory.Delete(raceData, recursive: true);
        }
        Console.WriteLine("PASS: Windows startup lifecycle, late ready, and stop during startup");
    }

    private static void CheckFaultRecovery()
    {
        var data = Path.Combine(Path.GetTempPath(), "cu-fault-recovery-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var host = new HostApplication(showWindow: false, dataDirectory: data);
            Pump();
            var store = new HostStartupStore(data);
            var starts = HostRuntime.StartCount;
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(HostRuntime.StartCount == starts, "recovery on a ready host is a no-op");
            host.TogglePauseAsync().GetAwaiter().GetResult();
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(host.IsPaused && store.Read() is { State: "paused", AutoStartBlocked: true }
                && HostRuntime.StartCount == starts, "remote fault recovery cannot resume a user pause");
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(!host.IsRunning && store.Read() is { State: "stopped", AutoStartBlocked: true }
                && HostRuntime.StartCount == starts, "remote fault recovery cannot clear emergency stop");

            host.RestartServicesAsync().GetAwaiter().GetResult();
            host.RevokeAsync("revoked-client").GetAwaiter().GetResult();
            var commands = HostRuntime.Commands.ToArray();
            var old = HostRuntime.Last!;
            starts = HostRuntime.StartCount;
            var disposal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HostRuntime.NextDispose = disposal.Task;
            old.Emit(new { @event = "fatal", message = "uncertain action" });
            Pump();
            var recovering = Invoke(host, "RecoverFaultAsync");
            var duplicate = Invoke(host, "RecoverFaultAsync");
            Check(!recovering.IsCompleted && duplicate.IsCompleted && host.IsBusy && HostRuntime.StartCount == starts,
                "concurrent recovery waits for retiring worker disposal without a duplicate start");
            disposal.SetResult();
            AwaitUi(recovering);
            old.Emit(new { @event = "fatal", message = "late old worker event" });
            old.Emit(new { @event = "ready" });
            Pump();
            Check(host.IsRunning && HostRuntime.StartCount == starts + 1
                && store.Read() is { State: "ready", AutoStartBlocked: false },
                "fault recovery starts one replacement and ignores old worker events");
            Check(commands.SequenceEqual(HostRuntime.Commands),
                "recovery sends no action, authorization, resume, or approval command after revocation");

            starts = HostRuntime.StartCount;
            disposal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HostRuntime.NextDispose = disposal.Task;
            HostRuntime.Last!.Emit(new { @event = "fatal", message = "uncertain action" });
            Pump();
            recovering = Invoke(host, "RecoverFaultAsync");
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            disposal.SetResult();
            AwaitUi(recovering);
            Check(!host.IsRunning && HostRuntime.StartCount == starts && store.Read() is { State: "stopped", AutoStartBlocked: true },
                "emergency stop during retiring-worker wait cancels recovery and remains persisted");

            host.RestartServicesAsync().GetAwaiter().GetResult();
            starts = HostRuntime.StartCount;
            HostRuntime.NextDispose = Task.FromException(new IOException("worker did not exit"));
            HostRuntime.Last!.Emit(new { @event = "fatal", message = "uncertain teardown" });
            Pump();
            Check(Field(host, "_retiringRuntime") is not null && !host.IsRunning,
                "failed disposal retains the old runtime rather than declaring its processes gone");
            HostRuntime.NextDispose = Task.FromException(new IOException("worker still alive"));
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(HostRuntime.StartCount == starts && Field(host, "_retiringRuntime") is not null,
                "recovery cannot start while the old worker exit remains unconfirmed");
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(host.IsRunning && HostRuntime.StartCount == starts + 1,
                "a later recovery may start only after old worker disposal is confirmed");

            HostRuntime.Last!.Emit(new { @event = "fatal", message = "startup stop race" });
            Pump();
            var starting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HostRuntime.NextStart = starting.Task;
            recovering = Invoke(host, "RecoverFaultAsync");
            Check(host.IsBusy && !host.IsRunning, "replacement startup is pending");
            host.EmergencyStopAsync().GetAwaiter().GetResult();
            starting.SetResult();
            AwaitUi(recovering);
            Check(!host.IsRunning && store.Read() is { State: "stopped", AutoStartBlocked: true },
                "late replacement ready cannot overwrite emergency stop during recovery");
            Invoke(host, "ExitAsync").GetAwaiter().GetResult();
            Invoke(host, "RecoverFaultAsync").GetAwaiter().GetResult();
            Check(!host.IsRunning && store.Read() is { State: "stopped", AutoStartBlocked: true },
                "an exiting GUI cannot recover or clear its persisted stop");
        }
        finally
        {
            HostRuntime.NextStart = null;
            HostRuntime.NextDispose = null;
            HostRuntime.NextControl = null;
            Directory.Delete(data, recursive: true);
        }
        Console.WriteLine("PASS: generic fault recovery, concurrency, old-worker exit, no replay and user-stop precedence");
    }

    private static void CheckAuthorizationLifecycle(HostApplication host)
    {
        Request(host, "one");
        Request(host, "queued");
        Check(Dialog(host)?.RequestId == "one", "first prompt visible");
        Finish(host, "queued", false);
        Finish(host, "one", false);
        Check(Dialog(host) is null, "active and queued expired prompts removed");
        Check(Status(host) != L10n.T(Msg.StatusApproved), "expiry does not show success");

        Request(host, "late");
        ClickAllow(host);
        Check(Status(host) == L10n.T(Msg.StatusDecisionSent), "pipe write is not approval");
        Check(HostRuntime.Commands.Last() == "foreground_allow:late", "one decision sent");
        Check(HostRuntime.AllAppsAcknowledgments.Last() is null, "foreground decisions do not acknowledge all-app pairing");
        Finish(host, "late", false);
        Check(Status(host) == L10n.T(Msg.StatusRequestInvalid), "late approval reported as invalid");

        Request(host, "accepted");
        ClickAllow(host);
        Finish(host, "accepted", true);
        Check(Status(host) == L10n.T(Msg.StatusApproved), "only runtime confirmation shows success");
        var count = HostRuntime.Commands.Count;
        Finish(host, "late", false);
        Check(Status(host) == L10n.T(Msg.StatusApproved), "stale result ignored");
        Check(HostRuntime.Commands.Count == count, "completion does not resend a decision");

        Request(host, "stopped");
        Request(host, "also-stopped");
        Invoke(host, "StopAsync", "test stop").GetAwaiter().GetResult();
        Pump();
        Check(Dialog(host) is null, "stop closes prompt");
        Check(HostRuntime.Commands.Count == count, "stop does not approve or deny stale prompts");
        Invoke(host, "StartAsync").GetAwaiter().GetResult();
        Pump();
        Check(Dialog(host) is null, "restart does not restore stale queue");
        Request(host, "default-deny");
        var dialog = Dialog(host)!;
        Check(dialog.AcceptButton == dialog.CancelButton, "default action is denial");
        dialog.Close();
        Pump();
        Check(HostRuntime.Commands.Last() == "foreground_deny:default-deny", "closing denies");

        // Approval grants every requested path, so the dialog must list all of them.
        var paths = Enumerable.Range(1, 25).Select(index => $@"C:\Apps\App{index}.exe").ToArray();
        Event(host, new { @event = "pair_request", clientId = "many-apps", name = "Many apps", appIds = paths, browser = false, foreground = true });
        var text = Dialog(host)?.ExplanationText ?? "";
        Check(text.Contains(L10n.F(Msg.ApprovalPathCount, 25)) && paths.All(text.Contains), "pair dialog lists every requested application");
        Check(Dialog(host)!.ContentViewport.AutoScroll, "long application lists have a scrollable content area");
        CheckApprovalLayout(Dialog(host)!, "many-apps");
        Finish(host, "many-apps", false);
        Check(Dialog(host) is null, "expired pair prompt withdrawn");
        Console.WriteLine("PASS: Windows authorization dialog lifecycle");
    }

    private static void CheckPairingScopes(HostApplication host)
    {
        var chinese = L10n.Chinese;
        try
        {
            foreach (var language in new[] { false, true })
            {
                L10n.Chinese = language;
                Event(host, new
                {
                    @event = "pair_request", clientId = "all-apps", name = "All desktop apps",
                    appIds = Array.Empty<string>(), allApps = true, browser = false, foreground = true
                });
                var dialog = Dialog(host)!;
                var text = dialog.ExplanationText;
                Check(text.Contains(L10n.T(Msg.ApprovalDesktopScope)) && text.Contains(L10n.T(Msg.ClientsAllApps))
                    && text.Contains(L10n.T(Msg.ApprovalAllAppsDetail))
                    && !text.Contains(L10n.F(Msg.ApprovalPathCount, 0)), "all-app pairing explains future apps instead of showing an empty scope");
                Check(text.Contains(L10n.T(Msg.ApprovalBrowser) + "\n" + L10n.T(Msg.ApprovalNotAllowed)),
                    "all-app pairing does not imply browser permission");
                Check(text.Contains(L10n.T(Msg.ApprovalPairBehavior)) && text.Contains(L10n.T(Msg.ApprovalPairLifetime)),
                    "pairing explains background operation and persistent approval in both languages");
                Check(text.Contains(L10n.T(Msg.ApprovalForegroundAllowed)), "pairing includes the requested foreground permission");
                Check(dialog.AcceptButton == dialog.DenyButton && dialog.CancelButton == dialog.DenyButton,
                    "all-app pairing still defaults to denial");
                Check(Descendants(dialog).OfType<TextBox>().All(control => control.ReadOnly), "approval text cannot be edited");
                CheckApprovalLayout(dialog, language ? "zh-all-apps" : "en-all-apps");
                ClickAllow(host);
                Check(HostRuntime.Commands.Last() == "pair_allow:all-apps" && Status(host) == L10n.T(Msg.StatusDecisionSent),
                    "all-app pairing waits for the runtime to confirm the decision");
                Check(HostRuntime.AllAppsAcknowledgments.Last() == true, "all-app approval explicitly acknowledges the displayed scope");
                Finish(host, "all-apps", true);
                Check(Status(host) == L10n.T(Msg.StatusApproved), "runtime confirmation completes all-app pairing");

                Event(host, new
                {
                    @event = "pair_request", clientId = "browser-only", name = "Browser only",
                    appIds = Array.Empty<string>(), browser = true, foreground = false
                });
                text = Dialog(host)!.ExplanationText;
                Check(text.Contains(L10n.F(Msg.ApprovalPathCount, 0)) && !text.Contains(L10n.T(Msg.ApprovalAllAppsDetail)),
                    "missing allApps keeps a browser-only request free of desktop permission");
                Check(text.Contains(L10n.T(Msg.ApprovalBrowser) + "\n" + L10n.T(Msg.ApprovalAllowed))
                    && text.Contains(L10n.T(Msg.ApprovalForeground) + "\n" + L10n.T(Msg.ApprovalNotAllowed)),
                    "browser and foreground permissions remain separate");
                ClickAllow(host);
                Check(HostRuntime.Commands.Last() == "pair_allow:browser-only" && HostRuntime.AllAppsAcknowledgments.Last() is null,
                    "legacy limited-scope approval does not send an all-app acknowledgment");
                Finish(host, "browser-only", false);
            }
        }
        finally { L10n.Chinese = chinese; }
        Console.WriteLine("PASS: Windows pairing scopes");
    }

    private static void CheckSettingsWindow(HostApplication host)
    {
        var window = (SettingsForm)Field(host, "_window")!;
        var titles = window.PageTitles;
        var expected = new[] { Msg.PaneGeneral, Msg.PaneStatus, Msg.PaneClients, Msg.PaneConnect, Msg.PaneUpdates, Msg.PaneAbout }.Select(L10n.T);
        Check(titles.SequenceEqual(expected), "settings window has the six pages in order");
        Check(!Descendants(window).OfType<TabControl>().Any(), "settings use sidebar navigation rather than tabs");
        foreach (var page in Enum.GetValues<SettingsPage>())
        {
            var title = window.PageTitles[(int)page];
            Descendants(window).OfType<Button>().Single(button => button.AccessibleName == title || button.Text == title).PerformClick();
            Pump();
            Check(window.SelectedPage == page, $"sidebar navigation selects {page}");
        }
        window.ShowPage(SettingsPage.Clients);
        Pump();
        var revoke = ControlField<Button>(window, "_revoke");
        Check(!revoke.Enabled, "revoke is disabled without a selected client");
        var allAppsClient = new { id = "c", name = "All apps", appIds = Array.Empty<string>(), allApps = true, browser = false, foreground = true };
        var clients = new object[]
        {
            new { id = "a", name = "Codex", appIds = new[] { @"win32:c:\apps\fixture&tool.exe" }, browser = false, foreground = true },
            new { id = "b", name = "Legacy" },
            allAppsClient,
            new { id = "d", name = "Browser", appIds = Array.Empty<string>(), allApps = false, browser = true, foreground = false },
        };
        Event(host, new { @event = "clients", clients });
        var items = window.ClientList.Items.Cast<ListViewItem>().ToArray();
        Check(items.Length == 4 && window.ClientList.Columns.Count == 4, "client list shows every paired client with the four scope columns");
        Check(items[0].SubItems[1].Text == @"c:\apps\fixture&tool.exe" && items[0].SubItems[3].Text == L10n.T(Msg.ClientsYes),
            "client list shows the authorized paths without the internal prefix");
        Check(items[1].SubItems[1].Text == L10n.T(Msg.ClientsNo), "older runtimes without grant fields still list the client");
        Check(host.Clients.Select(client => client.AllApps).SequenceEqual(new[] { false, false, true, false }),
            "only an explicit allApps grant is parsed as all desktop apps");
        Check(items[2].SubItems[1].Text == L10n.T(Msg.ClientsAllApps) && items[2].SubItems[2].Text == L10n.T(Msg.ClientsNo),
            "client list shows all desktop apps without granting browser access");
        Check(items[3].SubItems[1].Text == L10n.T(Msg.ClientsNo) && items[3].SubItems[2].Text == L10n.T(Msg.ClientsYes),
            "browser-only clients still have no desktop apps");
        items[0].Selected = true;
        Pump();
        var scope = ControlField<Label>(window, "_clientScope");
        Check(scope.Text == @"c:\apps\fixture&tool.exe" && !scope.UseMnemonic,
            "selected application paths display ampersands literally rather than as shortcut markers");
        items[2].Selected = true;
        Pump();
        Check(revoke.Enabled, "selecting one client enables revocation");
        clients[2] = new { id = "c", name = "All apps", appIds = Array.Empty<string>(), allApps = false, browser = false, foreground = true };
        Event(host, new { @event = "clients", clients });
        Check(window.ClientList.Items[2].SubItems[1].Text == L10n.T(Msg.ClientsNo), "scope-only changes refresh the client list");
        Check(window.ClientList.SelectedItems.Count == 1 && (string?)window.ClientList.SelectedItems[0].Tag == "c" && revoke.Enabled,
            "scope refresh preserves the selected client identity");
        Event(host, new { @event = "clients", clients = clients.Where((_, index) => index != 2).ToArray() });
        Check(window.ClientList.SelectedItems.Count == 0 && !revoke.Enabled, "removing the selected client disables revocation");
        clients[2] = allAppsClient;
        Event(host, new { @event = "clients", clients });
        Event(host, new { @event = "status", message = "Local MCP: http://127.0.0.1:47631/mcp" });
        Check(host.HttpStatus == "Local MCP: http://127.0.0.1:47631/mcp" && host.ServiceStatus != host.HttpStatus,
            "HTTP listener status goes to the Connect page, not the service status");
        window.ShowPage(SettingsPage.Connect);
        Check(ControlField<TextBox>(window, "_pairCommand").Text == SettingsForm.PairCommand(host.PackageRoot)
            && ControlField<TextBox>(window, "_pairCommand").ReadOnly,
            "Connect displays the generated pairing command as read-only text");
        Console.WriteLine("PASS: Windows settings window");
    }

    private static void CheckGrantAllApps(HostApplication host)
    {
        var clients = new object[]
        {
            new { id = "grant-scoped", name = "Scoped fixture", appIds = new[] { @"win32:c:\fixture.exe" }, allApps = false, browser = true, foreground = false },
            new { id = "grant-foreground", name = "Legacy all apps", appIds = Array.Empty<string>(), allApps = true, browser = false, foreground = false },
            new { id = "grant-browser", name = "Browser fixture", appIds = Array.Empty<string>(), allApps = false, browser = true, foreground = true },
            new { id = "grant-complete", name = "Complete fixture", appIds = Array.Empty<string>(), allApps = true, browser = false, foreground = true },
        };
        Event(host, new { @event = "clients", clients });
        var confirmed = false;
        var confirmations = 0;
        using var window = new SettingsForm(host, confirmGrant: (title, body) =>
        {
            confirmations++;
            Check(title.Contains("Scoped fixture") && body == L10n.T(Msg.ClientsGrantBody), "upgrade confirmation identifies the selected client and complete scope");
            return confirmed;
        });
        window.ShowPage(SettingsPage.Clients);
        Pump();
        var button = ControlField<Button>(window, "_grantAllApps");
        void Select(int index)
        {
            foreach (ListViewItem item in window.ClientList.Items) item.Selected = false;
            window.ClientList.Items[index].Selected = true;
            window.RefreshAll();
            Pump();
        }
        Select(2);
        Check(!button.Enabled, "browser-only clients cannot be expanded into desktop clients");
        Select(3);
        Check(!button.Enabled && button.Text == L10n.T(Msg.ClientsGranted), "already complete grants show their status without an action");
        Select(1);
        Check(button.Enabled, "all-app clients missing foreground permission can upgrade");
        Select(0);
        var before = HostRuntime.Commands.Count;
        button.PerformClick(); Pump();
        Check(confirmations == 1 && HostRuntime.Commands.Count == before, "cancelling local confirmation does not send an upgrade command");
        confirmed = true;
        button.PerformClick(); Pump(); window.RefreshAll();
        var id = HostRuntime.RequestIds.Last()!;
        Check(confirmations == 2 && Guid.TryParse(id, out _) && HostRuntime.Commands.Last() == "grant_all_apps:grant-scoped",
            "confirmation sends one correlated internal command with a fresh request UUID");
        Check(host.GrantState("grant-scoped") == ClientGrantState.Pending && !button.Enabled,
            "pipe write is not success and duplicate upgrade is disabled while awaiting persistence");
        host.GrantAllAppsAsync("grant-scoped", host.GrantRevision).GetAwaiter().GetResult();
        Check(HostRuntime.Commands.Count == before + 1, "pending request is not submitted twice");
        object Ack(string requestId, bool ok) => new { @event = "clients", clients,
            operation = new { command = "grant_all_apps", clientId = "grant-scoped", requestId, ok,
                error = ok ? null : new { code = "unavailable", message = "private runtime details must not be displayed" } } };
        Event(host, Ack(Guid.NewGuid().ToString(), true));
        Check(host.GrantState("grant-scoped") == ClientGrantState.Pending, "unrelated acknowledgement cannot complete the current request");
        Event(host, Ack(id, false)); window.RefreshAll();
        Check(host.GrantState("grant-scoped") == ClientGrantState.SaveFailed && button.Enabled
            && ControlField<Label>(window, "_grantFeedback").Text == L10n.T(Msg.ClientsGrantSaveFailed),
            "persist failure is visible without leaking worker error details or changing scope");

        host.TogglePauseAsync().GetAwaiter().GetResult();
        host.GrantAllAppsAsync("grant-scoped", host.GrantRevision).GetAwaiter().GetResult();
        id = HostRuntime.RequestIds.Last()!;
        clients[0] = new { id = "grant-scoped", name = "Scoped fixture", appIds = Array.Empty<string>(), allApps = true, browser = true, foreground = true };
        Event(host, Ack(id, true)); window.RefreshAll();
        Check(host.GrantState("grant-scoped") == ClientGrantState.Succeeded && host.IsPaused
            && host.Clients[0].Browser && !button.Enabled && button.Text == L10n.T(Msg.ClientsGranted),
            "persisted acknowledgement updates the UI while preserving pause and browser permission");
        host.TogglePauseAsync().GetAwaiter().GetResult();

        host.GrantAllAppsAsync("grant-foreground", host.GrantRevision).GetAwaiter().GetResult();
        var timeoutStart = System.Diagnostics.Stopwatch.StartNew();
        while (host.GrantState("grant-foreground") == ClientGrantState.Pending && timeoutStart.Elapsed < TimeSpan.FromSeconds(18))
        { Pump(); Thread.Sleep(20); }
        Check(host.GrantState("grant-foreground") == ClientGrantState.Unconfirmed && timeoutStart.Elapsed >= TimeSpan.FromSeconds(14),
            "missing persistence acknowledgement becomes unconfirmed after the bounded 15-second wait");
        var timeoutId = HostRuntime.RequestIds.Last()!;
        Event(host, new { @event = "clients", clients, operation = new { command = "grant_all_apps", clientId = "grant-foreground", requestId = timeoutId, ok = true } });
        Check(host.GrantState("grant-foreground") == ClientGrantState.Unconfirmed, "late acknowledgement after timeout cannot claim success");

        HostRuntime.NextControl = Task.FromException(new IOException("write failed"));
        host.GrantAllAppsAsync("grant-foreground", host.GrantRevision).GetAwaiter().GetResult();
        Check(host.GrantState("grant-foreground") == ClientGrantState.Unconfirmed && host.IsRunning,
            "a failed pipe write is unconfirmed and does not restart the service or replay the mutation");
        host.GrantAllAppsAsync("grant-foreground", host.GrantRevision).GetAwaiter().GetResult();
        var old = HostRuntime.Last!;
        var oldId = HostRuntime.RequestIds.Last()!;
        var oldRevision = host.GrantRevision;
        host.RestartServicesAsync().GetAwaiter().GetResult(); Pump();
        old.Emit(new { @event = "clients", clients, operation = new { command = "grant_all_apps", clientId = "grant-foreground", requestId = oldId, ok = true } });
        Pump();
        Check(host.GrantState("grant-foreground") == ClientGrantState.Idle && host.Clients.Count == 0,
            "restart clears pending grants and rejects late events from the previous runtime");
        Event(host, new { @event = "clients", clients });
        var afterRestart = HostRuntime.Commands.Count;
        host.GrantAllAppsAsync("grant-foreground", oldRevision).GetAwaiter().GetResult();
        Check(HostRuntime.Commands.Count == afterRestart, "confirmation from a previous service generation cannot grant on a new runtime");
        host.GrantAllAppsAsync("grant-foreground", host.GrantRevision).GetAwaiter().GetResult();
        Event(host, new { @event = "clients", clients,
            operation = new { command = "grant_all_apps", clientId = "grant-foreground", requestId = HostRuntime.RequestIds.Last(), ok = false,
                error = new { code = "not_found", message = "opaque internal details" } } });
        Check(host.GrantState("grant-foreground") == ClientGrantState.Missing, "revoked or missing client has a distinct bounded failure state");
        host.GrantAllAppsAsync("grant-foreground", host.GrantRevision).GetAwaiter().GetResult();
        host.EmergencyStopAsync().GetAwaiter().GetResult(); window.RefreshAll();
        Check(host.GrantState("grant-foreground") == ClientGrantState.Idle && !button.Enabled,
            "emergency stop clears pending grants and disables offline authorization");
        host.RestartServicesAsync().GetAwaiter().GetResult(); Pump();
        Console.WriteLine("PASS: local grant upgrade confirmation, persistence ACK, errors, timeout, pause and lifecycle isolation");
    }

    private static void CheckGrantRevocation(HostApplication host)
    {
        object Client(string id, bool complete = false) => new
        {
            id, name = id, appIds = complete ? Array.Empty<string>() : new[] { @"win32:c:\fixture.exe" },
            allApps = complete, browser = true, foreground = complete
        };
        var clients = new[] { Client("revoke-success"), Client("revoke-pending"), Client("revoke-send-failed") };
        object Ack(string clientId, string requestId) => new
        {
            @event = "clients", clients,
            operation = new { command = "grant_all_apps", clientId, requestId, ok = true }
        };
        Event(host, new { @event = "clients", clients });
        using var window = new SettingsForm(host, confirmGrant: (_, _) => true);
        window.ShowPage(SettingsPage.Clients);
        Pump();
        var button = ControlField<Button>(window, "_grantAllApps");
        var feedback = ControlField<Label>(window, "_grantFeedback");
        void Begin(string id)
        {
            foreach (ListViewItem item in window.ClientList.Items) item.Selected = (string?)item.Tag == id;
            window.RefreshAll();
            button.PerformClick(); Pump();
            Check(host.GrantState(id) == ClientGrantState.Pending, "revoke fixture starts a confirmed pending upgrade");
        }
        void CheckRemoved(string id)
        {
            window.RefreshAll(); Pump();
            Check(host.Clients.All(client => client.Id != id) && host.GrantState(id) == ClientGrantState.Idle
                && !feedback.Visible && !button.Enabled,
                "revocation removes the client and clears pending or successful upgrade feedback");
        }

        Begin("revoke-success");
        var successId = HostRuntime.RequestIds.Last()!;
        clients[0] = Client("revoke-success", complete: true);
        Event(host, Ack("revoke-success", successId)); window.RefreshAll();
        Check(feedback.Visible && feedback.Text == L10n.T(Msg.ClientsGrantSucceeded),
            "completed upgrade displays success before revocation");
        host.TogglePauseAsync().GetAwaiter().GetResult();
        host.RevokeAsync("revoke-success").GetAwaiter().GetResult();
        CheckRemoved("revoke-success");
        Event(host, Ack("revoke-success", successId));
        CheckRemoved("revoke-success");
        Check(host.IsRunning && host.IsPaused, "revoking an upgraded client does not resume paused execution");

        Begin("revoke-pending");
        var pendingId = HostRuntime.RequestIds.Last()!;
        var send = new TaskCompletionSource();
        HostRuntime.NextControl = send.Task;
        var revoke = host.RevokeAsync("revoke-pending");
        CheckRemoved("revoke-pending");
        clients[1] = Client("revoke-pending", complete: true);
        Event(host, Ack("revoke-pending", pendingId));
        CheckRemoved("revoke-pending");
        send.SetResult(); Pump(); revoke.GetAwaiter().GetResult();
        Event(host, new { @event = "clients", clients });
        CheckRemoved("revoke-pending");
        Check(host.IsRunning && host.IsPaused, "late grant events during revocation preserve paused execution");
        host.TogglePauseAsync().GetAwaiter().GetResult();

        Begin("revoke-send-failed");
        var failedId = HostRuntime.RequestIds.Last()!;
        var previous = HostRuntime.Last!;
        HostRuntime.NextControl = Task.FromException(new IOException("revoke write failed"));
        host.RevokeAsync("revoke-send-failed").GetAwaiter().GetResult();
        Check(!host.IsRunning, "failed revoke delivery stops the service instead of claiming successful revocation");
        previous.Emit(Ack("revoke-send-failed", failedId)); Pump();
        CheckRemoved("revoke-send-failed");
        host.RestartServicesAsync().GetAwaiter().GetResult(); Pump();
        previous.Emit(Ack("revoke-send-failed", failedId)); Pump();
        Check(host.Clients.Count == 0 && host.GrantState("revoke-send-failed") == ClientGrantState.Idle,
            "restarting rejects stale grant and client events from the retired runtime");
        Event(host, new { @event = "clients", clients = new[] { Client("revoke-send-failed") } });
        Check(host.Clients.Count == 1 && host.Clients[0].Id == "revoke-send-failed" && !host.Clients[0].AllApps,
            "new runtime snapshots determine actual authorization after uncertain revoke delivery");
        Console.WriteLine("PASS: grant revocation clears feedback, rejects late events and handles delivery failure and restart");
    }

    private static void CheckSettingsInteractions(HostApplication host)
    {
        var window = (SettingsForm)Field(host, "_window")!;
        Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) });
        window.ShowPage(SettingsPage.Status);
        Pump();
        var pause = ControlField<Button>(window, "_pause");
        var stop = ControlField<Button>(window, "_stop");
        var restart = ControlField<Button>(window, "_restart");
        Check(pause.AccessibilityObject.Name == pause.Text, "ready button accessibility name matches its visible action");
        CheckDisclosureAccessibility(window, Msg.StatusDiagnostics);
        var commands = HostRuntime.Commands.Count;
        pause.PerformClick();
        Pump();
        Check(host.IsPaused && pause.Text == L10n.T(Msg.TrayResume)
            && HostRuntime.Commands.Skip(commands).SequenceEqual(new[] { "pause:" }),
            "Pause sends one runtime command and changes the next action to Resume");
        Check(pause.AccessibilityObject.Name == pause.Text, "paused button accessibility name changes to Resume with its text");
        pause.PerformClick();
        Pump();
        Check(!host.IsPaused && pause.Text == L10n.T(Msg.TrayPause)
            && HostRuntime.Commands.Skip(commands).SequenceEqual(new[] { "pause:", "resume:" }),
            "Resume sends one runtime command and restores the ready controls");
        Check(pause.AccessibilityObject.Name == pause.Text, "resumed button accessibility name changes back to Pause with its text");

        var starts = HostRuntime.StartCount;
        var disposals = HostRuntime.DisposeCount;
        restart.PerformClick();
        Pump();
        Check(host.IsRunning && HostRuntime.StartCount == starts + 1 && HostRuntime.DisposeCount == disposals + 1,
            "Restart disposes the previous runtime and starts exactly one replacement");

        window.ShowPage(SettingsPage.Connect);
        Pump();
        CheckDisclosureAccessibility(window, Msg.ConnectAdvanced);
        Check(stop.Visible && stop.Enabled, "Emergency Stop stays available away from the Status page");
        stop.PerformClick();
        Pump();
        Check(!host.IsRunning && HostRuntime.DisposeCount == disposals + 2
            && host.ServiceStatus == L10n.T(Msg.StatusEmergencyStopped),
            "Emergency Stop from Connect stops the runtime");
        window.ShowPage(SettingsPage.Status);
        Check(!pause.Enabled && !stop.Enabled && restart.Enabled, "stopped controls offer Restart without Pause or Stop");
        window.ShowPage(SettingsPage.Clients);
        Check(window.ClientList.Items.Count == 0 && !ControlField<Button>(window, "_revoke").Enabled,
            "stopped services cannot revoke a stale selected client");
        window.ShowPage(SettingsPage.Status);
        restart.PerformClick();
        Pump();
        Check(host.IsRunning && HostRuntime.StartCount == starts + 2, "Restart recovers the stopped service");
        Console.WriteLine("PASS: Windows settings control interactions");
    }

    private static void CheckDisclosureAccessibility(SettingsForm window, Msg title)
    {
        var toggle = Descendants(window).OfType<Button>().Single(button => button.Text == L10n.T(title));
        Check(toggle.AccessibilityObject.Name == toggle.Text, "collapsed disclosure accessibility name matches its visible action");
        toggle.PerformClick();
        Pump();
        Check(toggle.Text == L10n.T(Msg.DetailsHide) && toggle.AccessibilityObject.Name == toggle.Text,
            "expanded disclosure accessibility name changes to Hide Details with its text");
        toggle.PerformClick();
        Pump();
        Check(toggle.Text == L10n.T(title) && toggle.AccessibilityObject.Name == toggle.Text,
            "collapsed disclosure restores both the visible and accessible action");
    }

    private static void CheckSettingsLayouts(HostApplication host)
    {
        var chinese = L10n.Chinese;
        try
        {
            foreach (var language in new[] { false, true })
            {
                L10n.Chinese = language;
                Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) });
                using var window = new SettingsForm(host);
                var expected = new[] { Msg.PaneGeneral, Msg.PaneStatus, Msg.PaneClients, Msg.PaneConnect, Msg.PaneUpdates, Msg.PaneAbout }.Select(L10n.T);
                Check(window.PageTitles.SequenceEqual(expected), "sidebar titles match the selected language");
                window.ShowPage(SettingsPage.General);
                Pump();
                var defaultSize = window.Size;
                foreach (var size in new[] { defaultSize, window.MinimumSize })
                {
                    Check(size.Width > 0 && size.Height > 0, "settings define a usable minimum window size");
                    window.Size = size;
                    foreach (var page in Enum.GetValues<SettingsPage>())
                    {
                        window.ShowPage(page);
                        Pump();
                        Check(window.SelectedPage == page, "ShowPage follows the enum order in both languages");
                        CheckHorizontalLayout(window, $"{(language ? "zh" : "en")}/{page}/{size.Width}");
                        Check(FullyWithinWindow(window, ControlField<Button>(window, "_stop")),
                            "Emergency Stop remains fully reachable on every page at the minimum size");
                    }
                }
            }
        }
        finally { L10n.Chinese = chinese; Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) }); }
        Console.WriteLine("PASS: Windows bilingual settings layouts at normal and minimum sizes");
    }

    // Vertical scrolling is intentional; a control must not need horizontal scrolling to be read or used.
    private static void CheckHorizontalLayout(Control root, string context)
    {
        foreach (var control in Descendants(root).Where(control => control.Visible
            && (control is Label or Button or CheckBox or TextBox or ComboBox or ListView)))
        {
            if (control.Parent is not { } parent) continue;
            Check(control.Left >= -1 && control.Right <= parent.ClientSize.Width + 1,
                $"{context}: {control.GetType().Name} '{control.AccessibleName ?? control.Text}' fits its content width");
        }
    }

    private static void CheckApprovalLayout(ApprovalDialog dialog, string context)
    {
        var originalSize = dialog.Size;
        try
        {
            foreach (var size in new[] { originalSize, dialog.MinimumSize })
            {
                dialog.Size = size;
                Pump();
                CheckHorizontalLayout(dialog, context);
                Check(dialog.AllowButton.Visible && dialog.DenyButton.Visible
                    && !Descendants(dialog.ContentViewport).Contains(dialog.AllowButton)
                    && !Descendants(dialog.ContentViewport).Contains(dialog.DenyButton)
                    && FullyWithinWindow(dialog, dialog.AllowButton) && FullyWithinWindow(dialog, dialog.DenyButton),
                    "approval decision buttons stay outside the scrolling scope details");
                var allowPosition = dialog.AllowButton.PointToScreen(Point.Empty);
                var denyPosition = dialog.DenyButton.PointToScreen(Point.Empty);
                dialog.ContentViewport.AutoScrollPosition = new Point(0, dialog.ContentViewport.VerticalScroll.Maximum);
                Pump();
                Check(dialog.AllowButton.PointToScreen(Point.Empty) == allowPosition
                    && dialog.DenyButton.PointToScreen(Point.Empty) == denyPosition,
                    "scrolling long approval text keeps both decisions reachable");
                dialog.ContentViewport.AutoScrollPosition = Point.Empty;
            }
        }
        finally { dialog.Size = originalSize; Pump(); }
    }

    private static void CheckTranslations()
    {
        var placeholder = new Regex(@"\{(\d+)\}");
        foreach (var key in Enum.GetValues<Msg>())
        {
            Check(L10n.Zh.TryGetValue(key, out var chinese) && chinese.Length > 0, $"Chinese text for {key}");
            Check(L10n.En.TryGetValue(key, out var english) && english.Length > 0, $"English text for {key}");
            var a = placeholder.Matches(chinese!).Select(match => match.Value).Order().ToArray();
            var b = placeholder.Matches(english!).Select(match => match.Value).Order().ToArray();
            Check(a.SequenceEqual(b), $"placeholders match for {key}");
            var values = Enumerable.Range(0, 8).Select(index => (object)index).ToArray();
            _ = string.Format(chinese!, values);
            _ = string.Format(english!, values);
        }
        Check(L10n.Zh.Count == Enum.GetValues<Msg>().Length && L10n.En.Count == L10n.Zh.Count, "no stray translations");
        Console.WriteLine("PASS: Windows translations");
    }

    private static void CheckHelpers()
    {
        Check(ReleaseVersion.Compare("0.10.0", "0.9.9") == 1 && ReleaseVersion.Compare("1.0.0", "1.0.0") == 0, "versions compare numerically");
        Check(ReleaseVersion.Compare("0.5.0-beta.1", "0.4.0") is null && ReleaseVersion.Compare("01.0.0", "1.0.0") is null, "only plain versions compare");
        var now = DateTimeOffset.UtcNow;
        Check(UpdateService.IsDue(null, now) && !UpdateService.IsDue(now.AddHours(-1), now) && UpdateService.IsDue(now.AddHours(-24), now)
            && UpdateService.IsDue(now.AddDays(3), now), "automatic checks run daily and after clock changes");
        Check(new UpdateFailure("unavailable", "GitHub rate limit reached; try again later.").Describe() == L10n.T(Msg.UpdateErrorRateLimit), "rate limit localized");
        Check(new UpdateFailure("timeout", "x").Describe() == L10n.T(Msg.UpdateErrorTimeout), "timeout localized");
        Check(new UpdateFailure("unavailable", "Odd.").Describe() == L10n.F(Msg.UpdateErrorGeneric, "Odd."), "unknown errors keep their detail");
        Check(LaunchAtLogin.Command(@"C:\A B\host.exe") == "\"C:\\A B\\host.exe\" --background", "startup command quotes the path");
        Check(LaunchAtLogin.RegisteredExecutable("\"C:\\A B\\host.exe\" --background") == @"C:\A B\host.exe"
            && LaunchAtLogin.RegisteredExecutable(@"C:\host.exe --background") == @"C:\host.exe"
            && LaunchAtLogin.RegisteredExecutable(null) is null, "startup command path is recovered");
        Check(SettingsForm.DisplayAppId(@"win32:c:\a.exe") == @"c:\a.exe" && SettingsForm.DisplayAppId("other") == "other", "app ids display as paths");
        Check(SettingsForm.HttpAddress("Local MCP: http://127.0.0.1:47631/mcp") == "http://127.0.0.1:47631/mcp"
            && SettingsForm.HttpAddress("HTTP listener could not start; check port 47631.") is null, "HTTP address parsed");
        Check(SettingsForm.Readable("## Computer Use v0.5.0\n\n- **新增**：设置") == "Computer Use v0.5.0\n\n- 新增：设置", "release notes read as text");
        using var config = JsonDocument.Parse(SettingsForm.StdioConfiguration(@"C:\Portable"));
        var server = config.RootElement.GetProperty("mcpServers").GetProperty("computer-use");
        Check(server.GetProperty("command").GetString() == @"C:\Portable\bin\node.exe"
            && server.GetProperty("args").EnumerateArray().Select(value => value.GetString()).SequenceEqual(new[] { @"C:\Portable\runtime\cli.js", "mcp", "stdio", "--profile", "default" }),
            "stdio configuration uses the bundled node and CLI");
        var pair = SettingsForm.PairCommand(@"C:\Portable");
        Check(SettingsForm.CliCommand(@"C:\O'Brien\$tools`") ==
            @"& 'C:\O''Brien\$tools`\bin\node.exe' 'C:\O''Brien\$tools`\runtime\cli.js'",
            "copied PowerShell commands preserve apostrophes, dollar signs and backticks in installation paths");
        Check(pair.StartsWith(SettingsForm.CliCommand(@"C:\Portable") + " pair ", StringComparison.Ordinal)
            && pair.Contains("--name", StringComparison.Ordinal) && !pair.Contains("--app", StringComparison.Ordinal)
            && pair.EndsWith("--profile 'default'", StringComparison.Ordinal),
            "pairing and stdio share the default profile and bundled CLI without restricting applications");
        var check = JsonSerializer.Deserialize<UpdateCheck>("""
            {"current":"0.4.0","latest":"0.5.0","available":true,"platform":"windows-arm64","tag":"v0.5.0",
             "url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0","notes":"n",
             "asset":{"name":"computer-use-0.5.0-windows-arm64.zip","size":10,"sha256":"ab"}}
            """, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Check(check.Latest == "0.5.0" && check.Asset?.Size == 10 && check.ReleasePage is not null && check.Installer is null,
            "update check output parsed; releases before 0.6.0 have no installer");
        Check((check with { Url = "https://example.com/x" }).ReleasePage is null, "only the project's release page opens");
        Check(InstallerCheck().Installer is { Name: "computer-use-0.6.0-windows-arm64-setup.exe", Size: 20, Sha256: "cd" },
            "update check output includes the installer");
        Check(new UpdateFailure("not_found", "The latest release has no installer for windows-arm64.").Describe() == L10n.T(Msg.UpdateErrorNoPackage),
            "missing installer localized");
        Check(UpdateService.IsInstalledAt(@"C:\Users\A\AppData\Local\Programs\Computer Use\", @"c:\users\a\appdata\local\programs\computer use")
            && UpdateService.IsInstalledAt("\"C:\\Apps\\Computer Use\"", @"C:\Apps\Computer Use\"), "installed copy recognized by its registered location");
        Check(!UpdateService.IsInstalledAt(null, @"C:\Apps\Computer Use") && !UpdateService.IsInstalledAt(" ", @"C:\Apps\Computer Use")
            && !UpdateService.IsInstalledAt(@"C:\Apps\Computer Use", @"C:\Portable\Computer Use")
            && !UpdateService.IsInstalledAt(@"C:\Apps\Computer Use", @"C:\Apps\Computer Use Old"), "other folders are portable copies");
        Console.WriteLine("PASS: Windows update and settings helpers");
    }

    /// <summary>安装程序登记的位置就是这个目录：读取真实的卸载登记，换成别的目录则不算安装版。</summary>
    private static void CheckInstalled(string directory)
    {
        var registered = UpdateService.RegisteredInstallLocation();
        Console.WriteLine($"registered install location: {registered}");
        Check(UpdateService.IsInstalledAt(registered, directory), "the registered install location is the installed folder");
        Check(!UpdateService.IsInstalledAt(registered, Path.Combine(directory, "other")), "another folder is not an installed copy");
        Console.WriteLine("PASS: installed copy recognized from the uninstall registration");
    }

    private static UpdateCheck InstallerCheck() => JsonSerializer.Deserialize<UpdateCheck>("""
        {"current":"0.5.0","latest":"0.6.0","available":true,"platform":"windows-arm64","tag":"v0.6.0",
         "url":"https://github.com/starroyhq/computer-use/releases/tag/v0.6.0",
         "notes":"## Computer Use v0.6.0\n\n- Windows 安装程序\n- macOS DMG",
         "asset":{"name":"computer-use-0.6.0-windows-arm64.zip","size":10,"sha256":"ab"},
         "installer":{"name":"computer-use-0.6.0-windows-arm64-setup.exe","size":20,"sha256":"cd"}}
        """, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

    /// <summary>
    /// 更新页按安装方式给出操作：安装版下载安装程序并提供“运行安装程序”，便携版下载 ZIP 并提示手动替换。
    /// 安装方式由卸载登记决定，这里用反射分别模拟两种情况。
    /// </summary>
    private static void CheckUpdatePage(HostApplication host)
    {
        const BindingFlags members = BindingFlags.Instance | BindingFlags.NonPublic;
        var window = (SettingsForm)Field(host, "_window")!;
        var updates = host.Updates;
        var installed = typeof(UpdateService).GetField("<Installed>k__BackingField", members)!;
        var original = installed.GetValue(updates);
        bool Shown(string name) => ((Control)typeof(SettingsForm).GetField(name, members)!.GetValue(window)!).Visible;
        void Show(UpdatePhase phase)
        {
            typeof(UpdateService).GetProperty("Phase", members)!.SetValue(updates, phase);
            window.RefreshAll();
            Pump();
        }
        var check = InstallerCheck();
        typeof(UpdateService).GetProperty("Check", members)!.SetValue(updates, check);
        window.ShowPage(SettingsPage.Updates);
        Pump();
        try
        {
            installed.SetValue(updates, false);
            Check(updates.Package == check.Asset, "portable copies download the ZIP");
            Show(UpdatePhase.Available);
            Check(Shown("_download") && Shown("_manualHint") && !Shown("_installerHint") && !Shown("_runInstaller"), "portable copy explains the manual replacement");
            Show(UpdatePhase.Downloaded);
            Check(Shown("_reveal") && Shown("_manualHint") && !Shown("_runInstaller"), "downloaded ZIP is shown in File Explorer");

            installed.SetValue(updates, true);
            Check(updates.Package == check.Installer, "installed copies download the installer");
            Show(UpdatePhase.Available);
            Check(Shown("_download") && Shown("_installerHint") && !Shown("_manualHint") && !Shown("_runInstaller"), "installed copy explains the setup wizard");
            Show(UpdatePhase.Downloaded);
            Check(Shown("_runInstaller") && Shown("_reveal") && Shown("_installerHint") && !Shown("_manualHint"), "downloaded installer can be run");

            typeof(UpdateService).GetProperty("Check", members)!.SetValue(updates, check with { Installer = null });
            Show(UpdatePhase.Available);
            Check(updates.Package is null && !Shown("_download") && !Shown("_installerHint"), "a release without an installer is not offered to installed copies");
        }
        finally
        {
            installed.SetValue(updates, original);
            typeof(UpdateService).GetProperty("Check", members)!.SetValue(updates, null);
            Show(UpdatePhase.Idle);
        }
        Console.WriteLine("PASS: Windows update page");
    }

    private static void CheckSettingsStore(string directory)
    {
        var store = new HostSettingsStore(directory);
        Check(store.Current.AutomaticUpdateChecks && store.Current.LastUpdateCheck is null && store.Current.SkippedVersion is null, "settings default");
        var when = DateTimeOffset.UtcNow;
        store.Update(settings =>
        {
            settings.AutomaticUpdateChecks = false;
            settings.LastUpdateCheck = when;
            settings.SkippedVersion = "0.5.0";
        });
        var reloaded = new HostSettingsStore(directory).Current;
        Check(!reloaded.AutomaticUpdateChecks && reloaded.LastUpdateCheck == when && reloaded.SkippedVersion == "0.5.0", "settings persist");
        File.WriteAllText(Path.Combine(directory, "host-settings.json"), "{not json");
        Check(new HostSettingsStore(directory).Current.AutomaticUpdateChecks, "damaged settings fall back to defaults");
        File.Delete(Path.Combine(directory, "host-settings.json"));
        Console.WriteLine("PASS: Windows settings store");
    }

    /// <summary>
    /// 联网检查：用一个旧版本号的便携包目录（含 bin\node.exe、runtime\cli.js）调用真实 GitHub 发布，
    /// 检查、下载校验、拒绝过期的确认版本、取消下载。只在人工验证时运行。
    /// </summary>
    private static void LiveUpdate(string root)
    {
        var command = UpdateCommand.ForPackage(root);
        var check = command.CheckAsync(CancellationToken.None).GetAwaiter().GetResult();
        Console.WriteLine($"check: current={check.Current} latest={check.Latest} available={check.Available} asset={check.Asset?.Name} size={check.Asset?.Size}");
        Check(check.Available && check.Asset is not null && check.ReleasePage is not null, "a newer release with a package for this computer");
        var directory = Path.Combine(Path.GetTempPath(), "cu-live-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var reports = 0;
            long last = 0;
            var progress = new ImmediateProgress(value =>
            {
                reports++;
                last = value.Downloaded;
            });
            var started = DateTime.UtcNow;
            var download = command.DownloadAsync(check.Latest, directory, progress, CancellationToken.None).GetAwaiter().GetResult();
            Console.WriteLine($"download: {download.Path} bytes={download.Bytes} sha256={download.Sha256} signing={download.Signing} reports={reports} seconds={(DateTime.UtcNow - started).TotalSeconds:0}");
            Check(new FileInfo(download.Path).Length == check.Asset!.Size && download.Bytes == check.Asset.Size && last == download.Bytes,
                "downloaded package matches the published size and progress reaches the end");
            Check(check.Asset.Sha256 is null || check.Asset.Sha256 == download.Sha256, "digest matches the release");
            // v0.6.0 起的发布才带安装程序。
            if (check.Installer is { } installer)
            {
                var setup = Path.Combine(directory, "installer");
                Directory.CreateDirectory(setup);
                var downloaded = command.DownloadAsync(check.Latest, setup, progress, CancellationToken.None, installer: true).GetAwaiter().GetResult();
                Console.WriteLine($"installer: {downloaded.Path} bytes={downloaded.Bytes} sha256={downloaded.Sha256}");
                Check(Path.GetFileName(downloaded.Path) == installer.Name && new FileInfo(downloaded.Path).Length == installer.Size
                    && (installer.Sha256 is null || installer.Sha256 == downloaded.Sha256), "downloaded installer matches the release");
            }
            else Console.WriteLine("installer: the latest release has none");
            try
            {
                command.DownloadAsync("0.0.1", directory, progress, CancellationToken.None).GetAwaiter().GetResult();
                Check(false, "a stale confirmed version must be refused");
            }
            catch (UpdateFailure failure)
            {
                Console.WriteLine($"stale: {failure.Code}: {failure.Describe()}");
                Check(failure.Describe() == L10n.T(Msg.UpdateErrorChanged), "stale confirmation refused with a localized reason");
            }
            var cancelled = Path.Combine(directory, "cancelled");
            Directory.CreateDirectory(cancelled);
            using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                command.DownloadAsync(check.Latest, cancelled, progress, cancellation.Token).GetAwaiter().GetResult();
                Check(false, "cancelled download must not complete");
            }
            catch (OperationCanceledException) { }
            Console.WriteLine($"cancel: stopped after {stopwatch.Elapsed.TotalSeconds:0.0}s");
            Check(stopwatch.Elapsed < TimeSpan.FromSeconds(20), "cancellation ends the download process promptly");
            Console.WriteLine("PASS: live Windows update check and download");
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }

    private sealed class ImmediateProgress(Action<(long Downloaded, long Total)> report) : IProgress<(long Downloaded, long Total)>
    {
        public void Report((long Downloaded, long Total) value) => report(value);
    }

    /// <summary>用运行时替身的就绪状态渲染两种语言的设置与授权窗口，不沿用生命周期测试的错误状态。</summary>
    private static void Screenshots(HostApplication host, string directory)
    {
        Directory.CreateDirectory(directory);
        const BindingFlags members = BindingFlags.Instance | BindingFlags.NonPublic;
        var installed = typeof(UpdateService).GetField("<Installed>k__BackingField", members)!;
        var originalInstalled = installed.GetValue(host.Updates);
        var check = typeof(UpdateService).GetProperty("Check", members)!;
        var phase = typeof(UpdateService).GetProperty("Phase", members)!;
        var originalCheck = check.GetValue(host.Updates);
        var originalPhase = phase.GetValue(host.Updates);
        var chinese = L10n.Chinese;
        void Save(Form form, string name)
        {
            Pump();
            using var bitmap = new Bitmap(form.Width, form.Height);
            form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
            bitmap.Save(Path.Combine(directory, name + ".png"), ImageFormat.Png);
        }
        try
        {
            foreach (var language in new[] { false, true })
            {
                L10n.Chinese = language;
                var prefix = language ? "zh" : "en";
                Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) });
                Event(host, new
                {
                    @event = "clients", clients = new[]
                    {
                        new { id = "screen-all", name = "Desktop Agent", appIds = Array.Empty<string>(), allApps = true, browser = false, foreground = true },
                        new { id = "screen-scoped", name = "Fixture Agent", appIds = new[] { @"win32:c:\apps\fixture.exe" }, allApps = false, browser = false, foreground = true },
                        new { id = "screen-browser", name = "Browser Agent", appIds = Array.Empty<string>(), allApps = false, browser = true, foreground = false },
                    }
                });
                Check(host.ServiceStatus == L10n.T(Msg.StatusReady), "settings screenshots start with ready service state");
                check.SetValue(host.Updates, InstallerCheck() with
                {
                    Notes = language ? "## Computer Use v0.6.0\n\n- Windows 安装程序\n- macOS DMG"
                        : "## Computer Use v0.6.0\n\n- Windows installer\n- macOS disk image"
                });
                installed.SetValue(host.Updates, false);
                phase.SetValue(host.Updates, UpdatePhase.Available);
                using (var window = new SettingsForm(host))
                {
                    foreach (var page in Enum.GetValues<SettingsPage>())
                    {
                        window.ShowPage(page);
                        Save(window, $"{prefix}-{(int)page + 1}-{page}");
                    }
                    installed.SetValue(host.Updates, true);
                    phase.SetValue(host.Updates, UpdatePhase.Downloaded);
                    window.ShowPage(SettingsPage.Updates);
                    Save(window, $"{prefix}-5-Updates-installer");
                    window.Size = window.MinimumSize;
                    foreach (var page in new[] { SettingsPage.Clients, SettingsPage.Connect, SettingsPage.Updates })
                    {
                        window.ShowPage(page);
                        Save(window, $"{prefix}-{(int)page + 1}-{page}-narrow");
                    }
                }
                foreach (var allApps in new[] { true, false })
                {
                    Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) });
                    var id = $"screenshot-{prefix}-{allApps}";
                    Event(host, new
                    {
                        @event = "pair_request", clientId = id, name = allApps ? "Desktop Agent" : "Fixture Agent",
                        appIds = allApps ? Array.Empty<string>()
                            : Enumerable.Range(1, 25).Select(index => $@"C:\Program Files\Example Applications\App {index}\Application.exe").ToArray(),
                        allApps, browser = false, foreground = true
                    });
                    var dialog = Dialog(host)!;
                    Save(dialog, $"{prefix}-pairing-{(allApps ? "all-apps" : "scoped-paths")}");
                    Finish(host, id, false);
                }
            }
        }
        finally
        {
            L10n.Chinese = chinese;
            installed.SetValue(host.Updates, originalInstalled);
            check.SetValue(host.Updates, originalCheck);
            phase.SetValue(host.Updates, originalPhase);
            Event(host, new { @event = "status", message = L10n.T(Msg.StatusReady) });
        }
        Console.WriteLine($"Saved bilingual settings and pairing screenshots to {directory}");
    }

    private static void Pump() { Application.DoEvents(); Application.DoEvents(); }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static T ControlField<T>(SettingsForm window, string name) where T : Control =>
        (T)typeof(SettingsForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
    private static bool FullyWithinWindow(Form form, Control control) => control.Visible
        && form.ClientRectangle.Contains(form.RectangleToClient(control.RectangleToScreen(control.ClientRectangle)));
    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }
    private static object? Field(HostApplication host, string name) => typeof(HostApplication).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(host);
    private static ApprovalDialog? Dialog(HostApplication host) => (ApprovalDialog?)Field(host, "_approvalDialog");
    private static string Status(HostApplication host) => (string)Field(host, "_status")!;
    private static Task Invoke(HostApplication host, string method, params object[] args) => (Task)typeof(HostApplication).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, args)!;
    private static void Event(HostApplication host, object message)
    {
        typeof(HostApplication).GetMethod("HandleEvent", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, [JsonSerializer.SerializeToElement(message)]);
        Pump();
    }
    private static void Request(HostApplication host, string id) => Event(host, new { @event = "foreground_request", sessionId = id, clientName = "Isolated UI regression", targetTitle = "No desktop driver" });
    private static void Finish(HostApplication host, string id, bool approved) => Event(host, new { @event = "decision_finished", requestId = id, approved });
    private static void ClickAllow(HostApplication host)
    {
        var dialog = Dialog(host)!;
        dialog.AllowButton.PerformClick();
        Pump();
    }
}

namespace ComputerUse.WindowsHost
{
    // The UI harness cannot connect to a real runtime, grant credentials, or input
    // into another app. Production runtime behavior is covered by runtime.test.ts.
    internal sealed class HostRuntime : IAsyncDisposable
    {
        internal static readonly List<string> Commands = [];
        internal static readonly List<bool?> AllAppsAcknowledgments = [];
        internal static readonly List<string?> RequestIds = [];
        internal static int StartCount { get; private set; }
        internal static int DisposeCount { get; private set; }
        internal static HostRuntime? Last { get; private set; }
        internal static Task? NextStart { get; set; }
        internal static Task? NextDispose { get; set; }
        internal static Task? NextControl { get; set; }
        private readonly Action<JsonElement> _onEvent;
        internal string PipeName => "isolated-test";
        internal HostRuntime(Action<JsonElement> onEvent) { _onEvent = onEvent; Last = this; }
        internal Task StartAsync()
        {
            StartCount++;
            var task = NextStart ?? Task.CompletedTask;
            NextStart = null;
            return task;
        }
        internal void Emit(object message) => _onEvent(JsonSerializer.SerializeToElement(message));
        internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null, bool? allApps = null, string? requestId = null)
        {
            Commands.Add(command + ":" + (clientId ?? sessionId));
            AllAppsAcknowledgments.Add(allApps);
            RequestIds.Add(requestId);
            var task = NextControl ?? Task.CompletedTask;
            NextControl = null;
            return task;
        }
        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            var task = NextDispose ?? Task.CompletedTask;
            NextDispose = null;
            return new ValueTask(task);
        }
    }
}

using System.Drawing;
using System.Drawing.Imaging;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using ComputerUse.WindowsHost;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Length == 2 && args[0] == "--live-update")
        {
            LiveUpdate(args[1]);
            return;
        }
        var screenshots = args.Length == 2 && args[0] == "--screenshots" ? args[1] : null;
        CheckTranslations();
        CheckHelpers();
        var data = Path.Combine(Path.GetTempPath(), "cu-host-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            CheckSettingsStore(data);
            using var host = new HostApplication(showWindow: true, dataDirectory: data);
            Pump();
            try
            {
                CheckAuthorizationLifecycle(host);
                CheckSettingsWindow(host);
                if (screenshots is not null) Screenshots(host, screenshots);
            }
            finally { Invoke(host, "ExitAsync").GetAwaiter().GetResult(); }
        }
        finally
        {
            try { Directory.Delete(data, recursive: true); } catch { }
        }
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
        var text = Dialog(host)?.Controls.OfType<TextBox>().Single().Text ?? "";
        Check(text.Contains(L10n.F(Msg.ApprovalPathCount, 25)) && paths.All(text.Contains), "pair dialog lists every requested application");
        Finish(host, "many-apps", false);
        Check(Dialog(host) is null, "expired pair prompt withdrawn");
        Console.WriteLine("PASS: Windows authorization dialog lifecycle");
    }

    private static void CheckSettingsWindow(HostApplication host)
    {
        var window = (SettingsForm)Field(host, "_window")!;
        var titles = window.Tabs.TabPages.Cast<TabPage>().Select(page => page.Text).ToArray();
        var expected = new[] { Msg.PaneGeneral, Msg.PaneStatus, Msg.PaneClients, Msg.PaneConnect, Msg.PaneUpdates, Msg.PaneAbout }.Select(L10n.T);
        Check(titles.SequenceEqual(expected), "settings window has the six pages in order");
        Event(host, new
        {
            @event = "clients",
            clients = new object[]
            {
                new { id = "a", name = "Codex", appIds = new[] { @"win32:c:\apps\fixture.exe" }, browser = false, foreground = true },
                new { id = "b", name = "Legacy" },
            }
        });
        var items = window.ClientList.Items.Cast<ListViewItem>().ToArray();
        Check(items.Length == 2, "client list shows every paired client");
        Check(items[0].SubItems[1].Text == @"c:\apps\fixture.exe" && items[0].SubItems[3].Text == L10n.T(Msg.ClientsYes),
            "client list shows the authorized paths without the internal prefix");
        Check(items[1].SubItems[1].Text == L10n.T(Msg.ClientsNo), "older runtimes without grant fields still list the client");
        Event(host, new { @event = "status", message = "Local MCP: http://127.0.0.1:47631/mcp" });
        Check(host.HttpStatus == "Local MCP: http://127.0.0.1:47631/mcp" && host.ServiceStatus != host.HttpStatus,
            "HTTP listener status goes to the Connect page, not the service status");
        Console.WriteLine("PASS: Windows settings window");
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
            && server.GetProperty("args").EnumerateArray().Select(value => value.GetString()).SequenceEqual(new[] { @"C:\Portable\runtime\cli.js", "mcp", "stdio" }),
            "stdio configuration uses the bundled node and CLI");
        var check = JsonSerializer.Deserialize<UpdateCheck>("""
            {"current":"0.4.0","latest":"0.5.0","available":true,"platform":"windows-arm64","tag":"v0.5.0",
             "url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0","notes":"n",
             "asset":{"name":"computer-use-0.5.0-windows-arm64.zip","size":10,"sha256":"ab"}}
            """, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Check(check.Latest == "0.5.0" && check.Asset?.Size == 10 && check.ReleasePage is not null, "update check output parsed");
        Check((check with { Url = "https://example.com/x" }).ReleasePage is null, "only the project's release page opens");
        Console.WriteLine("PASS: Windows update and settings helpers");
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

    /// <summary>把每个设置页渲染成 PNG，便于在不同 DPI 下人工检查布局。</summary>
    private static void Screenshots(HostApplication host, string directory)
    {
        Directory.CreateDirectory(directory);
        var window = (SettingsForm)Field(host, "_window")!;
        var check = JsonSerializer.Deserialize<UpdateCheck>("""
            {"current":"0.4.0","latest":"0.5.0","available":true,"platform":"windows-arm64","tag":"v0.5.0",
             "url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0",
             "notes":"## Computer Use v0.5.0\n\n- 设置窗口改为 6 个分区\n- 检查更新与下载校验","asset":{"name":"computer-use-0.5.0-windows-arm64.zip","size":125852817}}
            """, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        const BindingFlags members = BindingFlags.Instance | BindingFlags.NonPublic;
        typeof(UpdateService).GetProperty("Check", members)!.SetValue(host.Updates, check);
        typeof(UpdateService).GetProperty("Phase", members)!.SetValue(host.Updates, UpdatePhase.Available);
        window.ShowPage(SettingsPage.General);
        for (var index = 0; index < window.Tabs.TabCount; index++)
        {
            window.Tabs.SelectedIndex = index;
            window.RefreshAll();
            Pump();
            using var bitmap = new Bitmap(window.Width, window.Height);
            window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, window.Size));
            bitmap.Save(Path.Combine(directory, $"{index + 1}-{window.Tabs.TabPages[index].Text}.png"), ImageFormat.Png);
        }
        Console.WriteLine($"Saved settings screenshots to {directory}");
    }

    private static void Pump() { Application.DoEvents(); Application.DoEvents(); }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
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
        dialog.Controls.OfType<FlowLayoutPanel>().Single().Controls.OfType<Button>().Single(b => b.Text == L10n.T(Msg.ApprovalAllow)).PerformClick();
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
        internal string PipeName => "isolated-test";
        internal HostRuntime(Action<JsonElement> onEvent) { }
        internal Task StartAsync() => Task.CompletedTask;
        internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null)
        {
            Commands.Add(command + ":" + (clientId ?? sessionId));
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

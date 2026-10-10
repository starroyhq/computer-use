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
                CheckSettingsInteractions(host);
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

    private static void CheckSettingsInteractions(HostApplication host)
    {
        var window = (SettingsForm)Field(host, "_window")!;
        Event(host, new { @event = "ready" });
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
                Event(host, new { @event = "ready" });
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
        finally { L10n.Chinese = chinese; Event(host, new { @event = "ready" }); }
        Console.WriteLine("PASS: Windows bilingual settings layouts at normal and minimum sizes");
    }

    // Vertical scrolling is intentional; a control must not need horizontal scrolling to be read or used.
    private static void CheckHorizontalLayout(Control root, string context)
    {
        foreach (var control in Descendants(root).Where(control => control.Visible
            && (control is Label or Button or CheckBox or TextBox or ListView)))
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
            && server.GetProperty("args").EnumerateArray().Select(value => value.GetString()).SequenceEqual(new[] { @"C:\Portable\runtime\cli.js", "mcp", "stdio" }),
            "stdio configuration uses the bundled node and CLI");
        var pair = SettingsForm.PairCommand(@"C:\Portable");
        Check(SettingsForm.CliCommand(@"C:\O'Brien\$tools`") ==
            @"& 'C:\O''Brien\$tools`\bin\node.exe' 'C:\O''Brien\$tools`\runtime\cli.js'",
            "copied PowerShell commands preserve apostrophes, dollar signs and backticks in installation paths");
        Check(pair.StartsWith(SettingsForm.CliCommand(@"C:\Portable") + " pair ", StringComparison.Ordinal)
            && pair.Contains("--name", StringComparison.Ordinal) && !pair.Contains("--app", StringComparison.Ordinal)
            && !pair.Contains("--profile", StringComparison.Ordinal)
            && !server.GetProperty("args").EnumerateArray().Any(value => value.GetString() == "--profile"),
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
                Event(host, new { @event = "ready" });
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
                    Event(host, new { @event = "ready" });
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
            Event(host, new { @event = "ready" });
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
        internal static int StartCount { get; private set; }
        internal static int DisposeCount { get; private set; }
        internal string PipeName => "isolated-test";
        internal HostRuntime(Action<JsonElement> onEvent) { }
        internal Task StartAsync() { StartCount++; return Task.CompletedTask; }
        internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null, bool? allApps = null)
        {
            Commands.Add(command + ":" + (clientId ?? sessionId));
            AllAppsAcknowledgments.Add(allApps);
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync() { DisposeCount++; return ValueTask.CompletedTask; }
    }
}

using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal sealed record ClientInfo(string Id, string Name, IReadOnlyList<string> AppIds, bool AllApps, bool Browser, bool Foreground);
internal enum ClientGrantState { Idle, Pending, Succeeded, Failed, Missing, SaveFailed, Unconfirmed }

/// <summary>设置窗口读取的托盘程序状态与可以执行的操作。</summary>
internal interface ISettingsHost
{
    string ServiceStatus { get; }
    bool IsRunning { get; }
    bool IsPaused { get; }
    bool IsBusy { get; }
    string? PipeName { get; }
    IReadOnlyList<ClientInfo> Clients { get; }
    bool HttpEnabled { get; }
    string? HttpStatus { get; }
    string PackageRoot { get; }
    UpdateService Updates { get; }
    Task TogglePauseAsync();
    Task EmergencyStopAsync();
    Task RestartServicesAsync();
    Task RevokeAsync(string clientId);
    ClientGrantState GrantState(string clientId);
    long GrantRevision { get; }
    Task GrantAllAppsAsync(string clientId, long revision);
    Task SetHttpAsync(bool enabled);
}

internal enum SettingsPage { General, Status, Clients, Connect, Updates, About }

/// <summary>跨 Windows 10/11 的设置窗口；保留系统窗口框架与标准键盘交互。</summary>
internal sealed class SettingsForm : Form
{
    private readonly ISettingsHost _host;
    private readonly Panel _content = new() { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(24) };
    private readonly VerticalStack[] _pages = new VerticalStack[6];
    private readonly Dictionary<SettingsPage, Button> _navigation = new();
    private readonly string[] _pageTitles = new[] { Msg.PaneGeneral, Msg.PaneStatus, Msg.PaneClients, Msg.PaneConnect, Msg.PaneUpdates, Msg.PaneAbout }.Select(L10n.T).ToArray();
    private bool _refreshing;
    private readonly IAgentCommand _agentCommand;
    private readonly Func<string, bool> _copySetupPromptText;
    private readonly ClientsPane _clientPane;
    private CancellationTokenSource? _promptCancellation;
    private bool _promptCancelledByUser;
    private CancellationTokenSource? _profileCancellation;
    private bool _profilesLoaded;
    private readonly ComboBox _profile = new() { DropDownStyle = ComboBoxStyle.DropDown, MaxLength = 64, Text = "default", Margin = new Padding(0, 0, 0, 12) };
    private readonly Label _profileStatus = MakeFeedback();
    private readonly Button _refreshProfiles = MakeButton(Msg.ConnectRefreshProfiles);
    private readonly Button _copySetupPrompt = MakeButton(Msg.ConnectCopySetupPrompt, ButtonTone.Primary);
    private readonly Button _cancelSetupPrompt = MakeButton(Msg.UpdatesCancel);
    private readonly Label _setupPromptStatus = MakeFeedback();
    internal Task ProfileLoadTask { get; private set; } = Task.CompletedTask;
    internal Task SetupPromptTask { get; private set; } = Task.CompletedTask;

    private readonly CheckBox _launch = MakeCheckBox(Msg.GeneralLaunchAtLogin);
    private readonly Label _launchNote = MakeNote();
    private readonly TextBox _cliCommand = CommandBox();
    private readonly Button _copyCli = MakeButton(Msg.GeneralCopy);
    private readonly Label _cliCopied = MakeFeedback();
    private readonly Label _service = MakeNote();
    private readonly Label _serviceTitle = MakeValue();
    private readonly Label _sidebarState = MakeNote();
    private readonly Label _pairedCount = MakeValue();
    private readonly Label _pipe = MakeValue();
    private readonly Button _pause = MakeButton(Msg.TrayPause, ButtonTone.Primary);
    private readonly Button _stop = MakeButton(Msg.TrayEmergencyStop, ButtonTone.Danger);
    private readonly Button _restart = MakeButton(Msg.TrayRestart);
    private readonly CheckBox _http = MakeCheckBox(Msg.ConnectHttpToggle);
    private readonly Label _httpAddress = MakeValue();
    private readonly Button _copyAddress = MakeButton(Msg.ConnectCopyAddress);
    private readonly Button _copyStdio = MakeButton(Msg.ConnectCopy, ButtonTone.Primary);
    private readonly TextBox _pairCommand = CommandBox();
    private readonly Button _copyPair = MakeButton(Msg.ConnectCopyPair, ButtonTone.Primary);
    private readonly Label _pairCopied = MakeFeedback();
    private readonly Label _copied = MakeFeedback();
    private FlowLayoutPanel _addressRow = null!;
    private readonly Label _version = MakeValue();
    private readonly CheckBox _automatic = MakeCheckBox(Msg.UpdatesAutomaticToggle);
    private readonly Label _lastCheck = MakeValue();
    private readonly Button _check = MakeButton(Msg.UpdatesCheckNow);
    private readonly Label _updateStatus = MakeValue();
    private readonly ProgressBar _progress = new() { Width = 260, Height = 18, Minimum = 0, Maximum = 1000, Margin = new Padding(0, 8, 12, 8) };
    private readonly Button _cancel = MakeButton(Msg.UpdatesCancel);
    private readonly Button _download = MakeButton(Msg.UpdatesDownload, ButtonTone.Primary);
    private readonly Button _release = MakeButton(Msg.UpdatesViewRelease);
    private readonly Button _skip = MakeButton(Msg.UpdatesSkip);
    private readonly Button _reveal = MakeButton(Msg.UpdatesReveal);
    private readonly Button _retry = MakeButton(Msg.UpdatesRetry, ButtonTone.Primary);
    private readonly Button _runInstaller = MakeButton(Msg.UpdatesRunInstaller, ButtonTone.Primary);
    private readonly Label _manualHint = MakeNote();
    private readonly Label _installerHint = MakeNote();
    private readonly Label _notesLabel = SectionTitle(Msg.UpdatesNotes);
    private readonly TextBox _notes = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Height = 150,
        BorderStyle = BorderStyle.FixedSingle, BackColor = UiStyle.Surface, ForeColor = UiStyle.Text, Margin = new Padding(0, 4, 0, 8)
    };
    private FlowLayoutPanel _progressRow = null!;
    private FlowLayoutPanel _updateActions = null!;
    private readonly Label _aboutVersion = MakeNote();

    internal SettingsForm(ISettingsHost host, IAgentCommand? agentCommand = null, Func<string, bool>? copySetupPrompt = null,
        Func<string, string, bool>? confirmGrant = null, Func<string, string, bool>? confirmRevoke = null)
    {
        _host = host;
        _agentCommand = agentCommand ?? new AgentCommand(PackageCommand.ForPackage(host.PackageRoot));
        _copySetupPromptText = copySetupPrompt ?? CopyText;
        bool Confirm(string title, string body) => MessageBox.Show(this, body, title,
            MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.OK;
        _clientPane = new ClientsPane(host, confirmGrant ?? Confirm, confirmRevoke ?? Confirm,
            () => ShowPage(SettingsPage.Connect));
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = L10n.T(Msg.SettingsTitle);
        Icon = UiStyle.ApplicationIcon;
        Font = new Font(SystemFonts.MessageBoxFont!.FontFamily, 9.5F);
        BackColor = UiStyle.Background;
        ForeColor = UiStyle.Text;
        ClientSize = new Size(880, 650);
        MinimumSize = new Size(760, 540);
        StartPosition = FormStartPosition.CenterScreen;
        _pages[(int)SettingsPage.General] = Page(Msg.PaneGeneral, Msg.GeneralDescription, BuildGeneral());
        _pages[(int)SettingsPage.Status] = Page(Msg.PaneStatus, Msg.StatusDescription, BuildStatus());
        _pages[(int)SettingsPage.Clients] = Page(Msg.PaneClients, Msg.ClientsDescription, _clientPane);
        _pages[(int)SettingsPage.Connect] = Page(Msg.PaneConnect, Msg.ConnectDescription, BuildConnect());
        _pages[(int)SettingsPage.Updates] = Page(Msg.PaneUpdates, Msg.UpdatesDescription, BuildUpdates());
        _pages[(int)SettingsPage.About] = Page(Msg.PaneAbout, Msg.AboutDescription, BuildAbout());
        foreach (var page in _pages) { page.Visible = false; _content.Controls.Add(page); }
        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 176));
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.Controls.Add(BuildNavigation(), 0, 0);
        shell.Controls.Add(_content, 1, 0);
        Controls.Add(shell);
        SelectPage(SettingsPage.Status);
        Activated += (_, _) => RefreshAll();
        ResumeLayout(true);
    }

    internal SettingsPage SelectedPage { get; private set; }
    internal IReadOnlyList<string> PageTitles => _pageTitles;
    internal ClientsPane ClientPane => _clientPane;

    internal void ShowPage(SettingsPage? page = null)
    {
        if (page is { } value) SelectPage(value);
        RefreshAll();
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void SelectPage(SettingsPage page)
    {
        SelectedPage = page;
        foreach (var item in _navigation)
        {
            var selected = item.Key == page;
            item.Value.BackColor = selected ? UiStyle.Accent : UiStyle.Surface;
            item.Value.ForeColor = selected ? SystemColors.HighlightText : UiStyle.Text;
            item.Value.AccessibleDescription = selected ? L10n.T(Msg.NavigationSelected) : "";
        }
        for (var i = 0; i < _pages.Length; i++) _pages[i].Visible = i == (int)page;
        _content.AutoScrollPosition = Point.Empty;
    }

    private Control BuildNavigation()
    {
        var side = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, BackColor = UiStyle.Surface, ColumnCount = 1, RowCount = 2,
            Padding = new Padding(12, 24, 12, 16), Margin = Padding.Empty
        };
        side.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        side.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        side.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var links = new VerticalStack();
        var brand = MakeValue("Computer Use");
        brand.Font = UiStyle.SectionFont;
        brand.Margin = new Padding(10, 0, 0, 6);
        links.Add(brand);
        _sidebarState.Margin = new Padding(10, 0, 0, 24);
        links.Add(_sidebarState);
        foreach (var page in new[] { SettingsPage.Status, SettingsPage.Clients, SettingsPage.Connect, SettingsPage.General, SettingsPage.Updates, SettingsPage.About })
        {
            var button = new Button { Text = _pageTitles[(int)page], AccessibleName = _pageTitles[(int)page], TextAlign = ContentAlignment.MiddleLeft };
            UiStyle.StyleButton(button);
            button.FlatAppearance.BorderSize = 0;
            button.Margin = new Padding(0, 0, 0, 4);
            button.Padding = new Padding(12, 7, 8, 7);
            button.Click += (_, _) => { SelectPage(page); RefreshAll(); };
            _navigation.Add(page, button);
            links.Add(button);
        }
        side.Controls.Add(links, 0, 0);
        var controls = new VerticalStack();
        controls.Add(_stop);
        _stop.Margin = new Padding(0, 0, 0, 8);
        controls.Add(MakeNote().With(Msg.EmergencyHint));
        side.Controls.Add(controls, 0, 1);
        return side;
    }

    private static VerticalStack Page(Msg title, Msg description, params Control[] sections)
    {
        var page = new VerticalStack();
        var heading = MakeValue(L10n.T(title));
        heading.Font = UiStyle.HeadingFont;
        heading.Margin = new Padding(0, 0, 0, 8);
        page.Add(heading);
        var summary = MakeNote().With(description);
        summary.Margin = new Padding(0, 0, 0, 24);
        page.Add(summary);
        foreach (var section in sections) page.Add(section);
        return page;
    }

    private static VerticalStack Card(params Control[] controls)
    {
        var card = new VerticalStack { BackColor = UiStyle.Surface, Padding = new Padding(20), Margin = new Padding(0, 0, 0, 16) };
        foreach (var control in controls) card.Add(control);
        return card;
    }

    private static VerticalStack Stack(params Control[] controls)
    {
        var stack = new VerticalStack();
        foreach (var control in controls) stack.Add(control);
        return stack;
    }

    private static Control Disclosure(Msg title, Control details, Action? onExpanded = null)
    {
        var toggle = MakeButton(title);
        toggle.AccessibleDescription = L10n.T(Msg.DetailsCollapsed);
        details.Visible = false;
        toggle.Click += (_, _) =>
        {
            details.Visible = !details.Visible;
            toggle.Text = L10n.T(details.Visible ? Msg.DetailsHide : title);
            toggle.AccessibleDescription = L10n.T(details.Visible ? Msg.DetailsExpanded : Msg.DetailsCollapsed);
            if (details.Visible) onExpanded?.Invoke();
        };
        return Stack(Flow(toggle), details);
    }

    private static FlowLayoutPanel Flow(params Control[] controls)
    {
        var flow = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 2, 0, 4)
        };
        flow.Controls.AddRange(controls);
        return flow;
    }

    private static Label MakeNote() => new() { AutoSize = true, UseMnemonic = false, ForeColor = UiStyle.Muted, Margin = new Padding(0, 0, 0, 10) };
    private static Label MakeValue(string text = "") => new() { Text = text, AutoSize = true, UseMnemonic = false, ForeColor = UiStyle.Text, Margin = new Padding(0, 0, 0, 10) };
    private static Label MakeFeedback()
    {
        var label = MakeNote();
        label.Visible = false;
        return label;
    }
    private static Label SectionTitle(Msg text) => new() { Text = L10n.T(text).TrimEnd(':', '：'), Font = UiStyle.SectionFont, AutoSize = true, ForeColor = UiStyle.Text, Margin = new Padding(0, 0, 0, 12) };
    private static Button MakeButton(Msg text, ButtonTone tone = ButtonTone.Normal)
    {
        var button = new Button { Text = L10n.T(text) };
        UiStyle.StyleButton(button, tone);
        return button;
    }
    private static CheckBox MakeCheckBox(Msg text) => new() { Text = L10n.T(text), AutoSize = true, Margin = new Padding(0, 0, 0, 12) };
    private static TextBox CommandBox() => new()
    {
        Multiline = true, ReadOnly = true, WordWrap = true, ScrollBars = ScrollBars.Vertical, Height = 64,
        BorderStyle = BorderStyle.FixedSingle, BackColor = UiStyle.Background, ForeColor = UiStyle.Text, Margin = new Padding(0, 0, 0, 12)
    };

    private Control BuildGeneral()
    {
        _cliCommand.Text = CliCommand(_host.PackageRoot);
        _cliCommand.AccessibleName = L10n.T(Msg.GeneralCli);
        _launch.CheckedChanged += (_, _) =>
        {
            if (_refreshing) return;
            try { if (_launch.Checked) LaunchAtLogin.Enable(); else LaunchAtLogin.Disable(); }
            catch (Exception error) { MessageBox.Show(this, error.Message, L10n.T(Msg.GeneralLaunchFailed), MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            RefreshAll();
        };
        _copyCli.Click += (_, _) => CopyWithFeedback(_cliCommand.Text, _cliCopied);
        return Stack(
            Card(SectionTitle(Msg.GeneralStartup), _launch, _launchNote, MakeNote().With(Msg.GeneralBackgroundHint)),
            Card(SectionTitle(Msg.GeneralCli), MakeNote().With(Msg.GeneralCliHint), _cliCommand, Flow(_copyCli), _cliCopied),
            Card(SectionTitle(Msg.GeneralLanguage), MakeValue(L10n.T(Msg.GeneralLanguageValue))));
    }

    private Control BuildStatus()
    {
        _serviceTitle.Font = UiStyle.SectionFont;
        _pause.Click += async (_, _) => await _host.TogglePauseAsync();
        _stop.Click += async (_, _) => await _host.EmergencyStopAsync();
        _restart.Click += async (_, _) => await _host.RestartServicesAsync();
        var connect = MakeButton(Msg.ConnectAddClient);
        connect.Click += (_, _) => ShowPage(SettingsPage.Connect);
        return Stack(
            Card(_serviceTitle, MakeNote().With(Msg.StatusBackground), Flow(_pause, _restart), MakeNote().With(Msg.StatusHint)),
            Card(_pairedCount, MakeNote().With(Msg.StatusPairing), Flow(connect)),
            Disclosure(Msg.StatusDiagnostics, Card(SectionTitle(Msg.StatusLatestEvent), _service, SectionTitle(Msg.StatusPipe), _pipe)));
    }

    private Control BuildConnect()
    {
        _profile.Items.Add("default");
        _profile.AccessibleName = L10n.T(Msg.ConnectProfile);
        _profile.TextChanged += (_, _) => { RefreshProfile(); _profileStatus.Visible = false; };
        _profile.SelectionChangeCommitted += (_, _) => ProfileLoadTask = LoadProfilesAsync();
        _refreshProfiles.Click += (_, _) => ProfileLoadTask = LoadProfilesAsync();
        _copySetupPrompt.Click += (_, _) => SetupPromptTask = CopySetupPromptAsync();
        _cancelSetupPrompt.Click += (_, _) => { _promptCancelledByUser = true; _promptCancellation?.Cancel(); };
        _cancelSetupPrompt.Visible = false;
        _pairCommand.Text = PairCommand(_host.PackageRoot, _profile.Text);
        _pairCommand.AccessibleName = L10n.T(Msg.ConnectPairing);
        _copyPair.Click += (_, _) => CopyWithFeedback(_pairCommand.Text, _pairCopied);
        _copyStdio.Click += (_, _) => CopyWithFeedback(StdioConfiguration(_host.PackageRoot, _profile.Text), _copied);
        _http.CheckedChanged += async (_, _) => { if (!_refreshing) await _host.SetHttpAsync(_http.Checked); };
        _copyAddress.Click += (_, _) => { if (HttpAddress(_host.HttpStatus) is { } address) CopyWithFeedback(address, _copied); };
        _addressRow = Flow(_httpAddress, _copyAddress);
        return Stack(
            Card(SectionTitle(Msg.ConnectSetupPrompt), MakeNote().With(Msg.ConnectSetupPromptHint),
                Flow(_copySetupPrompt, _cancelSetupPrompt), _setupPromptStatus),
            Disclosure(Msg.ConnectAdvanced, Stack(
                Card(SectionTitle(Msg.ConnectProfile), MakeNote().With(Msg.ConnectProfileHint), _profile, Flow(_refreshProfiles), _profileStatus),
                Card(SectionTitle(Msg.ConnectStepPair), MakeNote().With(Msg.ConnectPairingHint), _pairCommand, Flow(_copyPair), _pairCopied),
                Card(SectionTitle(Msg.ConnectStepConfig), MakeNote().With(Msg.ConnectConfigHint), Flow(_copyStdio), _copied),
                Card(SectionTitle(Msg.ConnectHttp), _http, MakeNote().With(Msg.ConnectHttpHint), _addressRow)),
                () => { if (!_profilesLoaded) ProfileLoadTask = LoadProfilesAsync(); }));
    }

    private void RefreshProfile()
    {
        var valid = AgentCommand.ValidProfile(_profile.Text);
        var busy = _promptCancellation is not null;
        _profile.Enabled = !busy;
        _copyPair.Enabled = _copyStdio.Enabled = _copySetupPrompt.Enabled = valid && !busy;
        _refreshProfiles.Enabled = valid && !busy && _profileCancellation is null;
        _cancelSetupPrompt.Visible = busy;
        _pairCommand.Text = valid ? PairCommand(_host.PackageRoot, _profile.Text) : L10n.T(Msg.ConnectProfileInvalid);
    }

    private async Task LoadProfilesAsync()
    {
        if (IsDisposed || _profileCancellation is not null || !AgentCommand.ValidProfile(_profile.Text)) return;
        var profile = _profile.Text;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        _profileCancellation = cancellation;
        RefreshProfile();
        try
        {
            var result = await _agentCommand.PreflightAsync(profile, cancellation.Token);
            if (IsDisposed || cancellation.IsCancellationRequested) return;
            // A slow response must not change the profile currently being edited.
            var selected = _profile.Text;
            _profile.Items.Clear();
            _profile.Items.AddRange(result.Profiles.Prepend("default").Distinct(StringComparer.Ordinal).Cast<object>().ToArray());
            _profile.Text = selected;
            _profilesLoaded = true;
            if (selected == profile)
            {
                _profileStatus.Text = L10n.T(result.Profile.State switch
                {
                    "missing" => Msg.ConnectProfileMissing,
                    "invalid" => Msg.ConnectProfileInvalidCredential,
                    "unauthorized" => Msg.ConnectProfileUnauthorized,
                    "valid" => Msg.ConnectProfileValid,
                    _ => Msg.ConnectProfileUnverified
                });
                _profileStatus.ForeColor = UiStyle.Muted;
                _profileStatus.Visible = true;
            }
        }
        catch (Exception)
        {
            if (!IsDisposed && _profile.Text == profile)
            {
                _profileStatus.Text = L10n.T(Msg.ConnectProfileLoadFailed);
                _profileStatus.ForeColor = UiStyle.Danger;
                _profileStatus.Visible = true;
            }
        }
        finally
        {
            _profileCancellation = null;
            if (!IsDisposed) RefreshProfile();
        }
    }

    private async Task CopySetupPromptAsync()
    {
        if (_promptCancellation is not null || !AgentCommand.ValidProfile(_profile.Text)) return;
        var profile = _profile.Text;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        _promptCancellation = cancellation;
        _promptCancelledByUser = false;
        RefreshProfile();
        PromptFeedback(Msg.ConnectSetupPromptBusy, false);
        try
        {
            var text = await _agentCommand.SetupPromptAsync(profile, cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            if (IsDisposed) return;
            var copied = _copySetupPromptText(text);
            PromptFeedback(copied ? Msg.ConnectSetupPromptCopied : Msg.CommonCopyFailed, !copied);
        }
        catch (OperationCanceledException)
        {
            if (!IsDisposed) PromptFeedback(_promptCancelledByUser ? Msg.ConnectSetupPromptCancelled : Msg.ConnectSetupPromptFailed, !_promptCancelledByUser);
        }
        catch (Exception) { if (!IsDisposed) PromptFeedback(Msg.ConnectSetupPromptFailed, true); }
        finally
        {
            _promptCancellation = null;
            if (!IsDisposed) RefreshProfile();
        }
    }

    private void PromptFeedback(Msg message, bool failure)
    {
        _setupPromptStatus.Text = L10n.T(message);
        _setupPromptStatus.ForeColor = failure ? UiStyle.Danger : UiStyle.Muted;
        _setupPromptStatus.Visible = true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _promptCancellation?.Cancel(); _profileCancellation?.Cancel(); }
        base.Dispose(disposing);
    }

    private Control BuildUpdates()
    {
        _automatic.CheckedChanged += (_, _) => { if (!_refreshing) _host.Updates.SetAutomatic(_automatic.Checked); };
        _check.Click += async (_, _) => await _host.Updates.CheckAsync(manual: true);
        _retry.Click += async (_, _) => await _host.Updates.CheckAsync(manual: true);
        _download.Click += async (_, _) => await _host.Updates.DownloadAsync();
        _cancel.Click += (_, _) => _host.Updates.CancelDownload();
        _release.Click += (_, _) => _host.Updates.OpenReleasePage();
        _skip.Click += (_, _) => _host.Updates.Skip();
        _reveal.Click += (_, _) => _host.Updates.Reveal();
        _runInstaller.Click += (_, _) => _host.Updates.RunInstaller();
        _progressRow = Flow(_progress, _cancel);
        _updateActions = Flow(_runInstaller, _download, _release, _skip, _reveal, _retry);
        return Stack(
            Card(Flow(MakeNote().With(Msg.UpdatesVersion), _version), _updateStatus, _progressRow, _updateActions,
                _manualHint.With(Msg.UpdatesManualHint), _installerHint.With(Msg.UpdatesInstallerHint),
                _notesLabel, _notes, Flow(_check), Flow(MakeNote().With(Msg.UpdatesLastCheck), _lastCheck)),
            Card(SectionTitle(Msg.UpdatesAutomatic), _automatic, MakeNote().With(Msg.UpdatesAutomaticHint)));
    }

    private Control BuildAbout()
    {
        var title = MakeValue("Computer Use");
        title.Font = UiStyle.HeadingFont;
        return Card(title, _aboutVersion, MakeNote().With(Msg.AboutLocal), Flow(
            Link(Msg.AboutWebsite, () => UpdateService.Open(UpdateService.ProjectPage)),
            Link(Msg.AboutReleases, () => UpdateService.Open(UpdateService.ReleasesPage)),
            Link(Msg.AboutLicenses, () => OpenFolder(Path.Combine(_host.PackageRoot, "licenses")))));
    }

    private static LinkLabel Link(Msg text, Action open)
    {
        var link = new LinkLabel { Text = L10n.T(text), AutoSize = true, LinkColor = UiStyle.Accent, Margin = new Padding(0, 4, 16, 8) };
        link.LinkClicked += (_, _) => open();
        return link;
    }

    // MARK: 刷新

    internal void RefreshAll()
    {
        if (IsDisposed) return;
        _refreshing = true;
        SuspendLayout();
        try
        {
            RefreshGeneral();
            RefreshStatus();
            _clientPane.Refresh();
            RefreshConnect();
            RefreshUpdates();
            _aboutVersion.Text = L10n.F(Msg.AboutVersion, _host.Updates.Version ?? L10n.T(Msg.UpdatesUnknownVersion));
        }
        finally
        {
            ResumeLayout(true);
            _refreshing = false;
        }
    }

    private void RefreshGeneral()
    {
        var (state, path) = LaunchAtLogin.Read();
        _launch.Checked = state is LaunchState.On or LaunchState.DisabledBySystem;
        _launchNote.Text = state switch
        {
            LaunchState.OtherLocation => L10n.F(Msg.GeneralLaunchOther, path ?? ""),
            LaunchState.DisabledBySystem => L10n.T(Msg.GeneralLaunchDisabled),
            _ => "",
        };
        _launchNote.Visible = _launchNote.Text.Length > 0;
    }

    private void RefreshStatus()
    {
        var state = _host.IsBusy ? Msg.StatusBusyLabel : _host.IsPaused ? Msg.StatusPausedLabel
            : _host.IsRunning ? Msg.StatusRunningLabel : Msg.StatusOfflineLabel;
        _serviceTitle.Text = _sidebarState.Text = L10n.T(state);
        _serviceTitle.ForeColor = _host.IsRunning && !_host.IsPaused ? UiStyle.Accent : UiStyle.Text;
        _pairedCount.Text = L10n.F(Msg.StatusClientCount, _host.Clients.Count);
        _service.Text = _host.ServiceStatus;
        _pipe.Text = _host.PipeName ?? L10n.T(Msg.StatusPipeNotReady);
        _pause.Text = L10n.T(_host.IsPaused ? Msg.TrayResume : Msg.TrayPause);
        _pause.Enabled = !_host.IsBusy && (_host.IsRunning || _host.IsPaused);
        _stop.Enabled = _host.IsRunning || _host.IsBusy;
        _restart.Enabled = !_host.IsBusy;
    }

    /// <summary>运行时的 Windows 应用标识是 win32: 加小写的 exe 路径；列表里只显示路径。</summary>
    internal static string DisplayAppId(string appId) => appId.StartsWith("win32:", StringComparison.Ordinal) ? appId["win32:".Length..] : appId;

    private void RefreshConnect()
    {
        _http.Checked = _host.HttpEnabled;
        _http.Enabled = _host.IsRunning;
        var status = _host.HttpStatus;
        if (HttpAddress(status) is { } address)
        {
            _httpAddress.Text = L10n.F(Msg.ConnectHttpAddress, address);
            _copyAddress.Visible = true;
        }
        else
        {
            _httpAddress.Text = status ?? "";
            _copyAddress.Visible = false;
        }
        // 地址只在开启时显示；监听失败的原因在关闭后也保留，便于排查。
        _addressRow.Visible = status is not null && (_host.HttpEnabled || HttpAddress(status) is null);
    }

    internal static string? HttpAddress(string? status) =>
        status is not null && status.StartsWith("Local MCP: ", StringComparison.Ordinal) ? status["Local MCP: ".Length..] : null;

    private void RefreshUpdates()
    {
        var updates = _host.Updates;
        _version.Text = updates.Version ?? L10n.T(Msg.UpdatesUnknownVersion);
        _automatic.Checked = updates.Settings.AutomaticUpdateChecks;
        _lastCheck.Text = updates.Settings.LastUpdateCheck is { } last
            ? last.ToLocalTime().ToString("g", CultureInfo.CurrentCulture)
            : L10n.T(Msg.UpdatesNever);
        _check.Enabled = updates.CanCheck;
        string? status = null;
        string? notes = null;
        var buttons = new HashSet<Button>();
        var showProgress = false;
        // 安装版提示运行安装程序，便携版提示手动替换文件夹。
        var manual = false;
        var installer = false;
        var check = updates.Check;
        switch (updates.Phase)
        {
            case UpdatePhase.Checking:
                status = L10n.T(Msg.UpdatesChecking);
                break;
            case UpdatePhase.UpToDate when check is not null:
                status = L10n.F(Msg.UpdatesUpToDate, check.Current);
                break;
            case UpdatePhase.Available when check is not null:
                status = L10n.F(Msg.UpdatesAvailable, check.Latest, check.Current);
                if (updates.IsSkipped) status += "\n" + L10n.F(Msg.UpdatesSkipped, check.Latest);
                if (updates.Package is null) status += "\n" + L10n.T(Msg.UpdatesNoPackage);
                else buttons.Add(_download);
                buttons.Add(_release);
                if (!updates.IsSkipped) buttons.Add(_skip);
                notes = check.Notes;
                installer = updates.Package is not null && updates.Installed;
                manual = updates.Package is not null && !updates.Installed;
                break;
            case UpdatePhase.Downloading when check is not null:
                var (downloaded, total) = updates.Progress;
                status = L10n.F(Msg.UpdatesDownloading, check.Latest, Bytes(downloaded), Bytes(total));
                _progress.Value = (int)Math.Clamp(total > 0 ? downloaded * 1000 / total : 0, 0, 1000);
                showProgress = true;
                notes = check.Notes;
                break;
            case UpdatePhase.Downloaded when check is not null:
                status = L10n.F(Msg.UpdatesDownloaded, check.Latest);
                if (updates.Installed) buttons.Add(_runInstaller);
                buttons.Add(_reveal);
                buttons.Add(_release);
                notes = check.Notes;
                installer = updates.Installed;
                manual = !updates.Installed;
                break;
            case UpdatePhase.Failed:
                status = L10n.F(Msg.UpdatesFailed, updates.Error ?? "");
                buttons.Add(_retry);
                if (check is not null) buttons.Add(_release);
                break;
        }
        _updateStatus.Text = status ?? "";
        _updateStatus.Visible = status is not null;
        _progressRow.Visible = showProgress;
        foreach (var button in new[] { _runInstaller, _download, _release, _skip, _reveal, _retry }) button.Visible = buttons.Contains(button);
        _updateActions.Visible = buttons.Count > 0;
        _manualHint.Visible = manual;
        _installerHint.Visible = installer;
        var text = string.IsNullOrWhiteSpace(notes) ? "" : Readable(notes).Replace("\n", "\r\n");
        if (_notes.Text != text) _notes.Text = text;
        _notes.Visible = _notesLabel.Visible = text.Length > 0;
    }

    private static string Bytes(long value) => value >= 1024 * 1024
        ? string.Format(CultureInfo.CurrentCulture, "{0:0.0} MB", value / 1048576.0)
        : string.Format(CultureInfo.CurrentCulture, "{0:0} KB", value / 1024.0);

    /// <summary>发布说明是 Markdown；按纯文本显示，只去掉标题前的 # 与粗体标记。</summary>
    internal static string Readable(string notes) => string.Join("\n", notes.Split('\n').Select(line =>
        Regex.Replace(line, @"^#{1,6}\s+", "").Replace("**", "")));

    // MARK: 操作

    internal static string CliCommand(string root) =>
        $"& {PowerShellLiteral(Path.Combine(root, "bin", "node.exe"))} {PowerShellLiteral(Path.Combine(root, "runtime", "cli.js"))}";

    // Single-quoted PowerShell literals also preserve $ and backticks in user-selected install paths.
    private static string PowerShellLiteral(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    internal static string PairCommand(string root, string profile = "default") =>
        CliCommand(root) + " pair --name 'My Agent' --profile " + PowerShellLiteral(profile);

    /// <summary>与配对和安装提示词使用相同 profile 的通用 JSON，不含凭据。</summary>
    internal static string StdioConfiguration(string root, string profile = "default") => JsonSerializer.Serialize(
        new Dictionary<string, object>
        {
            ["mcpServers"] = new Dictionary<string, object>
            {
                ["computer-use"] = new { command = Path.Combine(root, "bin", "node.exe"), args = new[] { Path.Combine(root, "runtime", "cli.js"), "mcp", "stdio", "--profile", profile } }
            }
        },
        new JsonSerializerOptions { WriteIndented = true });

    private bool CopyText(string text)
    {
        try
        {
            Clipboard.SetText(text);
            return true;
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.ExternalException or ThreadStateException)
        {
            return false;
        }
    }

    private void CopyWithFeedback(string text, Label feedback)
    {
        var copied = CopyText(text);
        feedback.Text = L10n.T(copied ? Msg.CommonCopied : Msg.CommonCopyFailed);
        feedback.ForeColor = copied ? UiStyle.Accent : UiStyle.Danger;
        feedback.Visible = true;
    }

    private static void OpenFolder(string path)
    {
        if (!Directory.Exists(path)) return;
        try { Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { path }, UseShellExecute = false }); }
        catch { }
    }
}

internal static class ControlExtensions
{
    internal static Label With(this Label label, Msg text)
    {
        label.Text = L10n.T(text);
        return label;
    }

    internal static Label With(this Label label, string text)
    {
        label.Text = text;
        return label;
    }
}

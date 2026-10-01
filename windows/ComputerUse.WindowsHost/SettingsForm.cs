using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal sealed record ClientInfo(string Id, string Name, IReadOnlyList<string> AppIds, bool Browser, bool Foreground);

/// <summary>设置窗口读取的托盘程序状态与可以执行的操作。</summary>
internal interface ISettingsHost
{
    string ServiceStatus { get; }
    bool IsRunning { get; }
    bool IsPaused { get; }
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
    Task SetHttpAsync(bool enabled);
}

internal enum SettingsPage { General, Status, Clients, Connect, Updates, About }

/// <summary>
/// 设置窗口：6 个标签页，与 macOS 设置窗口的分区一一对应（Windows 没有系统权限，第二页只显示状态）。
/// 尺寸按 96 DPI 书写，窗体创建时按显示器 DPI 缩放。
/// </summary>
internal sealed class SettingsForm : Form
{
    private const int TextWidth = 430;
    private const int ListWidth = 580;
    private readonly ISettingsHost _host;
    private readonly TabControl _tabs = new() { Dock = DockStyle.Fill, Padding = new Point(14, 5) };
    private bool _refreshing;
    private string _shownClients = "";

    private readonly CheckBox _launch = MakeCheckBox(Msg.GeneralLaunchAtLogin);
    private readonly Label _launchNote = MakeNote();
    private readonly TextBox _cliCommand = new() { ReadOnly = true, Width = 330, Margin = new Padding(3, 6, 6, 3) };
    private readonly Button _copyCli = MakeButton(Msg.GeneralCopy);

    private readonly Label _service = MakeValue();
    private readonly Label _pipe = MakeValue();
    private readonly Button _pause = MakeButton(Msg.TrayPause);
    private readonly Button _stop = MakeButton(Msg.TrayEmergencyStop);
    private readonly Button _restart = MakeButton(Msg.TrayRestart);

    private readonly ListView _clients = new()
    {
        View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false, ShowItemToolTips = true,
        HeaderStyle = ColumnHeaderStyle.Nonclickable, Size = new Size(ListWidth, 210), Margin = new Padding(3, 3, 3, 8)
    };
    private readonly Button _revoke = MakeButton(Msg.ClientsRevoke);
    private readonly Label _clientsNote = MakeNote(ListWidth);

    private readonly CheckBox _http = MakeCheckBox(Msg.ConnectHttpToggle);
    private readonly Label _httpAddress = MakeValue(margin: new Padding(3, 10, 6, 3));
    private readonly Button _copyAddress = MakeButton(Msg.ConnectCopyAddress);
    private readonly Button _copyStdio = MakeButton(Msg.ConnectCopy);
    private readonly Label _copied = MakeNote();
    private FlowLayoutPanel _addressRow = null!;

    private readonly Label _version = MakeValue();
    private readonly CheckBox _automatic = MakeCheckBox(Msg.UpdatesAutomaticToggle);
    private readonly Label _lastCheck = MakeValue();
    private readonly Button _check = MakeButton(Msg.UpdatesCheckNow);
    private readonly Label _updateStatus = MakeValue();
    private readonly ProgressBar _progress = new() { Size = new Size(260, 18), Minimum = 0, Maximum = 1000, Margin = new Padding(3, 10, 8, 3) };
    private readonly Button _cancel = MakeButton(Msg.UpdatesCancel);
    private readonly Button _download = MakeButton(Msg.UpdatesDownload);
    private readonly Button _release = MakeButton(Msg.UpdatesViewRelease);
    private readonly Button _skip = MakeButton(Msg.UpdatesSkip);
    private readonly Button _reveal = MakeButton(Msg.UpdatesReveal);
    private readonly Button _retry = MakeButton(Msg.UpdatesRetry);
    private readonly Label _manualHint = MakeNote();
    private readonly Label _notesLabel = new() { Text = L10n.T(Msg.UpdatesNotes), AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Right, Margin = new Padding(3, 6, 6, 3) };
    private readonly TextBox _notes = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Size = new Size(TextWidth, 130), BackColor = SystemColors.Window
    };
    private FlowLayoutPanel _progressRow = null!;
    private FlowLayoutPanel _updateActions = null!;

    private readonly Label _aboutVersion = new() { AutoSize = true, ForeColor = SystemColors.GrayText, Anchor = AnchorStyles.Top, Margin = new Padding(3, 2, 3, 10) };

    internal SettingsForm(ISettingsHost host)
    {
        _host = host;
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = L10n.T(Msg.SettingsTitle);
        ClientSize = new Size(640, 520);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        _tabs.TabPages.Add(Page(Msg.PaneGeneral, BuildGeneral()));
        _tabs.TabPages.Add(Page(Msg.PaneStatus, BuildStatus()));
        _tabs.TabPages.Add(Page(Msg.PaneClients, BuildClients()));
        _tabs.TabPages.Add(Page(Msg.PaneConnect, BuildConnect()));
        _tabs.TabPages.Add(Page(Msg.PaneUpdates, BuildUpdates()));
        _tabs.TabPages.Add(Page(Msg.PaneAbout, BuildAbout()));
        Controls.Add(_tabs);
        ResumeLayout(false);
        Activated += (_, _) => RefreshAll();
        _tabs.SelectedIndexChanged += (_, _) => RefreshAll();
    }

    internal TabControl Tabs => _tabs;
    internal ListView ClientList => _clients;

    internal void ShowPage(SettingsPage? page = null)
    {
        if (page is { } value) _tabs.SelectedIndex = (int)value;
        RefreshAll();
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    // MARK: 布局

    private static TabPage Page(Msg title, Control content)
    {
        var page = new TabPage(L10n.T(title)) { AutoScroll = true, Padding = new Padding(10), UseVisualStyleBackColor = true };
        page.Controls.Add(content);
        return page;
    }

    private static TableLayoutPanel Grid(int columns = 2)
    {
        var grid = new TableLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = columns, Dock = DockStyle.Top,
            Padding = new Padding(8, 10, 8, 8)
        };
        for (var i = 0; i < columns; i++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        return grid;
    }

    /// <summary>添加一行：左列右对齐的标签，右列控件。标签的上边距按控件类型对齐文字。</summary>
    private static void Row(TableLayoutPanel grid, Msg? label, Control content, int gap = 0, Label? labelControl = null)
    {
        var row = grid.RowCount++;
        grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var offset = content switch
        {
            TextBox { Multiline: true } => 3,
            Button or FlowLayoutPanel or TextBox => 10,
            CheckBox => 5,
            _ => 3,
        };
        var caption = labelControl ?? (label is { } key
            ? new Label { Text = L10n.T(key), AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Right }
            : null);
        if (caption is not null)
        {
            caption.Margin = new Padding(3, offset + gap, 6, 3);
            grid.Controls.Add(caption, 0, row);
        }
        content.Margin = new Padding(content.Margin.Left, content.Margin.Top + gap, content.Margin.Right, content.Margin.Bottom);
        grid.Controls.Add(content, 1, row);
    }

    private static FlowLayoutPanel Flow(params Control[] controls)
    {
        var flow = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, FlowDirection = FlowDirection.LeftToRight,
            Margin = new Padding(0), Padding = new Padding(0)
        };
        flow.Controls.AddRange(controls);
        return flow;
    }

    private static Label MakeNote(int width = TextWidth) => new()
    {
        AutoSize = true, MaximumSize = new Size(width, 0), ForeColor = SystemColors.GrayText, Margin = new Padding(3, 0, 3, 6)
    };

    private static Label MakeValue(string text = "", Padding? margin = null) => new()
    {
        Text = text, AutoSize = true, MaximumSize = new Size(TextWidth, 0), Margin = margin ?? new Padding(3, 3, 3, 3)
    };

    private static Button MakeButton(Msg text) => new()
    {
        Text = L10n.T(text), AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(90, 30),
        Padding = new Padding(6, 0, 6, 0), Margin = new Padding(3, 3, 6, 3), UseVisualStyleBackColor = true
    };

    private static CheckBox MakeCheckBox(Msg text) => new() { Text = L10n.T(text), AutoSize = true, Margin = new Padding(3, 3, 3, 3) };

    private Control BuildGeneral()
    {
        var grid = Grid();
        Row(grid, Msg.GeneralStartup, _launch);
        Row(grid, null, _launchNote);
        _cliCommand.Text = CliCommand(_host.PackageRoot);
        Row(grid, Msg.GeneralCli, Flow(_cliCommand, _copyCli), gap: 10);
        Row(grid, null, MakeNote().With(Msg.GeneralCliHint));
        Row(grid, Msg.GeneralLanguage, MakeValue(L10n.T(Msg.GeneralLanguageValue)), gap: 10);
        _launch.CheckedChanged += (_, _) =>
        {
            if (_refreshing) return;
            try
            {
                if (_launch.Checked) LaunchAtLogin.Enable();
                else LaunchAtLogin.Disable();
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, L10n.T(Msg.GeneralLaunchFailed), MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            RefreshAll();
        };
        _copyCli.Click += (_, _) => CopyText(_cliCommand.Text);
        return grid;
    }

    private Control BuildStatus()
    {
        var grid = Grid();
        Row(grid, Msg.StatusService, _service);
        Row(grid, Msg.StatusPipe, _pipe);
        Row(grid, Msg.StatusControl, Flow(_pause, _stop, _restart), gap: 10);
        Row(grid, null, MakeNote().With(Msg.StatusHint));
        _pause.Click += async (_, _) => await _host.TogglePauseAsync();
        _stop.Click += async (_, _) => await _host.EmergencyStopAsync();
        _restart.Click += async (_, _) => await _host.RestartServicesAsync();
        return grid;
    }

    private Control BuildClients()
    {
        foreach (var (title, share) in new[] { (Msg.ClientsName, 0.26), (Msg.ClientsApps, 0.40), (Msg.ClientsBrowser, 0.17), (Msg.ClientsForeground, 0.17) })
            _clients.Columns.Add(new ColumnHeader { Text = L10n.T(title), Tag = share });
        // 列宽按比例分配；列宽不随窗体 DPI 自动缩放，所以在句柄创建和尺寸变化时重新计算。
        _clients.HandleCreated += (_, _) => FitColumns();
        _clients.Resize += (_, _) => FitColumns();
        var grid = Grid(columns: 1);
        foreach (var control in new Control[] { _clients, Flow(_revoke), _clientsNote, MakeNote(ListWidth).With(Msg.ClientsHint) })
        {
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(control, 0, grid.RowCount++);
        }
        _clients.SelectedIndexChanged += (_, _) => _revoke.Enabled = _host.IsRunning && _clients.SelectedItems.Count == 1;
        _revoke.Click += async (_, _) => await RevokeSelectedAsync();
        return grid;
    }

    private void FitColumns()
    {
        var width = _clients.ClientSize.Width - SystemInformation.VerticalScrollBarWidth;
        if (width <= 0) return;
        foreach (ColumnHeader column in _clients.Columns) column.Width = (int)(width * (double)column.Tag!);
    }

    private Control BuildConnect()
    {
        var grid = Grid();
        Row(grid, Msg.ConnectHttp, _http);
        Row(grid, null, MakeNote().With(Msg.ConnectHttpHint));
        _addressRow = Flow(_httpAddress, _copyAddress);
        Row(grid, null, _addressRow);
        Row(grid, Msg.ConnectStdio, Flow(_copyStdio), gap: 10);
        Row(grid, null, _copied);
        Row(grid, Msg.ConnectPairing, MakeNote().With(Msg.ConnectPairingHint), gap: 10);
        _http.CheckedChanged += async (_, _) =>
        {
            if (!_refreshing) await _host.SetHttpAsync(_http.Checked);
        };
        _copyAddress.Click += (_, _) =>
        {
            if (HttpAddress(_host.HttpStatus) is { } address) CopyText(address);
        };
        _copyStdio.Click += (_, _) =>
        {
            if (!CopyText(StdioConfiguration(_host.PackageRoot))) return;
            _copied.Text = L10n.T(Msg.ConnectCopied);
            _copied.Visible = true;
        };
        _copied.Visible = false;
        return grid;
    }

    private Control BuildUpdates()
    {
        var grid = Grid();
        Row(grid, Msg.UpdatesVersion, _version);
        Row(grid, Msg.UpdatesAutomatic, _automatic, gap: 10);
        Row(grid, null, MakeNote().With(Msg.UpdatesAutomaticHint));
        Row(grid, Msg.UpdatesLastCheck, _lastCheck, gap: 10);
        Row(grid, null, Flow(_check));
        Row(grid, null, _updateStatus);
        _progressRow = Flow(_progress, _cancel);
        Row(grid, null, _progressRow);
        _updateActions = Flow(_download, _release, _skip, _reveal, _retry);
        Row(grid, null, _updateActions);
        Row(grid, null, _manualHint.With(Msg.UpdatesManualHint));
        Row(grid, null, _notes, gap: 4, labelControl: _notesLabel);
        _automatic.CheckedChanged += (_, _) =>
        {
            if (!_refreshing) _host.Updates.SetAutomatic(_automatic.Checked);
        };
        _check.Click += async (_, _) => await _host.Updates.CheckAsync(manual: true);
        _retry.Click += async (_, _) => await _host.Updates.CheckAsync(manual: true);
        _download.Click += async (_, _) => await _host.Updates.DownloadAsync();
        _cancel.Click += (_, _) => _host.Updates.CancelDownload();
        _release.Click += (_, _) => _host.Updates.OpenReleasePage();
        _skip.Click += (_, _) => _host.Updates.Skip();
        _reveal.Click += (_, _) => _host.Updates.Reveal();
        return grid;
    }

    private Control BuildAbout()
    {
        var grid = Grid(columns: 1);
        grid.Dock = DockStyle.None;
        grid.Anchor = AnchorStyles.Top;
        var title = new Label
        {
            Text = "Computer Use", AutoSize = true, Anchor = AnchorStyles.Top, Margin = new Padding(3, 24, 3, 2),
            Font = new Font((SystemFonts.MessageBoxFont ?? DefaultFont).FontFamily, 14F, FontStyle.Bold)
        };
        var summary = new Label
        {
            Text = L10n.T(Msg.AboutDescription), AutoSize = true, MaximumSize = new Size(500, 0), TextAlign = ContentAlignment.MiddleCenter,
            Anchor = AnchorStyles.Top, Margin = new Padding(3, 0, 3, 14)
        };
        var links = Flow(
            Link(Msg.AboutWebsite, () => UpdateService.Open(UpdateService.ProjectPage)),
            Link(Msg.AboutReleases, () => UpdateService.Open(UpdateService.ReleasesPage)),
            Link(Msg.AboutLicenses, () => OpenFolder(Path.Combine(_host.PackageRoot, "licenses"))));
        links.Anchor = AnchorStyles.Top;
        foreach (var control in new Control[] { title, _aboutVersion, summary, links })
        {
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(control, 0, grid.RowCount++);
        }
        // 关于页内容水平居中。
        var host = new Panel { Dock = DockStyle.Fill };
        host.Controls.Add(grid);
        host.Layout += (_, _) => grid.Left = Math.Max(0, (host.ClientSize.Width - grid.Width) / 2);
        return host;
    }

    private static LinkLabel Link(Msg text, Action open)
    {
        var link = new LinkLabel { Text = L10n.T(text), AutoSize = true, Margin = new Padding(8, 3, 8, 3) };
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
            RefreshClients();
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
        _service.Text = _host.ServiceStatus;
        _pipe.Text = _host.PipeName ?? L10n.T(Msg.StatusPipeNotReady);
        _pause.Text = L10n.T(_host.IsPaused ? Msg.TrayResume : Msg.TrayPause);
        _pause.Enabled = _host.IsRunning;
        _stop.Enabled = _host.IsRunning;
    }

    private void RefreshClients()
    {
        IReadOnlyList<ClientInfo> clients = _host.IsRunning ? _host.Clients : Array.Empty<ClientInfo>();
        var signature = string.Join("\n", clients.Select(client =>
            $"{client.Id}\t{client.Name}\t{string.Join(";", client.AppIds)}\t{client.Browser}\t{client.Foreground}"));
        if (signature != _shownClients)
        {
            var selected = _clients.SelectedItems.Count == 1 ? _clients.SelectedItems[0].Tag as string : null;
            _clients.BeginUpdate();
            _clients.Items.Clear();
            foreach (var client in clients)
            {
                var apps = client.AppIds.Count == 0 ? L10n.T(Msg.ClientsNo) : string.Join("; ", client.AppIds.Select(DisplayAppId));
                var item = new ListViewItem(new[] { client.Name, apps, Mark(client.Browser), Mark(client.Foreground) })
                {
                    Tag = client.Id, ToolTipText = apps
                };
                _clients.Items.Add(item);
                if (client.Id == selected) item.Selected = true;
            }
            _clients.EndUpdate();
            _shownClients = signature;
        }
        _clientsNote.Text = !_host.IsRunning ? L10n.T(Msg.ClientsNotRunning) : clients.Count == 0 ? L10n.T(Msg.ClientsEmpty) : "";
        _clientsNote.Visible = _clientsNote.Text.Length > 0;
        _revoke.Enabled = _host.IsRunning && _clients.SelectedItems.Count == 1;
    }

    private static string Mark(bool allowed) => L10n.T(allowed ? Msg.ClientsYes : Msg.ClientsNo);

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
        var manual = false;
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
                if (check.Asset is null) status += "\n" + L10n.T(Msg.UpdatesNoPackage);
                else buttons.Add(_download);
                buttons.Add(_release);
                if (!updates.IsSkipped) buttons.Add(_skip);
                notes = check.Notes;
                manual = check.Asset is not null;
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
                buttons.Add(_reveal);
                buttons.Add(_release);
                notes = check.Notes;
                manual = true;
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
        foreach (var button in new[] { _download, _release, _skip, _reveal, _retry }) button.Visible = buttons.Contains(button);
        _updateActions.Visible = buttons.Count > 0;
        _manualHint.Visible = manual;
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

    private async Task RevokeSelectedAsync()
    {
        if (_clients.SelectedItems.Count != 1 || _clients.SelectedItems[0].Tag is not string id) return;
        var name = _clients.SelectedItems[0].Text;
        var answer = MessageBox.Show(this, L10n.T(Msg.ClientsRevokeBody), L10n.F(Msg.ClientsRevokeTitle, name),
            MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer == DialogResult.OK) await _host.RevokeAsync(id);
    }

    internal static string CliCommand(string root) =>
        $"& \"{Path.Combine(root, "bin", "node.exe")}\" \"{Path.Combine(root, "runtime", "cli.js")}\"";

    /// <summary>与 macOS“复制 stdio 配置”相同的通用 JSON：使用默认 profile，不含凭据。</summary>
    internal static string StdioConfiguration(string root) => JsonSerializer.Serialize(
        new Dictionary<string, object>
        {
            ["mcpServers"] = new Dictionary<string, object>
            {
                ["computer-use"] = new { command = Path.Combine(root, "bin", "node.exe"), args = new[] { Path.Combine(root, "runtime", "cli.js"), "mcp", "stdio" } }
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

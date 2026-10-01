using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal sealed class HostApplication : ApplicationContext, ISettingsHost
{
    private readonly SettingsForm _window;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _pauseItem;
    private readonly ToolStripMenuItem _stopItem;
    private readonly ToolStripMenuItem _updateItem;
    private readonly Queue<JsonElement> _alerts = new();
    private readonly RegisteredWaitHandle? _showRegistration;
    private HostRuntime? _runtime;
    private bool _running;
    private bool _busy;
    private bool _exiting;
    private bool _paused;
    private ApprovalDialog? _approvalDialog;
    private readonly HashSet<string> _pendingDecisions = new();
    private bool _httpEnabled;
    private string? _httpStatus;
    private string? _stopAfterStart;
    private string _status = L10n.T(Msg.StatusStarting);
    private IReadOnlyList<ClientInfo> _clients = Array.Empty<ClientInfo>();

    /// <param name="showWindow">登录时启动（--background）不打开窗口，只在托盘运行。</param>
    /// <param name="dataDirectory">托盘偏好与更新下载的位置；测试程序传入临时目录。</param>
    /// <param name="showSignal">再次启动程序时由新进程触发，已运行的实例据此打开设置窗口。</param>
    internal HostApplication(bool showWindow = true, string? dataDirectory = null, WaitHandle? showSignal = null)
    {
        var settings = new HostSettingsStore(dataDirectory ?? PrivateData.DirectoryPath);
        Updates = new UpdateService(AppContext.BaseDirectory, settings);
        _window = new SettingsForm(this);

        var menu = new ContextMenuStrip();
        menu.Items.Add(L10n.T(Msg.TraySettings), null, (_, _) => _window.ShowPage());
        menu.Items.Add(new ToolStripSeparator());
        _pauseItem = new ToolStripMenuItem(L10n.T(Msg.TrayPause), null, async (_, _) => await TogglePauseAsync());
        menu.Items.Add(_pauseItem);
        _stopItem = new ToolStripMenuItem(L10n.T(Msg.TrayEmergencyStop), null, async (_, _) => await EmergencyStopAsync());
        menu.Items.Add(_stopItem);
        menu.Items.Add(L10n.T(Msg.TrayRestart), null, async (_, _) => await RestartAsync());
        menu.Items.Add(new ToolStripSeparator());
        _updateItem = new ToolStripMenuItem("", null, (_, _) => _window.ShowPage(SettingsPage.Updates)) { Visible = false };
        menu.Items.Add(_updateItem);
        menu.Items.Add(L10n.T(Msg.TrayCheckUpdates), null, async (_, _) =>
        {
            _window.ShowPage(SettingsPage.Updates);
            await Updates.CheckAsync(manual: true);
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(L10n.T(Msg.TrayQuit), null, async (_, _) => await ExitAsync());
        menu.Opening += (_, _) => RefreshTray();
        _tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Computer Use", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => _window.ShowPage();
        Updates.Changed += StateChanged;

        _window.FormClosing += (_, e) =>
        {
            if (_exiting) return;
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                _window.Hide();
            }
            else
            {
                _exiting = true;
                // 注销或关机时只能在 UI 线程同步等待。把释放放到线程池执行并限时，
                // 否则 HostRuntime 的 await 需要回到这个被阻塞的 UI 线程，会互相等待。
                var runtime = _runtime;
                _runtime = null;
                if (runtime is not null)
                {
                    try { Task.Run(() => runtime.DisposeAsync().AsTask()).Wait(TimeSpan.FromSeconds(10)); }
                    catch { }
                }
                _tray.Visible = false;
            }
        };
        // 先创建窗口句柄：后台启动（不显示窗口）时，运行时事件与启动任务同样能投递到界面线程。
        _ = _window.Handle;
        if (showSignal is not null)
            _showRegistration = ThreadPool.RegisterWaitForSingleObject(showSignal, (_, _) => Post(() => _window.ShowPage()),
                null, Timeout.Infinite, executeOnlyOnce: false);
        Post(() => _ = StartAsync());
        Updates.Start();
        if (showWindow) _window.ShowPage(SettingsPage.Status);
        StateChanged();
    }

    // MARK: 设置窗口读取的状态

    public UpdateService Updates { get; }
    public string ServiceStatus => _status;
    public bool IsRunning => _running && _runtime is not null;
    public bool IsPaused => _paused;
    public string? PipeName => IsRunning ? _runtime!.PipeName : null;
    public IReadOnlyList<ClientInfo> Clients => _clients;
    public bool HttpEnabled => _httpEnabled;
    public string? HttpStatus => _httpStatus;
    public string PackageRoot => AppContext.BaseDirectory;

    private void StateChanged()
    {
        RefreshTray();
        _window.RefreshAll();
    }

    private void RefreshTray()
    {
        var text = $"Computer Use · {_status}";
        _tray.Text = text.Length <= 63 ? text : "Computer Use";
        _tray.Icon = _running || _busy ? SystemIcons.Application : SystemIcons.Warning;
        _pauseItem.Text = L10n.T(_paused ? Msg.TrayResume : Msg.TrayPause);
        _pauseItem.Enabled = IsRunning;
        _stopItem.Enabled = IsRunning || _busy;
        if (Updates.Announced is { } check)
        {
            _updateItem.Text = L10n.F(Msg.TrayUpdateAvailable, check.Latest);
            _updateItem.Visible = true;
        }
        else _updateItem.Visible = false;
    }

    private void SetStatus(string value)
    {
        _status = value.Length > 160 ? value[..160] : value;
        StateChanged();
    }

    private void Post(Action action)
    {
        if (_window.IsDisposed) return;
        try { _window.BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }

    // MARK: 服务

    private async Task StartAsync()
    {
        if (_busy || _runtime is not null || _exiting) return;
        _busy = true;
        SetStatus(L10n.T(Msg.StatusStartingRuntime));
        HostRuntime? next = null;
        try
        {
            next = new HostRuntime(message => PostEvent(next, message));
            _runtime = next;
            await next.StartAsync();
            _running = true;
            _paused = false;
            SetStatus(L10n.T(Msg.StatusReady));
        }
        catch (Exception error)
        {
            _runtime = null;
            _running = false;
            if (next is not null) await next.DisposeAsync();
            SetStatus(L10n.F(Msg.StatusStartFailed, error.Message));
            _window.ShowPage(SettingsPage.Status);
            MessageBox.Show(_window, error.Message, L10n.T(Msg.FailureLaunchTitle), MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _busy = false;
            StateChanged();
            if (_stopAfterStart is { } stopStatus)
            {
                _stopAfterStart = null;
                await StopAsync(stopStatus);
            }
        }
    }

    private void PostEvent(HostRuntime? source, JsonElement message) =>
        Post(() => { if (ReferenceEquals(_runtime, source) && !_exiting) HandleEvent(message); });

    private void HandleEvent(JsonElement message)
    {
        if (!message.TryGetProperty("event", out var eventValue)) return;
        switch (eventValue.GetString())
        {
            case "ready":
                _running = true;
                _paused = false;
                SetStatus(L10n.T(Msg.StatusReady));
                break;
            case "status":
                var status = String(message, "message");
                // 运行时的状态消息目前只报告本机 HTTP 监听结果，显示在“接入”页。
                if (status.StartsWith("Local MCP: ", StringComparison.Ordinal) || status.StartsWith("HTTP listener", StringComparison.Ordinal))
                {
                    _httpStatus = status.Length > 200 ? status[..200] : status;
                    if (status.Contains("could not start", StringComparison.OrdinalIgnoreCase)) _httpEnabled = false;
                    StateChanged();
                }
                else SetStatus(status);
                break;
            case "fatal": _ = StopAsync(L10n.F(Msg.StatusRuntimeFault, String(message, "message"))); break;
            case "clients":
                _clients = ParseClients(message);
                StateChanged();
                break;
            case "pair_request":
            case "foreground_request":
                _pendingDecisions.Add(String(message, String(message, "event") == "pair_request" ? "clientId" : "sessionId"));
                _alerts.Enqueue(message);
                PresentNextAlert();
                break;
            case "decision_finished":
                var requestId = String(message, "requestId");
                if (!_pendingDecisions.Remove(requestId)) break;
                SetStatus(message.TryGetProperty("approved", out var approved) && approved.ValueKind == JsonValueKind.True
                    ? L10n.T(Msg.StatusApproved) : L10n.T(Msg.StatusRequestInvalid));
                if (_approvalDialog?.RequestId == requestId) _approvalDialog.Withdraw();
                PresentNextAlert();
                break;
            default: _ = StopAsync(L10n.T(Msg.StatusUnknownEvent)); break;
        }
    }

    /// <summary>客户端列表与授权范围只用于展示；旧版运行时不发送授权字段。</summary>
    private static IReadOnlyList<ClientInfo> ParseClients(JsonElement message)
    {
        if (!message.TryGetProperty("clients", out var clients) || clients.ValueKind != JsonValueKind.Array) return Array.Empty<ClientInfo>();
        var result = new List<ClientInfo>();
        foreach (var client in clients.EnumerateArray())
        {
            if (client.ValueKind != JsonValueKind.Object) continue;
            var id = String(client, "id");
            if (id.Length == 0) continue;
            var name = String(client, "name");
            var apps = client.TryGetProperty("appIds", out var values) && values.ValueKind == JsonValueKind.Array
                ? values.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String).Select(value => value.GetString() ?? "").ToArray()
                : Array.Empty<string>();
            result.Add(new ClientInfo(id, name.Length <= 80 ? name : name[..80], apps, Flag(client, "browser"), Flag(client, "foreground")));
        }
        return result;
    }

    private void PresentNextAlert()
    {
        if (_approvalDialog is not null || _runtime is null || !_running) return;
        // Requests can expire while another dialog is being displayed.
        while (_alerts.TryPeek(out var queued) && !_pendingDecisions.Contains(String(queued,
            String(queued, "event") == "pair_request" ? "clientId" : "sessionId"))) _alerts.Dequeue();
        if (_alerts.Count == 0) return;
        var request = _alerts.Dequeue();
        var source = _runtime;
        var kind = String(request, "event");
        var isPair = kind == "pair_request";
        var identifier = String(request, isPair ? "clientId" : "sessionId");
        if (identifier.Length == 0) { _ = StopAsync(L10n.T(Msg.StatusMissingIdentifier)); return; }
        string explanation;
        if (isPair)
        {
            // 批准即授予全部路径，因此必须全部列出（文本框可滚动），不能截断。
            var paths = request.TryGetProperty("appIds", out var appIds) && appIds.ValueKind == JsonValueKind.Array
                ? appIds.EnumerateArray().Select(value => value.GetString() ?? "").ToArray() : Array.Empty<string>();
            var apps = string.Join("\n", paths);
            var foreground = request.TryGetProperty("foreground", out var foregroundValue) && foregroundValue.ValueKind == JsonValueKind.False
                ? L10n.T(Msg.ApprovalNotAllowed) : L10n.T(Msg.ApprovalForegroundAllowed);
            explanation = L10n.F(Msg.ApprovalPairBody, String(request, "name"), identifier, L10n.F(Msg.ApprovalPathCount, paths.Length),
                apps.Length == 0 ? L10n.T(Msg.ApprovalNone) : apps,
                Flag(request, "browser") ? L10n.T(Msg.ApprovalAllowed) : L10n.T(Msg.ApprovalNotAllowed), foreground);
        }
        else explanation = L10n.F(Msg.ApprovalForegroundBody, String(request, "clientName"), String(request, "targetTitle"), identifier);
        var dialog = new ApprovalDialog(identifier, L10n.T(isPair ? Msg.ApprovalPairTitle : Msg.ApprovalForegroundTitle), explanation);
        _approvalDialog = dialog;
        dialog.FormClosed += async (_, _) =>
        {
            _approvalDialog = null;
            if (!dialog.Withdrawn && ReferenceEquals(_runtime, source) && _running && _pendingDecisions.Contains(identifier))
            {
                var allow = dialog.DialogResult == DialogResult.Yes;
                // A successful pipe write is not an authorization result.
                SetStatus(L10n.T(Msg.StatusDecisionSent));
                try
                {
                    await source.SendControlAsync(isPair ? (allow ? "pair_allow" : "pair_deny") : (allow ? "foreground_allow" : "foreground_deny"),
                        clientId: isPair ? identifier : null, sessionId: isPair ? null : identifier);
                }
                catch { if (ReferenceEquals(_runtime, source)) await StopAsync(L10n.T(Msg.StatusSendDecisionFailed)); }
            }
            PresentNextAlert();
        };
        dialog.Show(_window);
    }

    private static string String(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private static bool Flag(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private async Task ControlAsync(string command, string status, string? clientId = null, string? sessionId = null)
    {
        if (!_running || _runtime is null) return;
        try { await _runtime.SendControlAsync(command, clientId, sessionId); SetStatus(status); }
        catch { await StopAsync(L10n.T(Msg.StatusSendControlFailed)); }
    }

    // MARK: 设置窗口与托盘菜单的操作

    public async Task TogglePauseAsync()
    {
        if (!IsRunning) return;
        var resume = _paused;
        await ControlAsync(resume ? "resume" : "pause", L10n.T(resume ? Msg.StatusReady : Msg.StatusPaused));
        if (IsRunning) _paused = !resume;
        StateChanged();
    }

    public Task EmergencyStopAsync() => StopAsync(L10n.T(Msg.StatusEmergencyStopped));
    public Task RestartServicesAsync() => RestartAsync();
    public Task RevokeAsync(string clientId) => ControlAsync("revoke", L10n.T(Msg.StatusRevoked), clientId: clientId);

    public async Task SetHttpAsync(bool enabled)
    {
        if (!IsRunning || enabled == _httpEnabled)
        {
            StateChanged();
            return;
        }
        try
        {
            await _runtime!.SendControlAsync(enabled ? "http_enable" : "http_disable");
            _httpEnabled = enabled;
            _httpStatus = null;
            StateChanged();
        }
        catch { await StopAsync(L10n.T(Msg.StatusHttpFailed)); }
    }

    private async Task RestartAsync()
    {
        await StopAsync(L10n.T(Msg.StatusRestarting));
        await StartAsync();
    }

    private async Task StopAsync(string status)
    {
        if (_busy) { _stopAfterStart = status; return; }
        _busy = true;
        _running = false;
        _paused = false;
        _httpEnabled = false;
        _httpStatus = null;
        _clients = Array.Empty<ClientInfo>();
        _alerts.Clear();
        _pendingDecisions.Clear();
        _approvalDialog?.Withdraw();
        SetStatus(status);
        var current = _runtime;
        _runtime = null;
        try { if (current is not null) await current.DisposeAsync(); }
        finally
        {
            _busy = false;
            StateChanged();
        }
    }

    private async Task ExitAsync()
    {
        if (_exiting) return;
        _exiting = true;
        _showRegistration?.Unregister(null);
        Updates.Dispose();
        await StopAsync(L10n.T(Msg.StatusQuitting));
        _tray.Visible = false;
        _tray.Dispose();
        _window.Dispose();
        ExitThread();
    }
}

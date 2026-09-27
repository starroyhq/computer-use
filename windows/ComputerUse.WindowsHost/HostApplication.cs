using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal sealed class HostApplication : ApplicationContext
{
    private readonly Form _window;
    private readonly Label _details;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _httpItem;
    private readonly ToolStripMenuItem _clientsMenu;
    private readonly Queue<JsonElement> _alerts = new();
    private HostRuntime? _runtime;
    private bool _running;
    private bool _busy;
    private bool _exiting;
    private ApprovalDialog? _approvalDialog;
    private readonly HashSet<string> _pendingDecisions = new();
    private bool _httpEnabled;
    private string? _stopAfterStart;
    private string _status = "正在启动…";

    internal HostApplication()
    {
        _window = new Form
        {
            Text = "Computer Use — Windows 状态",
            Width = 720,
            Height = 260,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedSingle,
            MaximizeBox = false
        };
        MainForm = _window;
        _details = new Label { AutoSize = false, Dock = DockStyle.Top, Height = 130, Padding = new Padding(18, 22, 18, 8), Font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, 11) };
        _window.Controls.Add(_details);
        var row = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 72, Padding = new Padding(14, 6, 10, 5) };
        AddButton(row, "暂停", async () => await ControlAsync("pause", "已暂停新动作"));
        AddButton(row, "恢复", async () => await ControlAsync("resume", "已恢复接收动作"));
        AddButton(row, "紧急停止", async () => await StopAsync("紧急停止；请手动重启服务"));
        AddButton(row, "重新启动", RestartAsync);
        AddButton(row, "切换本机 HTTP MCP", ToggleHttpAsync);
        _window.Controls.Add(row);

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开状态窗口", null, (_, _) => ShowStatus());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("暂停新动作", null, async (_, _) => await ControlAsync("pause", "已暂停新动作"));
        menu.Items.Add("恢复接收动作", null, async (_, _) => await ControlAsync("resume", "已恢复接收动作"));
        menu.Items.Add("紧急停止", null, async (_, _) => await StopAsync("紧急停止；请手动重启服务"));
        menu.Items.Add("重新启动服务", null, async (_, _) => await RestartAsync());
        menu.Items.Add(new ToolStripSeparator());
        _httpItem = new ToolStripMenuItem("启用 Windows 本机 HTTP MCP", null, async (_, _) => await ToggleHttpAsync());
        menu.Items.Add(_httpItem);
        _clientsMenu = new ToolStripMenuItem("撤销客户端");
        menu.Items.Add(_clientsMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 Computer Use", null, async (_, _) => await ExitAsync());
        _tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Computer Use", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => ShowStatus();

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
                _runtime?.DisposeAsync().AsTask().GetAwaiter().GetResult();
                _tray.Visible = false;
            }
        };
        _window.Shown += async (_, _) => await StartAsync();
        _window.Show();
        RefreshStatus();
    }

    private void AddButton(FlowLayoutPanel panel, string caption, Func<Task> click)
    {
        var button = new Button { Text = caption, AutoSize = true, Height = 36 };
        button.Click += async (_, _) => await click();
        panel.Controls.Add(button);
    }

    private void ShowStatus()
    {
        _window.Show();
        _window.WindowState = FormWindowState.Normal;
        _window.Activate();
        RefreshStatus();
    }

    private void RefreshStatus()
    {
        _details.Text = $"服务：{_status}\n本机 HTTP MCP：{(_httpEnabled ? "已请求启用（127.0.0.1:47631）" : "关闭")}\n" +
            $"CLI 管道：{(_running && _runtime is not null ? _runtime.PipeName : "未就绪")}\n" +
            "关闭此窗口后服务仍在托盘运行；截图能力需由 Agent 实际验证。";
        _tray.Text = _status.Length > 40 ? "Computer Use" : $"Computer Use · {_status}";
        _httpItem.Checked = _httpEnabled;
    }

    private void SetStatus(string value)
    {
        _status = value.Length > 160 ? value[..160] : value;
        RefreshStatus();
    }

    private async Task StartAsync()
    {
        if (_busy || _runtime is not null) return;
        _busy = true;
        SetStatus("正在启动统一运行时…");
        HostRuntime? next = null;
        try
        {
            next = new HostRuntime(message => PostEvent(next, message));
            _runtime = next;
            await next.StartAsync();
            _running = true;
            SetStatus("就绪 · 后台优先");
        }
        catch (Exception error)
        {
            _runtime = null;
            _running = false;
            if (next is not null) await next.DisposeAsync();
            SetStatus("启动失败：" + error.Message);
            MessageBox.Show(_window, error.Message, "Computer Use 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _busy = false;
            if (_stopAfterStart is { } stopStatus)
            {
                _stopAfterStart = null;
                await StopAsync(stopStatus);
            }
        }
    }

    private void PostEvent(HostRuntime? source, JsonElement message)
    {
        if (_window.IsDisposed) return;
        try { _window.BeginInvoke((Action)(() => { if (ReferenceEquals(_runtime, source) && !_exiting) HandleEvent(message); })); }
        catch (InvalidOperationException) { }
    }

    private void HandleEvent(JsonElement message)
    {
        if (!message.TryGetProperty("event", out var eventValue)) return;
        switch (eventValue.GetString())
        {
            case "ready": _running = true; SetStatus("就绪 · 后台优先"); break;
            case "status":
                var status = String(message, "message");
                if (status.Contains("could not start", StringComparison.OrdinalIgnoreCase)) _httpEnabled = false;
                SetStatus(status);
                break;
            case "fatal": _ = StopAsync("服务异常：" + String(message, "message")); break;
            case "clients": RebuildClientMenu(message); break;
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
                    ? "已批准请求" : "请求已拒绝、过期或失效；未授权");
                if (_approvalDialog?.RequestId == requestId) _approvalDialog.Withdraw();
                PresentNextAlert();
                break;
            default: _ = StopAsync("运行时返回了未知事件"); break;
        }
    }

    private void RebuildClientMenu(JsonElement message)
    {
        _clientsMenu.DropDownItems.Clear();
        if (!message.TryGetProperty("clients", out var clients) || clients.ValueKind != JsonValueKind.Array) return;
        foreach (var client in clients.EnumerateArray())
        {
            var id = String(client, "id");
            var name = String(client, "name");
            if (id.Length == 0) continue;
            var entry = new ToolStripMenuItem(name.Length <= 80 ? name : name[..80]);
            entry.Click += async (_, _) => await ControlAsync("revoke", "已撤销客户端", clientId: id);
            _clientsMenu.DropDownItems.Add(entry);
        }
        if (_clientsMenu.DropDownItems.Count == 0) _clientsMenu.DropDownItems.Add("尚无已配对客户端").Enabled = false;
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
        if (identifier.Length == 0) { _ = StopAsync("运行时请求缺少授权标识"); return; }
        string explanation;
        if (isPair)
        {
            var apps = request.TryGetProperty("appIds", out var appIds) && appIds.ValueKind == JsonValueKind.Array
                ? string.Join("\n", appIds.EnumerateArray().Take(20).Select(value => value.GetString())) : "";
            explanation = $"客户端：{String(request, "name")}\n标识：{identifier}\n应用路径：\n{(apps.Length == 0 ? "无" : apps)}\n独立浏览器：{(request.TryGetProperty("browser", out var browser) && browser.ValueKind == JsonValueKind.True ? "允许" : "不允许")}\n\n默认使用后台操作；前台操作另行确认。";
        }
        else explanation = $"客户端：{String(request, "clientName")}\n目标：{String(request, "targetTitle")}\n会话：{identifier}\n\n此操作可能切换焦点并移动鼠标。授权仅适用于当前会话和目标。";
        var dialog = new ApprovalDialog(identifier, isPair ? "允许客户端操作这些应用？" : "允许当前会话使用前台操作？", explanation);
        _approvalDialog = dialog;
        dialog.FormClosed += async (_, _) =>
        {
            _approvalDialog = null;
            if (!dialog.Withdrawn && ReferenceEquals(_runtime, source) && _running && _pendingDecisions.Contains(identifier))
            {
                var allow = dialog.DialogResult == DialogResult.Yes;
                // A successful pipe write is not an authorization result.
                SetStatus("已提交决定，等待运行时确认…");
                try
                {
                    await source.SendControlAsync(isPair ? (allow ? "pair_allow" : "pair_deny") : (allow ? "foreground_allow" : "foreground_deny"),
                        clientId: isPair ? identifier : null, sessionId: isPair ? null : identifier);
                }
                catch { if (ReferenceEquals(_runtime, source)) await StopAsync("无法向运行时发送授权决定"); }
            }
            PresentNextAlert();
        };
        dialog.Show(_window);
    }

    private static string String(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private async Task ControlAsync(string command, string status, string? clientId = null, string? sessionId = null)
    {
        if (!_running || _runtime is null) return;
        try { await _runtime.SendControlAsync(command, clientId, sessionId); SetStatus(status); }
        catch { await StopAsync("无法向运行时发送控制指令"); }
    }

    private async Task ToggleHttpAsync()
    {
        if (!_running || _runtime is null) return;
        var enable = !_httpEnabled;
        try
        {
            await _runtime.SendControlAsync(enable ? "http_enable" : "http_disable");
            _httpEnabled = enable;
            RefreshStatus();
        }
        catch { await StopAsync("无法切换本机 HTTP MCP"); }
    }

    private async Task RestartAsync()
    {
        await StopAsync("正在重新启动…");
        await StartAsync();
    }

    private async Task StopAsync(string status)
    {
        if (_busy) { _stopAfterStart = status; return; }
        _busy = true;
        _running = false;
        _httpEnabled = false;
        _alerts.Clear();
        _pendingDecisions.Clear();
        _approvalDialog?.Withdraw();
        SetStatus(status);
        var current = _runtime;
        _runtime = null;
        try { if (current is not null) await current.DisposeAsync(); }
        finally { _busy = false; }
    }

    private async Task ExitAsync()
    {
        if (_exiting) return;
        _exiting = true;
        await StopAsync("正在退出…");
        _tray.Visible = false;
        _tray.Dispose();
        _window.Dispose();
        ExitThread();
    }
}

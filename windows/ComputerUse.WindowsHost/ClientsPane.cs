using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

/// <summary>客户端卡片直接呈现授权入口；精确范围与撤销留在默认收起的高级区。</summary>
internal sealed class ClientsPane : VerticalStack
{
    private readonly ISettingsHost _host;
    private readonly Func<string, string, bool> _confirmGrant;
    private readonly Func<string, string, bool> _confirmRevoke;
    private readonly VerticalStack _cards = new();
    private readonly Label _placeholder = Note();
    private readonly Dictionary<string, ClientCard> _cardsById = new(StringComparer.Ordinal);
    private readonly HashSet<string> _expanded = new(StringComparer.Ordinal);
    // The host exposes per-client results. Remember their owners so a removed
    // client's final result survives without moving a filtered card's feedback.
    private readonly Dictionary<string, string> _feedbackOwners = new(StringComparer.Ordinal);
    private string[] _displayedIds = Array.Empty<string>();
    private long _revision;

    internal TextBox SearchField { get; } = new()
    {
        Name = "clients-search", Margin = new Padding(0, 0, 0, 16)
    };
    internal IReadOnlyList<string> DisplayedClientIds => _displayedIds;
    internal Label FallbackFeedback { get; } = Note();

    internal ClientsPane(ISettingsHost host, Func<string, string, bool> confirmGrant,
        Func<string, string, bool> confirmRevoke, Action connect)
    {
        _host = host;
        _confirmGrant = confirmGrant;
        _confirmRevoke = confirmRevoke;
        _revision = host.GrantRevision;
        Name = "clients-pane";
        SearchField.PlaceholderText = L10n.T(Msg.ClientsSearchPlaceholder);
        SearchField.AccessibleName = SearchField.PlaceholderText;
        SearchField.TextChanged += (_, _) => Refresh();
        var add = Button(Msg.ConnectAddClient, ButtonTone.Primary);
        add.Name = "clients-connect";
        add.Click += (_, _) => connect();
        Add(Actions(add));
        Add(SearchField);
        Add(_cards);
        _placeholder.Name = "clients-placeholder";
        Add(_placeholder);
        FallbackFeedback.Name = "clients-grant-feedback";
        Add(FallbackFeedback);
        Add(Note(L10n.T(Msg.ClientsHint)));
    }

    internal ClientCard? CardFor(string id) => _displayedIds.Contains(id, StringComparer.Ordinal)
        ? _cardsById.GetValueOrDefault(id) : null;

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            // Filtered cards are detached from Controls and still owned here.
            foreach (var card in _cardsById.Values) card.Dispose();
            _cardsById.Clear();
        }
        base.Dispose(disposing);
    }

    public override void Refresh()
    {
        if (IsDisposed) return;
        var all = _host.IsRunning ? _host.Clients : Array.Empty<ClientInfo>();
        var ids = all.Select(client => client.Id).ToHashSet(StringComparer.Ordinal);
        if (_revision != _host.GrantRevision)
        {
            _feedbackOwners.Clear();
            _revision = _host.GrantRevision;
        }
        _expanded.IntersectWith(ids);
        var query = SearchField.Text.Trim();
        var visible = all.Where(client => query.Length == 0 || Matches(client, query)).ToArray();
        // This must use the complete list, including cards hidden by search.
        var pending = HasPendingGrant();
        SuspendLayout();
        _cards.SuspendLayout();
        try
        {
            foreach (var client in all)
            {
                var state = _host.GrantState(client.Id);
                if (state != ClientGrantState.Idle) _feedbackOwners[client.Id] = client.Name;
                if (!_cardsById.TryGetValue(client.Id, out var card))
                {
                    var id = client.Id;
                    card = new ClientCard(id);
                    card.GrantButton.Click += async (_, _) => await GrantAsync(id);
                    card.RevokeButton.Click += async (_, _) => await RevokeAsync(id);
                    card.AdvancedButton.Click += (_, _) => ToggleAdvanced(id);
                    _cardsById.Add(id, card);
                }
                card.Update(client, state, _host.IsRunning, _host.IsBusy, pending, _expanded.Contains(client.Id));
            }
            foreach (var id in _cardsById.Keys.Where(id => !ids.Contains(id)).ToArray())
            {
                var removed = _cardsById[id];
                _cardsById.Remove(id);
                removed.Dispose();
            }
            var next = visible.Select(client => client.Id).ToArray();
            if (!_displayedIds.SequenceEqual(next, StringComparer.Ordinal))
            {
                _cards.Controls.Clear();
                _cards.RowStyles.Clear();
                _cards.RowCount = 0;
                foreach (var id in next) _cards.Add(_cardsById[id]);
                _displayedIds = next;
            }
            _cards.Visible = next.Length > 0;
            _placeholder.Text = !_host.IsRunning ? L10n.T(Msg.ClientsNotRunning)
                : all.Count == 0 ? L10n.T(Msg.ClientsEmpty)
                : next.Length == 0 ? L10n.T(Msg.ClientsNoMatches) : "";
            _placeholder.Visible = _placeholder.Text.Length > 0;
            SearchField.Enabled = _host.IsRunning && all.Count > 0;
            RefreshFallback(ids);
        }
        finally
        {
            _cards.ResumeLayout(true);
            ResumeLayout(true);
        }
        base.Refresh();
    }

    private void RefreshFallback(IReadOnlySet<string> ids)
    {
        var messages = new List<string>();
        foreach (var (id, name) in _feedbackOwners.ToArray())
        {
            var state = _host.GrantState(id);
            if (state == ClientGrantState.Idle)
            {
                _feedbackOwners.Remove(id);
                continue;
            }
            if (!ids.Contains(id) && state != ClientGrantState.Pending)
                messages.Add(L10n.F(Msg.ClientsFallbackFeedback, name, HostApplication.ShortId(id), Feedback(state)));
        }
        FallbackFeedback.Text = string.Join("\n", messages);
        FallbackFeedback.Visible = messages.Count > 0;
    }

    private void ToggleAdvanced(string id)
    {
        if (!_cardsById.ContainsKey(id)) return;
        if (!_expanded.Remove(id)) _expanded.Add(id);
        Refresh();
    }

    private bool HasPendingGrant() => _host.Clients.Select(client => client.Id).Concat(_feedbackOwners.Keys)
        .Any(id => _host.GrantState(id) == ClientGrantState.Pending);

    private bool CanGrant(string id) => _host.IsRunning && !_host.IsBusy
        && !HasPendingGrant()
        && _host.Clients.Any(client => client.Id == id && CanUpgrade(client));

    private async Task GrantAsync(string id)
    {
        if (!CanGrant(id)) return;
        var client = _host.Clients.First(client => client.Id == id);
        var revision = _host.GrantRevision;
        if (!_confirmGrant(L10n.F(Msg.ClientsGrantTitle, client.Name), L10n.T(Msg.ClientsGrantBody))) return;
        // A modal confirmation runs a nested message loop. Restart, revoke or
        // another grant may have changed the owner or eligibility meanwhile.
        if (IsDisposed || revision != _host.GrantRevision || !CanGrant(id)) return;
        _feedbackOwners[id] = client.Name;
        var request = _host.GrantAllAppsAsync(id, revision);
        Refresh();
        await request;
        if (!IsDisposed && revision == _host.GrantRevision) Refresh();
    }

    private async Task RevokeAsync(string id)
    {
        if (!_host.IsRunning || _host.Clients.FirstOrDefault(client => client.Id == id) is not { } client) return;
        var revision = _host.GrantRevision;
        if (!_confirmRevoke(L10n.F(Msg.ClientsRevokeTitle, client.Name), L10n.T(Msg.ClientsRevokeBody))) return;
        if (IsDisposed || revision != _host.GrantRevision || !_host.IsRunning
            || !_host.Clients.Any(client => client.Id == id)) return;
        _expanded.Remove(id);
        var request = _host.RevokeAsync(id);
        Refresh();
        await request;
        if (!IsDisposed && revision == _host.GrantRevision) Refresh();
    }

    internal static bool CanUpgrade(ClientInfo client) => (client.AllApps || client.AppIds.Count > 0)
        && !(client.AllApps && client.Foreground);

    private static bool Matches(ClientInfo client, string query) =>
        new[] { client.Name, client.Id, HostApplication.ShortId(client.Id) }
            .Concat(client.AppIds).Concat(client.AppIds.Select(SettingsForm.DisplayAppId))
            .Any(value => CultureInfo.CurrentCulture.CompareInfo.IndexOf(value, query,
                CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0);

    internal static string Feedback(ClientGrantState state) => state switch
    {
        ClientGrantState.Pending => L10n.T(Msg.ClientsGrantPending),
        ClientGrantState.Succeeded => L10n.T(Msg.ClientsGrantSucceeded),
        ClientGrantState.Failed => L10n.T(Msg.ClientsGrantFailed),
        ClientGrantState.Missing => L10n.T(Msg.ClientsGrantMissing),
        ClientGrantState.SaveFailed => L10n.T(Msg.ClientsGrantSaveFailed),
        ClientGrantState.Unconfirmed => L10n.T(Msg.ClientsGrantUnconfirmed),
        _ => ""
    };

    internal static Label Note(string text = "") => new()
    {
        Text = text, AutoSize = true, UseMnemonic = false, ForeColor = UiStyle.Muted,
        Margin = new Padding(0, 0, 0, 10)
    };

    internal static Button Button(Msg text, ButtonTone tone = ButtonTone.Normal)
    {
        var button = new Button { Text = L10n.T(text) };
        UiStyle.StyleButton(button, tone);
        return button;
    }

    internal static FlowLayoutPanel Actions(params Control[] controls)
    {
        var actions = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 2, 0, 4)
        };
        actions.Controls.AddRange(controls);
        return actions;
    }
}

/// <summary>由现有自动尺寸栈按实际换行高度排布，不缓存卡片高度。</summary>
internal sealed class ClientCard : VerticalStack
{
    private readonly Label _name = ClientsPane.Note();
    private readonly Label _restrictedNote = ClientsPane.Note();
    private readonly VerticalStack _advanced = new();

    internal string ClientId { get; }
    internal Button GrantButton { get; } = ClientsPane.Button(Msg.ClientsGrantAllApps, ButtonTone.Primary);
    internal Label StatusLabel { get; } = ClientsPane.Note();
    internal Label SummaryLabel { get; } = ClientsPane.Note();
    internal Label IdLabel { get; } = ClientsPane.Note();
    internal Label ScopeLabel { get; } = ClientsPane.Note();
    internal Label FeedbackLabel { get; } = ClientsPane.Note();
    internal Label BadgeLabel { get; } = ClientsPane.Note();
    internal Button AdvancedButton { get; } = ClientsPane.Button(Msg.ClientsAdvanced);
    internal Control AdvancedPanel => _advanced;
    internal Button RevokeButton { get; } = ClientsPane.Button(Msg.ClientsRevoke, ButtonTone.Danger);
    internal bool Expanded { get; private set; }

    internal ClientCard(string clientId)
    {
        ClientId = clientId;
        Name = "clients-card-" + clientId;
        Padding = new Padding(16);
        Margin = new Padding(0, 0, 0, 16);
        BackColor = UiStyle.Surface;
        _name.Name = "clients-name-" + clientId;
        _name.Font = UiStyle.SectionFont;
        _name.ForeColor = UiStyle.Text;
        IdLabel.Name = "clients-id-" + clientId;
        BadgeLabel.Name = "clients-badge-" + clientId;
        BadgeLabel.ForeColor = UiStyle.Accent;
        SummaryLabel.Name = "clients-summary-" + clientId;
        GrantButton.Name = "clients-grant-" + clientId;
        StatusLabel.Name = "clients-status-" + clientId;
        AdvancedButton.Name = "clients-advanced-toggle-" + clientId;
        FeedbackLabel.Name = "clients-feedback-" + clientId;
        ScopeLabel.Name = "clients-scope-" + clientId;
        _advanced.Name = "clients-advanced-" + clientId;
        RevokeButton.Name = "clients-revoke-" + clientId;
        _restrictedNote.Text = L10n.T(Msg.ClientsRestrictedNote);
        _advanced.Add(ScopeLabel);
        _advanced.Add(_restrictedNote);
        _advanced.Add(ClientsPane.Actions(RevokeButton));
        Add(_name);
        Add(IdLabel);
        Add(BadgeLabel);
        Add(SummaryLabel);
        Add(StatusLabel);
        Add(ClientsPane.Actions(GrantButton, AdvancedButton));
        Add(FeedbackLabel);
        Add(_advanced);
    }

    internal void Update(ClientInfo client, ClientGrantState state, bool running, bool busy, bool anyPending, bool expanded)
    {
        SuspendLayout();
        try
        {
            _name.Text = client.Name;
            IdLabel.Text = L10n.F(Msg.ClientsDetailLine, L10n.T(Msg.ClientsId), HostApplication.ShortId(client.Id));
            var desktop = client.AllApps ? L10n.T(Msg.ClientsAllApps)
                : client.AppIds.Count > 0 ? L10n.F(Msg.ClientsAppCount, client.AppIds.Count) : L10n.T(Msg.ClientsNo);
            BadgeLabel.Text = client.AllApps ? L10n.T(Msg.ClientsAllApps)
                : client.AppIds.Count > 0 ? L10n.F(Msg.ClientsBadgeRestricted, client.AppIds.Count)
                : client.Browser ? L10n.T(Msg.ClientsBadgeBrowserOnly) : L10n.T(Msg.ClientsNo);
            var browser = L10n.T(client.Browser ? Msg.ClientsYes : Msg.ClientsNo);
            var foreground = L10n.T(client.Foreground ? Msg.ClientsYes : Msg.ClientsNo);
            SummaryLabel.Text = L10n.F(Msg.ClientsSummary, desktop, browser, foreground);
            var canUpgrade = ClientsPane.CanUpgrade(client);
            GrantButton.Visible = canUpgrade;
            GrantButton.Text = L10n.T(state == ClientGrantState.Pending ? Msg.ClientsGrantPending : Msg.ClientsGrantAllApps);
            GrantButton.AccessibleName = GrantButton.Text;
            GrantButton.Enabled = running && !busy && !anyPending && canUpgrade;
            StatusLabel.Text = client.AllApps && client.Foreground ? L10n.T(Msg.ClientsGranted)
                : canUpgrade ? "" : L10n.T(client.Browser ? Msg.ClientsBrowserOnlyHint : Msg.ClientsUnavailableHint);
            StatusLabel.Visible = StatusLabel.Text.Length > 0;
            StatusLabel.ForeColor = client.AllApps && client.Foreground ? UiStyle.Accent : UiStyle.Muted;
            FeedbackLabel.Text = ClientsPane.Feedback(state);
            FeedbackLabel.Visible = FeedbackLabel.Text.Length > 0;
            FeedbackLabel.ForeColor = state is ClientGrantState.Failed or ClientGrantState.SaveFailed or ClientGrantState.Missing
                ? UiStyle.Danger : state == ClientGrantState.Succeeded ? UiStyle.Accent : UiStyle.Muted;
            var apps = client.AllApps ? L10n.T(Msg.ClientsAllApps)
                : client.AppIds.Count == 0 ? L10n.T(Msg.ClientsNo)
                : string.Join("\n", client.AppIds.Select(SettingsForm.DisplayAppId));
            ScopeLabel.Text = string.Join("\n", new[]
            {
                L10n.F(Msg.ClientsDetailLine, L10n.T(Msg.ClientsDesktopApps), apps),
                L10n.F(Msg.ClientsDetailLine, L10n.T(Msg.ClientsBrowser), browser),
                L10n.F(Msg.ClientsDetailLine, L10n.T(Msg.ClientsForeground), foreground),
                L10n.F(Msg.ClientsDetailLine, L10n.T(Msg.ClientsId), client.Id)
            });
            Expanded = expanded;
            _advanced.Visible = expanded;
            AdvancedButton.Text = L10n.T(Msg.ClientsAdvanced) + (expanded ? " ▴" : " ▾");
            AdvancedButton.AccessibleDescription = L10n.T(expanded ? Msg.DetailsExpanded : Msg.DetailsCollapsed);
            RevokeButton.Enabled = running;
        }
        finally { ResumeLayout(true); }
    }
}

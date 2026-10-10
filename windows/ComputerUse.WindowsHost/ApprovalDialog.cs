using System.Drawing;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal sealed record ApprovalSection(string Title, string Value, string? Detail = null);

internal sealed record ApprovalDetails(string Title, string ClientName, string IdentifierLabel, string Identifier,
    IReadOnlyList<ApprovalSection> Sections);

// Owned, modeless dialog: runtime expiry/stop can dismiss it without waiting
// for a user response, and emergency controls remain reachable.
internal sealed class ApprovalDialog : Form
{
    private readonly List<Label> _displayedText = new();
    private readonly List<TableLayoutPanel> _cards = new();

    internal string RequestId { get; }
    internal bool Withdrawn { get; private set; }
    internal Button AllowButton { get; }
    internal Button DenyButton { get; }
    internal Panel ContentViewport { get; }
    internal string ExplanationText => string.Join("\n", _displayedText.Select(label => label.Text));

    internal ApprovalDialog(string requestId, ApprovalDetails details)
    {
        RequestId = requestId;
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = details.Title;
        Font = new Font(SystemFonts.MessageBoxFont!.FontFamily, 9.5F);
        BackColor = UiStyle.Background;
        ForeColor = UiStyle.Text;
        ClientSize = new Size(680, 680);
        MinimumSize = new Size(540, 440);
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        FormBorderStyle = FormBorderStyle.Sizable;
        SizeGripStyle = SizeGripStyle.Show;

        ContentViewport = new FlowLayoutPanel
        {
            Name = "ApprovalContent", Dock = DockStyle.Fill, AutoScroll = true,
            FlowDirection = FlowDirection.TopDown, WrapContents = false,
            Padding = new Padding(24), BackColor = UiStyle.Background,
        };
        var heading = CreateCard(surface: false);
        AddText(heading, details.Title, UiStyle.HeadingFont, UiStyle.Text);

        var identity = CreateCard();
        AddText(identity, L10n.T(Msg.ApprovalClient), Font, UiStyle.Muted);
        AddText(identity, details.ClientName, UiStyle.SectionFont, UiStyle.Text);
        AddText(identity, details.IdentifierLabel, Font, UiStyle.Muted, top: 10);
        AddText(identity, details.Identifier, Font, UiStyle.Text);

        var permissions = CreateCard();
        var first = true;
        foreach (var section in details.Sections)
        {
            AddText(permissions, section.Title, UiStyle.SectionFont, UiStyle.Text, top: first ? 0 : 12);
            AddText(permissions, section.Value, Font, UiStyle.Text, top: 4);
            if (!string.IsNullOrEmpty(section.Detail)) AddText(permissions, section.Detail, Font, UiStyle.Muted, top: 4);
            first = false;
        }

        // Decisions remain outside the scrolling content, even for long names and many application paths.
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(24, 16, 24, 16),
            BackColor = UiStyle.Surface,
        };
        DenyButton = new Button { Name = "ApprovalDeny", Text = L10n.T(Msg.ApprovalDeny), DialogResult = DialogResult.No };
        AllowButton = new Button { Name = "ApprovalAllow", Text = L10n.T(Msg.ApprovalAllow), DialogResult = DialogResult.Yes };
        UiStyle.StyleButton(DenyButton);
        UiStyle.StyleButton(AllowButton, ButtonTone.Primary);
        DenyButton.Click += (_, _) => { DialogResult = DialogResult.No; Close(); };
        AllowButton.Click += (_, _) => { DialogResult = DialogResult.Yes; Close(); };
        buttons.Controls.Add(DenyButton);
        buttons.Controls.Add(AllowButton);
        Controls.Add(ContentViewport);
        Controls.Add(buttons);
        AcceptButton = DenyButton;
        CancelButton = DenyButton;
        ContentViewport.ClientSizeChanged += (_, _) => FitContentWidth();
        Shown += (_, _) => { FitContentWidth(); DenyButton.Focus(); };
        ResumeLayout(true);
        FitContentWidth();
    }

    private TableLayoutPanel CreateCard(bool surface = true)
    {
        var card = new TableLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1,
            Padding = surface ? new Padding(16) : Padding.Empty,
            Margin = new Padding(0, 0, 0, 12), BackColor = surface ? UiStyle.Surface : UiStyle.Background,
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        _cards.Add(card);
        ContentViewport.Controls.Add(card);
        return card;
    }

    private void AddText(TableLayoutPanel card, string text, Font font, Color color, int top = 0)
    {
        var label = new Label
        {
            AutoSize = true, Text = text, Font = font, ForeColor = color,
            UseMnemonic = false, AutoEllipsis = false, Margin = new Padding(0, top, 0, 0),
        };
        card.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        card.Controls.Add(label, 0, card.RowCount++);
        _displayedText.Add(label);
    }

    private void FitContentWidth()
    {
        // Reserve the scrollbar width before it appears to avoid a wrap/scrollbar layout loop.
        // No authorization text is shortened: labels wrap and the outer viewport scrolls vertically.
        var width = Math.Max(1, ContentViewport.ClientSize.Width - ContentViewport.Padding.Horizontal
            - SystemInformation.VerticalScrollBarWidth);
        ContentViewport.SuspendLayout();
        foreach (var card in _cards)
        {
            card.SuspendLayout();
            card.MinimumSize = new Size(width, 0);
            card.MaximumSize = new Size(width, 0);
            card.Width = width;
            foreach (var label in card.Controls.OfType<Label>())
                label.MaximumSize = new Size(Math.Max(1, width - card.Padding.Horizontal), 0);
            card.ResumeLayout(true);
        }
        ContentViewport.ResumeLayout(true);
    }

    internal void Withdraw()
    {
        Withdrawn = true;
        Close();
    }
}

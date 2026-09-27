using System.Drawing;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

// Owned, modeless dialog: runtime expiry/stop can dismiss it without waiting
// for a user response, and emergency controls remain reachable.
internal sealed class ApprovalDialog : Form
{
    internal string RequestId { get; }
    internal bool Withdrawn { get; private set; }

    internal ApprovalDialog(string requestId, string title, string explanation)
    {
        RequestId = requestId;
        Text = title;
        Size = new Size(660, 430);
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        var text = new TextBox
        {
            Multiline = true, ReadOnly = true, Dock = DockStyle.Fill,
            ScrollBars = ScrollBars.Vertical, Text = explanation.Replace("\n", "\r\n"),
            BackColor = SystemColors.Control, BorderStyle = BorderStyle.None, TabStop = false
        };
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, FlowDirection = FlowDirection.RightToLeft };
        var deny = new Button { Text = "否", DialogResult = DialogResult.No };
        var allow = new Button { Text = "是", DialogResult = DialogResult.Yes };
        deny.Click += (_, _) => { DialogResult = DialogResult.No; Close(); };
        allow.Click += (_, _) => { DialogResult = DialogResult.Yes; Close(); };
        buttons.Controls.Add(deny);
        buttons.Controls.Add(allow);
        Controls.Add(text);
        Controls.Add(buttons);
        Padding = new Padding(18);
        AcceptButton = deny;
        CancelButton = deny;
        Shown += (_, _) => deny.Focus();
    }

    internal void Withdraw()
    {
        Withdrawn = true;
        Close();
    }
}

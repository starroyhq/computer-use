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
        SuspendLayout();
        // Sizes below are 96-DPI pixels; the form scales them to the display DPI when it is created,
        // so the decision buttons stay fully visible on high-DPI displays.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
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
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 10, 0, 0)
        };
        var deny = new Button { Text = "否", DialogResult = DialogResult.No, AutoSize = true, MinimumSize = new Size(96, 32) };
        var allow = new Button { Text = "是", DialogResult = DialogResult.Yes, AutoSize = true, MinimumSize = new Size(96, 32) };
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
        ResumeLayout(false);
    }

    internal void Withdraw()
    {
        Withdrawn = true;
        Close();
    }
}

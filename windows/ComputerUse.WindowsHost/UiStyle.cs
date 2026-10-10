using System.Drawing;
using System.Windows.Forms;

namespace ComputerUse.WindowsHost;

internal enum ButtonTone { Normal, Primary, Danger }

/// <summary>Shared WinForms styling; no Windows 11 materials or platform-specific controls.</summary>
internal static class UiStyle
{
    internal static Color Background => SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(244, 246, 249);
    internal static Color Surface => SystemColors.Window;
    internal static Color Text => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(32, 42, 57);
    internal static Color Muted => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(88, 101, 120);
    internal static Color Border => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(210, 218, 229);
    internal static Color Accent => SystemInformation.HighContrast ? SystemColors.Highlight : Color.FromArgb(38, 91, 181);
    internal static Color Danger => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(172, 46, 52);
    internal static Font HeadingFont { get; } = new(SystemFonts.MessageBoxFont!.FontFamily, 20F, FontStyle.Bold);
    internal static Font SectionFont { get; } = new(SystemFonts.MessageBoxFont!.FontFamily, 11F, FontStyle.Bold);

    internal static void StyleButton(Button button, ButtonTone tone = ButtonTone.Normal)
    {
        button.AutoSize = true;
        button.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        button.MinimumSize = new Size(88, 34);
        button.Padding = new Padding(12, 4, 12, 4);
        button.Margin = new Padding(0, 0, 8, 8);
        button.UseVisualStyleBackColor = false;
        button.FlatStyle = SystemInformation.HighContrast ? FlatStyle.System : FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = tone == ButtonTone.Danger ? Danger : tone == ButtonTone.Primary ? Accent : Border;
        button.BackColor = tone == ButtonTone.Primary ? Accent : Surface;
        button.ForeColor = tone == ButtonTone.Primary ? SystemColors.HighlightText : tone == ButtonTone.Danger ? Danger : Text;
    }
}

/// <summary>A vertically sized stack that wraps text and action rows to its available width.</summary>
internal sealed class VerticalStack : TableLayoutPanel
{
    internal VerticalStack()
    {
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        ColumnCount = 1;
        ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Dock = DockStyle.Top;
        Margin = Padding.Empty;
        SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
    }

    internal void Add(Control control)
    {
        control.Dock = DockStyle.Top;
        RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(control, 0, RowCount++);
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        var width = Math.Max(1, ClientSize.Width - Padding.Horizontal);
        foreach (Control child in Controls)
        {
            var available = Math.Max(1, width - child.Margin.Horizontal);
            if (child is Label or CheckBox or FlowLayoutPanel)
                child.MaximumSize = new Size(available, 0);
        }
        base.OnLayout(e);
    }
}

using System.Windows;
using System.Windows.Input;
using FluentTimer.App.Services;

namespace FluentTimer.App.Views;

/// <summary>
/// Small rename box opened from the widget. The widget itself never takes keyboard focus (so clicking it
/// doesn't steal focus from your work), so typing a name happens in this separate, focusable window.
/// </summary>
public partial class RenameWindow : Window
{
    private readonly AppHost _host;
    private readonly Guid _timerId;
    private bool _closing;

    internal RenameWindow(AppHost host, Guid timerId, Rect nearWorkArea)
    {
        _host = host;
        _timerId = timerId;
        InitializeComponent();

        var timer = host.Timers.FirstOrDefault(t => t.Id == timerId);
        NameBox.Text = timer?.Name ?? "";
        Heading.Text = string.IsNullOrEmpty(timer?.Name) ? "Name this timer" : "Rename timer";

        Left = nearWorkArea.Left + (nearWorkArea.Width - Width) / 2;
        Top = nearWorkArea.Top + nearWorkArea.Height * 0.25;

        Loaded += (_, _) =>
        {
            Activate();
            NameBox.Focus();
            Keyboard.Focus(NameBox);
            NameBox.SelectAll();
        };
        Deactivated += (_, _) => CloseOnce();
    }

    private void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { Save(); e.Handled = true; }
        else if (e.Key == Key.Escape) { CloseOnce(); e.Handled = true; }
    }

    private void OnSave(object sender, RoutedEventArgs e) => Save();

    private void Save()
    {
        _host.Act(en => en.Rename(_timerId, NameBox.Text));
        CloseOnce();
    }

    private void CloseOnce()
    {
        if (_closing) return;
        _closing = true;
        Close();
    }
}

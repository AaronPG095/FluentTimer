using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using FluentTimer.App.Services;
using FluentTimer.App.Views.Pages;
using Wpf.Ui.Controls;

namespace FluentTimer.App.Views;

public partial class MainWindow : FluentWindow
{
    private readonly AppHost _host;
    private readonly Dictionary<string, Func<UserControl>> _factories;
    private readonly Dictionary<string, UserControl> _pages = [];
    private bool _allowClose;

    internal MainWindow(AppHost host)
    {
        _host = host;
        InitializeComponent();
        _factories = new()
        {
            ["Timers"] = () => new TimersPage(host),
            ["Reminders"] = () => new RemindersPage(host),
            ["History"] = () => new HistoryPage(host),
            ["Settings"] = () => new SettingsPage(host),
        };
        Nav.SelectedIndex = 0;
        HotkeyBadge.Text = host.Settings.Hotkey;
        host.SettingsApplied += () => HotkeyBadge.Text = host.Settings.Hotkey;
    }

    public void Navigate(string page)
    {
        foreach (ListBoxItem item in Nav.Items)
            if ((string)item.Tag == page) Nav.SelectedItem = item;
    }

    public void AllowClose() => _allowClose = true;

    private void OnNavChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Nav.SelectedItem is not ListBoxItem { Tag: string key }) return;
        if (!_pages.TryGetValue(key, out var page))
        {
            page = _factories[key]();
            _pages[key] = page;
        }
        PageHost.Content = page;
    }

    /// <summary>Closing the window keeps the app running in the tray.</summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_allowClose)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }
}

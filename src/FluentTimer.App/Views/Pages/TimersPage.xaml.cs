using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.Views.Pages;

public partial class TimersPage : UserControl
{
    private readonly AppHost _host;

    internal TimersPage(AppHost host)
    {
        _host = host;
        InitializeComponent();
        TimerItems.ItemsSource = host.Timers;
        host.Timers.CollectionChanged += (_, _) => UpdateEmpty();
        host.SettingsApplied += BuildPresets;
        BuildPresets();
        UpdateEmpty();
    }

    private void BuildPresets()
    {
        Presets.Children.Clear();
        foreach (var m in _host.Settings.PresetMinutes)
            Presets.Children.Add(PresetButton($"{m} min", () => _host.StartCountdown(TimeSpan.FromMinutes(m), Quick.Text.Trim())));
        var p = _host.Settings.Pomodoro;
        Presets.Children.Add(PresetButton($"Pomodoro {p.WorkMinutes}/{p.ShortBreakMinutes}", () => _host.StartPomodoro(Quick.Text.Trim())));
        HotkeyRun.Text = _host.Settings.Hotkey;
    }

    private Button PresetButton(string text, Action start)
    {
        var b = new Button { Content = text, Style = (Style)FindResource("ChipButton"), Margin = new Thickness(0, 0, 6, 6) };
        b.Click += (_, _) =>
        {
            start();
            Quick.Clear();
        };
        return b;
    }

    private void UpdateEmpty() => Empty.Visibility = _host.Timers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

    private void OnQuickChanged(object sender, TextChangedEventArgs e)
    {
        QuickPreview.Text = string.IsNullOrWhiteSpace(Quick.Text)
            ? "Type a duration and an optional label. Add a time with 'at' for an alarm."
            : QuickEntryParser.TryParse(Quick.Text, out var entry)
                ? $"Enter →{AppHost.Describe(entry)}"
                : "Not understood yet. Try 25m, 1h30, 90s, 5:00, at 14:30, 2pm, pomo";
    }

    private void OnQuickKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        OnQuickStart(sender, e);
    }

    private void OnQuickStart(object sender, RoutedEventArgs e)
    {
        if (!QuickEntryParser.TryParse(Quick.Text, out var entry)) return;
        QuickPreview.Text = _host.Run(entry);
        Quick.Clear();
    }

    /// <summary>Enter saves the name (by leaving the box), Esc puts the old name back.</summary>
    private void OnNameKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox box || e.Key is not (Key.Enter or Key.Escape)) return;
        var binding = box.GetBindingExpression(TextBox.TextProperty);
        if (e.Key == Key.Enter) binding?.UpdateSource();
        else binding?.UpdateTarget(); // Esc: back to the saved name
        e.Handled = true;
        Quick.Focus(); // leave the box so it reads as plain text again
    }

    private static Guid Id(object sender) => (Guid)((FrameworkElement)sender).Tag;

    private void OnPause(object sender, RoutedEventArgs e) => _host.Act(en => en.TogglePause(Id(sender)));
    private void OnReset(object sender, RoutedEventArgs e) => _host.Act(en => en.Reset(Id(sender)));
    private void OnAdd1(object sender, RoutedEventArgs e) => _host.Act(en => en.AddTime(Id(sender), TimeSpan.FromMinutes(1)));
    private void OnAdd5(object sender, RoutedEventArgs e) => _host.Act(en => en.AddTime(Id(sender), TimeSpan.FromMinutes(5)));
    private void OnSkip(object sender, RoutedEventArgs e) => _host.Act(en => en.SkipPhase(Id(sender)));
    private void OnCancel(object sender, RoutedEventArgs e) => _host.Act(en => en.Cancel(Id(sender)));
}

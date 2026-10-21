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
        host.SavedTimersChanged += SyncSaved;
        BuildPresets();
        UpdateEmpty();
        SavedItems.ItemsSource = _saved;
        SyncSaved();
    }

    // ---- Saved timers -----------------------------------------------------------------------

    private readonly System.Collections.ObjectModel.ObservableCollection<ViewModels.SavedTimerVm> _saved = [];

    private void SyncSaved()
    {
        var models = _host.State.SavedTimers;
        foreach (var vm in _saved.Where(vm => !models.Contains(vm.Model)).ToList()) _saved.Remove(vm);
        foreach (var m in models)
            if (_saved.All(vm => vm.Model != m)) _saved.Add(new ViewModels.SavedTimerVm(m, _host));
        SavedEmpty.Visibility = _saved.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnAddSaved(object sender, RoutedEventArgs e)
    {
        _host.AddSavedTimer();
        // Put the cursor straight into the new card's name box.
        Dispatcher.BeginInvoke(() =>
        {
            if (SavedItems.ItemContainerGenerator.ContainerFromIndex(_saved.Count - 1) is DependencyObject card &&
                FindChild<TextBox>(card) is { } box)
                box.Focus();
        }, System.Windows.Threading.DispatcherPriority.Loaded);
    }

    private void OnDeleteSaved(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is ViewModels.SavedTimerVm vm) _host.DeleteSavedTimer(vm.Model);
    }

    private void OnStartSaved(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is not ViewModels.SavedTimerVm vm) return;
        Keyboard.ClearFocus(); // commit any half-typed edit first
        _host.StartSaved(vm.Model);
    }

    private void OnPlanMinus(object sender, RoutedEventArgs e) => ChangePlan(Id(sender), -1);
    private void OnPlanPlus(object sender, RoutedEventArgs e) => ChangePlan(Id(sender), +1);

    /// <summary>∞ → (sessions done + 1) → … ; going below what's already done returns to ∞ (open-ended).</summary>
    private void ChangePlan(Guid id, int delta)
    {
        if (_host.Engine.Timers.FirstOrDefault(t => t.Id == id) is not { } t) return;
        var floor = Math.Max(1, t.CompletedWorkSessions + (t.Phase == PomodoroPhase.Work ? 1 : 0));
        int? next = t.Planned switch
        {
            null when delta > 0 => floor,
            null => null,
            { } n when n + delta < floor => null,
            { } n => n + delta,
        };
        _host.Act(en => en.SetPlanned(id, next));
    }

    private void OnSaveRunning(object sender, RoutedEventArgs e)
    {
        if (_host.SaveTimer(Id(sender)) is { } saved)
            QuickPreview.Text = $"Saved \"{saved.DisplayName}\" ({TimeFormat.Friendly(saved.Duration)}) to your saved timers";
    }

    /// <summary>Enter commits a saved-timer field, Esc puts the previous value back.</summary>
    private void OnSavedFieldKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox box || e.Key is not (Key.Enter or Key.Escape)) return;
        var binding = box.GetBindingExpression(TextBox.TextProperty);
        if (e.Key == Key.Enter) binding?.UpdateSource();
        else binding?.UpdateTarget();
        e.Handled = true;
        Quick.Focus();
    }

    private static T? FindChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is T match) return match;
            if (FindChild<T>(child) is { } deeper) return deeper;
        }
        return null;
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

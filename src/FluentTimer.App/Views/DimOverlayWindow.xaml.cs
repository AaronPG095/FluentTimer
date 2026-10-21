using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Animation;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.Views;

/// <summary>Full-screen dim for "you must take a break" alerts. Shows the live break countdown when there is one.</summary>
public partial class DimOverlayWindow : Window
{
    private readonly AlertManager _alerts;
    private readonly AppHost _host = AppHost.Current;

    internal DimOverlayWindow(ActiveAlert alert, AlertManager alerts)
    {
        Alert = alert;
        _alerts = alerts;
        InitializeComponent();

        Left = SystemParameters.VirtualScreenLeft;
        Top = SystemParameters.VirtualScreenTop;
        Width = SystemParameters.VirtualScreenWidth;
        Height = SystemParameters.VirtualScreenHeight;

        TitleText.Text = alert.Request.Title;
        MessageText.Text = alert.Request.Message;
        SnoozeButton.Content = $"Snooze {_host.Settings.SnoozeMinutes} min";
        SnoozeButton.Visibility = alert.CanSnooze ? Visibility.Visible : Visibility.Collapsed;
        DismissButton.Content = IsBreak ? "Skip break" : alert.Request.Repeats ? "Start next round" : "Dismiss";
        if (IsBreak)
        {
            // Breaks wear the break colour, like the widget and the timer card.
            Card.SetResourceReference(Border.BorderBrushProperty, "BreakBrush");
            CardIcon.SetResourceReference(TextBlock.ForegroundProperty, "BreakBrush");
            Hint.Text = "Esc to skip the break";
        }

        KeyDown += (_, e) => { if (e.Key == Key.Escape) OnDismiss(this, e); };
        Loaded += (_, _) =>
        {
            // Centre the card on the monitor the widget is on (never across monitor bezels).
            var work = App.Current.WidgetWorkArea();
            Card.Margin = new Thickness(
                work.Left - Left + (work.Width - Card.ActualWidth) / 2,
                work.Top - Top + (work.Height - Card.ActualHeight) / 2.4, 0, 0);
            BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)));
            DismissButton.Focus();
        };
        _host.Ticked += UpdateCountdown;
        Closed += (_, _) => _host.Ticked -= UpdateCountdown;
        UpdateCountdown();
    }

    internal ActiveAlert Alert { get; }

    /// <summary>The timer this overlay belongs to, if it is on a break (a reminder's break or a Pomodoro break).</summary>
    private TimerItem? BreakTimer => Alert.Request.TimerId is { } id
        ? _host.Engine.Timers.FirstOrDefault(t => t.Id == id && t.IsOnBreak)
        : null;

    private bool IsBreak => BreakTimer is not null;

    private void UpdateCountdown()
    {
        var timer = _host.Timers.FirstOrDefault(t => t.Id == Alert.Request.TimerId);
        CountdownText.Visibility = timer is { Model.IsOnBreak: true } ? Visibility.Visible : Visibility.Collapsed;
        if (timer is not null) CountdownText.Text = timer.TimeText;
    }

    /// <summary>Skip the break: a Pomodoro moves on to its next focus session; a reminder's break simply ends.</summary>
    private void SkipBreak(TimerItem t)
    {
        if (t.Kind == TimerKind.Pomodoro) _host.Act(en => en.SkipPhase(t.Id)); // also clears this alert
        else _host.Act(en => en.Cancel(t.Id));
    }

    private void OnSnooze(object sender, RoutedEventArgs e)
    {
        if (BreakTimer is { Kind: TimerKind.Break } brk) _host.Act(en => en.Cancel(brk.Id));
        _alerts.Snooze(Alert);
    }

    private void OnDismiss(object sender, RoutedEventArgs e)
    {
        if (BreakTimer is { } brk) SkipBreak(brk);
        else _alerts.Dismiss(Alert);
    }

    public void FadeOutAndClose()
    {
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(160));
        fade.Completed += (_, _) => Close();
        BeginAnimation(OpacityProperty, fade);
    }
}

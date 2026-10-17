using System.Windows;
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

    private bool IsBreak => Alert.Request.TimerId is { } id && _host.Engine.Timers.Any(t => t.Id == id && t.Kind == TimerKind.Break);

    private void UpdateCountdown()
    {
        var timer = _host.Timers.FirstOrDefault(t => t.Id == Alert.Request.TimerId);
        CountdownText.Visibility = timer is { IsBreak: true } ? Visibility.Visible : Visibility.Collapsed;
        if (timer is not null) CountdownText.Text = timer.TimeText;
    }

    private void OnSnooze(object sender, RoutedEventArgs e)
    {
        if (Alert.Request.TimerId is { } id && IsBreak) _host.Act(en => en.Cancel(id));
        _alerts.Snooze(Alert);
    }

    private void OnDismiss(object sender, RoutedEventArgs e)
    {
        if (Alert.Request.TimerId is { } id && IsBreak) _host.Act(en => en.Cancel(id)); // clears this alert too
        else _alerts.Dismiss(Alert);
    }

    public void FadeOutAndClose()
    {
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(160));
        fade.Completed += (_, _) => Close();
        BeginAnimation(OpacityProperty, fade);
    }
}

using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.Views;

/// <summary>
/// Always-on-top floating timer. Drag it anywhere (soft-snaps to screen edges); it grows away from the
/// edge it's anchored to. Click = pause/resume (or dismiss an alert), double-click = open app, right-click = menu.
/// </summary>
public partial class PillWindow : Window
{
    private const double SnapDistance = 24;
    private const double EdgeGap = 4;

    private readonly AppHost _host;
    private readonly DispatcherTimer _clickDelay;
    private readonly DispatcherTimer _hoverIn;
    private readonly DispatcherTimer _hoverOut;
    private bool _expanded;
    private bool _anchorRight;
    private bool _anchorBottom;
    private Point _anchor;
    private bool _positioned;
    private ActiveAlert? _shownAlert;
    private readonly List<AnimationClock> _alertClocks = [];

    internal PillWindow(AppHost host)
    {
        _host = host;
        InitializeComponent();
        TimerList.ItemsSource = host.Timers;

        _clickDelay = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(Native.GetDoubleClickTime()) };
        _clickDelay.Tick += (_, _) => { _clickDelay.Stop(); OnSingleClick(); };
        _hoverIn = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(180) };
        _hoverIn.Tick += (_, _) => { _hoverIn.Stop(); SetExpanded(true); };
        _hoverOut = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(380) };
        _hoverOut.Tick += (_, _) => { _hoverOut.Stop(); SetExpanded(false); };

        MouseEnter += (_, _) => { _hoverOut.Stop(); if (!_expanded) _hoverIn.Start(); };
        MouseLeave += (_, _) => { _hoverIn.Stop(); if (ContextMenu is not { IsOpen: true }) _hoverOut.Start(); };
        SizeChanged += (_, _) => Reposition();
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            Native.AddExStyle(hwnd, Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        Loaded += (_, _) => InitPosition();

        host.Ticked += Refresh;
        host.SettingsApplied += UpdateVisibility;
        host.Alerts.CurrentChanged += OnAlertChanged;
        Refresh();
    }

    // ---- Visibility & content ---------------------------------------------------------------

    public void UpdateVisibility()
    {
        var pill = _host.Settings.Pill;
        var alerting = _host.Alerts.Current is not null;
        var show = alerting || (!pill.Hidden && (_host.Timers.Count > 0 || pill.ShowWhenIdle));
        if (show && !IsVisible) Show();
        else if (!show && IsVisible) Hide();
        IdleHotkey.Text = _host.Settings.Hotkey;
    }

    private void Refresh()
    {
        UpdateVisibility();
        if (!IsVisible || _shownAlert is not null) return;

        var first = _host.Timers.FirstOrDefault();
        var idle = first is null;
        IdleBar.Visibility = idle && !_expanded ? Visibility.Visible : Visibility.Collapsed;
        IdleHover.Visibility = idle && _expanded ? Visibility.Visible : Visibility.Collapsed;
        TimerContent.Visibility = idle ? Visibility.Collapsed : Visibility.Visible;
        ListPanel.Visibility = !idle && _expanded ? Visibility.Visible : Visibility.Collapsed;
        Pill.Opacity = idle && !_expanded ? 0.75 : 1;
        if (idle) return;

        PillTime.Text = first!.TimeText;
        PillLabel.Text = first.Label;
        PillLabel.Visibility = _expanded || _host.Timers.Count == 1 && first.Label.Length <= 14 ? Visibility.Visible : Visibility.Collapsed;
        var extra = _host.Timers.Count - 1;
        Badge.Visibility = extra > 0 ? Visibility.Visible : Visibility.Collapsed;
        BadgeText.Text = $"+{extra}";

        var running = first.IsRunning;
        PausedGlyph.Visibility = running ? Visibility.Collapsed : Visibility.Visible;
        Dot.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
        PillTime.Opacity = running ? 1 : 0.6;
        // Gentle breathing dot while running.
        Dot.Opacity = running ? 0.55 + 0.45 * Math.Abs(Math.Cos(DateTime.UtcNow.TimeOfDay.TotalSeconds * Math.PI / 2)) : 1;
    }

    private void SetExpanded(bool expanded)
    {
        if (_expanded == expanded) return;
        _expanded = expanded;
        Refresh();
    }

    // ---- Alerts -----------------------------------------------------------------------------

    private void OnAlertChanged()
    {
        if (_shownAlert is not null) _shownAlert.PropertyChanged -= OnAlertPropertyChanged;
        _shownAlert = _host.Alerts.Current;
        if (_shownAlert is not null) _shownAlert.PropertyChanged += OnAlertPropertyChanged;
        UpdateVisibility();
        ApplyAlertVisuals();
        Refresh();
    }

    private void OnAlertPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(ActiveAlert.Escalated)) ApplyAlertVisuals();
    }

    private void ApplyAlertVisuals()
    {
        foreach (var c in _alertClocks) c.Controller?.Remove();
        _alertClocks.Clear();
        FlashLayer.BeginAnimation(OpacityProperty, null);
        PillScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
        PillScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
        PillGlow.BeginAnimation(System.Windows.Media.Effects.DropShadowEffect.BlurRadiusProperty, null);
        PillGlow.BeginAnimation(System.Windows.Media.Effects.DropShadowEffect.OpacityProperty, null);
        PillGlow.Color = Colors.Black;
        PillGlow.BlurRadius = 10;
        PillGlow.Opacity = 0.3;
        FlashLayer.Opacity = 0;

        var alert = _shownAlert;
        AlertContent.Visibility = alert is null ? Visibility.Collapsed : Visibility.Visible;
        if (alert is null)
        {
            ListPanel.Visibility = Visibility.Collapsed;
            return;
        }

        IdleBar.Visibility = IdleHover.Visibility = TimerContent.Visibility = Visibility.Collapsed;
        ListPanel.Visibility = Visibility.Collapsed;
        AlertTitle.Text = alert.Request.Title;
        AlertMessage.Text = alert.Request.Message;
        SnoozeButton.Content = $"+{_host.Settings.SnoozeMinutes} min";
        SnoozeButton.Visibility = alert.CanSnooze ? Visibility.Visible : Visibility.Collapsed;
        var startFocus = StartFocusTarget(alert) is not null;
        AlertAction.Content = "Start focus";
        AlertAction.Visibility = startFocus ? Visibility.Visible : Visibility.Collapsed;

        // Re-assert topmost so the alert rises above other always-on-top windows.
        Topmost = false;
        Topmost = true;

        var s = alert.Settings;
        var hot = alert.Escalated;
        var period = TimeSpan.FromMilliseconds(hot ? 260 : 520);
        var ease = new SineEase { EasingMode = EasingMode.EaseInOut };

        if (s.Flash)
            Animate(FlashLayer, OpacityProperty, 0.55, 1.0, period, ease);
        else
            FlashLayer.Opacity = 1;

        if (s.Grow)
        {
            var to = hot ? 1.45 : 1.22;
            Animate(PillScale, ScaleTransform.ScaleXProperty, 1.0, to, period * 1.4, ease);
            Animate(PillScale, ScaleTransform.ScaleYProperty, 1.0, to, period * 1.4, ease);
        }

        if (s.Glow || hot)
        {
            PillGlow.Color = ThemeService.AlertRed;
            PillGlow.ShadowDepth = 0;
            Animate(PillGlow, System.Windows.Media.Effects.DropShadowEffect.BlurRadiusProperty, 4, hot ? 40 : 26, period, ease);
            Animate(PillGlow, System.Windows.Media.Effects.DropShadowEffect.OpacityProperty, 0.4, 1, period, ease);
        }
    }

    private void Animate(IAnimatable target, DependencyProperty prop, double from, double to, TimeSpan duration, IEasingFunction ease)
    {
        var anim = new DoubleAnimation(from, to, duration)
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = ease,
        };
        if (SystemParameters.ClientAreaAnimation is false) // reduced motion: hold the peak instead
        {
            target.BeginAnimation(prop, new DoubleAnimation(to, TimeSpan.Zero));
            return;
        }
        target.BeginAnimation(prop, anim);
    }

    private Guid? StartFocusTarget(ActiveAlert alert) =>
        alert.Request.Kind == AlertKind.PomodoroPhase && alert.Request.TimerId is { } id &&
        _host.Timers.FirstOrDefault(t => t.Id == id) is { IsPaused: true, Model.Phase: PomodoroPhase.Work }
            ? id
            : null;

    private void OnSnooze(object sender, RoutedEventArgs e)
    {
        if (_shownAlert is { } a) _host.Alerts.Snooze(a);
    }

    private void OnDismiss(object sender, RoutedEventArgs e)
    {
        if (_shownAlert is { } a) _host.Alerts.Dismiss(a);
    }

    private void OnAlertAction(object sender, RoutedEventArgs e)
    {
        if (_shownAlert is not { } a) return;
        if (StartFocusTarget(a) is { } id) _host.Act(en => en.Resume(id));
        _host.Alerts.Dismiss(a);
    }

    // ---- Mouse ------------------------------------------------------------------------------

    private void OnPillMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount >= 2)
        {
            _clickDelay.Stop();
            App.Current.ShowMain();
            return;
        }
        var before = new Point(Left, Top);
        try { DragMove(); }
        catch (InvalidOperationException) { return; }

        if (Math.Abs(Left - before.X) + Math.Abs(Top - before.Y) > 3)
        {
            SnapToEdges();
            return;
        }
        _clickDelay.Start();
    }

    private void OnSingleClick()
    {
        AppHost.Trace("pill single click");
        if (_shownAlert is { } a)
        {
            _host.Alerts.Dismiss(a);
            return;
        }
        var first = _host.Timers.FirstOrDefault();
        if (first is null) App.Current.ShowQuickEntry();
        else _host.Act(en => en.TogglePause(first.Id));
    }

    private void OnPillRightClick(object sender, MouseButtonEventArgs e)
    {
        var menu = new ContextMenu();
        TrayService.BuildMenu(menu);
        menu.Closed += (_, _) => { if (!IsMouseOver) _hoverOut.Start(); };
        ContextMenu = menu;
        menu.IsOpen = true;
        e.Handled = true;
    }

    private void OnPauseItem(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is Guid id) _host.Act(en => en.TogglePause(id));
    }

    private void OnCancelItem(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is Guid id) _host.Act(en => en.Cancel(id));
    }

    private void OnNew(object sender, RoutedEventArgs e) => App.Current.ShowQuickEntry();

    private void OnOpen(object sender, RoutedEventArgs e) => App.Current.ShowMain();

    // ---- Positioning ------------------------------------------------------------------------

    /// <summary>Pill's top-left inside the window (the window has transparent headroom around it).</summary>
    private Point PillOffset() => Pill.TranslatePoint(new Point(0, 0), this);

    private void InitPosition()
    {
        var p = _host.Settings.Pill;
        var work = SystemParameters.WorkArea;
        var x = p.Left ?? work.Left + EdgeGap;
        var y = p.Top ?? work.Top + work.Height * 0.45;
        // Keep it on screen if a monitor was removed.
        var virt = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
        if (!virt.Contains(new Point(x + 10, y + 5))) { x = work.Left + EdgeGap; y = work.Top + work.Height * 0.45; }

        var o = PillOffset();
        Left = x - o.X;
        Top = y - o.Y;
        _positioned = true;
        CaptureAnchor(save: false);
    }

    private void Reposition()
    {
        if (!_positioned) return;
        var o = PillOffset();
        var w = Pill.ActualWidth;
        var h = Pill.ActualHeight;
        var x = _anchorRight ? _anchor.X - w : _anchor.X;
        var y = _anchorBottom ? _anchor.Y - h : _anchor.Y;
        Left = x - o.X;
        Top = y - o.Y;
    }

    /// <summary>Remember which edges to grow away from, based on which half of the screen the pill is in.</summary>
    private void CaptureAnchor(bool save)
    {
        var o = PillOffset();
        var x = Left + o.X;
        var y = Top + o.Y;
        var w = Pill.ActualWidth;
        var h = Pill.ActualHeight;
        var work = WorkAreaDip(x + w / 2, y + h / 2);

        _anchorRight = x + w / 2 > work.Left + work.Width / 2;
        _anchorBottom = y + h / 2 > work.Top + work.Height / 2;
        _anchor = new Point(_anchorRight ? x + w : x, _anchorBottom ? y + h : y);

        // List grows away from the anchored edge too.
        Grid.SetRow(ListPanel, _anchorBottom ? 0 : 2);
        var align = _anchorRight ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        Pill.HorizontalAlignment = align;
        ListPanel.HorizontalAlignment = align;
        // Grow animations scale away from the anchored edge so a snapped pill never pushes off-screen.
        Pill.RenderTransformOrigin = new Point(_anchorRight ? 1 : 0, _anchorBottom ? 1 : 0);

        if (!save) return;
        _host.Settings.Pill.Left = x;
        _host.Settings.Pill.Top = y;
        _host.SettingsChanged();
    }

    private void SnapToEdges()
    {
        var o = PillOffset();
        var x = Left + o.X;
        var y = Top + o.Y;
        var w = Pill.ActualWidth;
        var h = Pill.ActualHeight;
        var work = WorkAreaDip(x + w / 2, y + h / 2);

        if (Math.Abs(x - work.Left) < SnapDistance) x = work.Left + EdgeGap;
        if (Math.Abs(work.Right - (x + w)) < SnapDistance) x = work.Right - w - EdgeGap;
        if (Math.Abs(y - work.Top) < SnapDistance) y = work.Top + EdgeGap;
        if (Math.Abs(work.Bottom - (y + h)) < SnapDistance) y = work.Bottom - h - EdgeGap;
        x = Math.Clamp(x, work.Left, Math.Max(work.Left, work.Right - w));
        y = Math.Clamp(y, work.Top, Math.Max(work.Top, work.Bottom - h));

        Left = x - o.X;
        Top = y - o.Y;
        CaptureAnchor(save: true);
        Reposition();
    }

    /// <summary>Work area (in DIPs) of the monitor under a DIP point.</summary>
    private Rect WorkAreaDip(double x, double y)
    {
        var source = PresentationSource.FromVisual(this);
        if (source?.CompositionTarget is null) return SystemParameters.WorkArea;
        var toDevice = source.CompositionTarget.TransformToDevice;
        var r = Native.WorkAreaAt((int)(x * toDevice.M11), (int)(y * toDevice.M22));
        return new Rect(r.Left / toDevice.M11, r.Top / toDevice.M22,
            (r.Right - r.Left) / toDevice.M11, (r.Bottom - r.Top) / toDevice.M22);
    }
}

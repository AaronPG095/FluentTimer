using System.ComponentModel;
using System.Windows;
using System.Windows.Automation;
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
    private const double NearDistance = 36;   // DIPs around the pill where it wakes up
    private const double AwayOpacity = 0.6;
    private static readonly TimeSpan ExpandDwell = TimeSpan.FromMilliseconds(180);
    private static readonly TimeSpan CollapseDwell = TimeSpan.FromMilliseconds(380);

    private readonly DispatcherTimer _clickDelay;
    private readonly DispatcherTimer _presence;
    private IntPtr _hwnd;
    private DateTime _overSince = DateTime.MaxValue;
    private DateTime _awaySince = DateTime.MaxValue;
    private bool _clickThrough;
    private bool _vertical;
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
        // One loop reads the real cursor position and drives hover, fade and click-through.
        // (Event-based hover is unreliable on layered windows and impossible while click-through.)
        _presence = new DispatcherTimer(DispatcherPriority.Input) { Interval = TimeSpan.FromMilliseconds(80) };
        _presence.Tick += (_, _) => UpdatePresence();

        SizeChanged += (_, _) => Reposition();
        SourceInitialized += (_, _) =>
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            Native.AddExStyle(_hwnd, Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        IsVisibleChanged += (_, _) => { if (IsVisible) _presence.Start(); else _presence.Stop(); };
        Loaded += (_, _) => InitPosition();

        host.Ticked += Refresh;
        ApplySize();
        host.SettingsApplied += () =>
        {
            ApplySize();
            UpdateVisibility();
            if (_positioned) CaptureAnchor(save: false); // picks up "stand upright on side edges" changes
        };
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
        ApplyOrientation(idle);
        if (idle) return;

        // Vertical: minutes stacked over seconds, like a narrow side bar.
        PillTime.Text = _vertical ? first!.TimeText.Replace(":", "\n") : first!.TimeText;
        AutomationProperties.SetName(Pill, $"{first.Label}, {first.TimeText} left");
        PillLabel.Text = first.Label;
        PillLabel.Visibility = !_vertical && (_expanded || _host.Timers.Count == 1 && first.Label.Length <= 14)
            ? Visibility.Visible : Visibility.Collapsed;
        var extra = _host.Timers.Count - 1;
        Badge.Visibility = extra > 0 ? Visibility.Visible : Visibility.Collapsed;
        BadgeText.Text = $"+{extra}";

        var running = first.IsRunning;
        PausedGlyph.Visibility = running ? Visibility.Collapsed : Visibility.Visible;
        Dot.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
        PillTime.Opacity = running ? 1 : 0.6;
        SetBreathing(running);
    }

    private bool _breathing;

    /// <summary>
    /// Gentle breathing dot while a timer runs. Driven by WPF's animation clock (display frame rate, render thread)
    /// rather than the 4 Hz app tick, so it fades smoothly instead of stepping.
    /// </summary>
    private void SetBreathing(bool on)
    {
        on &= SystemParameters.ClientAreaAnimation; // honour "show animations in Windows" off
        if (on == _breathing) return;
        _breathing = on;
        if (!on)
        {
            Dot.BeginAnimation(OpacityProperty, null);
            DotScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            DotScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            Dot.Opacity = 1;
            return;
        }
        var ease = new SineEase { EasingMode = EasingMode.EaseInOut };
        var period = TimeSpan.FromSeconds(1.4); // one fade; a full breath (in + out) is 2.8 s
        Timeline Breath(double from, double to) => new DoubleAnimation(from, to, period)
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = ease,
        };
        Dot.BeginAnimation(OpacityProperty, (DoubleAnimation)Breath(1.0, 0.35));
        DotScale.BeginAnimation(ScaleTransform.ScaleXProperty, (DoubleAnimation)Breath(1.0, 0.82));
        DotScale.BeginAnimation(ScaleTransform.ScaleYProperty, (DoubleAnimation)Breath(1.0, 0.82));
    }

    private void ApplyOrientation(bool idle)
    {
        var v = _vertical;
        TimerContent.Orientation = v ? Orientation.Vertical : Orientation.Horizontal;
        TimerContent.Margin = v ? new Thickness(0, 10, 0, 10) : new Thickness(11, 0, 12, 0);
        TimerContent.Width = v ? 40 : double.NaN;
        DotHost.Margin = v ? new Thickness(0, 0, 0, 6) : new Thickness(0, 0, 8, 0);
        Badge.Margin = v ? new Thickness(0, 6, 0, 0) : new Thickness(8, 0, 0, 0);
        PillTime.LineHeight = v ? 15 : double.NaN;
        IdleBar.Width = v ? 8 : 44;
        IdleBar.Height = v ? 44 : 8;
        // The hover list sits beside a vertical pill, above/below a horizontal one.
        if (v)
        {
            Grid.SetRow(ListPanel, 1);
            Grid.SetColumn(ListPanel, _anchorRight ? 0 : 2);
            ListPanel.Margin = new Thickness(8, 0, 8, 0);
            ListPanel.VerticalAlignment = _anchorBottom ? VerticalAlignment.Bottom : VerticalAlignment.Top;
        }
        else
        {
            Grid.SetRow(ListPanel, _anchorBottom ? 0 : 2);
            Grid.SetColumn(ListPanel, 1);
            ListPanel.Margin = new Thickness(0, 8, 0, 8);
            ListPanel.VerticalAlignment = VerticalAlignment.Top;
        }
    }

    /// <summary>Cursor position in DIPs, plus whether it is over the visible parts (or near the pill).</summary>
    private (bool Over, bool Near) CursorState()
    {
        if (!Native.GetCursorPos(out var pt) || PresentationSource.FromVisual(this) is not { CompositionTarget: { } target })
            return (false, false);
        var p = target.TransformFromDevice.Transform(new Point(pt.X, pt.Y));
        Rect RectOf(FrameworkElement e)
        {
            var o = e.TranslatePoint(new Point(0, 0), this);
            return new Rect(Left + o.X, Top + o.Y, e.ActualWidth * _scale, e.ActualHeight * _scale);
        }
        var pill = RectOf(Pill);
        var over = pill.Contains(p) || ListPanel.IsVisible && RectOf(ListPanel).Contains(p) || ContextMenu is { IsOpen: true };
        pill.Inflate(NearDistance, NearDistance);
        return (over, over || pill.Contains(p));
    }

    private bool CursorIsOver() => CursorState().Over;

    /// <summary>Hover with dwell times, and fade + click-through while the cursor is away.</summary>
    private void UpdatePresence()
    {
        var now = DateTime.UtcNow;
        var (over, near) = CursorState();
        var dragging = Mouse.LeftButton == MouseButtonState.Pressed && over;

        if (over) { _awaySince = DateTime.MaxValue; if (_overSince == DateTime.MaxValue) _overSince = now; }
        else { _overSince = DateTime.MaxValue; if (_awaySince == DateTime.MaxValue) _awaySince = now; }

        if (!_expanded && over && !dragging && now - _overSince >= ExpandDwell) SetExpanded(true);
        else if (_expanded && !over && now - _awaySince >= CollapseDwell) SetExpanded(false);

        var fade = _host.Settings.Pill.FadeWhenAway && !near && !_expanded && _shownAlert is null;
        if (fade != _clickThrough && _hwnd != IntPtr.Zero)
        {
            _clickThrough = fade;
            Native.SetExStyle(_hwnd, Native.WS_EX_TRANSPARENT, fade);
            Outer.BeginAnimation(OpacityProperty, new DoubleAnimation(fade ? AwayOpacity : 1, TimeSpan.FromMilliseconds(fade ? 400 : 120)));
        }
    }

    /// <summary>Test hook: expand the list and open the first Repeat toggle's tooltip, as hovering would.</summary>
    internal void DevShowRepeatTooltip()
    {
        _presence.Stop(); // keep it expanded regardless of where the real cursor is
        SetExpanded(true);
        Dispatcher.BeginInvoke(() =>
        {
            var toggle = FindChild<System.Windows.Controls.Primitives.ToggleButton>(TimerList);
            if (toggle is null) return;
            // Assigned as the button's own ToolTip, so it inherits from the button exactly like a hover tooltip.
            var tip = new ToolTip
            {
                Content = toggle.ToolTip,
                PlacementTarget = toggle,
                Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom,
                StaysOpen = true,
            };
            toggle.ToolTip = tip;
            tip.IsOpen = true;
        }, DispatcherPriority.Loaded);
    }

    private static T? FindChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T match) return match;
            if (FindChild<T>(child) is { } deeper) return deeper;
        }
        return null;
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
        DismissButton.Content = alert.Request.Repeats ? "Next round" : "Dismiss"; // click restarts a repeating timer
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
        ContextMenu = menu;
        menu.IsOpen = true;
        e.Handled = true;
    }

    private void OnPauseItem(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is Guid id) _host.Act(en => en.TogglePause(id));
    }

    private void OnLabelMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 2 || ((FrameworkElement)sender).Tag is not Guid id) return;
        e.Handled = true;
        App.Current.ShowRename(id);
    }

    private void OnResetItem(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is Guid id) _host.Act(en => en.Reset(id));
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

    // ---- Size --------------------------------------------------------------------------------

    private double _scale = 1;

    /// <summary>On-screen pill size (the whole widget is scaled as vectors by a LayoutTransform).</summary>
    private double PillW => Pill.ActualWidth * _scale;
    private double PillH => Pill.ActualHeight * _scale;

    public static double ScaleFor(WidgetSize size) => size switch
    {
        WidgetSize.Medium => 1.35,
        WidgetSize.Large => 1.75,
        _ => 1.0,
    };

    /// <summary>Apply Small / Medium / Large. The edge the widget is anchored to stays put; it grows away from it.</summary>
    private void ApplySize()
    {
        var scale = ScaleFor(_host.Settings.Pill.Size);
        if (Math.Abs(scale - _scale) < 0.001 && Outer.LayoutTransform is ScaleTransform) return;
        _scale = scale;
        Outer.LayoutTransform = new ScaleTransform(scale, scale);
        // Margins aren't scaled by the LayoutTransform; keep proportional headroom for grow/glow alerts.
        Outer.Margin = new Thickness(60 * scale, 32 * scale, 60 * scale, 32 * scale);
        if (!_positioned) return;
        Dispatcher.BeginInvoke(() =>
        {
            Reposition();
            CaptureAnchor(save: false);
        }, DispatcherPriority.Loaded);
    }

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
        var w = PillW;
        var h = PillH;
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
        var w = PillW;
        var h = PillH;
        var work = WorkAreaDip(x + w / 2, y + h / 2);

        _anchorRight = x + w / 2 > work.Left + work.Width / 2;
        _anchorBottom = y + h / 2 > work.Top + work.Height / 2;
        _anchor = new Point(_anchorRight ? x + w : x, _anchorBottom ? y + h : y);

        // Snapped flush to the left or right edge → stand upright (Wispr-style side bar).
        var onSide = x <= work.Left + EdgeGap + 1 || x + w >= work.Right - EdgeGap - 1;
        _vertical = _host.Settings.Pill.VerticalOnSides && onSide;
        ApplyOrientation(_host.Timers.Count == 0); // also places the list away from the anchored edge
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
        var w = PillW;
        var h = PillH;
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

    /// <summary>Work area (DIPs) of the monitor the widget is on, used to place the break card.</summary>
    public Rect CurrentWorkArea()
    {
        if (!_positioned) return SystemParameters.WorkArea;
        var o = PillOffset();
        return WorkAreaDip(Left + o.X + PillW / 2, Top + o.Y + PillH / 2);
    }

    /// <summary>
    /// Work area (in DIPs) of the monitor under a DIP point. The conversion uses this window's own DPI,
    /// which under per-monitor-v2 awareness is the DPI of the monitor it currently sits on.
    /// </summary>
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

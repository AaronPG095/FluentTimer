using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using FluentTimer.App.Views;
using FluentTimer.Core;

namespace FluentTimer.App.Services;

public sealed class ActiveAlert : ObservableObject
{
    private bool _escalated;

    public ActiveAlert(AlertRequest request, DateTime raisedUtc, bool quiet, bool isTest)
    {
        Request = request;
        RaisedUtc = raisedUtc;
        Quiet = quiet;
        IsTest = isTest;
    }

    public AlertRequest Request { get; }
    public DateTime RaisedUtc { get; }
    public bool Quiet { get; }
    public bool IsTest { get; }
    public AlertSettings Settings => Request.Settings;
    public bool CanSnooze => Request.CanSnooze && !IsTest;

    public bool Escalated { get => _escalated; set => SetProperty(ref _escalated, value); }

    /// <summary>Informational alerts (phase change, break over) clear themselves.</summary>
    public bool AutoDismisses => Request.Kind is AlertKind.PomodoroPhase or AlertKind.BreakOver || IsTest;
}

/// <summary>Turns engine alert requests into sound, the pill's visual alert state and the dim overlay.</summary>
internal sealed class AlertManager
{
    public static readonly TimeSpan EscalateAfter = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan AutoDismissAfter = TimeSpan.FromSeconds(12);

    private readonly AppHost _host;
    private readonly SoundService _sound = new();
    private DimOverlayWindow? _overlay;

    public AlertManager(AppHost host) => _host = host;

    public ObservableCollection<ActiveAlert> Active { get; } = [];
    public ActiveAlert? Current => Active.Count > 0 ? Active[^1] : null;

    /// <summary>Raised when the alert shown to the user changes (including to none).</summary>
    public event Action? CurrentChanged;

    public void Raise(AlertRequest request, bool isTest = false)
    {
        var quiet = _host.Settings.QuietWhenFullscreen && Native.IsFullscreenAppActive();
        var alert = new ActiveAlert(request, DateTime.UtcNow, quiet, isTest);
        AppHost.Trace($"raise {request.Kind} '{request.Title}' quiet={quiet}");
        Active.Add(alert);
        Present(alert);
    }

    public void Test(AlertSettings settings) =>
        Raise(new AlertRequest(AlertKind.TimerDone, "Test alert", "This is how alerts will look", settings.Clone()), isTest: true);

    public void Dismiss(ActiveAlert alert)
    {
        AppHost.Trace($"dismiss {alert.Request.Kind} '{alert.Request.Title}'");
        if (!alert.IsTest) _host.Engine.Dismiss(alert.Request);
        Remove(alert);
    }

    public void Snooze(ActiveAlert alert)
    {
        if (!alert.IsTest) _host.Engine.Snooze(alert.Request);
        Remove(alert);
    }

    public void DismissAll()
    {
        foreach (var a in Active.ToList()) Dismiss(a);
    }

    /// <summary>The engine removed a timer (cancelled, or a break finished): drop its alerts silently.</summary>
    public void OnTimerCleared(Guid timerId)
    {
        foreach (var a in Active.Where(a => a.Request.TimerId == timerId).ToList()) Remove(a);
    }

    public void Tick()
    {
        var now = DateTime.UtcNow;
        foreach (var a in Active.ToList())
        {
            var age = now - a.RaisedUtc;
            if (a.AutoDismisses && age >= AutoDismissAfter)
            {
                Dismiss(a);
                continue;
            }
            if (a.Settings.Escalate && !a.Escalated && !a.AutoDismisses && age >= EscalateAfter)
            {
                a.Escalated = true;
                if (a == Current && !a.Quiet) _sound.Play(a.Settings, loud: true);
            }
        }
    }

    private void Remove(ActiveAlert alert)
    {
        var wasCurrent = alert == Current;
        Active.Remove(alert);
        if (_overlay?.Alert == alert) CloseOverlay();
        if (!wasCurrent) return;

        _sound.Stop();
        if (Current is { } next) Present(next, replaySound: next.Settings.LoopSound);
        else CurrentChanged?.Invoke();
    }

    private void Present(ActiveAlert alert, bool replaySound = true)
    {
        if (!alert.Quiet && replaySound) _sound.Play(alert.Settings, loud: alert.Escalated);
        if (alert.Settings.DimOverlay && !alert.Quiet) ShowOverlay(alert);
        CurrentChanged?.Invoke();
    }

    private void ShowOverlay(ActiveAlert alert)
    {
        CloseOverlay();
        _overlay = new DimOverlayWindow(alert, this);
        _overlay.Show();
        _overlay.Activate();
    }

    private void CloseOverlay()
    {
        var o = _overlay;
        _overlay = null;
        o?.FadeOutAndClose();
    }

    public void StopSound() => _sound.Stop();
}

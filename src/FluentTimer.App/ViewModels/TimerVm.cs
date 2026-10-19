using CommunityToolkit.Mvvm.ComponentModel;
using FluentTimer.Core;

namespace FluentTimer.App.ViewModels;

/// <summary>Live view of one <see cref="TimerItem"/>, refreshed on every engine tick.</summary>
public sealed class TimerVm : ObservableObject
{
    private string _label = "";
    private string _subtitle = "";
    private string _timeText = "";
    private double _progress;
    private TimerState _state;

    public TimerVm(TimerItem model) => Model = model;

    public TimerItem Model { get; }
    public Guid Id => Model.Id;
    public bool IsPomodoro => Model.Kind == TimerKind.Pomodoro;
    public bool IsCountdown => Model.Kind == TimerKind.Countdown;

    private string _name = "";
    /// <summary>The user's own name for the timer (empty = unnamed). Two-way: edits write through the engine.</summary>
    public string Name
    {
        get => _name;
        set
        {
            var clean = (value ?? "").Trim();
            if (!SetProperty(ref _name, clean)) return;
            Services.AppHost.Current.Act(e => e.Rename(Id, clean));
        }
    }

    /// <summary>Shown in the name box when the timer has no name yet.</summary>
    public string NamePlaceholder => IsPomodoro ? "Name this focus session" : IsBreak ? "Break" : "Name this timer";

    private bool _repeat;
    /// <summary>Two-way: the toggle writes through the engine.</summary>
    public bool Repeat
    {
        get => _repeat;
        set
        {
            if (!SetProperty(ref _repeat, value)) return;
            Services.AppHost.Current.Act(e => e.SetRepeat(Id, value));
        }
    }
    public bool IsBreak => Model.Kind == TimerKind.Break;

    public string Label { get => _label; private set => SetProperty(ref _label, value); }
    public string Subtitle { get => _subtitle; private set => SetProperty(ref _subtitle, value); }
    public string TimeText { get => _timeText; private set => SetProperty(ref _timeText, value); }
    public double Progress { get => _progress; private set => SetProperty(ref _progress, value); }

    public TimerState State
    {
        get => _state;
        private set
        {
            if (!SetProperty(ref _state, value)) return;
            OnPropertyChanged(nameof(IsRunning));
            OnPropertyChanged(nameof(IsPaused));
            OnPropertyChanged(nameof(IsRinging));
            OnPropertyChanged(nameof(PauseGlyph));
            OnPropertyChanged(nameof(PauseText));
        }
    }

    public bool IsRunning => State == TimerState.Running;
    public bool IsPaused => State == TimerState.Paused;
    public bool IsRinging => State == TimerState.Ringing;

    /// <summary>Segoe Fluent Icons: Pause / Play.</summary>
    public string PauseGlyph => IsRunning ? "" : "";
    public string PauseText => IsRunning ? "Pause" : (IsPomodoro && Model.PausedRemaining == Model.Duration ? "Start" : "Resume");

    /// <summary>Sort key: ringing first, then soonest running, then paused.</summary>
    public (int, TimeSpan) SortKey(DateTime now) => (State switch
    {
        TimerState.Ringing => 0,
        TimerState.Running => 1,
        _ => 2,
    }, Model.Remaining(now));

    public void Update(DateTime utcNow)
    {
        State = Model.State;
        if (_repeat != Model.Repeat) { _repeat = Model.Repeat; OnPropertyChanged(nameof(Repeat)); }
        // Only notify when the name changed elsewhere (widget rename box), so typing in the box isn't overwritten.
        if (_name != Model.Label) { _name = Model.Label; OnPropertyChanged(nameof(Name)); }
        Label = Model.DisplayLabel;
        TimeText = TimeFormat.Countdown(Model.Remaining(utcNow));
        Progress = Model.Progress(utcNow);
        Subtitle = Model.Kind switch
        {
            TimerKind.Pomodoro => $"{TimerItem.PhaseName(Model.Phase)} · session {Model.CompletedWorkSessions + (Model.Phase == PomodoroPhase.Work ? 1 : 0)} · {TimeFormat.Friendly(Model.Duration)}",
            TimerKind.Break => $"Break · {TimeFormat.Friendly(Model.Duration)}",
            _ => IsRinging ? "Time's up" : TimeFormat.Friendly(Model.Duration),
        };
        if (Model.Repeat) Subtitle += " · repeats";
        if (IsPaused) Subtitle += " · paused";
    }
}

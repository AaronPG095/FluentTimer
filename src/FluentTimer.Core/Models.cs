namespace FluentTimer.Core;

public enum TimerKind { Countdown, Pomodoro, Break }

public enum TimerState { Running, Paused, Ringing }

public enum PomodoroPhase { Work, ShortBreak, LongBreak }

public sealed class TimerItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Label { get; set; } = "";
    public TimerKind Kind { get; set; }
    public TimerState State { get; set; }

    /// <summary>Length of the current run (or Pomodoro phase), including any snoozes.</summary>
    public TimeSpan Duration { get; set; }

    /// <summary>Wall-clock end time while running. Survives restarts because it is absolute.</summary>
    public DateTime? EndsAtUtc { get; set; }

    public TimeSpan? PausedRemaining { get; set; }
    public DateTime StartedAtUtc { get; set; }

    public PomodoroPhase Phase { get; set; }
    public int CompletedWorkSessions { get; set; }

    /// <summary>For breaks started by an interval reminder.</summary>
    public Guid? ReminderId { get; set; }

    public AlertSettings? AlertOverride { get; set; }

    public TimeSpan Remaining(DateTime utcNow) => State switch
    {
        TimerState.Running when EndsAtUtc is { } end => end > utcNow ? end - utcNow : TimeSpan.Zero,
        TimerState.Paused => PausedRemaining ?? Duration,
        _ => TimeSpan.Zero,
    };

    public double Progress(DateTime utcNow) =>
        Duration <= TimeSpan.Zero ? 1 : Math.Clamp(1 - Remaining(utcNow) / Duration, 0, 1);

    public string DisplayLabel => Kind switch
    {
        TimerKind.Pomodoro => string.IsNullOrWhiteSpace(Label)
            ? PhaseName(Phase)
            : $"{Label} · {PhaseName(Phase)}",
        _ => string.IsNullOrWhiteSpace(Label) ? (Kind == TimerKind.Break ? "Break" : "Timer") : Label,
    };

    public static string PhaseName(PomodoroPhase phase) => phase switch
    {
        PomodoroPhase.Work => "Focus",
        PomodoroPhase.ShortBreak => "Short break",
        _ => "Long break",
    };
}

public sealed class IntervalReminder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Label { get; set; } = "Reminder";
    public bool Enabled { get; set; } = true;
    public TimeSpan Interval { get; set; } = TimeSpan.FromMinutes(30);
    public List<DayOfWeek> Days { get; set; } =
        [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday];
    public TimeOnly ActiveFrom { get; set; } = new(9, 0);
    public TimeOnly ActiveTo { get; set; } = new(18, 0);

    /// <summary>When set, firing the reminder starts a break countdown of this length.</summary>
    public TimeSpan? BreakDuration { get; set; }

    public DateTime? NextDueUtc { get; set; }
    public AlertSettings? AlertOverride { get; set; }

    public bool IsActiveAt(DateTime local)
    {
        if (!Days.Contains(local.DayOfWeek)) return false;
        var t = TimeOnly.FromDateTime(local);
        return ActiveFrom <= ActiveTo
            ? t >= ActiveFrom && t < ActiveTo
            : t >= ActiveFrom || t < ActiveTo; // overnight window, e.g. 22:00–02:00
    }
}

public sealed class Alarm
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Label { get; set; } = "Alarm";
    public bool Enabled { get; set; } = true;
    public TimeOnly Time { get; set; }

    /// <summary>Set for one-off alarms. Ignored when <see cref="RepeatDays"/> is non-empty.</summary>
    public DateOnly? Date { get; set; }

    public List<DayOfWeek> RepeatDays { get; set; } = [];
    public DateOnly? LastFired { get; set; }
    public AlertSettings? AlertOverride { get; set; }

    public bool IsRepeating => RepeatDays.Count > 0;
}

public sealed class AlertSettings
{
    public bool Flash { get; set; } = true;
    public bool Grow { get; set; } = true;
    public bool Glow { get; set; }
    public bool DimOverlay { get; set; }

    /// <summary>"None", a built-in sound name (see <see cref="SoundSynth.BuiltIn"/>), or a file path.</summary>
    public string Sound { get; set; } = "Chime";

    public double Volume { get; set; } = 0.7;
    public bool LoopSound { get; set; } = true;

    /// <summary>Raise volume and visual intensity if the alert is ignored for a minute.</summary>
    public bool Escalate { get; set; } = true;

    public AlertSettings Clone() => (AlertSettings)MemberwiseClone();

    public static AlertSettings DefaultTimer() => new();

    public static AlertSettings DefaultBreak() => new() { DimOverlay = true, Sound = "Soft", LoopSound = false };
}

public sealed class SessionRecord
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Label { get; set; } = "";
    public TimerKind Kind { get; set; }
    public DateTime StartedUtc { get; set; }
    public DateTime EndedUtc { get; set; }
    public TimeSpan Duration { get; set; }
    public bool Completed { get; set; }
}

public enum AlertKind { TimerDone, PomodoroPhase, Reminder, Alarm, BreakOver }

public sealed record AlertRequest(
    AlertKind Kind,
    string Title,
    string Message,
    AlertSettings Settings,
    Guid? TimerId = null,
    Guid? SourceId = null)
{
    public Guid Id { get; } = Guid.NewGuid();
    public bool CanSnooze => Kind is AlertKind.TimerDone or AlertKind.Reminder or AlertKind.Alarm;
}

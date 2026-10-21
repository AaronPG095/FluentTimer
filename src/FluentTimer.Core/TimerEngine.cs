namespace FluentTimer.Core;

/// <summary>
/// Owns all timers, reminders and alarms. The host calls <see cref="Tick"/> a few times a second;
/// the engine raises <see cref="AlertRaised"/> when something needs the user's attention.
/// </summary>
public sealed class TimerEngine
{
    /// <summary>Alarms that fire later than this (e.g. the PC was asleep) are skipped.</summary>
    public static readonly TimeSpan AlarmGrace = TimeSpan.FromMinutes(15);

    private readonly IClock _clock;
    private readonly Func<AppSettings> _settings;
    private bool _suspended;

    public TimerEngine(IClock clock, AppState state, Func<AppSettings> settings)
    {
        _clock = clock;
        State = state;
        _settings = settings;
    }

    public AppState State { get; }
    public IReadOnlyList<TimerItem> Timers => State.Timers;

    /// <summary>Raised when the user should be alerted.</summary>
    public event Action<AlertRequest>? AlertRaised;

    /// <summary>Raised when an alert is no longer relevant (its timer was removed or restarted).</summary>
    public event Action<Guid>? TimerAlertsCleared;

    /// <summary>Raised when a focus or countdown session finishes or is cancelled.</summary>
    public event Action<SessionRecord>? SessionLogged;

    /// <summary>Raised after any change that should be persisted.</summary>
    public event Action? Changed;

    private AppSettings Settings => _settings();
    private DateTime Now => _clock.UtcNow;

    // ---- Countdowns -------------------------------------------------------------------------

    public TimerItem StartCountdown(TimeSpan duration, string label = "", AlertSettings? alert = null, bool? repeat = null)
    {
        if (duration <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(duration));
        var timer = new TimerItem
        {
            Kind = TimerKind.Countdown,
            Label = label.Trim(),
            AlertOverride = alert,
            Repeat = repeat ?? Settings.RepeatByDefault,
        };
        Run(timer, duration);
        State.Timers.Add(timer);
        Changed?.Invoke();
        return timer;
    }

    /// <summary>Start a saved timer: a countdown (name, length, repeat) or a Pomodoro (name, planned sessions).</summary>
    public TimerItem StartSaved(SavedTimer saved) => saved.IsPomodoro
        ? StartPomodoro(saved.Name, saved.Planned)
        : StartCountdown(saved.Duration, saved.Name, repeat: saved.Repeat);

    /// <summary>Save a running (or finished) timer so it can be started again later. Returns the new entry.</summary>
    public SavedTimer? SaveAsTimer(Guid timerId)
    {
        if (Find(timerId) is not { Kind: TimerKind.Countdown or TimerKind.Pomodoro } t) return null;
        var saved = new SavedTimer
        {
            Name = t.Label,
            Kind = t.Kind,
            Duration = t.Kind == TimerKind.Pomodoro
                ? Settings.Pomodoro.PhaseLength(PomodoroPhase.Work)
                : t.InitialDuration > TimeSpan.Zero ? t.InitialDuration : t.Duration,
            Repeat = t.Kind == TimerKind.Countdown && t.Repeat,
            Planned = t.Kind == TimerKind.Pomodoro ? t.Planned : null,
        };
        State.SavedTimers.Add(saved);
        Changed?.Invoke();
        return saved;
    }

    public const int MaxPlanned = 16;

    /// <param name="planned">Number of focus sessions for this task; null keeps going until cancelled.</param>
    public TimerItem StartPomodoro(string label = "", int? planned = null)
    {
        var timer = new TimerItem
        {
            Kind = TimerKind.Pomodoro,
            Label = label.Trim(),
            Phase = PomodoroPhase.Work,
            Planned = planned is { } n ? Math.Clamp(n, 1, MaxPlanned) : null,
        };
        Run(timer, Settings.Pomodoro.PhaseLength(PomodoroPhase.Work));
        State.Timers.Add(timer);
        Changed?.Invoke();
        return timer;
    }

    /// <summary>Set (or clear, with null) how many focus sessions a Pomodoro should run. Never below those already done.</summary>
    public void SetPlanned(Guid id, int? planned)
    {
        if (Find(id) is not { Kind: TimerKind.Pomodoro } t) return;
        int? clean = planned is { } n ? Math.Clamp(n, Math.Max(1, t.CompletedWorkSessions), MaxPlanned) : null;
        if (t.Planned == clean) return;
        t.Planned = clean;
        Changed?.Invoke();
    }

    public void Pause(Guid id)
    {
        if (Find(id) is not { State: TimerState.Running } t) return;
        t.PausedRemaining = t.Remaining(Now);
        t.EndsAtUtc = null;
        t.State = TimerState.Paused;
        if (t.Kind == TimerKind.Pomodoro && t.Phase == PomodoroPhase.Work)
        {
            // In Pomodoro terms a pause is an interruption: count it, and remember when (for strict mode).
            t.Interruptions++;
            t.PausedAtUtc = Now;
        }
        Changed?.Invoke();
    }

    public void Resume(Guid id)
    {
        if (Find(id) is not { State: TimerState.Paused } t) return;
        if (VoidIfPausedTooLong(t)) { Changed?.Invoke(); return; }
        t.PausedAtUtc = null;
        var remaining = t.PausedRemaining ?? t.Duration;
        // A Pomodoro waiting at the start of a phase begins its session now.
        if (remaining == t.Duration) t.StartedAtUtc = Now;
        t.EndsAtUtc = Now + remaining;
        t.PausedRemaining = null;
        t.State = TimerState.Running;
        Changed?.Invoke();
    }

    public void TogglePause(Guid id)
    {
        if (Find(id) is not { } t) return;
        if (t.State == TimerState.Running) Pause(id);
        else if (t.State == TimerState.Paused) Resume(id);
    }

    /// <summary>Adds time to a running or paused timer.</summary>
    public void AddTime(Guid id, TimeSpan extra)
    {
        if (Find(id) is not { } t || t.State == TimerState.Ringing) return;
        t.Duration += extra;
        if (t.State == TimerState.Running) t.EndsAtUtc += extra;
        else t.PausedRemaining = (t.PausedRemaining ?? t.Duration - extra) + extra;
        Changed?.Invoke();
    }

    public void Cancel(Guid id)
    {
        if (Find(id) is not { } t) return;
        if (t.Kind != TimerKind.Break && !(t.Kind == TimerKind.Pomodoro && t.Phase != PomodoroPhase.Work))
        {
            var ran = t.Duration - t.Remaining(Now);
            if (ran >= TimeSpan.FromSeconds(30)) Log(t, ran, completed: t.State == TimerState.Ringing);
        }
        State.Timers.Remove(t);
        TimerAlertsCleared?.Invoke(t.Id);
        Changed?.Invoke();
    }

    /// <summary>Restart from the original length (ignoring added time and snoozes) and keep it running.</summary>
    public void Reset(Guid id)
    {
        if (Find(id) is not { } t) return;
        var tracked = t.Kind == TimerKind.Countdown || t.Kind == TimerKind.Pomodoro && t.Phase == PomodoroPhase.Work;
        var ran = t.Duration - t.Remaining(Now);
        if (tracked && ran >= TimeSpan.FromSeconds(30)) Log(t, ran, completed: false);

        var length = t.Kind == TimerKind.Pomodoro
            ? Settings.Pomodoro.PhaseLength(t.Phase)
            : t.InitialDuration > TimeSpan.Zero ? t.InitialDuration : t.Duration;
        Run(t, length);
        TimerAlertsCleared?.Invoke(t.Id); // a ringing timer that is reset no longer needs its alert
        Changed?.Invoke();
    }

    /// <summary>Skip the rest of the current Pomodoro phase and move to the next one.</summary>
    public void SkipPhase(Guid id)
    {
        if (Find(id) is not { Kind: TimerKind.Pomodoro } t) return;
        AdvancePomodoro(t, raiseAlert: false);
        Changed?.Invoke();
    }

    /// <summary>
    /// Strict mode: a focus session paused longer than the limit no longer counts. It is voided and restarts
    /// from the full length, running. Returns true if that happened.
    /// </summary>
    private bool VoidIfPausedTooLong(TimerItem t)
    {
        var p = Settings.Pomodoro;
        if (!p.StrictMode || t.Kind != TimerKind.Pomodoro || t.Phase != PomodoroPhase.Work || t.PausedAtUtc is not { } pausedAt) return false;
        if (Now - pausedAt <= TimeSpan.FromMinutes(Math.Max(1, p.StrictPauseLimitMinutes))) return false;
        t.Voided++;
        t.Interruptions = 0;
        t.PausedAtUtc = null;
        Run(t, p.PhaseLength(PomodoroPhase.Work));
        return true;
    }

    // ---- Alert responses ----------------------------------------------------------------------

    /// <summary>Name (or rename) a timer at any time. Its sessions are logged under the name it has when they end.</summary>
    public void Rename(Guid id, string name)
    {
        var clean = (name ?? "").Trim();
        if (clean.Length > 60) clean = clean[..60];
        if (Find(id) is not { } t || t.Label == clean) return;
        t.Label = clean;
        Changed?.Invoke();
    }

    public void SetRepeat(Guid id, bool repeat)
    {
        if (Find(id) is not { Kind: TimerKind.Countdown } t || t.Repeat == repeat) return;
        t.Repeat = repeat;
        Changed?.Invoke();
    }

    /// <summary>Acknowledge a finished timer: it is logged, then removed, or restarted if it repeats.</summary>
    public void Dismiss(AlertRequest alert)
    {
        if (alert.Kind == AlertKind.TimerDone && alert.TimerId is { } id && Find(id) is { State: TimerState.Ringing } t)
        {
            Log(t, t.Duration, completed: true);
            if (t.Repeat) Run(t, t.InitialDuration > TimeSpan.Zero ? t.InitialDuration : t.Duration);
            else State.Timers.Remove(t);
            Changed?.Invoke();
        }
    }

    public void Snooze(AlertRequest alert, TimeSpan? length = null)
    {
        var snooze = length ?? TimeSpan.FromMinutes(Settings.SnoozeMinutes);
        switch (alert.Kind)
        {
            case AlertKind.TimerDone when alert.TimerId is { } id && Find(id) is { } t:
                t.Duration += snooze;
                t.EndsAtUtc = Now + snooze;
                t.State = TimerState.Running;
                break;
            case AlertKind.Reminder when FindReminder(alert.SourceId) is { } r:
                r.NextDueUtc = Now + snooze;
                break;
            case AlertKind.Alarm:
                StartCountdown(snooze, alert.Title, alert.Settings, repeat: false); // a snooze never loops
                return;
            default:
                Dismiss(alert);
                return;
        }
        Changed?.Invoke();
    }

    // ---- Reminders & alarms -------------------------------------------------------------------

    /// <summary>Call when reminder settings change so the next due time is recomputed.</summary>
    public void ResetReminder(IntervalReminder reminder)
    {
        reminder.NextDueUtc = null;
        Changed?.Invoke();
    }

    /// <summary>While suspended (screen locked or user idle), interval reminders don't fire.</summary>
    public void SetSuspended(bool suspended)
    {
        if (_suspended == suspended) return;
        _suspended = suspended;
        if (!suspended)
        {
            // Coming back from a break away from the desk restarts every interval.
            foreach (var r in State.Reminders) r.NextDueUtc = null;
            Changed?.Invoke();
        }
    }

    public bool IsSuspended => _suspended;

    public static DateOnly NextOccurrenceDate(TimeOnly time, DateTime localNow) =>
        TimeOnly.FromDateTime(localNow) < time
            ? DateOnly.FromDateTime(localNow)
            : DateOnly.FromDateTime(localNow).AddDays(1);

    // ---- Tick ---------------------------------------------------------------------------------

    /// <summary>Re-raise alerts for timers that were ringing when the app last closed.</summary>
    public void RaisePendingAlerts()
    {
        foreach (var t in State.Timers.Where(t => t.State == TimerState.Ringing).ToList())
            AlertRaised?.Invoke(TimerDoneAlert(t));
    }

    public void Tick()
    {
        var now = Now;
        var changed = false;

        foreach (var t in State.Timers.Where(t => t.State == TimerState.Running && t.EndsAtUtc <= now).ToList())
        {
            Complete(t);
            changed = true;
        }

        changed |= TickReminders(now);
        changed |= TickAlarms();

        if (changed) Changed?.Invoke();
    }

    private bool TickReminders(DateTime now)
    {
        var local = _clock.LocalNow();
        var changed = false;
        foreach (var r in State.Reminders)
        {
            if (!r.Enabled || !r.IsActiveAt(local))
            {
                if (r.NextDueUtc != null) { r.NextDueUtc = null; changed = true; }
                continue;
            }
            if (_suspended) continue;
            if (r.NextDueUtc is null)
            {
                r.NextDueUtc = now + r.Interval;
                changed = true;
                continue;
            }
            if (now < r.NextDueUtc) continue;

            FireReminder(r, now);
            changed = true;
        }
        return changed;
    }

    private void FireReminder(IntervalReminder r, DateTime now)
    {
        var settings = r.AlertOverride ?? (r.BreakDuration is null ? Settings.DefaultAlert : Settings.BreakAlert);
        r.NextDueUtc = now + r.Interval + (r.BreakDuration ?? TimeSpan.Zero);

        Guid? breakId = null;
        var message = $"Every {TimeFormat.Friendly(r.Interval)}";
        if (r.BreakDuration is { } len)
        {
            var brk = new TimerItem { Kind = TimerKind.Break, Label = r.Label, ReminderId = r.Id, AlertOverride = settings };
            Run(brk, len);
            State.Timers.Add(brk);
            breakId = brk.Id;
            message = $"Break for {TimeFormat.Friendly(len)}";
        }
        AlertRaised?.Invoke(new AlertRequest(AlertKind.Reminder, r.Label, message, settings, breakId, r.Id));
    }

    private bool TickAlarms()
    {
        var local = _clock.LocalNow();
        var today = DateOnly.FromDateTime(local);
        var changed = false;
        foreach (var a in State.Alarms)
        {
            if (!a.Enabled || a.LastFired == today) continue;

            if (!a.IsRepeating)
            {
                if (a.Date is not { } date) continue;
                if (date < today) { a.Enabled = false; changed = true; continue; }
                if (date > today) continue;
            }
            else if (!a.RepeatDays.Contains(local.DayOfWeek)) continue;

            var scheduled = today.ToDateTime(a.Time);
            if (local < scheduled) continue;

            a.LastFired = today;
            if (!a.IsRepeating) a.Enabled = false;
            changed = true;

            if (local - scheduled <= AlarmGrace)
            {
                var settings = a.AlertOverride ?? Settings.DefaultAlert;
                AlertRaised?.Invoke(new AlertRequest(AlertKind.Alarm, a.Label, a.Time.ToString("HH:mm"), settings, null, a.Id));
            }
        }
        return changed;
    }

    // ---- Internals ----------------------------------------------------------------------------

    private void Complete(TimerItem t)
    {
        switch (t.Kind)
        {
            case TimerKind.Countdown:
                t.State = TimerState.Ringing;
                t.EndsAtUtc = null;
                AlertRaised?.Invoke(TimerDoneAlert(t));
                break;
            case TimerKind.Pomodoro:
                AdvancePomodoro(t, raiseAlert: true);
                break;
            case TimerKind.Break:
                State.Timers.Remove(t);
                TimerAlertsCleared?.Invoke(t.Id);
                var soft = (t.AlertOverride ?? Settings.BreakAlert).Clone();
                soft.DimOverlay = false;
                soft.LoopSound = false;
                soft.Escalate = false;
                AlertRaised?.Invoke(new AlertRequest(AlertKind.BreakOver, "Break over", t.Label, soft, null, t.ReminderId));
                break;
        }
    }

    private void AdvancePomodoro(TimerItem t, bool raiseAlert)
    {
        var p = Settings.Pomodoro;
        var finished = t.Phase;
        TimerAlertsCleared?.Invoke(t.Id); // the previous phase's alert (e.g. a dimmed break) is over

        if (finished == PomodoroPhase.Work)
        {
            var ran = t.Duration - t.Remaining(Now);
            if (raiseAlert || ran >= TimeSpan.FromMinutes(1)) Log(t, ran, completed: raiseAlert);
            t.CompletedWorkSessions++;
            t.Interruptions = 0;
            t.PausedAtUtc = null;

            // A planned task is done after its last focus session: no more breaks.
            if (t.Planned is { } planned && t.CompletedWorkSessions >= planned)
            {
                State.Timers.Remove(t);
                var done = (t.AlertOverride ?? Settings.DefaultAlert).Clone();
                done.LoopSound = false;
                AlertRaised?.Invoke(new AlertRequest(AlertKind.PomodoroPhase,
                    string.IsNullOrWhiteSpace(t.Label) ? "Pomodoros done" : $"{t.Label} done",
                    $"{t.CompletedWorkSessions}/{planned} pomodoros complete", done, t.Id));
                return;
            }

            t.Phase = p.LongBreakEvery > 0 && t.CompletedWorkSessions % p.LongBreakEvery == 0
                ? PomodoroPhase.LongBreak
                : PomodoroPhase.ShortBreak;
        }
        else
        {
            t.Phase = PomodoroPhase.Work;
        }

        var length = p.PhaseLength(t.Phase);
        var autoStart = t.Phase == PomodoroPhase.Work ? p.AutoStartWork : p.AutoStartBreaks;
        if (autoStart) Run(t, length);
        else Wait(t, length);

        if (!raiseAlert) return;
        if (finished == PomodoroPhase.Work)
        {
            // Breaks use the Breaks alert style (its own calmer sound) and can dim the screen with a countdown.
            var brk = Settings.BreakAlert.Clone();
            brk.LoopSound = false;
            brk.Escalate = false;
            brk.DimOverlay = autoStart && (t.Phase == PomodoroPhase.LongBreak ? p.DimLongBreaks : p.DimShortBreaks);
            AlertRaised?.Invoke(new AlertRequest(AlertKind.PomodoroBreak, "Focus done · take a break",
                $"{TimerItem.PhaseName(t.Phase)} · {TimeFormat.Friendly(length)}", brk, t.Id));
        }
        else
        {
            // Back to work: the timer/alarm sound, so the two transitions sound different.
            var back = (t.AlertOverride ?? Settings.DefaultAlert).Clone();
            back.LoopSound = false;
            AlertRaised?.Invoke(new AlertRequest(AlertKind.PomodoroPhase, "Break over",
                autoStart ? "Next focus session started" : "Ready to focus? Click to start", back, t.Id));
        }
    }

    private void Run(TimerItem t, TimeSpan length)
    {
        t.Duration = length;
        t.InitialDuration = length;
        t.StartedAtUtc = Now;
        t.EndsAtUtc = Now + length;
        t.PausedRemaining = null;
        t.State = TimerState.Running;
    }

    private static void Wait(TimerItem t, TimeSpan length)
    {
        t.Duration = length;
        t.InitialDuration = length;
        t.EndsAtUtc = null;
        t.PausedRemaining = length;
        t.State = TimerState.Paused;
    }

    private AlertRequest TimerDoneAlert(TimerItem t) =>
        new(AlertKind.TimerDone, t.DisplayLabel,
            t.Repeat
                ? $"{TimeFormat.Friendly(t.Duration)} is up · click to go again"
                : $"{TimeFormat.Friendly(t.Duration)} is up",
            t.AlertOverride ?? Settings.DefaultAlert, t.Id)
        { Repeats = t.Repeat };

    private void Log(TimerItem t, TimeSpan duration, bool completed) =>
        SessionLogged?.Invoke(new SessionRecord
        {
            Label = t.Label,
            Kind = t.Kind,
            StartedUtc = t.StartedAtUtc,
            EndedUtc = Now,
            Duration = duration,
            Completed = completed,
            Interruptions = t.Kind == TimerKind.Pomodoro ? t.Interruptions : 0,
        });

    private TimerItem? Find(Guid id) => State.Timers.FirstOrDefault(t => t.Id == id);

    private IntervalReminder? FindReminder(Guid? id) => State.Reminders.FirstOrDefault(r => r.Id == id);
}

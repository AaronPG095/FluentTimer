using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class TimerEngineTests
{
    private static readonly TimeSpan Min = TimeSpan.FromMinutes(1);

    [Fact]
    public void Countdown_rings_when_end_time_passes()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(10 * Min, "Tea");

        f.Advance(9 * Min);
        Assert.Empty(f.Alerts);
        Assert.Equal(Min, t.Remaining(f.Clock.UtcNow));

        f.Advance(Min);
        var alert = Assert.Single(f.Alerts);
        Assert.Equal(AlertKind.TimerDone, alert.Kind);
        Assert.Equal(TimerState.Ringing, t.State);
    }

    [Fact]
    public void Several_countdowns_run_independently()
    {
        var f = new EngineFixture();
        f.Engine.StartCountdown(5 * Min, "A");
        f.Engine.StartCountdown(10 * Min, "B");

        f.Advance(5 * Min);
        Assert.Equal("A", Assert.Single(f.Alerts).Title);
        f.Advance(5 * Min);
        Assert.Equal(2, f.Alerts.Count);
    }

    [Fact]
    public void Pause_freezes_remaining_time()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(10 * Min);
        f.Advance(3 * Min);
        f.Engine.Pause(t.Id);
        f.Advance(60 * Min);

        Assert.Empty(f.Alerts);
        Assert.Equal(7 * Min, t.Remaining(f.Clock.UtcNow));

        f.Engine.Resume(t.Id);
        f.Advance(7 * Min);
        Assert.Single(f.Alerts);
    }

    [Fact]
    public void Timer_that_ended_while_app_was_closed_rings_on_first_tick()
    {
        var f = new EngineFixture();
        f.Engine.StartCountdown(10 * Min);
        f.Advance(3 * 60 * Min); // e.g. PC was off
        Assert.Single(f.Alerts);
    }

    [Fact]
    public void Dismiss_logs_completed_session_and_removes_timer()
    {
        var f = new EngineFixture();
        f.Engine.StartCountdown(10 * Min, "Writing");
        f.Advance(10 * Min);
        f.Engine.Dismiss(f.Alerts[0]);

        Assert.Empty(f.State.Timers);
        var s = Assert.Single(f.Sessions);
        Assert.True(s.Completed);
        Assert.Equal(10 * Min, s.Duration);
        Assert.Equal("Writing", s.Label);
    }

    [Fact]
    public void Snooze_restarts_ringing_timer()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(10 * Min);
        f.Advance(10 * Min);
        f.Engine.Snooze(f.Alerts[0], 5 * Min);

        Assert.Equal(TimerState.Running, t.State);
        f.Advance(5 * Min);
        Assert.Equal(2, f.Alerts.Count);
    }

    [Fact]
    public void Cancel_logs_partial_session()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(25 * Min, "Email");
        f.Advance(12 * Min);
        f.Engine.Cancel(t.Id);

        var s = Assert.Single(f.Sessions);
        Assert.False(s.Completed);
        Assert.Equal(12 * Min, s.Duration);
    }

    [Fact]
    public void AddTime_extends_running_timer()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(Min);
        f.Engine.AddTime(t.Id, Min);
        f.Advance(Min);
        Assert.Empty(f.Alerts);
        f.Advance(Min);
        Assert.Single(f.Alerts);
    }

    [Fact]
    public void Reset_restarts_from_original_length_and_keeps_running()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartCountdown(60 * Min, "Deep work");
        f.Engine.AddTime(t.Id, 5 * Min);
        f.Advance(20 * Min);
        f.Engine.Pause(t.Id);

        f.Engine.Reset(t.Id);

        Assert.Equal(TimerState.Running, t.State);
        Assert.Equal(60 * Min, t.Duration);
        Assert.Equal(60 * Min, t.Remaining(f.Clock.UtcNow));
        var s = Assert.Single(f.Sessions); // the 20 minutes already spent still count
        Assert.Equal(20 * Min, s.Duration);
        Assert.False(s.Completed);
    }

    [Fact]
    public void Reset_of_ringing_timer_clears_alert_and_runs_again()
    {
        var f = new EngineFixture();
        var cleared = new List<Guid>();
        f.Engine.TimerAlertsCleared += cleared.Add;
        var t = f.Engine.StartCountdown(10 * Min);
        f.Advance(10 * Min);
        Assert.Equal(TimerState.Ringing, t.State);

        f.Engine.Reset(t.Id);

        Assert.Equal(TimerState.Running, t.State);
        Assert.Contains(t.Id, cleared);
        f.Advance(10 * Min);
        Assert.Equal(2, f.Alerts.Count);
    }

    [Fact]
    public void Reset_of_pomodoro_restarts_current_phase()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro();
        f.Advance(25 * Min); // now in a short break
        f.Advance(2 * Min);
        f.Engine.Reset(t.Id);
        Assert.Equal(PomodoroPhase.ShortBreak, t.Phase);
        Assert.Equal(5 * Min, t.Remaining(f.Clock.UtcNow));
    }

    [Fact]
    public void Pomodoro_cycles_work_and_breaks_with_long_break_every_fourth()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro("Thesis");

        for (var i = 1; i <= 4; i++)
        {
            Assert.Equal(PomodoroPhase.Work, t.Phase);
            f.Advance(25 * Min);
            Assert.Equal(i == 4 ? PomodoroPhase.LongBreak : PomodoroPhase.ShortBreak, t.Phase);
            Assert.Equal(TimerState.Running, t.State); // breaks auto-start

            f.Advance(t.Duration);
            Assert.Equal(PomodoroPhase.Work, t.Phase);
            Assert.Equal(TimerState.Paused, t.State); // work waits for the user
            f.Engine.Resume(t.Id);
        }

        Assert.Equal(4, f.Sessions.Count);
        Assert.All(f.Sessions, s => Assert.Equal(25 * Min, s.Duration));
        Assert.Equal(15 * Min, f.Settings.Pomodoro.PhaseLength(PomodoroPhase.LongBreak));
    }

    [Fact]
    public void Reminder_fires_on_interval_only_in_active_hours()
    {
        var f = new EngineFixture();
        f.State.Reminders.Add(new IntervalReminder { Label = "Stand", Interval = 30 * Min });

        f.Advance(TimeSpan.FromSeconds(1)); // schedules first due time
        f.Advance(30 * Min);
        Assert.Single(f.Alerts);
        f.Advance(30 * Min);
        Assert.Equal(2, f.Alerts.Count);

        f.Clock.UtcNow = new DateTime(2026, 10, 14, 19, 0, 0, DateTimeKind.Utc); // after 18:00
        f.Engine.Tick();
        f.Advance(60 * Min);
        Assert.Equal(2, f.Alerts.Count);
    }

    [Fact]
    public void Reminder_does_not_fire_on_weekend()
    {
        var f = new EngineFixture();
        f.Clock.UtcNow = new DateTime(2026, 10, 17, 10, 0, 0, DateTimeKind.Utc); // Saturday
        f.State.Reminders.Add(new IntervalReminder { Interval = 30 * Min });
        f.Advance(Min);
        f.Advance(120 * Min);
        Assert.Empty(f.Alerts);
    }

    [Fact]
    public void Suspension_pauses_and_restarts_reminder_interval()
    {
        var f = new EngineFixture();
        f.State.Reminders.Add(new IntervalReminder { Interval = 30 * Min });
        f.Advance(TimeSpan.FromSeconds(1));
        f.Advance(20 * Min);

        f.Engine.SetSuspended(true);
        f.Advance(60 * Min);
        Assert.Empty(f.Alerts);

        f.Engine.SetSuspended(false);
        f.Advance(TimeSpan.FromSeconds(1));
        f.Advance(29 * Min);
        Assert.Empty(f.Alerts); // interval restarted on return
        f.Advance(Min);
        Assert.Single(f.Alerts);
    }

    [Fact]
    public void Break_reminder_starts_break_timer_then_signals_break_over()
    {
        var f = new EngineFixture();
        f.State.Reminders.Add(new IntervalReminder { Interval = 20 * Min, BreakDuration = TimeSpan.FromSeconds(20) });
        f.Advance(TimeSpan.FromSeconds(1));
        f.Advance(20 * Min);

        var alert = Assert.Single(f.Alerts);
        Assert.True(alert.Settings.DimOverlay);
        var brk = Assert.Single(f.State.Timers);
        Assert.Equal(TimerKind.Break, brk.Kind);

        f.Advance(TimeSpan.FromSeconds(20));
        Assert.Equal(AlertKind.BreakOver, f.Alerts[^1].Kind);
        Assert.Empty(f.State.Timers);
        Assert.Empty(f.Sessions); // breaks are not tracked time
    }

    [Fact]
    public void Repeating_alarm_fires_once_per_matching_day()
    {
        var f = new EngineFixture();
        f.State.Alarms.Add(new Alarm { Time = new TimeOnly(12, 0), RepeatDays = [DayOfWeek.Wednesday, DayOfWeek.Thursday] });

        f.Advance(2 * 60 * Min); // 12:00 Wed
        Assert.Single(f.Alerts);
        f.Advance(Min);
        Assert.Single(f.Alerts);

        f.Advance(24 * 60 * Min); // Thu
        Assert.Equal(2, f.Alerts.Count);
        f.Advance(24 * 60 * Min); // Fri
        Assert.Equal(2, f.Alerts.Count);
    }

    [Fact]
    public void One_off_alarm_disables_after_firing_and_skips_if_long_missed()
    {
        var f = new EngineFixture();
        var today = new DateOnly(2026, 10, 14);
        var a = new Alarm { Time = new TimeOnly(10, 30), Date = today };
        var missed = new Alarm { Time = new TimeOnly(8, 0), Date = today };
        f.State.Alarms.AddRange([a, missed]);

        f.Advance(30 * Min);
        Assert.Single(f.Alerts);
        Assert.False(a.Enabled);
        Assert.False(missed.Enabled);
    }

    [Fact]
    public void Alarm_snooze_starts_countdown()
    {
        var f = new EngineFixture();
        f.State.Alarms.Add(new Alarm { Label = "Lunch", Time = new TimeOnly(10, 1), Date = new DateOnly(2026, 10, 14) });
        f.Advance(Min);
        f.Engine.Snooze(f.Alerts[0], 5 * Min);
        Assert.Equal("Lunch", Assert.Single(f.State.Timers).Label);
    }

    [Fact]
    public void NextOccurrenceDate_rolls_to_tomorrow_when_time_passed()
    {
        var now = new DateTime(2026, 10, 14, 15, 0, 0);
        Assert.Equal(new DateOnly(2026, 10, 14), TimerEngine.NextOccurrenceDate(new TimeOnly(16, 0), now));
        Assert.Equal(new DateOnly(2026, 10, 15), TimerEngine.NextOccurrenceDate(new TimeOnly(9, 0), now));
    }
}

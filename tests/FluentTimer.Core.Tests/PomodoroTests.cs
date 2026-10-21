using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class PomodoroTests
{
    private static readonly TimeSpan Min = TimeSpan.FromMinutes(1);

    [Fact]
    public void Pausing_focus_counts_interruptions_and_logs_them()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro("Thesis");
        f.Advance(5 * Min);
        f.Engine.Pause(t.Id);
        f.Advance(Min);
        f.Engine.Resume(t.Id);
        f.Engine.Pause(t.Id);
        f.Engine.Resume(t.Id);
        Assert.Equal(2, t.Interruptions);

        f.Advance(20 * Min);
        var s = Assert.Single(f.Sessions);
        Assert.True(s.IsCompletedPomodoro);
        Assert.Equal(2, s.Interruptions);
        Assert.Equal(0, t.Interruptions); // reset for the next focus session
    }

    [Fact]
    public void Pausing_a_break_is_not_an_interruption()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro();
        f.Advance(25 * Min); // short break running
        f.Engine.Pause(t.Id);
        Assert.Equal(0, t.Interruptions);
    }

    [Fact]
    public void Strict_mode_voids_a_focus_session_paused_too_long()
    {
        var f = new EngineFixture();
        f.Settings.Pomodoro.StrictMode = true;
        f.Settings.Pomodoro.StrictPauseLimitMinutes = 2;
        var t = f.Engine.StartPomodoro();

        f.Advance(10 * Min);
        f.Engine.Pause(t.Id);
        f.Advance(Min);
        f.Engine.Resume(t.Id); // within the limit: carries on
        Assert.Equal(15 * Min, t.Remaining(f.Clock.UtcNow));
        Assert.Equal(0, t.Voided);

        f.Engine.Pause(t.Id);
        f.Advance(3 * Min);
        f.Engine.Resume(t.Id); // too long: voided, restarts from 25:00 and runs
        Assert.Equal(1, t.Voided);
        Assert.Equal(TimerState.Running, t.State);
        Assert.Equal(25 * Min, t.Remaining(f.Clock.UtcNow));
        Assert.Equal(0, t.Interruptions);
    }

    [Fact]
    public void Without_strict_mode_a_long_pause_is_fine()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro();
        f.Advance(10 * Min);
        f.Engine.Pause(t.Id);
        f.Advance(60 * Min);
        f.Engine.Resume(t.Id);
        Assert.Equal(15 * Min, t.Remaining(f.Clock.UtcNow));
        Assert.Equal(0, t.Voided);
    }

    [Fact]
    public void Planned_task_finishes_after_its_last_focus_session()
    {
        var f = new EngineFixture();
        f.Settings.Pomodoro.AutoStartWork = true;
        var t = f.Engine.StartPomodoro("Thesis", planned: 2);

        f.Advance(25 * Min);      // focus 1 done -> short break
        f.Advance(5 * Min);       // break over -> focus 2
        f.Advance(25 * Min);      // focus 2 done -> task complete

        Assert.Empty(f.State.Timers);
        var done = f.Alerts[^1];
        Assert.Equal("Thesis done", done.Title);
        Assert.Equal("2/2 pomodoros complete", done.Message);
        Assert.Equal(2, f.Sessions.Count(s => s.IsCompletedPomodoro));
    }

    [Fact]
    public void Planned_count_can_be_changed_but_not_below_sessions_done()
    {
        var f = new EngineFixture();
        var t = f.Engine.StartPomodoro(planned: 4);
        f.Advance(25 * Min);
        f.Engine.SetPlanned(t.Id, 0);
        Assert.Equal(1, t.Planned);
        f.Engine.SetPlanned(t.Id, 99);
        Assert.Equal(TimerEngine.MaxPlanned, t.Planned);
        f.Engine.SetPlanned(t.Id, null);
        Assert.Null(t.Planned);
    }

    [Fact]
    public void Breaks_use_the_break_alert_and_dim_long_breaks_by_default()
    {
        var f = new EngineFixture();
        f.Settings.BreakAlert.Sound = "Soft";
        f.Settings.DefaultAlert.Sound = "Chime";
        var cleared = new List<Guid>();
        f.Engine.TimerAlertsCleared += cleared.Add;
        var t = f.Engine.StartPomodoro();

        f.Advance(25 * Min); // short break
        var shortBreak = f.Alerts[^1];
        Assert.Equal(AlertKind.PomodoroBreak, shortBreak.Kind);
        Assert.Equal("Soft", shortBreak.Settings.Sound);
        Assert.False(shortBreak.Settings.DimOverlay);

        f.Advance(5 * Min); // break over: different sound, and the break's alert is cleared
        Assert.Equal(AlertKind.PomodoroPhase, f.Alerts[^1].Kind);
        Assert.Equal("Chime", f.Alerts[^1].Settings.Sound);
        Assert.Contains(t.Id, cleared);

        for (var i = 0; i < 3; i++)
        {
            f.Engine.Resume(t.Id);
            f.Advance(25 * Min);
            if (i < 2) f.Advance(5 * Min);
        }
        var longBreak = f.Alerts[^1];
        Assert.Equal(PomodoroPhase.LongBreak, t.Phase);
        Assert.True(longBreak.Settings.DimOverlay);
    }

    [Fact]
    public void Counts_pomodoros_per_day_and_per_label()
    {
        var clock = new FakeClock(new DateTime(2026, 10, 14, 12, 0, 0));
        SessionRecord S(string label, int day, bool completed, TimerKind kind = TimerKind.Pomodoro) => new()
        {
            Label = label, Kind = kind, Completed = completed,
            EndedUtc = new DateTime(2026, 10, day, 10, 0, 0, DateTimeKind.Utc), Duration = TimeSpan.FromMinutes(25),
        };
        var records = new[] { S("Thesis", 14, true), S("Thesis", 14, true), S("Thesis", 14, false), S("Email", 14, true, TimerKind.Countdown), S("Thesis", 13, true) };

        Assert.Equal(2, HistoryReport.PomodorosOn(records, clock, new DateOnly(2026, 10, 14)));
        var thesis = HistoryReport.Totals(records).Single(t => t.Label == "Thesis");
        Assert.Equal(3, thesis.Pomodoros);
    }

    [Theory]
    [InlineData("pomo 4 thesis", 4, "thesis")]
    [InlineData("pomodoro 3x writing", 3, "writing")]
    [InlineData("focus 2 pomos", 2, "")]
    [InlineData("pomo writing", null, "writing")]
    [InlineData("pomo", null, "")]
    public void Quick_entry_parses_planned_pomodoros(string input, int? planned, string label)
    {
        Assert.True(QuickEntryParser.TryParse(input, out var e));
        Assert.Equal(QuickEntryKind.Pomodoro, e.Kind);
        Assert.Equal(planned, e.Planned);
        Assert.Equal(label, e.Label);
    }

    [Fact]
    public void Saved_pomodoro_starts_with_its_plan_and_can_be_saved_from_a_running_one()
    {
        var f = new EngineFixture();
        var saved = new SavedTimer { Name = "Thesis", Kind = TimerKind.Pomodoro, Planned = 4 };
        var t = f.Engine.StartSaved(saved);
        Assert.Equal((TimerKind.Pomodoro, "Thesis", (int?)4), (t.Kind, t.Label, t.Planned));

        var again = f.Engine.SaveAsTimer(t.Id);
        Assert.NotNull(again);
        Assert.Equal((TimerKind.Pomodoro, (int?)4, false), (again.Kind, again.Planned, again.Repeat));
    }
}

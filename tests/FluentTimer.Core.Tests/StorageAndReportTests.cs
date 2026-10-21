using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class StorageAndReportTests
{
    [Fact]
    public void State_round_trips_through_json()
    {
        var dir = Path.Combine(Path.GetTempPath(), "FluentTimerTests", Guid.NewGuid().ToString("N"));
        var store = new JsonStore<AppState>(Path.Combine(dir, "state.json"), AppState.CreateDefault);
        var end = new DateTime(2026, 10, 14, 10, 25, 0, DateTimeKind.Utc);
        var state = new AppState
        {
            Timers = [new TimerItem { Label = "Tea", Duration = TimeSpan.FromMinutes(4), EndsAtUtc = end, Kind = TimerKind.Pomodoro, Phase = PomodoroPhase.LongBreak }],
            Alarms = [new Alarm { Time = new TimeOnly(7, 30), RepeatDays = [DayOfWeek.Monday] }],
            Reminders = [new IntervalReminder { BreakDuration = TimeSpan.FromSeconds(20) }],
            SavedTimers = [new SavedTimer { Name = "Tea", Duration = TimeSpan.FromMinutes(4), Repeat = true }],
        };

        store.Save(state);
        var loaded = store.Load();

        var t = Assert.Single(loaded.Timers);
        Assert.Equal("Tea", t.Label);
        Assert.Equal(end, t.EndsAtUtc);
        Assert.Equal(PomodoroPhase.LongBreak, t.Phase);
        Assert.Equal(new TimeOnly(7, 30), loaded.Alarms[0].Time);
        Assert.Equal(TimeSpan.FromSeconds(20), loaded.Reminders[0].BreakDuration);
        var saved = Assert.Single(loaded.SavedTimers);
        Assert.Equal(("Tea", TimeSpan.FromMinutes(4), true), (saved.Name, saved.Duration, saved.Repeat));
        Directory.Delete(dir, true);
    }

    [Fact]
    public void Corrupt_file_falls_back_to_default_and_is_kept()
    {
        var dir = Path.Combine(Path.GetTempPath(), "FluentTimerTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "settings.json");
        File.WriteAllText(path, "{ not json");

        var settings = new JsonStore<AppSettings>(path, () => new AppSettings()).Load();

        Assert.Equal("Ctrl+Alt+T", settings.Hotkey);
        Assert.True(File.Exists(path + ".corrupt"));
        Directory.Delete(dir, true);
    }

    [Fact]
    public void Totals_group_by_label_case_insensitively()
    {
        var records = new[]
        {
            new SessionRecord { Label = "Client X", Duration = TimeSpan.FromMinutes(25) },
            new SessionRecord { Label = "client x", Duration = TimeSpan.FromMinutes(25) },
            new SessionRecord { Label = "", Duration = TimeSpan.FromMinutes(10) },
        };
        var totals = HistoryReport.Totals(records);

        Assert.Equal(2, totals.Count);
        Assert.Equal(TimeSpan.FromMinutes(50), totals[0].Total);
        Assert.Equal(2, totals[0].Sessions);
        Assert.Equal(HistoryReport.NoLabel, totals[1].Label);
    }

    [Fact]
    public void Csv_escapes_commas_quotes_and_formulas()
    {
        var clock = new FakeClock(new DateTime(2026, 10, 14));
        var start = new DateTime(2026, 10, 14, 9, 0, 0, DateTimeKind.Utc);
        var csv = HistoryReport.ToCsv(
        [
            new SessionRecord { Label = "Smith, \"Big\" deal", StartedUtc = start, EndedUtc = start.AddMinutes(25), Duration = TimeSpan.FromMinutes(25), Completed = true },
            new SessionRecord { Label = "=HYPERLINK()", StartedUtc = start, EndedUtc = start.AddMinutes(5), Duration = TimeSpan.FromMinutes(5) },
        ], clock);

        var lines = csv.TrimEnd().Split(Environment.NewLine);
        Assert.Equal("Date,Start,End,Label,Type,Minutes,Completed,Interruptions", lines[0]);
        Assert.Contains("\"Smith, \"\"Big\"\" deal\"", csv);
        Assert.Contains(",'=HYPERLINK(),", csv);
        Assert.Contains("2026-10-14,09:00,09:25", csv);
    }

    [Fact]
    public void Daily_splits_by_series_and_folds_the_rest_into_other()
    {
        var clock = new FakeClock(new DateTime(2026, 10, 14));
        SessionRecord S(string label, int day, int minutes) => new()
        {
            Label = label,
            EndedUtc = new DateTime(2026, 10, day, 12, 0, 0, DateTimeKind.Utc),
            Duration = TimeSpan.FromMinutes(minutes),
        };
        var records = new[] { S("Client X", 12, 50), S("client x", 12, 10), S("Thesis", 13, 25), S("Email", 13, 5), S("Old", 1, 99) };

        var series = HistoryReport.SeriesLabels(records, max: 2);
        var days = HistoryReport.Daily(records, clock, new DateOnly(2026, 10, 12), 3, series);

        Assert.Equal(["Old", "Client X"], series); // all-time ranking keeps colours stable
        Assert.Equal(3, days.Count);
        Assert.Equal(TimeSpan.FromMinutes(60), days[0].BySeries[1]);
        Assert.Equal(TimeSpan.FromMinutes(30), days[1].BySeries[2]); // Thesis + Email -> Other
        Assert.Equal(TimeSpan.Zero, days[2].Total);
    }

    [Fact]
    public void StartOfWeek_is_monday()
    {
        Assert.Equal(new DateTime(2026, 10, 12), HistoryReport.StartOfWeek(new DateTime(2026, 10, 18, 23, 0, 0)));
        Assert.Equal(new DateTime(2026, 10, 12), HistoryReport.StartOfWeek(new DateTime(2026, 10, 12, 1, 0, 0)));
    }

    [Theory]
    [InlineData(299.2, "05:00")]
    [InlineData(3900, "1:05:00")]
    [InlineData(0, "00:00")]
    public void Countdown_format_rounds_up(double seconds, string expected) =>
        Assert.Equal(expected, TimeFormat.Countdown(TimeSpan.FromSeconds(seconds)));

    [Theory]
    [InlineData("Chime")]
    [InlineData("Bell")]
    [InlineData("Digital")]
    [InlineData("Soft")]
    public void Built_in_sounds_render_valid_wav(string name)
    {
        var wav = SoundSynth.Render(name, 0.5);
        Assert.Equal("RIFF", System.Text.Encoding.ASCII.GetString(wav, 0, 4));
        Assert.Equal("WAVE", System.Text.Encoding.ASCII.GetString(wav, 8, 4));
        Assert.Equal(wav.Length - 8, BitConverter.ToInt32(wav, 4));
        Assert.True(wav.Length > 44 + SoundSynth.SampleRate); // > 0.5 s of audio
    }
}

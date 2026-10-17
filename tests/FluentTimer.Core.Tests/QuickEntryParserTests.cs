using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class QuickEntryParserTests
{
    [Theory]
    [InlineData("25m", 25 * 60, "")]
    [InlineData("25", 25 * 60, "")]
    [InlineData("90s", 90, "")]
    [InlineData("1h30", 90 * 60, "")]
    [InlineData("1h 30m", 90 * 60, "")]
    [InlineData("1.5h", 90 * 60, "")]
    [InlineData("2m30s", 150, "")]
    [InlineData("2 min 30 sec", 150, "")]
    [InlineData("5:00", 300, "")]
    [InlineData("1:05:00", 3900, "")]
    [InlineData("25m deep work", 25 * 60, "deep work")]
    [InlineData("Tea 4m", 4 * 60, "Tea")]
    [InlineData("Call   mum 10 min", 10 * 60, "Call mum")]
    [InlineData("5 meeting", 5 * 60, "meeting")]
    public void Parses_countdowns(string input, int seconds, string label)
    {
        Assert.True(QuickEntryParser.TryParse(input, out var e));
        Assert.Equal(QuickEntryKind.Countdown, e.Kind);
        Assert.Equal(TimeSpan.FromSeconds(seconds), e.Duration);
        Assert.Equal(label, e.Label);
    }

    [Theory]
    [InlineData("at 14:30", 14, 30, "")]
    [InlineData("@9", 9, 0, "")]
    [InlineData("2:30pm call", 14, 30, "call")]
    [InlineData("lunch at 12:00", 12, 0, "lunch")]
    [InlineData("12am", 0, 0, "")]
    [InlineData("7 am standup", 7, 0, "standup")]
    public void Parses_alarms(string input, int h, int m, string label)
    {
        Assert.True(QuickEntryParser.TryParse(input, out var e));
        Assert.Equal(QuickEntryKind.Alarm, e.Kind);
        Assert.Equal(new TimeOnly(h, m), e.Time);
        Assert.Equal(label, e.Label);
    }

    [Theory]
    [InlineData("pomo", "")]
    [InlineData("pomodoro writing", "writing")]
    [InlineData("Thesis focus", "Thesis")]
    public void Parses_pomodoro(string input, string label)
    {
        Assert.True(QuickEntryParser.TryParse(input, out var e));
        Assert.Equal(QuickEntryKind.Pomodoro, e.Kind);
        Assert.Equal(label, e.Label);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("hello")]
    [InlineData("0m")]
    [InlineData("at 25:00")]
    [InlineData("13pm")]
    [InlineData("5:75")]
    public void Rejects_invalid(string input) => Assert.False(QuickEntryParser.TryParse(input, out _));

    [Fact]
    public void TryParseDuration_requires_whole_string()
    {
        Assert.True(QuickEntryParser.TryParseDuration("45m", out var d));
        Assert.Equal(TimeSpan.FromMinutes(45), d);
        Assert.False(QuickEntryParser.TryParseDuration("45m tea", out _));
    }
}

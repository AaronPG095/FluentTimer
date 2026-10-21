using System.Globalization;
using System.Text;

namespace FluentTimer.Core;

public sealed record LabelTotal(string Label, TimeSpan Total, int Sessions, int Pomodoros = 0);

/// <summary>One chart column: totals per series slot; the last slot is "Other".</summary>
public sealed record DayTotals(DateOnly Day, TimeSpan[] BySeries)
{
    public TimeSpan Total => new(BySeries.Sum(t => t.Ticks));
}

public static class HistoryReport
{
    public const string NoLabel = "(no label)";

    public static DateTime StartOfWeek(DateTime local)
    {
        var diff = ((int)local.DayOfWeek - (int)DayOfWeek.Monday + 7) % 7;
        return local.Date.AddDays(-diff);
    }

    /// <summary>Sessions that ended within [fromLocal, toLocal).</summary>
    public static IEnumerable<SessionRecord> InRange(IEnumerable<SessionRecord> records, IClock clock, DateTime fromLocal, DateTime toLocal) =>
        records.Where(r =>
        {
            var ended = clock.ToLocal(r.EndedUtc);
            return ended >= fromLocal && ended < toLocal;
        });

    public static IReadOnlyList<LabelTotal> Totals(IEnumerable<SessionRecord> records) =>
        records
            .GroupBy(r => string.IsNullOrWhiteSpace(r.Label) ? NoLabel : r.Label.Trim(), StringComparer.OrdinalIgnoreCase)
            .Select(g => new LabelTotal(g.First().Label is { Length: > 0 } l ? l.Trim() : NoLabel,
                new TimeSpan(g.Sum(r => r.Duration.Ticks)), g.Count(), g.Count(r => r.IsCompletedPomodoro)))
            .OrderByDescending(t => t.Total)
            .ToList();

    /// <summary>
    /// Per-day totals per series for a chart. <paramref name="series"/> are the labels that get their own colour
    /// (in fixed order); everything else is summed into <see cref="Other"/>.
    /// </summary>
    public static IReadOnlyList<DayTotals> Daily(IEnumerable<SessionRecord> records, IClock clock, DateOnly firstDay, int days,
        IReadOnlyList<string> series)
    {
        var result = Enumerable.Range(0, days).Select(i => new DayTotals(firstDay.AddDays(i), new TimeSpan[series.Count + 1])).ToList();
        foreach (var r in records)
        {
            var day = DateOnly.FromDateTime(clock.ToLocal(r.EndedUtc));
            var index = day.DayNumber - firstDay.DayNumber;
            if (index < 0 || index >= days) continue;
            var slot = IndexOf(series, Normalize(r.Label));
            result[index].BySeries[slot < 0 ? series.Count : slot] += r.Duration;
        }
        return result;
    }

    public const string Other = "Other";

    /// <summary>Completed Pomodoro focus sessions that ended on the given local day.</summary>
    public static int PomodorosOn(IEnumerable<SessionRecord> records, IClock clock, DateOnly day) =>
        records.Count(r => r.IsCompletedPomodoro && DateOnly.FromDateTime(clock.ToLocal(r.EndedUtc)) == day);

    /// <summary>
    /// Labels ranked by all-time total, so a label keeps its colour whichever period is shown
    /// (colour follows the entity, not its rank in the current view).
    /// </summary>
    public static IReadOnlyList<string> SeriesLabels(IEnumerable<SessionRecord> allRecords, int max) =>
        Totals(allRecords).Take(max).Select(t => t.Label).ToList();

    private static string Normalize(string label) => string.IsNullOrWhiteSpace(label) ? NoLabel : label.Trim();

    private static int IndexOf(IReadOnlyList<string> series, string label)
    {
        for (var i = 0; i < series.Count; i++)
            if (string.Equals(series[i], label, StringComparison.OrdinalIgnoreCase)) return i;
        return -1;
    }

    public static string ToCsv(IEnumerable<SessionRecord> records, IClock clock)
    {
        var sb = new StringBuilder();
        sb.AppendLine("Date,Start,End,Label,Type,Minutes,Completed,Interruptions");
        foreach (var r in records.OrderBy(r => r.StartedUtc))
        {
            var start = clock.ToLocal(r.StartedUtc);
            var end = clock.ToLocal(r.EndedUtc);
            sb.Append(start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).Append(',')
              .Append(start.ToString("HH:mm", CultureInfo.InvariantCulture)).Append(',')
              .Append(end.ToString("HH:mm", CultureInfo.InvariantCulture)).Append(',')
              .Append(Escape(r.Label)).Append(',')
              .Append(r.Kind == TimerKind.Pomodoro ? "Focus" : "Timer").Append(',')
              .Append(Math.Round(r.Duration.TotalMinutes, 1).ToString(CultureInfo.InvariantCulture)).Append(',')
              .Append(r.Completed ? "yes" : "no").Append(',')
              .Append(r.Interruptions.ToString(CultureInfo.InvariantCulture))
              .AppendLine();
        }
        return sb.ToString();
    }

    private static string Escape(string value)
    {
        // Leading =, +, -, @ would be evaluated as formulas by spreadsheet apps.
        if (value.Length > 0 && "=+-@".Contains(value[0])) value = "'" + value;
        return value.IndexOfAny([',', '"', '\n', '\r']) >= 0
            ? "\"" + value.Replace("\"", "\"\"") + "\""
            : value;
    }
}

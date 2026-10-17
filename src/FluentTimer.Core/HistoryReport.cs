using System.Globalization;
using System.Text;

namespace FluentTimer.Core;

public sealed record LabelTotal(string Label, TimeSpan Total, int Sessions);

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
                new TimeSpan(g.Sum(r => r.Duration.Ticks)), g.Count()))
            .OrderByDescending(t => t.Total)
            .ToList();

    public static string ToCsv(IEnumerable<SessionRecord> records, IClock clock)
    {
        var sb = new StringBuilder();
        sb.AppendLine("Date,Start,End,Label,Type,Minutes,Completed");
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
              .Append(r.Completed ? "yes" : "no")
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

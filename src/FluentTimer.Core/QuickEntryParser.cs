using System.Globalization;
using System.Text.RegularExpressions;

namespace FluentTimer.Core;

public enum QuickEntryKind { Countdown, Alarm, Pomodoro }

public sealed record QuickEntry(QuickEntryKind Kind, TimeSpan Duration, TimeOnly Time, string Label);

/// <summary>
/// Parses quick-entry text such as "25m", "1h30 deep work", "Tea 4m", "90s", "5:00",
/// "at 14:30 lunch", "2:30pm call" or "pomo writing".
/// A bare "h:mm" is a duration; prefix "at"/"@" or add am/pm to set a clock-time alarm.
/// </summary>
public static partial class QuickEntryParser
{
    private const string End = @"(?=\s|$)";

    [GeneratedRegex(@"^(?:pomo|pomodoro|focus)" + End, RegexOptions.IgnoreCase)]
    private static partial Regex PomodoroRx();

    [GeneratedRegex(@"^(?:(?:at\s+|@)(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)?|(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm))" + End, RegexOptions.IgnoreCase)]
    private static partial Regex AlarmRx();

    [GeneratedRegex(@"^(?<h>\d+)\s*h(?:ours?|rs?)?\s*(?<m>\d+)(?:\s*m(?:in(?:ute)?s?)?)?" + End, RegexOptions.IgnoreCase)]
    private static partial Regex HourMinuteRx();

    [GeneratedRegex(@"^(?:(?<n>\d+(?:\.\d+)?)\s*(?<u>hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+" + End, RegexOptions.IgnoreCase)]
    private static partial Regex UnitsRx();

    [GeneratedRegex(@"^(?<a>\d+):(?<b>\d{2})(?::(?<c>\d{2}))?" + End)]
    private static partial Regex ColonRx();

    [GeneratedRegex(@"^(?<n>\d+(?:\.\d+)?)" + End)]
    private static partial Regex BareNumberRx();

    public static bool TryParse(string? input, out QuickEntry entry)
    {
        entry = null!;
        var text = Regex.Replace(input ?? "", @"\s+", " ").Trim();
        if (text.Length == 0) return false;

        // The time spec may appear anywhere ("Tea 4m" or "4m Tea"); try each word boundary.
        var starts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++)
            if (text[i] == ' ') starts.Add(i + 1);

        foreach (var start in starts)
        {
            var rest = text[start..];
            if (!TryParseSpec(rest, out var kind, out var duration, out var time, out var length))
            {
                // "at 25:00" is an invalid alarm, not a 25-minute timer labelled "at".
                if (Regex.IsMatch(rest, @"^(?:at\s|@)", RegexOptions.IgnoreCase)) return false;
                continue;
            }
            var label = (text[..start] + " " + rest[length..]).Trim();
            entry = new QuickEntry(kind, duration, time, label);
            return true;
        }
        return false;
    }

    public static bool TryParseDuration(string? input, out TimeSpan duration)
    {
        duration = default;
        var text = (input ?? "").Trim();
        return TryParseSpec(text, out var kind, out duration, out _, out var len)
               && kind == QuickEntryKind.Countdown && len == text.Length;
    }

    private static bool TryParseSpec(string s, out QuickEntryKind kind, out TimeSpan duration, out TimeOnly time, out int length)
    {
        kind = QuickEntryKind.Countdown;
        duration = default;
        time = default;
        length = 0;

        Match m;
        if ((m = PomodoroRx().Match(s)).Success)
        {
            kind = QuickEntryKind.Pomodoro;
            length = m.Length;
            return true;
        }

        if ((m = AlarmRx().Match(s)).Success)
        {
            var h = int.Parse(m.Groups["h"].Value, CultureInfo.InvariantCulture);
            var min = m.Groups["m"].Success ? int.Parse(m.Groups["m"].Value, CultureInfo.InvariantCulture) : 0;
            var ap = m.Groups["ap"].Value.ToLowerInvariant();
            if (ap.Length > 0)
            {
                if (h is < 1 or > 12) return false;
                h = h % 12 + (ap == "pm" ? 12 : 0);
            }
            if (h > 23 || min > 59) return false;
            kind = QuickEntryKind.Alarm;
            time = new TimeOnly(h, min);
            length = m.Length;
            return true;
        }

        if ((m = HourMinuteRx().Match(s)).Success)
        {
            duration = TimeSpan.FromHours(Num(m.Groups["h"].Value)) + TimeSpan.FromMinutes(Num(m.Groups["m"].Value));
        }
        else if ((m = UnitsRx().Match(s)).Success)
        {
            var g = m.Groups;
            for (var i = 0; i < g["n"].Captures.Count; i++)
            {
                var n = Num(g["n"].Captures[i].Value);
                var unit = char.ToLowerInvariant(g["u"].Captures[i].Value[0]);
                duration += unit switch
                {
                    'h' => TimeSpan.FromHours(n),
                    'm' => TimeSpan.FromMinutes(n),
                    _ => TimeSpan.FromSeconds(n),
                };
            }
        }
        else if ((m = ColonRx().Match(s)).Success)
        {
            var a = (int)Num(m.Groups["a"].Value);
            var b = (int)Num(m.Groups["b"].Value);
            if (b > 59) return false;
            duration = m.Groups["c"].Success
                ? new TimeSpan(a, b, (int)Num(m.Groups["c"].Value)) // h:mm:ss
                : new TimeSpan(0, a, b);                            // m:ss
        }
        else if ((m = BareNumberRx().Match(s)).Success)
        {
            duration = TimeSpan.FromMinutes(Num(m.Groups["n"].Value)); // "25" means minutes
        }
        else
        {
            return false;
        }

        duration = TimeSpan.FromSeconds(Math.Round(duration.TotalSeconds));
        if (duration <= TimeSpan.Zero || duration > TimeSpan.FromDays(7)) return false;
        length = m.Length;
        return true;
    }

    private static double Num(string s) => double.Parse(s, CultureInfo.InvariantCulture);
}

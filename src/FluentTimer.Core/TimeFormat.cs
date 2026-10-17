namespace FluentTimer.Core;

public static class TimeFormat
{
    /// <summary>Clock-style countdown: "04:59", "1:05:00". Rounds up so "00:00" only shows when done.</summary>
    public static string Countdown(TimeSpan remaining)
    {
        var secs = (long)Math.Ceiling(Math.Max(0, remaining.TotalSeconds));
        var h = secs / 3600;
        var m = secs % 3600 / 60;
        var s = secs % 60;
        return h > 0 ? $"{h}:{m:00}:{s:00}" : $"{m:00}:{s:00}";
    }

    /// <summary>Human duration: "25 min", "1 h 30 min", "20 s".</summary>
    public static string Friendly(TimeSpan span)
    {
        if (span < TimeSpan.FromMinutes(1)) return $"{Math.Round(span.TotalSeconds)} s";
        var h = (int)span.TotalHours;
        var m = span.Minutes;
        var s = span.Seconds;
        var parts = new List<string>();
        if (h > 0) parts.Add($"{h} h");
        if (m > 0) parts.Add($"{m} min");
        if (s > 0 && h == 0) parts.Add($"{s} s");
        return string.Join(" ", parts);
    }

    /// <summary>Total for reports: "3 h 05 m", "42 m".</summary>
    public static string Total(TimeSpan span)
    {
        var h = (int)span.TotalHours;
        return h > 0 ? $"{h} h {span.Minutes:00} m" : $"{Math.Max(0, (int)span.TotalMinutes)} m";
    }
}

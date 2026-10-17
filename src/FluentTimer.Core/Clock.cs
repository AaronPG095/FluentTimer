namespace FluentTimer.Core;

/// <summary>Time source. Injected so the engine can be tested without waiting in real time.</summary>
public interface IClock
{
    DateTime UtcNow { get; }
    TimeZoneInfo Zone { get; }
}

public sealed class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
    public TimeZoneInfo Zone => TimeZoneInfo.Local;
}

public static class ClockExtensions
{
    public static DateTime LocalNow(this IClock clock) =>
        TimeZoneInfo.ConvertTimeFromUtc(clock.UtcNow, clock.Zone);

    public static DateTime ToLocal(this IClock clock, DateTime utc) =>
        TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), clock.Zone);
}

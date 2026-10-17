using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

internal sealed class FakeClock(DateTime utcNow) : IClock
{
    public DateTime UtcNow { get; set; } = DateTime.SpecifyKind(utcNow, DateTimeKind.Utc);
    public TimeZoneInfo Zone => TimeZoneInfo.Utc;

    public void Advance(TimeSpan by) => UtcNow += by;
}

internal sealed class EngineFixture
{
    // Wednesday 10:00 UTC — inside default weekday 09–18 active hours.
    public FakeClock Clock { get; } = new(new DateTime(2026, 10, 14, 10, 0, 0));
    public AppSettings Settings { get; } = new();
    public AppState State { get; } = new();
    public TimerEngine Engine { get; }
    public List<AlertRequest> Alerts { get; } = [];
    public List<SessionRecord> Sessions { get; } = [];

    public EngineFixture()
    {
        Engine = new TimerEngine(Clock, State, () => Settings);
        Engine.AlertRaised += Alerts.Add;
        Engine.SessionLogged += Sessions.Add;
    }

    public void Advance(TimeSpan by)
    {
        Clock.Advance(by);
        Engine.Tick();
    }
}

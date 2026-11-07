using System.Text.Json;
using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class SettingsTests
{
    [Fact]
    public void PillSettings_defaults_PinTimerList_to_false()
    {
        var settings = new PillSettings();
        Assert.False(settings.PinTimerList);
    }

    [Fact]
    public void AppSettings_round_trips_PinTimerList_through_json()
    {
        var original = new AppSettings
        {
            Pill = new PillSettings
            {
                PinTimerList = true,
            },
        };

        var json = JsonSerializer.Serialize(original);
        var restored = JsonSerializer.Deserialize<AppSettings>(json);

        Assert.NotNull(restored);
        Assert.True(restored.Pill.PinTimerList);
    }
}

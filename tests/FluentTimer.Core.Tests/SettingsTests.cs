using System.Text.Json;
using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class SettingsTests
{
    [Fact]
    public void Pill_settings_defaults_show_timer_name_to_true()
    {
        var settings = new PillSettings();
        Assert.True(settings.ShowTimerName);
    }

    [Fact]
    public void Pill_settings_round_trips_show_timer_name()
    {
        var dir = Path.Combine(Path.GetTempPath(), "FluentTimerTests", Guid.NewGuid().ToString("N"));
        var store = new JsonStore<AppSettings>(Path.Combine(dir, "settings.json"), () => new AppSettings());
        var settings = new AppSettings
        {
            Pill = new PillSettings { ShowTimerName = false, Size = WidgetSize.Medium },
        };

        store.Save(settings);
        var loaded = store.Load();

        Assert.False(loaded.Pill.ShowTimerName);
        Assert.Equal(WidgetSize.Medium, loaded.Pill.Size);
        Directory.Delete(dir, true);
    }

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

    [Fact]
    public void PillSettings_defaults_ShowAllTimersInPill_to_true()
    {
        var settings = new PillSettings();
        Assert.True(settings.ShowAllTimersInPill);
    }

    [Fact]
    public void AppSettings_round_trips_ShowAllTimersInPill_through_json()
    {
        var original = new AppSettings
        {
            Pill = new PillSettings
            {
                ShowAllTimersInPill = false,
            },
        };

        var json = JsonSerializer.Serialize(original);
        var restored = JsonSerializer.Deserialize<AppSettings>(json);

        Assert.NotNull(restored);
        Assert.False(restored.Pill.ShowAllTimersInPill);
    }
}

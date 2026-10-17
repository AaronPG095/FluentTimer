namespace FluentTimer.Core;

public enum AppTheme { System, Dark, Light }

public enum AccentMode { Brand, System, Custom }

public sealed class PomodoroSettings
{
    public int WorkMinutes { get; set; } = 25;
    public int ShortBreakMinutes { get; set; } = 5;
    public int LongBreakMinutes { get; set; } = 15;
    public int LongBreakEvery { get; set; } = 4;
    public bool AutoStartBreaks { get; set; } = true;
    public bool AutoStartWork { get; set; }

    public TimeSpan PhaseLength(PomodoroPhase phase) => TimeSpan.FromMinutes(phase switch
    {
        PomodoroPhase.Work => WorkMinutes,
        PomodoroPhase.ShortBreak => ShortBreakMinutes,
        _ => LongBreakMinutes,
    });
}

public sealed class PillSettings
{
    public double? Left { get; set; }
    public double? Top { get; set; }
    public bool ShowWhenIdle { get; set; } = true;
    public bool Hidden { get; set; }
}

public sealed class AppSettings
{
    public bool LaunchAtStartup { get; set; } = true;
    public string Hotkey { get; set; } = "Ctrl+Alt+T";
    public AppTheme Theme { get; set; } = AppTheme.System;
    public AccentMode Accent { get; set; } = AccentMode.Brand;
    public string CustomAccent { get; set; } = "#0078D4";
    public AlertSettings DefaultAlert { get; set; } = AlertSettings.DefaultTimer();
    public AlertSettings BreakAlert { get; set; } = AlertSettings.DefaultBreak();
    public PomodoroSettings Pomodoro { get; set; } = new();
    public PillSettings Pill { get; set; } = new();
    public List<int> PresetMinutes { get; set; } = [5, 10, 25, 60];
    public int SnoozeMinutes { get; set; } = 5;
    public bool QuietWhenFullscreen { get; set; } = true;
    public int IdleMinutes { get; set; } = 5;
    public bool FirstRunDone { get; set; }
}

/// <summary>Everything that changes while the app runs and must survive a restart.</summary>
public sealed class AppState
{
    public List<TimerItem> Timers { get; set; } = [];
    public List<IntervalReminder> Reminders { get; set; } = [];
    public List<Alarm> Alarms { get; set; } = [];

    public static AppState CreateDefault() => new()
    {
        Reminders =
        [
            new IntervalReminder { Label = "Stand up and stretch", Interval = TimeSpan.FromMinutes(30), Enabled = false },
            new IntervalReminder
            {
                Label = "Eye break: look 20 ft away",
                Interval = TimeSpan.FromMinutes(20),
                BreakDuration = TimeSpan.FromSeconds(20),
                Enabled = false,
            },
        ],
    };
}

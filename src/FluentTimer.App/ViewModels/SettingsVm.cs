using System.Runtime.CompilerServices;
using CommunityToolkit.Mvvm.ComponentModel;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.ViewModels;

/// <summary>Write-through editor for one <see cref="AlertSettings"/> (global default or breaks).</summary>
public sealed class AlertEditorVm : ObservableObject
{
    public const string CustomFile = "Custom file…";
    private readonly AlertSettings _s;
    private readonly Action _changed;

    public AlertEditorVm(string title, string description, AlertSettings settings, Action changed)
    {
        Title = title;
        Description = description;
        _s = settings;
        _changed = changed;
    }

    public string Title { get; }
    public string Description { get; }
    public AlertSettings Settings => _s;

    public bool Flash { get => _s.Flash; set => Set(() => _s.Flash = value); }
    public bool Grow { get => _s.Grow; set => Set(() => _s.Grow = value); }
    public bool Glow { get => _s.Glow; set => Set(() => _s.Glow = value); }
    public bool DimOverlay { get => _s.DimOverlay; set => Set(() => _s.DimOverlay = value); }
    public double Volume { get => _s.Volume * 100; set => Set(() => _s.Volume = Math.Clamp(value / 100, 0, 1)); }
    public bool LoopSound { get => _s.LoopSound; set => Set(() => _s.LoopSound = value); }
    public bool Escalate { get => _s.Escalate; set => Set(() => _s.Escalate = value); }

    public static IReadOnlyList<string> SoundChoices { get; } = ["None", .. SoundSynth.BuiltIn, CustomFile];

    /// <summary>The combo box value; a file path shows as "Custom file…".</summary>
    public string SoundChoice
    {
        get => SoundChoices.Contains(_s.Sound) ? _s.Sound : CustomFile;
        set
        {
            if (value == CustomFile) return; // the page opens a file picker and calls SetCustomSound
            Set(() => _s.Sound = value);
            OnPropertyChanged(nameof(CustomPath));
        }
    }

    public string CustomPath => SoundChoices.Contains(_s.Sound) ? "" : System.IO.Path.GetFileName(_s.Sound);

    public void SetCustomSound(string path)
    {
        Set(() => _s.Sound = path);
        OnPropertyChanged(nameof(SoundChoice));
        OnPropertyChanged(nameof(CustomPath));
    }

    private void Set(Action apply, [CallerMemberName] string? name = null)
    {
        apply();
        OnPropertyChanged(name);
        _changed();
    }
}

public sealed class SettingsVm : ObservableObject
{
    private readonly AppHost _host;
    private string _hotkeyStatus = "";

    internal SettingsVm(AppHost host)
    {
        _host = host;
        TimerAlert = new AlertEditorVm("Timers, alarms & reminders", "Used when a countdown finishes, an alarm goes off or a reminder fires.",
            S.DefaultAlert, Save);
        BreakAlert = new AlertEditorVm("Breaks", "Used by reminders that include a break countdown.", S.BreakAlert, Save);
        UpdateHotkeyStatus();
    }

    private AppSettings S => _host.Settings;

    public AlertEditorVm TimerAlert { get; }
    public AlertEditorVm BreakAlert { get; }

    // General
    public bool LaunchAtStartup { get => S.LaunchAtStartup; set { S.LaunchAtStartup = value; Save(); } }
    public bool ShowWidget { get => !S.Pill.Hidden; set { S.Pill.Hidden = !value; Save(); } }
    public bool ShowWhenIdle { get => S.Pill.ShowWhenIdle; set { S.Pill.ShowWhenIdle = value; Save(); } }
    public bool QuietWhenFullscreen { get => S.QuietWhenFullscreen; set { S.QuietWhenFullscreen = value; Save(); } }
    public double? SnoozeMinutes { get => S.SnoozeMinutes; set { if (value is >= 1) { S.SnoozeMinutes = (int)value; Save(); } } }
    public double? IdleMinutes { get => S.IdleMinutes; set { if (value is >= 1) { S.IdleMinutes = (int)value; Save(); } } }

    public string Presets
    {
        get => string.Join(", ", S.PresetMinutes);
        set
        {
            var mins = value.Split([',', ' ', ';'], StringSplitOptions.RemoveEmptyEntries)
                .Select(p => int.TryParse(p, out var n) ? n : 0).Where(n => n is > 0 and <= 600).Distinct().Take(8).ToList();
            if (mins.Count > 0) { S.PresetMinutes = mins; Save(); }
            OnPropertyChanged();
        }
    }

    // Hotkey
    public string Hotkey => S.Hotkey;
    public string HotkeyStatus { get => _hotkeyStatus; private set => SetProperty(ref _hotkeyStatus, value); }

    public void SetHotkey(string gesture)
    {
        S.Hotkey = gesture;
        Save();
        OnPropertyChanged(nameof(Hotkey));
        UpdateHotkeyStatus();
    }

    private void UpdateHotkeyStatus() =>
        HotkeyStatus = _host.HotkeyError.Length == 0 ? "Active everywhere" : $"⚠ {_host.HotkeyError}. Pick another.";

    // Pomodoro
    public double? WorkMinutes { get => S.Pomodoro.WorkMinutes; set { if (value is >= 1) { S.Pomodoro.WorkMinutes = (int)value; Save(); } } }
    public double? ShortBreakMinutes { get => S.Pomodoro.ShortBreakMinutes; set { if (value is >= 1) { S.Pomodoro.ShortBreakMinutes = (int)value; Save(); } } }
    public double? LongBreakMinutes { get => S.Pomodoro.LongBreakMinutes; set { if (value is >= 1) { S.Pomodoro.LongBreakMinutes = (int)value; Save(); } } }
    public double? LongBreakEvery { get => S.Pomodoro.LongBreakEvery; set { if (value is >= 1) { S.Pomodoro.LongBreakEvery = (int)value; Save(); } } }
    public bool AutoStartBreaks { get => S.Pomodoro.AutoStartBreaks; set { S.Pomodoro.AutoStartBreaks = value; Save(); } }
    public bool AutoStartWork { get => S.Pomodoro.AutoStartWork; set { S.Pomodoro.AutoStartWork = value; Save(); } }

    // Appearance
    public static IReadOnlyList<string> ThemeChoices { get; } = ["System", "Dark", "Light"];
    public static IReadOnlyList<string> AccentChoices { get; } = ["Fluent blue", "Windows accent", "Custom"];

    public string Theme { get => S.Theme.ToString(); set { S.Theme = Enum.Parse<AppTheme>(value); Save(); } }

    public string Accent
    {
        get => AccentChoices[(int)S.Accent];
        set
        {
            S.Accent = (AccentMode)Math.Max(0, AccentChoices.ToList().IndexOf(value));
            Save();
            OnPropertyChanged(nameof(IsCustomAccent));
        }
    }

    public bool IsCustomAccent => S.Accent == AccentMode.Custom;

    public string CustomAccent
    {
        get => S.CustomAccent;
        set
        {
            if (ThemeService.TryParseColor(value, out _)) { S.CustomAccent = value.Trim(); Save(); }
            OnPropertyChanged();
        }
    }

    public string DataFolder => AppPaths.DataDir;
    public string Version => typeof(SettingsVm).Assembly.GetName().Version?.ToString(3) ?? "";

    private void Save() => _host.SettingsChanged();
}

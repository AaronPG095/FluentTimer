using System.Collections.ObjectModel;
using System.Windows.Threading;
using FluentTimer.App.ViewModels;
using FluentTimer.Core;
using Microsoft.Win32;

namespace FluentTimer.App.Services;

/// <summary>Composition root: loads data, runs the engine on the UI thread, persists changes.</summary>
internal sealed class AppHost : IDisposable
{
    private readonly JsonStore<AppSettings> _settingsStore = new(AppPaths.Settings, () => new AppSettings());
    private readonly JsonStore<AppState> _stateStore = new(AppPaths.State, AppState.CreateDefault);
    private readonly JsonStore<List<SessionRecord>> _historyStore = new(AppPaths.History, () => []);
    private readonly DispatcherTimer _tick;
    private readonly DispatcherTimer _saveState;
    private readonly DispatcherTimer _saveSettings;
    private bool _locked;
    private int _presenceCounter;

    public AppHost()
    {
        Current = this;
        Clock = new SystemClock();
        Settings = _settingsStore.Load();
        State = _stateStore.Load();
        History = _historyStore.Load();
        _saveState = Debouncer(TimeSpan.FromMilliseconds(500), SaveState);
        _saveSettings = Debouncer(TimeSpan.FromMilliseconds(400), () => _settingsStore.Save(Settings));
        Engine = new TimerEngine(Clock, State, () => Settings);
        Alerts = new AlertManager(this);
        Hotkey = new HotkeyService();

        Engine.AlertRaised += r => Alerts.Raise(r);
        Engine.TimerAlertsCleared += Alerts.OnTimerCleared;
        Engine.SessionLogged += OnSessionLogged;
        Engine.Changed += () => Restart(_saveState);

        _tick = new DispatcherTimer(TimeSpan.FromMilliseconds(250), DispatcherPriority.Normal, (_, _) => OnTick(), Dispatcher.CurrentDispatcher);

        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.SessionEnding += (_, _) => SaveAll();
    }

    public static AppHost Current { get; private set; } = null!;

    /// <summary>Dev-only event trace (FLUENTTIMER_DEV=1) written to trace.log in the data folder.</summary>
    public static void Trace(string message)
    {
        if (!AppPaths.IsIsolated) return;
        try { System.IO.File.AppendAllText(System.IO.Path.Combine(AppPaths.DataDir, "trace.log"), $"{DateTime.Now:HH:mm:ss.fff} {message}\n"); }
        catch (System.IO.IOException) { }
    }

    public IClock Clock { get; }
    public AppSettings Settings { get; }
    public AppState State { get; }
    public List<SessionRecord> History { get; }
    public TimerEngine Engine { get; }
    public AlertManager Alerts { get; }
    public HotkeyService Hotkey { get; }
    public UpdateService Updates { get; } = new();
    public IReadOnlyDictionary<HotkeyAction, string> HotkeyErrors { get; private set; } = new Dictionary<HotkeyAction, string>();

    public string GetHotkey(HotkeyAction action) => action switch
    {
        HotkeyAction.QuickAdd => Settings.Hotkey,
        HotkeyAction.PauseResume => Settings.HotkeyPauseResume,
        HotkeyAction.Dismiss => Settings.HotkeyDismiss,
        _ => Settings.HotkeyToggleWidget,
    };

    public void SetHotkey(HotkeyAction action, string gesture)
    {
        switch (action)
        {
            case HotkeyAction.QuickAdd: Settings.Hotkey = gesture; break;
            case HotkeyAction.PauseResume: Settings.HotkeyPauseResume = gesture; break;
            case HotkeyAction.Dismiss: Settings.HotkeyDismiss = gesture; break;
            default: Settings.HotkeyToggleWidget = gesture; break;
        }
        SettingsChanged();
    }

    /// <summary>All timers, soonest first. Shared by the pill, tray and main window.</summary>
    public ObservableCollection<TimerVm> Timers { get; } = [];

    public event Action? Ticked;
    public event Action? SettingsApplied;
    public event Action? HistoryChanged;

    public void Start()
    {
        ApplySettings();
        SyncTimers();
        Engine.RaisePendingAlerts();
        _tick.Start();
        OnTick();
        ScheduleUpdateCheck();
    }

    /// <summary>At most once a day, a minute after startup (so sign-in isn't slowed down).</summary>
    private void ScheduleUpdateCheck()
    {
        if (!Settings.AutoCheckUpdates || AppPaths.IsDev) return;
        if (Settings.LastUpdateCheckUtc is { } last && DateTime.UtcNow - last < TimeSpan.FromDays(1)) return;
        var t = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
        t.Tick += async (_, _) =>
        {
            t.Stop();
            await Updates.CheckAsync();
            Settings.LastUpdateCheckUtc = DateTime.UtcNow;
            Restart(_saveSettings);
        };
        t.Start();
    }

    // ---- Commands used by the UI ------------------------------------------------------------

    /// <summary>repeat: null = use the "repeat new timers" setting.</summary>
    public void StartCountdown(TimeSpan duration, string label = "", bool? repeat = null)
    {
        Engine.StartCountdown(duration, label, repeat: repeat);
        SyncTimers();
    }

    public void StartPomodoro(string label = "")
    {
        Engine.StartPomodoro(label);
        SyncTimers();
    }

    /// <summary>Runs parsed quick-entry text. Returns a short confirmation for the UI.</summary>
    public string Run(QuickEntry entry)
    {
        switch (entry.Kind)
        {
            case QuickEntryKind.Pomodoro:
                StartPomodoro(entry.Label);
                return "Pomodoro started";
            case QuickEntryKind.Alarm:
                var date = TimerEngine.NextOccurrenceDate(entry.Time, Clock.LocalNow());
                State.Alarms.Add(new Alarm
                {
                    Label = entry.Label.Length > 0 ? entry.Label : "Alarm",
                    Time = entry.Time,
                    Date = date,
                });
                Restart(_saveState);
                return $"Alarm set for {entry.Time:HH:mm}";
            default:
                StartCountdown(entry.Duration, entry.Label, entry.Repeat ? true : null);
                return $"{TimeFormat.Friendly(entry.Duration)} timer started{(entry.Repeat ? ", repeating" : "")}";
        }
    }

    public static string Describe(QuickEntry e) => e.Kind switch
    {
        QuickEntryKind.Pomodoro => $"Pomodoro{Suffix(e.Label)}",
        QuickEntryKind.Alarm => $"Alarm at {e.Time:HH:mm}{Suffix(e.Label)}",
        _ => $"Timer {TimeFormat.Friendly(e.Duration)}{Suffix(e.Label)}{(e.Repeat ? " · repeats when dismissed" : "")}",
    };

    private static string Suffix(string label) => label.Length > 0 ? $" · {label}" : "";

    public void Act(Action<TimerEngine> action)
    {
        action(Engine);
        SyncTimers();
    }

    public void StateEdited() => Restart(_saveState);

    /// <summary>Persist settings and re-apply anything they affect (theme, hotkey, startup, pill).</summary>
    public void SettingsChanged()
    {
        Restart(_saveSettings);
        ApplySettings();
    }

    /// <summary>Persist after a session was edited in place (e.g. relabelled).</summary>
    public void HistoryEdited()
    {
        _historyStore.Save(History);
        HistoryChanged?.Invoke();
    }

    public void DeleteSession(SessionRecord record)
    {
        History.Remove(record);
        HistoryEdited();
    }

    /// <summary>Log a session you forgot to time.</summary>
    public void AddSession(string label, DateTime startLocal, TimeSpan duration)
    {
        var start = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(startLocal, DateTimeKind.Unspecified), Clock.Zone);
        History.Add(new SessionRecord
        {
            Label = label.Trim(),
            Kind = TimerKind.Countdown,
            StartedUtc = start,
            EndedUtc = start + duration,
            Duration = duration,
            Completed = true,
        });
        HistoryEdited();
    }

    public void ClearHistory()
    {
        History.Clear();
        _historyStore.Save(History);
        HistoryChanged?.Invoke();
    }

    public void SaveAll()
    {
        SaveState();
        _settingsStore.Save(Settings);
    }

    // ---- Internals --------------------------------------------------------------------------

    private void ApplySettings()
    {
        ThemeService.Apply(Settings);
        try { if (!AppPaths.IsIsolated) StartupRegistration.Apply(Settings.LaunchAtStartup); }
        catch (UnauthorizedAccessException) { /* locked-down registry: leave setting as-is */ }
        HotkeyErrors = Hotkey.RegisterAll(Enum.GetValues<HotkeyAction>().ToDictionary(a => a, GetHotkey));
        SettingsApplied?.Invoke();
    }

    private void OnTick()
    {
        Engine.Tick();
        Alerts.Tick();
        SyncTimers();

        if (++_presenceCounter >= 8) // every ~2 s
        {
            _presenceCounter = 0;
            var idle = Native.IdleTime() >= TimeSpan.FromMinutes(Math.Max(1, Settings.IdleMinutes));
            Engine.SetSuspended(_locked || idle);
        }
        Ticked?.Invoke();
    }

    /// <summary>Mirror engine timers into <see cref="Timers"/>, keeping existing view models.</summary>
    private void SyncTimers()
    {
        var now = Clock.UtcNow;
        var models = Engine.Timers;
        for (var i = Timers.Count - 1; i >= 0; i--)
            if (!models.Contains(Timers[i].Model)) Timers.RemoveAt(i);
        foreach (var m in models)
            if (Timers.All(vm => vm.Model != m)) Timers.Add(new TimerVm(m));
        foreach (var vm in Timers) vm.Update(now);

        var sorted = Timers.OrderBy(vm => vm.SortKey(now)).ToList();
        for (var i = 0; i < sorted.Count; i++)
        {
            var at = Timers.IndexOf(sorted[i]);
            if (at != i) Timers.Move(at, i);
        }
    }

    private void OnSessionLogged(SessionRecord record)
    {
        History.Add(record);
        _historyStore.Save(History);
        HistoryChanged?.Invoke();
    }

    private void OnSessionSwitch(object? sender, SessionSwitchEventArgs e)
    {
        if (e.Reason == SessionSwitchReason.SessionLock) _locked = true;
        else if (e.Reason == SessionSwitchReason.SessionUnlock) _locked = false;
    }

    private void SaveState() => _stateStore.Save(State);

    private static DispatcherTimer Debouncer(TimeSpan delay, Action action)
    {
        var t = new DispatcherTimer { Interval = delay };
        t.Tick += (_, _) =>
        {
            t.Stop();
            action();
        };
        return t;
    }

    private static void Restart(DispatcherTimer t)
    {
        t.Stop();
        t.Start();
    }

    public void Dispose()
    {
        _tick.Stop();
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        Alerts.StopSound();
        Hotkey.Dispose();
        SaveAll();
    }
}

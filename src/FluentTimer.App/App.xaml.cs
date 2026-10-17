using System.IO;
using System.Windows;
using System.Windows.Threading;
using FluentTimer.App.Services;
using FluentTimer.App.Views;
using FluentTimer.Core;

namespace FluentTimer.App;

public partial class App : Application
{
    private SingleInstance? _instance;
    private AppHost? _host;
    private TrayService? _tray;
    private PillWindow? _pill;
    private MainWindow? _main;
    private QuickEntryWindow? _quick;

    public static new App Current => (App)Application.Current;

    protected override void OnStartup(StartupEventArgs e)
    {
        UpdateService.FinishPreviousUpdate(e.Args); // waits for the old process after a self-update
        _instance = SingleInstance.TryAcquire(() => Dispatcher.BeginInvoke(() => ShowMain()));
        if (_instance is null)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandledException;

        _host = new AppHost();
        _host.Hotkey.Pressed += OnHotkey;
        _host.Start();

        // WPF makes the first window created Application.MainWindow, and WPF-UI's theme manager restyles
        // MainWindow, which breaks the widget's transparency if that's the widget. A never-shown placeholder
        // takes the role until the real main window exists (and keeps startup light).
        MainWindow = new Window { Width = 0, Height = 0, WindowStyle = WindowStyle.None, ShowInTaskbar = false, ShowActivated = false };

        _tray = new TrayService(_host);
        _pill = new PillWindow(_host);
        _pill.UpdateVisibility();

        // Dev aid for screenshot checks: FLUENTTIMER_PAGE=Settings opens that page on launch.
        if (AppPaths.IsDev && Environment.GetEnvironmentVariable("FLUENTTIMER_PAGE") is { Length: > 0 } devPage)
        {
            ShowMain(devPage);
            return;
        }

        // Test hooks (only with an isolated data folder, so they can never act on real data):
        //   FLUENTTIMER_SELFTEST=reapply  re-applies settings after 3 s, like dropping the widget does
        //   FLUENTTIMER_SELFTEST=update   checks GitHub Releases and installs a newer version
        var selfTest = AppPaths.IsIsolated ? Environment.GetEnvironmentVariable("FLUENTTIMER_SELFTEST") : null;
        if (selfTest is "reapply" or "update")
        {
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            t.Tick += async (_, _) =>
            {
                t.Stop();
                if (selfTest == "reapply") { _host.SettingsChanged(); return; }
                await _host.Updates.CheckAsync();
                AppHost.Trace($"selftest update: {_host.Updates.Status}");
                InstallUpdate();
            };
            t.Start();
        }

        var launchedAtLogin = e.Args.Contains(StartupRegistration.MinimizedArg);
        if (!launchedAtLogin || !_host.Settings.FirstRunDone) ShowMain();
        if (!_host.Settings.FirstRunDone)
        {
            _host.Settings.FirstRunDone = true;
            _host.SettingsChanged();
        }
    }

    public void ShowMain(string? page = null)
    {
        if (_host is null) return;
        EnsureFluentUi();
        if (_main is null)
        {
            _main = new MainWindow(_host);
            MainWindow = _main;
        }
        if (page is not null) _main.Navigate(page);
        _main.Show();
        if (_main.WindowState == WindowState.Minimized) _main.WindowState = WindowState.Normal;
        _main.Activate();
    }

    public void ShowQuickEntry()
    {
        if (_host is null) return;
        if (_quick is { IsVisible: true })
        {
            _quick.Activate();
            return;
        }
        EnsureFluentUi();
        _quick = new QuickEntryWindow(_host);
        _quick.Show();
    }

    private void OnHotkey(HotkeyAction action)
    {
        if (_host is null) return;
        switch (action)
        {
            case HotkeyAction.QuickAdd:
                ShowQuickEntry();
                break;
            case HotkeyAction.PauseResume when _host.Timers.FirstOrDefault() is { } first:
                _host.Act(e => e.TogglePause(first.Id));
                break;
            case HotkeyAction.Dismiss when _host.Alerts.Current is { } alert:
                _host.Alerts.Dismiss(alert);
                break;
            case HotkeyAction.ToggleWidget:
                SetPillHidden(!_host.Settings.Pill.Hidden);
                break;
        }
    }

    /// <summary>Merge WPF-UI's theme and control styles the first time a window that uses them opens.</summary>
    private void EnsureFluentUi()
    {
        if (ThemeService.FluentUiLoaded || _host is null) return;
        Resources.MergedDictionaries.Insert(0, new Wpf.Ui.Markup.ThemesDictionary { Theme = Wpf.Ui.Appearance.ApplicationTheme.Dark });
        Resources.MergedDictionaries.Insert(1, new Wpf.Ui.Markup.ControlsDictionary());
        ThemeService.FluentUiLoaded = true;
        ThemeService.Apply(_host.Settings);
    }

    /// <summary>Work area of the monitor the widget is on (primary if the widget isn't placed yet).</summary>
    public Rect WidgetWorkArea() => _pill?.CurrentWorkArea() ?? SystemParameters.WorkArea;

    public void SetPillHidden(bool hidden)
    {
        if (_host is null) return;
        _host.Settings.Pill.Hidden = hidden;
        _host.SettingsChanged();
    }

    /// <summary>Download, verify and swap in the new version, then hand over to it.</summary>
    public async void InstallUpdate()
    {
        if (_host is null) return;
        _host.SaveAll();
        var ok = await _host.Updates.InstallAsync(() =>
        {
            _instance?.Dispose(); // let the new process take the single-instance lock
            _instance = null;
        });
        if (ok) Quit();
    }

    public void Quit()
    {
        _main?.AllowClose();
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _tray?.Dispose();
        _host?.Dispose();
        _instance?.Dispose();
        base.OnExit(e);
    }

    private void OnUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // A timer app must not vanish silently: log and keep running.
        try
        {
            Directory.CreateDirectory(AppPaths.DataDir);
            File.AppendAllText(Path.Combine(AppPaths.DataDir, "error.log"), $"[{DateTime.Now:u}] {e.Exception}\n\n");
        }
        catch (IOException) { }
        e.Handled = true;
    }
}

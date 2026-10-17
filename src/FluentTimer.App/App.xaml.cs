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
        _instance = SingleInstance.TryAcquire(() => Dispatcher.BeginInvoke(() => ShowMain()));
        if (_instance is null)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandledException;

        _host = new AppHost();
        _host.Hotkey.Pressed += ShowQuickEntry;
        _host.Start();

        _tray = new TrayService(_host);
        _pill = new PillWindow(_host);
        _pill.UpdateVisibility();

        // Dev aid for screenshot checks: FLUENTTIMER_PAGE=Settings opens that page on launch.
        if (AppPaths.IsDev && Environment.GetEnvironmentVariable("FLUENTTIMER_PAGE") is { Length: > 0 } devPage)
        {
            ShowMain(devPage);
            return;
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
        _main ??= new MainWindow(_host);
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
        _quick = new QuickEntryWindow(_host);
        _quick.Show();
    }

    public void SetPillHidden(bool hidden)
    {
        if (_host is null) return;
        _host.Settings.Pill.Hidden = hidden;
        _host.SettingsChanged();
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

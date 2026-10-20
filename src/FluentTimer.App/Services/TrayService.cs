using System.Windows;
using System.Windows.Controls;
using H.NotifyIcon;
using FluentTimer.Core;

namespace FluentTimer.App.Services;

/// <summary>Notification-area icon: left click opens the app, right click shows presets and actions.</summary>
internal sealed class TrayService : IDisposable
{
    private readonly AppHost _host;
    private readonly TaskbarIcon _icon;
    private DateTime _lastTooltip;

    public TrayService(AppHost host)
    {
        _host = host;
        var stream = Application.GetResourceStream(new Uri("pack://application:,,,/Assets/FluentTimer.ico"))!.Stream;
        _icon = new TaskbarIcon
        {
            Icon = new System.Drawing.Icon(stream),
            ToolTipText = "Fluent Timer",
            ContextMenu = new ContextMenu(),
            NoLeftClickDelay = true,
        };
        _icon.TrayLeftMouseUp += (_, _) => App.Current.ShowMain();
        _icon.ContextMenu.Opened += (_, _) => BuildMenu(_icon.ContextMenu);
        BuildMenu(_icon.ContextMenu);
        _icon.ForceCreate(enablesEfficiencyMode: false);

        host.Ticked += UpdateTooltip;
    }

    private void UpdateTooltip()
    {
        var now = DateTime.UtcNow;
        if (now - _lastTooltip < TimeSpan.FromSeconds(1)) return;
        _lastTooltip = now;
        var first = _host.Timers.FirstOrDefault();
        _icon.ToolTipText = first is null
            ? "Fluent Timer"
            : $"{first.Label} · {first.TimeText}" + (_host.Timers.Count > 1 ? $" (+{_host.Timers.Count - 1})" : "");
    }

    /// <summary>Same menu as the pill's right-click menu.</summary>
    public static void BuildMenu(ContextMenu menu)
    {
        var host = AppHost.Current;
        menu.Items.Clear();
        menu.Items.Add(Item("New timer…", () => App.Current.ShowQuickEntry(), host.Settings.Hotkey));

        var presets = new MenuItem { Header = "Start" };
        foreach (var saved in host.State.SavedTimers)
            presets.Items.Add(Item(saved.DisplayName, () => host.StartSaved(saved), TimeFormat.Friendly(saved.Duration)));
        if (host.State.SavedTimers.Count > 0) presets.Items.Add(new Separator());
        foreach (var m in host.Settings.PresetMinutes)
            presets.Items.Add(Item($"{m} min", () => host.StartCountdown(TimeSpan.FromMinutes(m))));
        presets.Items.Add(new Separator());
        presets.Items.Add(Item($"Pomodoro ({host.Settings.Pomodoro.WorkMinutes}/{host.Settings.Pomodoro.ShortBreakMinutes})", () => host.StartPomodoro()));
        menu.Items.Add(presets);

        if (host.Timers.Count > 0)
        {
            var anyRunning = host.Timers.Any(t => t.IsRunning);
            menu.Items.Add(Item(anyRunning ? "Pause all" : "Resume all", () => host.Act(e =>
            {
                foreach (var t in host.Timers.ToList())
                    if (anyRunning) e.Pause(t.Id); else e.Resume(t.Id);
            })));
        }
        // Rename: straight to the box for one timer, a submenu to pick one when several are running.
        if (host.Timers.Count == 1)
        {
            var only = host.Timers[0];
            menu.Items.Add(Item("Rename timer…", () => App.Current.ShowRename(only.Id)));
        }
        else if (host.Timers.Count > 1)
        {
            var rename = new MenuItem { Header = "Rename timer" };
            foreach (var t in host.Timers.ToList())
                rename.Items.Add(Item($"{t.Label}  ·  {t.TimeText}", () => App.Current.ShowRename(t.Id)));
            menu.Items.Add(rename);
        }

        if (host.Alerts.Current is not null)
            menu.Items.Add(Item("Dismiss alerts", host.Alerts.DismissAll));

        if (host.Updates.Available is { } update && UpdateService.CanSelfUpdate)
        {
            menu.Items.Add(new Separator());
            menu.Items.Add(Item($"Update to {update.Version}", () => App.Current.InstallUpdate()));
        }

        menu.Items.Add(new Separator());
        var hidden = host.Settings.Pill.Hidden;
        menu.Items.Add(Item(hidden ? "Show widget" : "Hide widget", () => App.Current.SetPillHidden(!hidden)));

        var sizes = new MenuItem { Header = "Widget size" };
        foreach (var size in Enum.GetValues<WidgetSize>())
        {
            var item = Item(size.ToString(), () =>
            {
                host.Settings.Pill.Size = size;
                host.SettingsChanged();
            });
            item.IsCheckable = true;
            item.IsChecked = host.Settings.Pill.Size == size;
            sizes.Items.Add(item);
        }
        menu.Items.Add(sizes);
        menu.Items.Add(Item("Open Fluent Timer", () => App.Current.ShowMain()));
        menu.Items.Add(Item("Settings", () => App.Current.ShowMain("Settings")));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Quit", () => App.Current.Quit()));
    }

    private static MenuItem Item(string header, Action action, string? gesture = null)
    {
        var item = new MenuItem { Header = header, InputGestureText = gesture ?? "" };
        item.Click += (_, _) => action();
        return item;
    }

    public void Dispose()
    {
        _host.Ticked -= UpdateTooltip;
        _icon.Dispose();
    }
}

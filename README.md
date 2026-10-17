# Fluent Timer

A Windows timer that lives in your tray and starts with Windows. A small floating widget, inspired by Wispr Flow's bar, keeps your current timer on screen. You can drag it anywhere and it snaps to screen edges. Styled after FluentOverlay.

## Features

- **Countdowns** with labels. Several can run at once.
- **Pomodoro**: 25/5/15 with a long break every 4 sessions, all configurable. Breaks start automatically; you start each focus session yourself.
- **Interval reminders** (stand up, eye breaks) with active hours and weekdays. They pause while the screen is locked or you're idle, and an optional break countdown dims the screen.
- **Alarms**: one-off or repeating on chosen weekdays.
- **Quick entry** from anywhere with **Ctrl+Alt+T**: `25m`, `Tea 4m`, `1h30 deep work`, `90s`, `5:00`, `at 14:30 lunch`, `2pm call`, `pomo writing`.
- **Custom alerts** instead of Windows toasts: the widget flashes red, grows and glows, and can dim the screen. Built-in synthesized chimes or your own audio file, volume, repeat until dismissed, escalation if ignored, and quiet mode during full-screen apps. Separate settings for timers and breaks, each with a **Test** button.
- **History**: every finished or cancelled session is logged with its label, with totals per label and **CSV export**.
- Timers survive restarts. They store a wall-clock end time, so time spent while the PC was off still counts.

## Widget

| Action | Result |
|---|---|
| Hover | Expand to list all timers (pause / cancel / new) |
| Click | Pause/resume the soonest timer, or dismiss the current alert |
| Double-click | Open the main window |
| Right-click | Menu: presets, Pomodoro, hide widget, quit |
| Drag | Move; it snaps to the nearest screen edge and grows away from it |

## Build

Requires the .NET 10 SDK on Windows.

```bash
dotnet test tests/FluentTimer.Core.Tests
dotnet run --project src/FluentTimer.App
dotnet publish src/FluentTimer.App -c Release -p:PublishSingleFile=true -o publish
```

`publish/FluentTimer.exe` is a single self-contained exe; no .NET install is needed. On first run it registers itself in `HKCU\…\Run` so it starts with Windows. You can turn that off under Settings → General.

### Development switches

| Variable | Effect |
|---|---|
| `FLUENTTIMER_DATA=<dir>` | Use another data folder instead of `%AppData%\FluentTimer` |
| `FLUENTTIMER_DEV=1` | Never touch the Windows startup Run key; write `trace.log` |
| `FLUENTTIMER_PAGE=Settings` | (dev only) open that main-window page on launch |

## Layout

```
src/FluentTimer.Core         Timer engine, scheduler, quick-entry parser, storage, CSV, sound synthesis (no UI, fully tested)
src/FluentTimer.App          WPF app: tray, floating widget, alerts, hotkey, main window (WPF-UI)
tests/FluentTimer.Core.Tests xUnit tests with a fake clock
scripts/make-icon.ps1        Regenerates the app icon
```

Data is stored as JSON in `%AppData%\FluentTimer` (`settings.json`, `state.json`, `history.json`).

## Known limits (v1)

- Memory use is about 100 MB, the usual baseline for WPF with WPF-UI's control themes.
- No charts, cloud sync, auto-update or installer.
- The dim overlay's card is centred on the primary monitor.

## License

MIT

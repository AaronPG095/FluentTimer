# Fluent Timer

A Windows timer that lives in your tray and starts with Windows. A small floating widget, inspired by Wispr Flow's bar, keeps your current timer on screen. You can drag it anywhere and it snaps to screen edges. Styled after FluentOverlay.

## Features

- **Countdowns** with labels. Several can run at once. Turn on **Repeat** (or type `1h repeat`) and clicking the finished timer starts the same length again.
- **Pomodoro**: 25/5/15 with a long break every 4 sessions, all configurable. Breaks start automatically; you start each focus session yourself.
- **Interval reminders** (stand up, eye breaks) with active hours and weekdays. They pause while the screen is locked or you're idle, and an optional break countdown dims the screen.
- **Alarms**: one-off or repeating on chosen weekdays.
- **Quick entry** from anywhere with **Ctrl+Alt+T**: `25m`, `Tea 4m`, `1h30 deep work`, `90s`, `5:00`, `at 14:30 lunch`, `2pm call`, `pomo writing`.
- **Custom alerts** instead of Windows toasts: the widget flashes red, grows and glows, and can dim the screen. Built-in synthesized chimes or your own audio file, volume, repeat until dismissed, escalation if ignored, and quiet mode during full-screen apps. Separate settings for timers and breaks, each with a **Test** button.
- **History**: every finished or cancelled session is logged with its label, with a per-day stacked chart, totals per label and **CSV export**. You can relabel or delete sessions, and add ones you forgot to time.
- **Global shortcuts** (all changeable, each warns if another app already uses it): **Ctrl+Alt+T** quick add, **Ctrl+Alt+P** pause/resume, **Ctrl+Alt+D** dismiss alert, **Ctrl+Alt+H** show/hide widget.
- **Updates**: checks GitHub Releases once a day and updates in one click. It verifies the SHA-256, swaps the exe and restarts.
- Timers survive restarts. They store a wall-clock end time, so time spent while the PC was off still counts.

## Widget

| Action | Result |
|---|---|
| Hover | Expand to list all timers (pause / cancel / new) |
| Click | Pause/resume the soonest timer, or dismiss the current alert |
| Double-click | Open the main window |
| Right-click | Menu: presets, Pomodoro, hide widget, quit |
| Drag | Move; it snaps to the nearest screen edge and grows away from it |
| Snap to left/right edge | Turns into a slim vertical bar (toggle in Settings) |
| Right-click → Widget size | Small, Medium (1.35×) or Large (1.75×); also in Settings |
| Cursor away | Fades and lets clicks pass through until the cursor comes near (toggle in Settings) |

## Build

Requires the .NET 10 SDK on Windows.

```bash
dotnet test tests/FluentTimer.Core.Tests
dotnet run --project src/FluentTimer.App
dotnet publish src/FluentTimer.App -c Release -p:PublishSingleFile=true -o publish
pwsh tests/ui-smoke.ps1 -Exe publish/FluentTimer.exe
```

The UI smoke test re-applies settings in an isolated instance and checks pixels to confirm the widget's transparent margin stays transparent. It runs in CI after every build.

### Releasing

Push a tag such as `v0.2.0`. The `release` workflow then tests, publishes, runs the smoke test and creates a GitHub Release with `FluentTimer.exe` and `FluentTimer.exe.sha256`. Installed copies pick it up through the in-app updater.

`publish/FluentTimer.exe` is a single self-contained exe; no .NET install is needed. On first run it registers itself in `HKCU\…\Run` so it starts with Windows. You can turn that off under Settings → General.

### Development switches

| Variable | Effect |
|---|---|
| `FLUENTTIMER_DATA=<dir>` | Use another data folder instead of `%AppData%\FluentTimer`; never touch the Windows startup entry; write `trace.log` |
| `FLUENTTIMER_DEV=1` | Same isolation, and disables self-update |
| `FLUENTTIMER_PAGE=Settings` | (dev only) open that main-window page on launch |
| `FLUENTTIMER_SELFTEST=reapply\|update` | (isolated only) test hooks used by the smoke test and the updater test |

## Layout

```
src/FluentTimer.Core         Timer engine, scheduler, quick-entry parser, storage, CSV, sound synthesis (no UI, fully tested)
src/FluentTimer.App          WPF app: tray, floating widget, alerts, hotkey, main window (WPF-UI)
tests/FluentTimer.Core.Tests xUnit tests with a fake clock
scripts/make-icon.ps1        Regenerates the app icon
```

Data is stored as JSON in `%AppData%\FluentTimer` (`settings.json`, `state.json`, `history.json`).

## Known limits (v1)

- Memory use is about 100 MB in the tray. WPF-UI's control themes load only when the main window or quick entry opens.
- No cloud sync or installer. See [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT

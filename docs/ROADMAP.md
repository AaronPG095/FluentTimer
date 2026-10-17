# Fluent Timer roadmap

## Stage 2 (v0.2): reliability first, then distribution ✅

Agreed and delivered on 2026-10-17.

### Widget
- [x] Hover is detected from the real cursor position (no stale MouseEnter).
- [x] When the cursor is away, the widget fades and lets clicks pass through. It becomes interactive again when the cursor comes near.
- [x] It turns vertical when snapped to the left or right screen edge, like Wispr Flow's bar.
- [x] Buttons and the pill have screen-reader names.
- [x] Reset button (main window and widget list).

### Keyboard
- [x] Global hotkeys, each changeable (Backspace turns one off), with an "already used" warning:
  - Ctrl+Alt+T: quick add
  - Ctrl+Alt+P: pause/resume
  - Ctrl+Alt+D: dismiss alert
  - Ctrl+Alt+H: show/hide widget
  - Pause/resume was planned as Ctrl+Alt+Space, but another app already used that on the dev machine.

### Multiple monitors
- [x] The break card appears on the monitor the widget is on.
- [x] Snapping converts with the widget's own per-monitor DPI.

### History
- [x] Rename a session's label, delete a session, add a forgotten one by hand.
- [x] Per-day stacked bar chart, with colours that follow the label, a legend and hover tooltips.

### Footprint
- [x] WPF-UI themes load lazily. A never-shown placeholder takes the Application.MainWindow role. Tray memory went from ~110–120 MB to ~100 MB private.

### Distribution
- [x] Pushing a `v*` tag publishes a GitHub Release with `FluentTimer.exe` and its SHA-256.
- [x] In-app update check (daily or on demand) with one-click update. The hash is verified, the exe renamed and swapped, and the app restarts.

### Testing
- [x] `tests/ui-smoke.ps1` runs in CI. A deliberate mutation (painting transparent windows white) makes it fail as intended.

## Later
- Installer and winget package, if it gets shared more widely
- Projects/clients with hourly rates
- Shake alert effect; quiet mode during calls
- Bring memory below 100 MB (would mean replacing WPF-UI controls in the main window)

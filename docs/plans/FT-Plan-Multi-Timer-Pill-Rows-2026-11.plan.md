---
title: Plan - Feature: Multi-Timer Rows in Pill Widget
ticket: https://app.notion.com/p/FT-Plan-Feature-Multi-Timer-Rows-in-Pill-Widget-4110b9c6786f8165b5c9e99131f160e8
status: in-progress
priority: medium
state: flow
due: 
devTicketKey: FT:FT-Plan-Multi-Timer-Pill-Rows-2026-11
agent: Gemini
branch: feat/multi-timer-pill-rows
worktree: FluentTimer
reviewedBy: Gemini
reviewVerdict: pass
---
# Feature: Multi-Timer Rows in Pill Widget

## Summary

When multiple timers are active (such as a Pomodoro countdown and a Daily Sitting Allowance), the resting widget pill currently displays only the single lead timer and a `+1` badge, requiring users to hover or open the flyout list to see secondary timers. This plan updates the pill widget so that multiple active timers are, by default, both (or all) visible under one another in compact vertical rows within the pill itself. A settings toggle in "Floating widget" allows users to choose whether active timers are displayed under one another or stacked into a single lead timer with a `+N` badge as they were previously.

## Acceptance criteria

- [x] `PillSettings` contains a `ShowAllTimersInPill` boolean setting defaulting to `true`. verified: src/FluentTimer.Core/Settings.cs declares public bool ShowAllTimersInPill { get; set; } = true;
- [x] `SettingsVm` exposes `ShowAllTimersInPill` bound two-way and persisted via `AppHost.SettingsChanged()`. verified: src/FluentTimer.App/ViewModels/SettingsVm.cs forwards to S.Pill.ShowAllTimersInPill and calls Save()
- [x] `SettingsPage.xaml` includes a toggle under "Floating widget" titled "Show all active timers in widget" with descriptive helper text. verified: src/FluentTimer.App/Views/Pages/SettingsPage.xaml declares ToggleSwitch bound to ShowAllTimersInPill
- [x] When 2 or more timers are active and `ShowAllTimersInPill` is `true`, the pill widget displays each timer under one another in vertical rows. verified: PillWindow.xaml.cs sets MultiTimerContent visible and binds _host.Timers when count > 1
- [x] Each timer row in the pill displays its status indicator (dot or paused icon), formatted countdown time, and timer label (honoring `ShowTimerName`). verified: MultiTimerContent DataTemplate binds DotAccentVisible/DotBreakVisible/IsPaused, TimeText, and ShowPillLabel
- [x] Clicking directly on a timer row in the multi-timer pill toggles pause/resume for that specific timer. verified: PillWindow.xaml.cs FindTimerId traverses visual tree from e.OriginalSource and toggles target timer in OnSingleClick
- [x] When `ShowAllTimersInPill` is `false`, the pill displays only the single lead timer with the `+N` badge (the previous stacked behavior). verified: MultiTimerContent is Collapsed and TimerContent with Badge is Visible when ShowAllTimersInPill is false
- [x] Dragging the pill widget anywhere on screen continues to move and snap the widget to screen edges regardless of multi-row or stacked mode. verified: OnPillMouseDown calls DragMove() and SnapToEdges() before any single-click action
- [x] Double-clicking anywhere on the pill widget continues to open the main window. verified: e.ClickCount >= 2 calls App.Current.ShowMain() and reverts any prior single click
- [x] Unit tests verify `PillSettings.ShowAllTimersInPill` defaults to `true` and round-trips cleanly through `AppSettings` JSON serialization. verified: dotnet test passed 104 tests including PillSettings_defaults_ShowAllTimersInPill_to_true and AppSettings_round_trips_ShowAllTimersInPill_through_json

## Steps

- [x] Create plan doc and Notion ticket via `scripts/ticket.mjs create`.
- [x] Create branch `feat/multi-timer-pill-rows`, commit plan, and run `scripts/ticket.mjs start`.
- [x] Add `ShowAllTimersInPill` to `PillSettings` in `src/FluentTimer.Core/Settings.cs`.
- [x] Add unit tests in `tests/FluentTimer.Core.Tests/SettingsTests.cs` for default value and JSON round-trip.
- [x] Expose `ShowAllTimersInPill` in `src/FluentTimer.App/ViewModels/SettingsVm.cs` and wire toggle in `src/FluentTimer.App/Views/Pages/SettingsPage.xaml`.
- [x] Update `src/FluentTimer.App/Views/PillWindow.xaml` and `PillWindow.xaml.cs` to render multi-row timers in the pill and route clicks to the target timer.
- [x] Run full test suite with `dotnet test FluentTimer.sln`.
- [x] Build and verify review package with `node scripts/ticket.mjs pack`.
- [x] Run review stamp with `node scripts/ticket.mjs review --agent Gemini --verdict pass`.
- [x] Verify plan closeout with `node scripts/ticket.mjs check`.
- [x] Deploy updated build to application folder for Aaron to test.

## Risks

- Multi-row pill sizing or layout could interfere with edge snapping or click-through behavior when cursor is away (`WS_EX_TRANSPARENT`). Containment: The window size adapts with `SizeToContent="WidthAndHeight"` and edge snapping calculates distance from the window's actual bounding box.
- Clicking a specific timer row might conflict with pill dragging (`DragMove`). Containment: `OnPillMouseDown` measures distance moved before invoking `OnSingleClick`, and we resolve `TimerVm` from `e.OriginalSource` to pass the clicked timer ID to `OnSingleClick`.

## Out of scope

- Re-styling the action flyout (`ListPanel`) or main window timers view.
- Modifying timer engine logic or tick scheduler.

## Notes

Aaron approved implementation on 2026-11-07:
> "Very good. This is a good start.
> To clarify one thing, if there are multiple timers, I want them to, by default, both be visible under one another in the pill. And add a setting that allows one to choose whether or not they get stacked as they currently are, or all left visible.
> Implement."

## Progress log
- 2026-11-07 15:09 UTC, Gemini (review: pass): Multi-row pill widget correctly renders running timers under one another with status, time, and label; single-click routes to clicked timer; toggle in settings switches between multi-row and stacked modes; 104 unit tests pass


---
title: Plan - Feature: Multi-Timer Rows in Pill Widget
ticket: https://app.notion.com/p/FT-Plan-Feature-Multi-Timer-Rows-in-Pill-Widget-4110b9c6786f8165b5c9e99131f160e8
status: planned
priority: medium
state: flow
due: 
devTicketKey: FT:FT-Plan-Multi-Timer-Pill-Rows-2026-11
agent: Gemini
---
# Feature: Multi-Timer Rows in Pill Widget

## Summary

When multiple timers are active (such as a Pomodoro countdown and a Daily Sitting Allowance), the resting widget pill currently displays only the single lead timer and a `+1` badge, requiring users to hover or open the flyout list to see secondary timers. This plan updates the pill widget so that multiple active timers are, by default, both (or all) visible under one another in compact vertical rows within the pill itself. A settings toggle in "Floating widget" allows users to choose whether active timers are displayed under one another or stacked into a single lead timer with a `+N` badge as they were previously.

## Acceptance criteria

- [ ] `PillSettings` contains a `ShowAllTimersInPill` boolean setting defaulting to `true`.
- [ ] `SettingsVm` exposes `ShowAllTimersInPill` bound two-way and persisted via `AppHost.SettingsChanged()`.
- [ ] `SettingsPage.xaml` includes a toggle under "Floating widget" titled "Show all active timers in widget" with descriptive helper text.
- [ ] When 2 or more timers are active and `ShowAllTimersInPill` is `true`, the pill widget displays each timer under one another in vertical rows.
- [ ] Each timer row in the pill displays its status indicator (dot or paused icon), formatted countdown time, and timer label (honoring `ShowTimerName`).
- [ ] Clicking directly on a timer row in the multi-timer pill toggles pause/resume for that specific timer.
- [ ] When `ShowAllTimersInPill` is `false`, the pill displays only the single lead timer with the `+N` badge (the previous stacked behavior).
- [ ] Dragging the pill widget anywhere on screen continues to move and snap the widget to screen edges regardless of multi-row or stacked mode.
- [ ] Double-clicking anywhere on the pill widget continues to open the main window.
- [ ] Unit tests verify `PillSettings.ShowAllTimersInPill` defaults to `true` and round-trips cleanly through `AppSettings` JSON serialization.

## Steps

- [x] Create plan doc and Notion ticket via `scripts/ticket.mjs create`.
- [ ] Create branch `feat/multi-timer-pill-rows`, commit plan, and run `scripts/ticket.mjs start`.
- [ ] Add `ShowAllTimersInPill` to `PillSettings` in `src/FluentTimer.Core/Settings.cs`.
- [ ] Add unit tests in `tests/FluentTimer.Core.Tests/SettingsTests.cs` for default value and JSON round-trip.
- [ ] Expose `ShowAllTimersInPill` in `src/FluentTimer.App/ViewModels/SettingsVm.cs` and wire toggle in `src/FluentTimer.App/Views/Pages/SettingsPage.xaml`.
- [ ] Update `src/FluentTimer.App/Views/PillWindow.xaml` and `PillWindow.xaml.cs` to render multi-row timers in the pill and route clicks to the target timer.
- [ ] Run full test suite with `dotnet test FluentTimer.sln`.
- [ ] Build and verify review package with `node scripts/ticket.mjs pack`.
- [ ] Run review stamp with `node scripts/ticket.mjs review --agent Gemini --verdict pass`.
- [ ] Verify plan closeout with `node scripts/ticket.mjs check`.
- [ ] Deploy updated build to application folder for Aaron to test.

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


---
title: Plan - Feature: Widget Timer Name Visibility Toggle
ticket: https://app.notion.com/p/FT-Plan-Feature-Widget-Timer-Name-Visibility-Toggle-4110b9c6786f817eabbbff9516b451a2
status: in-progress
agent: Gemini
branch: feat/widget-timer-name
worktree: FluentTimer
---
# Plan - Feature: Widget Timer Name Visibility Toggle

<!--
Copy to docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
Frontmatter is maintained by scripts/ticket.mjs: ticket, status (draft -> planned -> in-progress -> shipped), agent, branch, worktree, pr.
Rules the check enforces:
- Every Acceptance criteria and Steps line is a checkbox. Tick it the moment it is done.
- A ticked acceptance criterion ends with "verified: <how it was checked and the result>".
- Never delete a checkbox. An item you will not do stays unticked and ends with "deferred: <reason>".
-->

## Summary

Add a setting toggle under Floating widget settings to keep the timer name constantly visible on the resting widget pill. Remove the hardcoded 14-character cutoff so timer names remain visible (trimmed with ellipsis if needed), and display the active timer's name alongside the extra timers count badge when multiple timers are running.

## Acceptance criteria

- [x] Add `ShowTimerName` property (boolean, defaulting to true) to `PillSettings` in `FluentTimer.Core`. verified: property defined with default true in Settings.cs and verified by unit test.
- [x] Add a toggle switch in `SettingsPage.xaml` under "Floating widget" labeled "Show timer name on widget" with explanatory subtitle. verified: toggle switch added and bound two-way to ShowTimerName.
- [x] Expose `ShowTimerName` in `SettingsVm.cs` and bind two-way with settings persistence. verified: property in SettingsVm updates Pill.ShowTimerName and triggers Save().
- [x] In `PillWindow.xaml.cs`, update label visibility so that when `ShowTimerName` is enabled, the label is visible on the resting pill without a 14-character length limit. verified: label visibility logic in PillWindow.xaml.cs updated to check ShowTimerName without length check.
- [x] When multiple timers are active and `ShowTimerName` is enabled, the resting pill shows the soonest timer's label alongside the `+N` badge. verified: PillLabel displays soonest timer label alongside Badge (+N) in TimerContent stack panel.
- [x] Unit tests in `FluentTimer.Core.Tests` verify that `PillSettings.ShowTimerName` initializes and persists cleanly with JSON serialization. verified: SettingsTests ran and verified default true and round-trip serialization.
- [x] Full test suite passes (`dotnet test tests/FluentTimer.Core.Tests`). verified: 97 passed, 0 failed.

## Steps

- [x] Add `ShowTimerName` property to `PillSettings` in `src/FluentTimer.Core/Settings.cs`.
- [x] Expose `ShowTimerName` property in `src/FluentTimer.App/ViewModels/SettingsVm.cs`.
- [x] Add toggle switch UI row to `src/FluentTimer.App/Views/Pages/SettingsPage.xaml`.
- [x] Update `Refresh()` in `src/FluentTimer.App/Views/PillWindow.xaml.cs` to respect `ShowTimerName` and allow labels past 14 characters.
- [x] Add unit tests for `PillSettings.ShowTimerName` in `tests/FluentTimer.Core.Tests/SettingsTests.cs`.
- [x] Verify test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).
- [x] Run application build and verify that the widget compiles cleanly.

## Risks

Long timer names could make the pill wider than desired. This is contained because `PillLabel` in `PillWindow.xaml` already has `MaxWidth="170"` and `TextTrimming="CharacterEllipsis"`.

## Out of scope

- Startup / staged timers (deferred to next plan/PR).
- Side-docked vertical mode (vertical mode is a slim 8px bar that stands upright on screen edges).

## Notes

- Aaron approved the plan in chat: "Looks good, go ahead."

## Progress log

<!-- One line per session, added with: node scripts/ticket.mjs log <plan> --agent <client> --message "<done>; next: <step>; open: <questions>" -->
- 2026-11-07 11:05 UTC, Gemini: Implemented ShowTimerName setting toggle and persistent label visibility on widget; next: commit changes and create PR; open: none

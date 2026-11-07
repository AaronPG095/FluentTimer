---
title: Plan - Feature: Widget Timer Name Visibility Toggle
ticket: https://app.notion.com/p/FT-Plan-Feature-Widget-Timer-Name-Visibility-Toggle-4110b9c6786f817eabbbff9516b451a2
status: planned
agent: Gemini
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

- [ ] Add `ShowTimerName` property (boolean, defaulting to true) to `PillSettings` in `FluentTimer.Core`.
- [ ] Add a toggle switch in `SettingsPage.xaml` under "Floating widget" labeled "Show timer name on widget" with explanatory subtitle.
- [ ] Expose `ShowTimerName` in `SettingsVm.cs` and bind two-way with settings persistence.
- [ ] In `PillWindow.xaml.cs`, update label visibility so that when `ShowTimerName` is enabled, the label is visible on the resting pill without a 14-character length limit.
- [ ] When multiple timers are active and `ShowTimerName` is enabled, the resting pill shows the soonest timer's label alongside the `+N` badge.
- [ ] Unit tests in `FluentTimer.Core.Tests` verify that `PillSettings.ShowTimerName` initializes and persists cleanly with JSON serialization.
- [ ] Full test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).

## Steps

- [ ] Add `ShowTimerName` property to `PillSettings` in `src/FluentTimer.Core/Settings.cs`.
- [ ] Expose `ShowTimerName` property in `src/FluentTimer.App/ViewModels/SettingsVm.cs`.
- [ ] Add toggle switch UI row to `src/FluentTimer.App/Views/Pages/SettingsPage.xaml`.
- [ ] Update `Refresh()` in `src/FluentTimer.App/Views/PillWindow.xaml.cs` to respect `ShowTimerName` and allow labels past 14 characters.
- [ ] Add unit tests for `PillSettings.ShowTimerName` in `tests/FluentTimer.Core.Tests/SettingsTests.cs`.
- [ ] Verify test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).
- [ ] Run application build and verify that the widget compiles cleanly.

## Risks

Long timer names could make the pill wider than desired. This is contained because `PillLabel` in `PillWindow.xaml` already has `MaxWidth="170"` and `TextTrimming="CharacterEllipsis"`.

## Out of scope

- Startup / staged timers (deferred to next plan/PR).
- Side-docked vertical mode (vertical mode is a slim 8px bar that stands upright on screen edges).

## Notes

- Aaron approved the plan in chat: "Looks good, go ahead."

## Progress log

<!-- One line per session, added with: node scripts/ticket.mjs log <plan> --agent <client> --message "<done>; next: <step>; open: <questions>" -->

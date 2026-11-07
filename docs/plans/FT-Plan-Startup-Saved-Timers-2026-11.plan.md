---
title: Plan - Feature: Saved Timers Startup Staging and Auto-Start
ticket: https://app.notion.com/p/FT-Plan-Feature-Saved-Timers-Startup-Staging-and-Auto-Start-4110b9c6786f817ab147d58a6b887e18
status: shipped
agent: Gemini
branch: feat/startup-saved-timers
worktree: FluentTimer
pr: https://github.com/AaronPG095/FluentTimer/pull/3
---
# Plan - Feature: Saved Timers Startup Staging and Auto-Start

<!--
Copy to docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
Frontmatter is maintained by scripts/ticket.mjs: ticket, status (draft -> planned -> in-progress -> shipped), agent, branch, worktree, pr.
Rules the check enforces:
- Every Acceptance criteria and Steps line is a checkbox. Tick it the moment it is done.
- A ticked acceptance criterion ends with "verified: <how it was checked and the result>".
- Never delete a checkbox. An item you will not do stays unticked and ends with "deferred: <reason>".
-->

## Summary

Allow saved timers to specify startup behavior: None (default), Stage paused (opens at launch in paused state at full duration, visible on the widget and main window, ready to start with one click), or Auto-start running (begins counting down immediately when FluentTimer launches).

## Acceptance criteria

- [x] Add `SavedTimerStartup` enum (`None`, `StagePaused`, `AutoStart`) and property to `SavedTimer` in `FluentTimer.Core`. verified: defined in Models.cs and verified by unit tests.
- [x] Add `StageSaved(SavedTimer saved)` to `TimerEngine` that stages a timer in `TimerState.Paused` with its initial duration and label. verified: implemented in TimerEngine.cs and verified by unit test.
- [x] In `AppHost.Start()`, evaluate saved timers on launch and stage or start them, preventing duplicates if matching active timers already exist from a previous session. verified: ApplyStartupTimers() called in AppHost.Start() and duplicate avoidance verified by unit test.
- [x] In `TimersPage.xaml`, add a startup selector on Saved Timer cards allowing selection between None, Stage paused, and Auto-start. verified: ComboBox selector added to card template bound to SavedTimerVm.StartupChoice.
- [x] Unit tests in `FluentTimer.Core.Tests` verify staging, auto-starting, JSON round-trip serialization, and duplicate avoidance logic. verified: unit tests in TimerEngineTests.cs and StorageAndReportTests.cs passed.
- [x] Full test suite passes (`dotnet test tests/FluentTimer.Core.Tests`). verified: 98 passed, 0 failed.

## Steps

- [x] Add `SavedTimerStartup` enum and `Startup` property to `SavedTimer` in `src/FluentTimer.Core/Models.cs`.
- [x] Implement `StageSaved(SavedTimer saved)` in `src/FluentTimer.Core/TimerEngine.cs`.
- [x] Update `AppHost.Start()` in `src/FluentTimer.App/Services/AppHost.cs` to process saved timers with startup actions.
- [x] Expose startup options and two-way property on `SavedTimerVm` in `src/FluentTimer.App/ViewModels/ScheduleVms.cs`.
- [x] Add startup UI selector in `src/FluentTimer.App/Views/Pages/TimersPage.xaml`.
- [x] Add unit tests for startup saved timers in `tests/FluentTimer.Core.Tests/TimerEngineTests.cs` and `StorageAndReportTests.cs`.
- [x] Verify test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).
- [x] Run application build and verify that the app compiles cleanly.

## Risks

Duplicate timers across restarts: If a staged or running timer was saved to `state.json` when the app exited, re-launching must not create a second duplicate timer. Handled by checking whether an active timer with matching identity or origin already exists.

## Out of scope

- Background Windows Task Scheduler triggers or calendar integrations.

## Notes

- Aaron approved the plan in chat: "Looks good, implement."

## Progress log

<!-- One line per session, added with: node scripts/ticket.mjs log <plan> --agent <client> --message "<done>; next: <step>; open: <questions>" -->
- 2026-11-07 11:28 UTC, Gemini: Implemented saved timers startup behavior (stage paused or auto-start); next: commit and create PR; open: none

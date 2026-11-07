---
title: Plan - Feature: Saved Timers Startup Staging and Auto-Start
ticket: https://app.notion.com/p/FT-Plan-Feature-Saved-Timers-Startup-Staging-and-Auto-Start-4110b9c6786f817ab147d58a6b887e18
status: planned
agent: Gemini
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

- [ ] Add `SavedTimerStartup` enum (`None`, `StagePaused`, `AutoStart`) and property to `SavedTimer` in `FluentTimer.Core`.
- [ ] Add `StageSaved(SavedTimer saved)` to `TimerEngine` that stages a timer in `TimerState.Paused` with its initial duration and label.
- [ ] In `AppHost.Start()`, evaluate saved timers on launch and stage or start them, preventing duplicates if matching active timers already exist from a previous session.
- [ ] In `TimersPage.xaml`, add a startup selector on Saved Timer cards allowing selection between None, Stage paused, and Auto-start.
- [ ] Unit tests in `FluentTimer.Core.Tests` verify staging, auto-starting, JSON round-trip serialization, and duplicate avoidance logic.
- [ ] Full test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).

## Steps

- [ ] Add `SavedTimerStartup` enum and `Startup` property to `SavedTimer` in `src/FluentTimer.Core/Models.cs`.
- [ ] Implement `StageSaved(SavedTimer saved)` in `src/FluentTimer.Core/TimerEngine.cs`.
- [ ] Update `AppHost.Start()` in `src/FluentTimer.App/Services/AppHost.cs` to process saved timers with startup actions.
- [ ] Expose startup options and two-way property on `SavedTimerVm` in `src/FluentTimer.App/ViewModels/ScheduleVms.cs`.
- [ ] Add startup UI selector in `src/FluentTimer.App/Views/Pages/TimersPage.xaml`.
- [ ] Add unit tests for startup saved timers in `tests/FluentTimer.Core.Tests/TimerEngineTests.cs` and `StorageAndReportTests.cs`.
- [ ] Verify test suite passes (`dotnet test tests/FluentTimer.Core.Tests`).
- [ ] Run application build and verify that the app compiles cleanly.

## Risks

Duplicate timers across restarts: If a staged or running timer was saved to `state.json` when the app exited, re-launching must not create a second duplicate timer. Handled by checking whether an active timer with matching identity or origin already exists.

## Out of scope

- Background Windows Task Scheduler triggers or calendar integrations.

## Notes

- Aaron approved the plan in chat: "Looks good, implement."

## Progress log

<!-- One line per session, added with: node scripts/ticket.mjs log <plan> --agent <client> --message "<done>; next: <step>; open: <questions>" -->

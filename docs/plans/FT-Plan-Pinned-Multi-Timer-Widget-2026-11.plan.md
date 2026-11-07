---
title: Plan - Feature: Pinned Multi-Timer Widget List
ticket: https://app.notion.com/p/FT-Plan-Feature-Pinned-Multi-Timer-Widget-List-4110b9c6786f81f99b22fb5b1053016d
status: planned
priority: medium
state: quick
due: 
reviewedBy: 
reviewVerdict: 
devTicketKey: FT:FT-Plan-Pinned-Multi-Timer-Widget-2026-11
agent: Gemini
---
# Pinned Multi-Timer Widget List

<!--
Copy to docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
Title: <Plan|Debug|Ask> - <Type>: <Title>. Type is Feature, Bug, Refactor, Docs, Perf, Process or similar; the script adds the project prefix.
Optional, set before `create` (leave empty if unsure): priority (emergency, critical, high, medium, low), state (quick, easy, flow), due (YYYY-MM-DD, only an explicit real deadline).
Creation starts To Do with Task Lane = Development and a stable Dev Ticket Key, queries the key before creating, and leaves Focus Slot/Date blank. Preserve devTicketKey if renaming this plan; do not run concurrent creates for the same plan.
Frontmatter is maintained by scripts/ticket.mjs: ticket, devTicketKey, status (draft -> planned -> in-progress -> shipped -> done), agent, branch, worktree, reviewedBy, reviewVerdict, pr.
Rules the check enforces:
- Every Acceptance criteria and Steps line is a checkbox. Tick it the moment it is done.
- A ticked acceptance criterion ends with "verified: <how it was checked and the result>". Keep evidence terse (1 line).
- Never delete a checkbox. An item you will not do stays unticked and ends with "deferred: <reason>".
- Before shipping, run `node scripts/ticket.mjs pack` for a 0-token review digest and record the review with `node scripts/ticket.mjs review --agent <client> --verdict <pass|warn|block> --summary "<findings>"`.
-->

## Summary

Adds a pinning capability to the floating widget (`PillWindow`) so that multiple active timers can be monitored continuously on the desktop without needing to keep the mouse hovered over the widget. Provides a pin toggle button on the widget list itself, a setting toggle under Settings -> Widget, and preserves transparent click-through / away-fade behavior so the pinned list does not block clicks on background applications.

## Acceptance criteria

- [ ] `PillSettings` has `PinTimerList` (boolean, default `false`), persisting to `settings.json`.
- [ ] Settings -> Widget provides a toggle switch ("Keep timer list pinned open") bound two-way to `PinTimerList`.
- [ ] Widget flyout (`ListPanel`) includes a pin toggle button (`PinToggle`, style `IconToggle`, glyph `&#xE718;`) allowing one-click pinning/unpinning directly from the widget.
- [ ] When `PinTimerList` is `true` and active/staged timers exist (`_host.Timers.Count > 0`), `ListPanel` remains visible on screen rather than collapsing when the mouse leaves.
- [ ] When all timers complete or are dismissed, the widget returns cleanly to its idle state (collapsed idle bar or hidden per idle setting).
- [ ] When `FadeWhenAway` is enabled, the pinned widget smoothly dims to away opacity and enables click-through (`WS_EX_TRANSPARENT`) while the mouse is away, restoring full opacity when hovered.
- [ ] Unit tests in `SettingsTests.cs` verify `PinTimerList` default state and JSON serialization round-tripping.

## Steps

- [ ] Add `PinTimerList` to `PillSettings` in `Settings.cs` and unit test in `SettingsTests.cs`
- [ ] Expose `PinTimerList` in `SettingsVm.cs` and add toggle switch in `SettingsPage.xaml`
- [ ] Add pin toggle button in `PillWindow.xaml` and handle click/visual state in `PillWindow.xaml.cs`
- [ ] Update `UpdatePresence()`, `Refresh()`, and `CursorState()` in `PillWindow.xaml.cs` to honor `PinTimerList` and maintain proper fade/click-through behavior
- [ ] Verify build, run test suite (`dotnet test`), and check widget behavior
- [ ] Perform review with `ticket.mjs pack` and stamp with `ticket.mjs review`

## Risks

Pinned widget might obstruct window interactions if click-through is not enabled while away; addressed by tying pinned away-state to `WS_EX_TRANSPARENT` when `FadeWhenAway` is true.

## Out of scope

Modifying timer countdown or sound logic; altering main window timer cards layout.

## Notes

- Aaron approved the plan on 2026-11-07: "Proceed with the plan. Please also be aware of the new AI dev workflow that's currently being implemented and how we should take that into consideration for the next steps."
- Selected Option A: Pinned Multi-Timer List (Pin toggle on widget flyout + Settings toggle).
- Uses the new 6-step AI dev workflow (with `pack` and `review` lifecycle).

## Progress log

<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->

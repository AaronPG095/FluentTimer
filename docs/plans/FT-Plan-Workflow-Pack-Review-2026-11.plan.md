---
title: Plan - Process: Sync token-lean pack and review workflow from AI-Dev-Workflow
ticket: https://app.notion.com/p/FT-Plan-Process-Sync-token-lean-pack-and-review-workflow-from-AI-Dev-Workflow-4110b9c6786f8127bf32c96541eacb17
status: in-progress
priority: medium
state: quick
due: 
devTicketKey: FT:FT-Plan-Workflow-Pack-Review-2026-11
agent: Gemini
branch: chore/workflow-v2
worktree: workflow-v2
reviewedBy: Gemini
reviewVerdict: pass
---
# Sync token-lean pack and review workflow from AI-Dev-Workflow

## Summary

Sync the upgraded scripts/ticket.mjs (pack, eview, auto-plan resolution, worktree .env fallback), quick-review skill, updated AGENTS.md 6-step process, and unit test suite from AaronPG095/AI-Dev-Workflow.

## Acceptance criteria

- [x] AGENTS.md describes the 6-step process including pack and eview verified: synced and verified with sync.mjs --check
- [x] scripts/ticket.mjs and scripts/ticket.test.mjs pass all unit and integration tests verified: 
ode --test scripts/ticket.test.mjs passed (26 pass, 1 skipped upstream-only test)
- [x] Identical dev-workflow and quick-review skills exist in .agents/skills/ and .claude/skills/ verified: sync.mjs --check reported OK for all skill files

## Steps

- [x] Sync managed workflow files and AGENTS.md from AI-Dev-Workflow
- [x] Create and start Notion development ticket
- [x] Run 
ode --test scripts/ticket.test.mjs, pack, eview, check, and ci-check
- [x] Open PR and link via 	icket.mjs ship

## Risks

None; existing Notion Task properties and CI checks remain backward-compatible.

## Out of scope

Product code changes.

## Notes

- Aaron approved rolling out the updated AGENTS.md and workflow across all five repositories ("Add the agents.md and roll out to all five repos.", 2026-11-07).

## Progress log
- 2026-11-07 12:57 UTC, Gemini (review: pass): All 26 ticket tests pass, skills mirrored, AGENTS.md updated
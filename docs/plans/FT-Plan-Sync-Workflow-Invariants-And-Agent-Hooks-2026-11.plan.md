---
title: Plan - Chore: Sync Workflow Invariants And Agent Hooks
ticket: https://app.notion.com/p/FT-Plan-Chore-Sync-Workflow-Invariants-And-Agent-Hooks-4220b9c6786f81c1a5d2dcf58ce5f952
status: in-progress
priority: 
state: 
due: 
appetite: L
version: 
impact: 
dependsOn: 
devTicketKey: FT:FT-Plan-Sync-Workflow-Invariants-And-Agent-Hooks-2026-11
agent: Gemini
branch: gemini/sync-workflow-invariants-and-agent-hooks
worktree: FluentTimer
reviewedBy: Gemini
reviewVerdict: pass
reviewSession: df4fdd1e-7ea9-4f9b-a30d-71a89118daf7
baseBranch: main
reviewFingerprint: 226c7a8022cdb4cf45cfa1fe8e496ba66b00eb4ea7850f130ed7e613da338d4b
---
# Sync Workflow Invariants And Agent Hooks

## Summary

Sync latest AI-Dev-Workflow bundle from upstream main, configure repository invariants, and track .claude/settings.json runtime hooks.

## Context

None noted.

## Open questions

None

## Acceptance criteria

- [x] Managed workflow files synced with zero drift against AI-Dev-Workflow verified: sync.mjs synced bundle and sync --check exited 0
- [x] Agent runtime hooks installed and tracked in .claude/settings.json (3/3 events) verified: hook status --agent-hooks confirmed 3/3 events in .claude/settings.json
- [x] Repository verification command and close-out check pass verified: ticket.mjs verify --tier test passed (FluentTimer.Core.Tests 104/104)

## Steps

- [x] Sync workflow bundle and invariants config
- [x] Verify 3/3 agent runtime hooks in .claude/settings.json
- [x] Run repository verify command, independent subagent review, and close-out check

## Risks

None noted.

## Out of scope

None noted.

## Notes

- Approval (Aaron): "Do all"

## Progress log

<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->
- 2026-11-24 11:13 UTC, Gemini (review: pass): Clean upstream AI-Dev-Workflow bundle sync, invariants config, and 3/3 .claude/settings.json hooks with zero sync drift; L-appetite line exceedance (~2700/1000) is justified by the atomic managed-bundle update. [reviewer: df4fdd1e-7ea9-4f9b-a30d-71a89118daf7]

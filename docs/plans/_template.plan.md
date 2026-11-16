---
title: <Plan|Debug|Ask> - <Type>: <Title>, e.g. Plan - Feature: Smart Shortcut Suggestions
ticket:
status: draft
priority:
state:
due:
appetite:
version:
impact:
---
# <Title>

<!--
Copy to docs/plans/<PREFIX>-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
Title: <Plan|Debug|Ask> - <Type>: <Title>. Type is Feature, Bug, Refactor, Docs, Perf, Process or similar; the script adds the project prefix.
Optional, set before `create` (leave empty if unsure): priority (emergency, critical, high, medium, low), state (quick, easy, flow), due (YYYY-MM-DD, only an explicit real deadline), appetite (S, M, or L — Shape Up diff budget), version (target release e.g. 1.2.0 or none), impact (none, patch, minor, major).
Creation starts To Do with Task Lane = Development and a stable Dev Ticket Key (plus Target Version when version is set), queries the key before creating, and leaves Focus Slot/Date blank. Preserve devTicketKey if renaming this plan; do not run concurrent creates for the same plan.
Frontmatter is maintained by scripts/ticket.mjs: ticket, devTicketKey, status (draft -> planned -> in-progress -> shipped -> done), agent, branch, worktree, reviewedBy, reviewVerdict, pr, version, impact.
Rules the check enforces:
- Every Acceptance criteria and Steps line is a checkbox. Tick it the moment it is done.
- Write Acceptance criteria as observable outcomes (e.g. `AC1: WHEN <trigger> THE SYSTEM SHALL <response>`), not task verbs. Map Steps to criteria with `(AC1)`.
- A ticked acceptance criterion ends with "verified: <how it was checked and the result>" (or typed `verified(test|cmd|manual|inspect):`). Keep evidence terse (1 line).
- Never delete a checkbox. An item you will not do stays unticked and ends with "deferred: <reason>".
- Before shipping, run `node scripts/ticket.mjs pack` for a 0-token review digest and record the review with `node scripts/ticket.mjs review --agent <client> --verdict <pass|warn|block> --summary "<findings>"`.
-->

## Summary

<2-3 sentences: what changes and why.>

## Context

<Compacted research: relevant files with path:line, current behaviour, constraints, and alternatives considered & rejected.>

## Open questions

<Unresolved assumptions or `- [ ] Question?` items to resolve before `start`; write `None` when clear.>

## Acceptance criteria

- [ ] AC1: <Observable outcome>

## Steps

- [ ] <Step> (AC1)

## Risks

<Pre-mortem: Assume this shipped and broke in production a week later — what failed, and what test/guardrail mitigates it?>

## Out of scope

<What this plan deliberately does not do.>

## Notes

<Discoveries and decisions during implementation, including Aaron's plan approval.>

## Progress log

<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->

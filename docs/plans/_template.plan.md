---
title: <Plan|Debug|Ask> - <Type>: <Title>, e.g. Plan - Feature: Smart Shortcut Suggestions
ticket:
status: draft
priority:
state:
due:
---
# <Title>

<!--
Copy to docs/plans/<PREFIX>-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
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

<2-3 sentences: what changes and why.>

## Acceptance criteria

- [ ] <Checkable outcome>

## Steps

- [ ] <Step>

## Risks

<What could go wrong and how it is contained.>

## Out of scope

<What this plan deliberately does not do.>

## Notes

<Discoveries and decisions during implementation, including Aaron's plan approval.>

## Progress log

<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->

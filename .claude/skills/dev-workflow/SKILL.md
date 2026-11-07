---
name: dev-workflow
description: Shared AI development process - plan, plan doc, ticket, implement while ticking the plan, single-pass review via pack, finish only when the plan is closed out. Use when starting, continuing, reviewing, handing over or finishing any non-trivial code change, or when asked to plan, ticket, start or ship work.
---

# Development workflow

The authoritative process is "Development process" in `AGENTS.md`. This skill is the runnable checklist. Keep this file identical in `.agents/skills/` and `.claude/skills/`.

1. **Plan.** Investigate read-only. Propose Summary, Acceptance criteria, Steps, Risks and Out of scope. Wait for approval and quote it under Notes.
2. **Plan doc.** Copy `docs/plans/_template.plan.md` to `docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md`. The title reads `<Plan|Debug|Ask> - <Type>: <Title>` (for example `Plan - Feature: Smart Shortcut Suggestions`); optionally set `priority`, `state` and `due` in the frontmatter. Every criterion and step is a `- [ ]` checkbox. Bigger than one PR? Split it into one plan per PR.
3. **Ticket.** `node scripts/ticket.mjs create <plan> --agent <your client: Claude, Codex, Gemini or Other>`. In Notion mode, new Tasks start To Do, stamp Development and a stable Dev Ticket Key, and have no Focus Slot or scheduling Date; creation reads the key first and restores an existing canonical URL without changing that Task. In local mode (`tracker: "local"`), it stamps `local://<key>`. Preserve `devTicketKey` when renaming a plan; do not create the same plan concurrently.
4. **Start.** Create a branch, commit the plan on it, then `node scripts/ticket.mjs start [<plan>]`.
5. **Implement.** Re-read the plan before each step. Tick each checkbox as soon as it is done. Ticked acceptance criteria end with concise `verified: <how and result>` evidence (1 line, no raw terminal dumps). Never delete a checkbox; mark it `deferred: <reason>` instead. Record discoveries under Notes.
6. **Before you stop.** `node scripts/ticket.mjs log [<plan>] --agent <you> --message "<done>; next: <step>; open: <questions>"`, then commit the plan.
7. **Review (token-lean).** Run `node scripts/ticket.mjs pack [<plan>]` (one command, 0 LLM tokens) to inspect the plan criteria, hygiene status, and filtered diff. Perform a single-pass check for plan fidelity, regressions, and verification honesty (use the `quick-review` skill or a fresh session/second model when practical), then record the result: `node scripts/ticket.mjs review [<plan>] --agent <you> --verdict <pass|warn|block> --summary "<concise findings>"`.
8. **Close out.** `node scripts/ticket.mjs check [<plan>]` must pass. Tell the user about any deferred item.
9. **Ship.** Open the PR with the template filled in, then `node scripts/ticket.mjs ship [<plan>] --pr <url>` and copy the deferred items it prints into the PR. Do not mark the Task Done; merging does that.

Continuing someone else's work: find the plan with `status: in-progress`, read it fully including the Progress log, and resume at the first unticked step.

If any `ticket.mjs` command fails, report the error and stop at that step.

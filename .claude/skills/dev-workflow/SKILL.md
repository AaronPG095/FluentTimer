---
name: dev-workflow
description: Shared AI development process - plan, plan doc, ticket, implement while ticking the plan, single-pass review via pack, finish only when the plan is closed out. Use when starting, continuing, reviewing, handing over or finishing any non-trivial code change, or when asked to plan, ticket, start or ship work.
---

# Development workflow

The authoritative process is "Development process" in `AGENTS.md`. This skill is the runnable checklist. Keep this file identical in `.agents/skills/` and `.claude/skills/`.

1. **Plan.** Investigate read-only. Propose Summary, Acceptance criteria, Steps, Risks and Out of scope. Wait for approval and quote it under Notes.
2. **Plan doc.** Copy `docs/plans/_template.plan.md` to `docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md` or scaffold with `node scripts/ticket.mjs new "<Topic>" [--type Feature] [--branch]`. The title reads `<Plan|Debug|Ask> - <Type>: <Title>` (for example `Plan - Feature: Smart Shortcut Suggestions`); optionally set `priority`, `state` and `due` in the frontmatter. Every criterion and step is a `- [ ]` checkbox. Bigger than one PR? Split it into one plan per PR.
3. **Ticket.** `node scripts/ticket.mjs create <plan> --agent <your client: Claude, Codex, Gemini or Other>`. In Notion mode, new Tasks start To Do, stamp Development and a stable Dev Ticket Key, and have no Focus Slot or scheduling Date; creation reads the key first and restores an existing canonical URL without changing that Task. In local mode (`tracker: "local"`), it stamps `local://<key>`. Preserve `devTicketKey` when renaming a plan; do not create the same plan concurrently.
4. **Start.** Create a branch, commit the plan on it, then `node scripts/ticket.mjs start [<plan>]`.
5. **Implement.** Re-read the plan before each step. Cold start / resume: run `node scripts/ticket.mjs prime` for a compact session primer with numbered `[#]` checkboxes, `node scripts/ticket.mjs resume` for handoff state, or `node scripts/ticket.mjs overview` for multi-repo status. Tick each checkbox as soon as it is done with zero tokens: `node scripts/ticket.mjs tick <#|query> [--verified <evidence>]`. Ticked acceptance criteria end with concise `verified: <how and result>` evidence (1 line, no raw terminal dumps). Never delete a checkbox; mark it `deferred: <reason>` instead via `node scripts/ticket.mjs defer <#|query> --reason <why>`. Record architectural choices in `docs/decisions/` with `node scripts/ticket.mjs adr "<Title>"`. Search past decisions and plan notes with `node scripts/ticket.mjs recall "<query>" [--fleet]`. Manage isolated worktrees with `node scripts/ticket.mjs wt [list|new|prune] [--fleet]`. Diagnose repo health with `node scripts/ticket.mjs doctor [--fleet]`.
6. **Before you stop.** `node scripts/ticket.mjs handoff --agent <you> --done "<done>" --next "<step>" [--open "<questions>"]` (or `log`), then commit the plan.
7. **Review (token-lean).** Run `node scripts/ticket.mjs pack [<plan>] [--test]` (one command, 0 LLM tokens, embeds test results with `--test`) to inspect the plan criteria, hygiene status, and filtered diff. Perform a single-pass check for plan fidelity, regressions, and verification honesty (use the `quick-review` skill or a fresh session/second model when practical), then record the result: `node scripts/ticket.mjs review [<plan>] --agent <you> --verdict <pass|warn|block> --summary "<concise findings>"`.
8. **Close out.** `node scripts/ticket.mjs check [<plan>]` must pass. Tell the user about any deferred item.
9. **Ship.** Open the PR and ship in one command: `node scripts/ticket.mjs pr [--verify] [--auto] [--draft]` (or open the PR manually with the template filled in, then `node scripts/ticket.mjs ship [<plan>] --pr <url>`). Do not mark the Task Done; merging does that.

Continuing someone else's work: find the plan with `status: in-progress`, read it fully including the Progress log, and resume at the first unticked step.

If any `ticket.mjs` command fails, report the error and stop at that step.

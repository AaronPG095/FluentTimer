# FluentTimer

## Development process (every AI: Claude, Codex, Gemini/Antigravity, Cursor)

Non-trivial changes follow these six steps. Only trivial changes (at most 40 changed lines, no new files under `src/`: typos, dependency bumps, one-line fixes) may skip them; their PR gets the `no-plan` label.

1. **Plan.** Investigate read-only and propose a plan. Wait for Aaron's approval before changing code, and quote it under Notes in the plan.
2. **Plan doc.** Copy `docs/plans/_template.plan.md` to `docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md` or scaffold with `node scripts/ticket.mjs new "<Topic>" [--type Feature] [--branch]`. The title reads `<Plan|Debug|Ask> - <Type>: <Title>` (for example `Plan - Feature: Smart Shortcut Suggestions`); optionally set `priority`, `state` and `due` in the frontmatter. Acceptance criteria and Steps are `- [ ]` checkboxes. A plan bigger than one PR is split into separate plans, one per PR.
3. **Ticket.** Run `node scripts/ticket.mjs create <plan> --agent <Claude|Codex|Gemini|Other>`. It creates the Notion Task (FT prefix, To Do, `Task Lane = Development`, a stable `Dev Ticket Key`, plus any explicit priority, state and real deadline (`due`); no Focus Slot or scheduling Date) and writes its URL into the plan. Create FT tickets only this way. Creation queries the stable key first; if the Task already exists, it restores its canonical URL without changing the Task. Preserve `devTicketKey` when renaming a plan. Do not run concurrent creates for the same plan (Notion has no unique-key constraint).
4. **Implement.** Create a branch, commit the plan on it, and run `node scripts/ticket.mjs start [<plan>]` (Task → Doing and Started At; records the branch and worktree in the plan).
   - Cold start / resume: run `node scripts/ticket.mjs prime` for a compact session context primer, `node scripts/ticket.mjs resume` for handoff state, or `node scripts/ticket.mjs overview` for multi-repo status.
   - Tick each checkbox as soon as it is done. A ticked acceptance criterion ends with concise `verified: <how it was checked and the result>` evidence (one line, no raw terminal dumps); never tick one you have not verified.
   - Never delete a checkbox. Anything you will not do stays unticked and ends with `deferred: <reason>`.
   - Record architectural choices in `docs/decisions/` with `node scripts/ticket.mjs adr "<Title>"`. Progress lives in the plan; do not post progress to Notion.
   - **Before you stop** (end of session, usage limit, handing over), run `node scripts/ticket.mjs handoff --agent <you> --done "<done>" --next "<step>" [--open "<questions>"]` (or `log`) and commit the plan. To continue someone else's work, run `node scripts/ticket.mjs resume`, read the plan fully, and resume at the first unticked step.
5. **Review.** Before closing out, run `node scripts/ticket.mjs pack [<plan>] [--test]` (0 LLM tokens, embeds test results with `--test`) to generate a compact review digest (plan criteria, hygiene check, and filtered diff). Perform a single-pass review checking plan fidelity, regressions, and verification honesty (using the `quick-review` skill or a fresh session/second model when practical), then stamp the result with `node scripts/ticket.mjs review [<plan>] --agent <you> --verdict <pass|warn|block> --summary "<findings>"`. A `block` verdict fails close-out until resolved.
6. **Finish.** You are done only when `node scripts/ticket.mjs check [<plan>]` passes. Open the PR and ship in one command: `node scripts/ticket.mjs pr [--draft]` (or open manually with the template filled in and run `node scripts/ticket.mjs ship [<plan>] --pr <url>`). Merging closes the Task (Done and Completed At); never set it to Done yourself.

If a `ticket.mjs` command fails (for example no `NOTION_TOKEN`), say so and stop at that step. Do not create or update the ticket another way. CI (`Plan check`) blocks a PR whose plan has open items, unverified criteria, a `block` review verdict, removed checkboxes or no ticket, and a `no-plan` PR that is not trivial.
Git pre-push guardrail: run `node scripts/ticket.mjs hook install` to prevent accidental direct pushes to protected branches.

Upstream workflow & multi-repo sync: https://github.com/AaronPG095/AI-Dev-Workflow (`node scripts/sync.mjs --remote` or `scripts/sync-repos.ps1`).

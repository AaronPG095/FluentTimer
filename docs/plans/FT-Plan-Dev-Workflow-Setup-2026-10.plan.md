---
title: Plan - Process: Set up the shared AI development process
ticket: https://app.notion.com/p/FT-Plan-Process-Set-up-the-shared-AI-development-process-4090b9c6786f81ef916feacbf110e4e8
status: in-progress
agent: Codex
branch: chore/dev-workflow
worktree: dev-workflow
---
# FluentTimer: shared AI development process

<!--
Copy to docs/plans/FT-Plan-<Topic>-<YYYY-MM>.plan.md. Follow "Development process" in AGENTS.md.
Frontmatter is maintained by scripts/ticket.mjs: ticket, status (draft -> planned -> in-progress -> shipped), agent, branch, worktree, pr.
Rules the check enforces:
- Every Acceptance criteria and Steps line is a checkbox. Tick it the moment it is done.
- A ticked acceptance criterion ends with "verified: <how it was checked and the result>".
- Never delete a checkbox. An item you will not do stays unticked and ends with "deferred: <reason>".
-->

## Summary

Install FluentOverlay's shared development process in FluentTimer. Use one repo-specific plan, a CLI-managed Notion ticket, and one PR so future non-trivial work has a checked close-out gate. Preserve product code and existing local work.

## Acceptance criteria

- [x] Create isolated setup branch and ignore worktrees and environment files. verified: git branch confirms chore/dev-workflow; git check-ignore matches .worktrees/probe and .env.
- [x] Copy shared CLI, template, skills and workflows without replacing existing files. verified: shared CLI is byte-identical to the pinned source; all seven shared files are installed.
- [x] Configure the repository prefix, existing Task source, Project and source folders. verified: JSON assertions confirm FT, the selected Project and source-folder limits; live Notion ticket creation succeeded.
- [x] Configure workflows for the protected branches. verified: both workflow branch lists match main.
- [x] Keep the two repository-specific workflow skill copies identical. verified: both SKILL.md copies are byte-identical and use this repo name and plan prefix.
- [x] Append the authoritative development process while preserving existing instructions. verified: installed process text exactly matches the adapted source; pre-existing instructions remain above it.
- [x] Make Claude import AGENTS.md without creating GEMINI.md. verified: CLAUDE.md begins with @AGENTS.md; no GEMINI.md was created.
- [x] Align existing ticket guidance with the CLI and preserve historical records. verified: tracked instruction paths were inspected; no conflicting ticket lifecycle rules exist.
- [x] Ensure the no-plan label exists with the documented scope. verified: GitHub label lookup confirmed no-plan exists; no label was added to this non-trivial PR.
- [x] Create the Codex ticket, commit the plan and start the work. verified: create/start succeeded with --agent Codex; the initial plan commit exists and the plan records its ticket, branch and worktree.
- [x] Verify the template rejection, closed-out plan and CI gate. verified: node --check succeeded; unfinished template failed with open items; plan check and ci-check passed.
- [ ] Publish one setup PR, link it with ship and leave merging to Aaron. deferred: publishing and ship run after the closed-out check gate.

## Steps

- [x] Create isolated setup branch and ignore worktrees and environment files.
- [x] Copy shared CLI, template, skills and workflows without replacing existing files.
- [x] Configure the repository prefix, existing Task source, Project and source folders.
- [x] Configure workflows for the protected branches.
- [x] Keep the two repository-specific workflow skill copies identical.
- [x] Append the authoritative development process while preserving existing instructions.
- [x] Make Claude import AGENTS.md without creating GEMINI.md.
- [x] Align existing ticket guidance with the CLI and preserve historical records.
- [x] Ensure the no-plan label exists with the documented scope.
- [x] Create the Codex ticket, commit the plan and start the work.
- [x] Verify the template rejection, closed-out plan and CI gate. verified: node --check succeeded; unfinished template failed with open items; plan check and ci-check passed.
- [ ] Publish one setup PR, link it with ship and leave merging to Aaron. deferred: publishing and ship run after the closed-out check gate.

## Risks

Existing workflow or instruction contracts may conflict. Inspect before writing, preserve existing files, adapt the protected branches and source-folder limits, and verify against the original shared CLI. NOTION_TOKEN stays in the process environment and GitHub Actions secrets; never commit it.

## Out of scope

Product behavior changes, deployment, Notion schema changes, modification of existing unrelated records, and merging this PR. Shared source PR #27 remains open; do not merge it or change FluentOverlay performance work.

## Notes

- Aaron approved the shared setup guide: "Let's set up this process for the various repos that we're working in." Scope confirmation: "Please do it for the portfolio website Fluent Studio Automations. Fluent Studio Company" followed by the named repo list in chat.
- FluentOverlay source: origin/chore/ai-dev-process at 5f763ff2869eb630f800a0cc2dcfed64c8903bbf; PR #27 was observed open.
- Project: https://app.notion.com/p/4090b9c6786f81939114fa3bff3f8ba3. Ticket prefix: FT.
- Existing checkouts are preserved; this PR uses an isolated worktree.
- Setup bootstraps the CLI before creating its own ticket, as the setup guide specifies.
- The final verification and shipping checkboxes may temporarily be deferred only to break the check-before-ship dependency; they will be verified and ticked after the commands succeed.
- Codex Timer App folder is empty. The FluentTimer GitHub repository contains the requested Pomodoro/timer application.


## Progress log

<!-- One line per session, added with: node scripts/ticket.mjs log <plan> --agent <client> --message "<done>; next: <step>; open: <questions>" -->

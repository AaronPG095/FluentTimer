---
name: quick-review
description: Token-lean, single-pass code review against the active plan. Uses `node scripts/ticket.mjs pack` to gather plan criteria, hygiene status, and filtered diff in one command (zero sub-agents), then stamps the verdict with `node scripts/ticket.mjs review`. Use before shipping a plan or when asked for a quick/lean review.
---

# Quick Review (Token-Lean)

Perform a high-signal, low-token code review in a **single pass** without spawning sub-agents or running exploratory git/file discovery loops.

## 1. Gather the Review Packet (1 tool call)

Run:

```powershell
node scripts/ticket.mjs pack
```

*(Pass `--test` to execute the repository's verifyCommand and embed test execution proof directly in the packet. Pass `<plan-path>` only if multiple plans are active on the branch, and `--base <ref>` only if reviewing against a non-default base.)*

Do **not** separately run `git status`, `git diff`, `git log`, or read the plan file unless a specific hunk in `pack` was truncated and must be inspected to confirm a real bug.

## 2. Evaluate Three Axes Only

Check the packet against `AGENTS.md` and the plan:

1. **Plan Fidelity & Scope:**
   - Does the code diff actually implement every ticked acceptance criterion?
   - Is there unrequested scope creep, drive-by refactoring, or accidental file modification?
2. **Correctness & Boundaries:**
   - Are there concrete bugs: unhandled null/error paths, async/thread blocking, broken state transitions, or security/trust boundary regressions?
   - Skip stylistic nitpicks or anything already enforced by formatters/linters.
3. **Verification Honesty:**
   - Does each ticked criterion's `verified:` note reflect a real check of the changed behavior (using the repo's `verifyCommand` where configured)?

## 3. Record Verdict & Report Concisely

Stamp the review into the plan:

```powershell
node scripts/ticket.mjs review --agent <Claude|Codex|Gemini|Other> --verdict <pass|warn|block> --summary "<1-line summary of verdict and any findings>"
```

- `pass`: No blocking issues; ready for `ticket.mjs check` and `ship`.
- `warn`: Non-blocking edge case or follow-up noted; safe to ship if acknowledged.
- `block`: Concrete bug, unverified claim, or missing requirement (`ticket.mjs check` and CI will block until resolved and re-reviewed).

Keep your chat response under **120 words**:
- **Verdict:** `PASS` | `WARN` | `BLOCK`
- **Findings:** Bullet list citing `file:line` and consequence (or `None`).
- **Verification:** Whether plan gates and repo checks passed.

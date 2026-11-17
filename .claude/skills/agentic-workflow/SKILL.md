---
name: agentic-workflow
description: Opt-in modular agentic execution engine on top of AI-Dev-Workflow (Level A self-healing step loop, Level B role-isolated adversarial review, Level C parallel worktree waves). Use when executing plans autonomously, managing multi-agent subtasks, or running worktree waves.
---

# Agentic Workflow Add-On (Levels A, B, and C)

An opt-in, modular execution layer built on top of the deterministic `AI-Dev-Workflow` core. While Layer 1 enforces plan discipline and verification honesty, Layer 2 enables autonomous self-healing loops, role-isolated adversarial reviews, and parallel git-worktree execution.

Keep this file identical in `.agents/skills/agentic-workflow/` and `.claude/skills/agentic-workflow/`.

---

## Architecture Overview

```mermaid
flowchart TD
    Plan["Active Plan (.plan.md)\nState & Checkboxes [1..N]"]

    subgraph LevelA ["Level A: Self-Healing Step Loop"]
        S1["1. Next Step Brief\n(ticket.mjs step)"]
        S2["2. Autonomous Edit Code"]
        S3["3. Verify & Self-Heal\n(Retries <= 3)"]
        S4["4. Checkpoint & Commit\n(ticket.mjs checkpoint --commit)"]
        S1 --> S2 --> S3
        S3 -- "Pass" --> S4
        S3 -- "Fail (<3x)" --> S2
        S3 -- "Fail (3x)" --> CircuitBreaker["STOP: Circuit Breaker\n(ticket.mjs handoff & Ask Aaron)"]
    end

    subgraph LevelB ["Level B: Role-Isolated Reviewer"]
        B1["Builder Finishes All Steps"]
        B2["Fresh Context Sub-Agent\n(ticket.mjs step --role reviewer)"]
        B3["Run Deterministic Pack\n(ticket.mjs pack --test)"]
        B4{"Review Verdict"}
        B1 --> B2 --> B3 --> B4
        B4 -- "pass / warn" --> Shipped["Ready for PR & Ship\n(ticket.mjs check)"]
        B4 -- "block" --> Fixer["Fixer Sub-Agent\n(ticket.mjs step --role fixer)"]
        Fixer --> S2
    end

    subgraph LevelC ["Level C: Worktree Wave Swarm"]
        W1["Spawn Worktrees\n(ticket.mjs wave --spawn)"]
        W2["Parallel Agent Execution\n(One Sub-Agent per Worktree)"]
        W3["Live Swarm Dashboard\n(ticket.mjs wave --status)"]
        W4["Verify & Prune Closed Waves\n(ticket.mjs wave --check / --prune)"]
        W1 --> W2 --> W3 --> W4
    end

    Plan --> LevelA
    S4 -- "All Done" --> LevelB
    Plan --> LevelC
```

---

## Level A: Autonomous Self-Healing Step Loop

Use this when you want an agent to autonomously advance a plan step-by-step with safety guardrails.

1. **Obtain Next Step Brief:**
   ```bash
   node scripts/ticket.mjs step
   # Or for structured JSON:
   node scripts/ticket.mjs step --json
   # Or for a dedicated builder prompt:
   node scripts/ticket.mjs step --role builder
   ```

2. **Implement Step:**
   Make minimal, high-leverage changes scoped strictly to the target step.

3. **Verify & Self-Heal (Max 3 Retries):**
   Run the verification tier specified in the brief (e.g. `npm test` or `node --test scripts/ticket.test.mjs`).
   - If tests fail, analyze the error output and adjust the code.
   - **Circuit Breaker:** If tests fail 3 consecutive times, stop immediately. Record the blocker with:
     ```bash
     node scripts/ticket.mjs handoff --agent <you> --done "<what worked>" --next "<failing step>" --open "<test error details>"
     ```
     Alert the user and wait for guidance. Never loop beyond 3 retries.

4. **Checkpoint & Atomic Git Commit:**
   Once verification passes cleanly, execute:
   ```bash
   node scripts/ticket.mjs checkpoint <#> --commit
   ```
   This deterministically runs the verify command, checks that tests exit with code 0, marks the checkbox `[x]` with verified evidence, and commits the checkpoint to git.

5. **Repeat** until `node scripts/ticket.mjs step` reports all items completed.

### Outer-Loop Autonomous Supervisor (`run`)
To drive an external CLI runner (such as `claude -p`, `codex exec`, or a custom harness script) automatically step-by-step from the terminal or CI:
```bash
node scripts/ticket.mjs run [<plan>] --cmd "<runner>" [--review-cmd "<runner>"] [--commit] [--tier <name>] [--max-retries <N>] [--max-steps <N>] [--no-review] [--dry-run]
```
- Receives each `builder` brief on `stdin` and in `ADW_PROMPT_FILE` (alongside `ADW_PLAN`, `ADW_STEP`, `ADW_ROLE`).
- Runs `checkpoint` automatically after each runner pass, injects any verification failure tail into the next retry brief under `## Last Verification Failure`, trips at `maxRetries`, and runs a fresh `--role reviewer` pass once all items finish.

---

## Level B: Role-Isolated Adversarial Review

Prevent confirmation bias by separating the Builder from the Reviewer.

1. **Spawn Reviewer in a Fresh Context Window:**
   Generate the adversarial review brief:
   ```bash
   node scripts/ticket.mjs step --role reviewer
   ```

2. **Run Zero-Token Review Digest:**
   The Reviewer runs:
   ```bash
   node scripts/ticket.mjs pack --test
   ```
   Inspects:
   - Spec fidelity against plan Acceptance Criteria
   - Test execution proof and regression checks
   - Verification honesty (no unsubstantiated claims)
   - Working-tree hygiene

3. **Stamp Verdict:**
   ```bash
   node scripts/ticket.mjs review --agent <client> --verdict <pass|warn|block> --summary "<concise findings>"
   ```

4. **Handling Block Verdicts (The Fixer Role):**
   If the verdict is `block`, generate a focused fixer brief:
   ```bash
   node scripts/ticket.mjs step --role fixer
   ```
   The Fixer agent receives the exact blocker findings from the Progress log, fixes the code, re-runs tests, and requests re-review.

---

## Level C: Parallel Worktree Waves

Coordinate multi-plan development across isolated git worktrees without context collisions.

1. **Provision Worktree Wave:**
   ```bash
   node scripts/ticket.mjs wave --spawn
   # Or for specific plans:
   node scripts/ticket.mjs wave docs/plans/Plan-A.plan.md docs/plans/Plan-B.plan.md --spawn
   ```
   This creates `.worktrees/<branch>` with `.env` inheritance and prints the exact builder ignition command for each worktree.

2. **Dispatch Autonomous Agents:**
   Assign a sub-agent or chat session to each worktree:
   ```bash
   cd .worktrees/<name>
   node scripts/ticket.mjs step --role builder
   ```

3. **Monitor Live Swarm Progress:**
   From the main repository or any worktree, run:
   ```bash
   node scripts/ticket.mjs wave --status
   ```
   Displays a live table tracking plan name, branch, active worktree, checkbox progress (`N/Total`), review verdict, and close-out readiness.

4. **Check & Prune Wave Worktrees:**
   ```bash
   # Verify plan criteria + hygiene (+ optional verify command) across all active wave worktrees
   node scripts/ticket.mjs wave --check [--test] [--strict]
   # Safely prune clean, unlocked worktrees for closed/merged wave plans
   node scripts/ticket.mjs wave --prune [--dry-run] [--all]
   ```

---

## Safety & Token-Economy Rules

- **Strict Retry Budget:** Never exceed `maxRetries: 3` without human intervention.
- **Verification Before Checkpointing:** Checkpoints only advance when tests pass with exit code 0.
- **Context Isolation:** Keep Builder and Reviewer contexts separate to ensure honest adversarial validation.
- **Zero External Dependencies:** Level A, B, and C run on pure Node.js 22+ built into `ticket.mjs`.

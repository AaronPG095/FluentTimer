#!/usr/bin/env node
// Opt-in runtime hook handler for Claude Code / AI clients (PreToolUse, PostToolUse, Stop).
// Zero external dependencies; Node.js 22+ only.
// Exits 0 to allow, 2 to block with concise stderr feedback.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const WORKFLOW_FILE_SET = new Set([
  'scripts/workflow-manifest.json',
  '.github/workflows/ci.yml',
  'scripts/ticket.mjs',
  'scripts/ticket.test.mjs',
  'scripts/hooks/adw-hook.mjs',
  'scripts/ticket.config.json',
  'scripts/ticket.config.example.json',
  'scripts/sync.mjs',
  'scripts/sync-repos.ps1',
  'scripts/install.ps1',
  'scripts/install.sh',
  'docs/plans/_template.plan.md',
  'docs/dev-workflow/setup-other-repos.md',
  '.agents/skills/quick-review/SKILL.md',
  '.claude/skills/quick-review/SKILL.md',
  '.agents/skills/dev-workflow/SKILL.md',
  '.claude/skills/dev-workflow/SKILL.md',
  '.agents/skills/agentic-workflow/SKILL.md',
  '.claude/skills/agentic-workflow/SKILL.md',
  '.github/pull_request_template.md',
  '.github/workflows/workflow-sync.yml',
  '.github/workflows/plan-check.yml',
  '.github/workflows/ticket-done.yml',
  'AGENTS.md',
  'CLAUDE.md',
]);

function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function readConfig(root) {
  const cfgPath = join(root, 'scripts', 'ticket.config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function gitOut(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function toRelPosix(root, filePath) {
  if (!filePath) return '';
  const abs = resolve(root, String(filePath));
  return relative(root, abs).replace(/\\/g, '/');
}

function isWorkflowPath(relPath) {
  if (!relPath) return false;
  return (
    WORKFLOW_FILE_SET.has(relPath) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(relPath)
  );
}

function listActivePlans(root, plansDir = 'docs/plans') {
  const dir = join(root, plansDir);
  if (!existsSync(dir)) return [];
  const active = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.plan.md') || entry.name.startsWith('_')) {
      continue;
    }
    const full = join(dir, entry.name);
    const body = readFileSync(full, 'utf8');
    if (!/^status:\s*in-progress\s*$/im.test(body)) continue;
    const branchMatch = body.match(/^branch:\s*(.+)\s*$/im);
    active.push({
      rel: `${plansDir.replace(/\\/g, '/')}/${entry.name}`,
      full,
      branch: branchMatch ? branchMatch[1].trim() : '',
      body,
    });
  }
  return active;
}

function extractCheckboxLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[[ xX]\]\s/.test(line));
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readStdinText() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractPayloadFields(payload) {
  const toolName = String(
    payload.tool_name || payload.toolName || payload.tool?.name || '',
  ).trim();
  const input =
    payload.tool_input ||
    payload.toolInput ||
    payload.input ||
    payload.tool?.input ||
    payload;
  const filePath =
    input.file_path ||
    input.filePath ||
    input.path ||
    input.TargetFile ||
    input.target_file ||
    '';
  const command =
    input.command || input.CommandLine || input.cmd || input.command_line || '';
  const edits = Array.isArray(input.edits) ? input.edits : null;
  const oldStr =
    input.old_string ?? input.oldString ?? input.Target ?? input.target ?? null;
  const newStr =
    input.new_string ??
    input.newString ??
    input.Replacement ??
    input.replacement ??
    null;
  const fullContent =
    input.content ?? input.CodeContent ?? input.code_content ?? null;

  return { toolName, input, filePath, command, edits, oldStr, newStr, fullContent };
}

function touchesPlanCheckboxes(root, filePath, { edits, oldStr, newStr, fullContent }) {
  if (edits) {
    for (const ed of edits) {
      const o = ed.old_string ?? ed.oldString ?? '';
      const n = ed.new_string ?? ed.newString ?? '';
      if (o !== n && (extractCheckboxLines(o).length || extractCheckboxLines(n).length)) {
        return true;
      }
    }
  }
  if (oldStr !== null || newStr !== null) {
    const o = String(oldStr ?? '');
    const n = String(newStr ?? '');
    if (o !== n && (extractCheckboxLines(o).length || extractCheckboxLines(n).length)) {
      return true;
    }
  }
  if (fullContent !== null) {
    const abs = resolve(root, String(filePath));
    if (existsSync(abs)) {
      const existingCheckboxes = extractCheckboxLines(readFileSync(abs, 'utf8'));
      const incomingCheckboxes = extractCheckboxLines(fullContent);
      if (!arraysEqual(existingCheckboxes, incomingCheckboxes)) {
        return true;
      }
    }
  }
  return false;
}

function detectsProtectedPush(root, cmd, protectedBranches) {
  const m = String(cmd || '').match(/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+push\b(.*)$/i);
  if (!m) return null;
  if (/GIT_ALLOW_PROTECTED_PUSH=1/.test(cmd)) return null;
  const argsStr = m[1] || '';
  const tokens = argsStr
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'));
  // Tokens after remote (e.g. `origin main` or `origin HEAD:main`)
  for (const tok of tokens.slice(1)) {
    const target = tok.includes(':') ? tok.split(':').pop() : tok;
    const cleanTarget = target.replace(/^refs\/heads\//, '');
    if (protectedBranches.includes(cleanTarget)) {
      return cleanTarget;
    }
  }
  // No explicit branch token: check current branch
  if (tokens.length <= 1) {
    const curBranch = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (protectedBranches.includes(curBranch)) return curBranch;
  }
  return null;
}

function handlePreTool(root, cfg, payload) {
  const { filePath, command, edits, oldStr, newStr, fullContent } =
    extractPayloadFields(payload);

  // 1. Block direct checkbox edits in active .plan.md files
  if (filePath) {
    const rel = toRelPosix(root, filePath);
    if (
      rel.endsWith('.plan.md') &&
      !basename(rel).startsWith('_') &&
      touchesPlanCheckboxes(root, filePath, { edits, oldStr, newStr, fullContent })
    ) {
      console.error(
        `[adw-hook] BLOCKED: Direct edits to plan checkboxes in ${rel} are disallowed. Use \`node scripts/ticket.mjs tick|defer|split\` instead.`,
      );
      return 2;
    }

    // 2. Block workflow file edits when no matching active in-progress plan exists on current branch
    if (isWorkflowPath(rel)) {
      const plansDir = cfg.plansDir || 'docs/plans';
      const curBranch = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const protectedBranches = cfg.protectedBranches || ['main', 'master', 'develop'];
      const active = listActivePlans(root, plansDir).filter(
        (p) => !p.branch || !curBranch || p.branch === curBranch,
      );
      if (!active.length || (curBranch && protectedBranches.includes(curBranch))) {
        console.error(
          `[adw-hook] BLOCKED: Editing workflow file ${rel} requires an active \`in-progress\` plan on the current feature branch. Scaffold, ticket, and start a plan first.`,
        );
        return 2;
      }
    }
  }

  // 3. Block direct git push to protected branches
  if (command) {
    const protectedBranches = cfg.protectedBranches || ['main', 'master', 'develop'];
    const blockedBranch = detectsProtectedPush(root, command, protectedBranches);
    if (blockedBranch) {
      console.error(
        `[adw-hook] BLOCKED: Direct \`git push\` to protected branch "${blockedBranch}" is disallowed by AI-Dev-Workflow.`,
      );
      return 2;
    }
  }

  return 0;
}

function handlePostTool(root, cfg, payload, strict) {
  const enabled =
    Boolean(cfg.hooks?.postToolVerify) ||
    Boolean(payload.runVerify) ||
    process.env.ADW_HOOK_POST_VERIFY === '1';
  if (!enabled) return 0;

  const { filePath } = extractPayloadFields(payload);
  if (!filePath) return 0;

  const verifyCfg = cfg.verify || {};
  const cmd = verifyCfg.fast || verifyCfg.test || cfg.verifyCommand || '';
  if (!cmd) return 0;

  const res = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  if (res.status !== 0) {
    const combined = ((res.stdout || '') + (res.stderr || '')).trim();
    const tail = combined.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    console.error(`[adw-hook] post-tool verify failed (\`${cmd}\`):\n${tail}`);
    return strict || cfg.hooks?.postToolStrict ? 2 : 0;
  }
  return 0;
}

function handleStop(root, cfg) {
  const plansDir = cfg.plansDir || 'docs/plans';
  const curBranch = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const protectedBranches = cfg.protectedBranches || ['main', 'master', 'develop'];
  if (protectedBranches.includes(curBranch)) return 0;

  const active = listActivePlans(root, plansDir);
  if (!active.length) return 0;

  const matching =
    active.find((p) => !p.branch || p.branch === curBranch) || active[0];

  // Check if ticket.mjs check passes
  const checkRes = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'ticket.mjs'), 'check', matching.rel],
    { cwd: root, encoding: 'utf8' },
  );
  if (checkRes.status === 0) return 0;

  // Check dirty files & handoff log state
  const statusShort = gitOut(root, ['status', '--short']);
  const dirtyNonPlan = statusShort
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith('.plan.md'));

  const logMatch = matching.body.match(/## Progress log\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
  const logLines = (logMatch ? logMatch[1] : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--'));
  const lastLog = logLines[logLines.length - 1] || '';
  const hasHandoff = /\(handoff\):/i.test(lastLog);

  if (dirtyNonPlan.length && !hasHandoff) {
    console.error(
      `[adw-hook] BLOCKED: Active plan ${matching.rel} has ${dirtyNonPlan.length} unlogged dirty file(s) and failing \`check\`. Run \`node scripts/ticket.mjs handoff ...\` or close out the plan before stopping.`,
    );
    return 2;
  }
  if (!hasHandoff) {
    console.error(
      `[adw-hook] BLOCKED: Active plan ${matching.rel} is not closed out and has no latest handoff entry. Run \`node scripts/ticket.mjs handoff ...\` or finish closing out.`,
    );
    return 2;
  }
  return 0;
}

const args = process.argv.slice(2);
const mode = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const strict = args.includes('--strict');

if (!['pre-tool', 'post-tool', 'stop'].includes(mode)) {
  console.error('usage: node scripts/hooks/adw-hook.mjs <pre-tool|post-tool|stop> [--strict]');
  process.exit(1);
}

const root = resolveRepoRoot();
const cfg = readConfig(root);
const rawStdin = readStdinText().trim();
let payload = {};
if (rawStdin) {
  try {
    payload = JSON.parse(rawStdin);
  } catch (err) {
    console.error(`[adw-hook] warning: malformed JSON stdin (${err.message})`);
    process.exit(strict ? 2 : 0);
  }
}

let code = 0;
if (mode === 'pre-tool') code = handlePreTool(root, cfg, payload);
else if (mode === 'post-tool') code = handlePostTool(root, cfg, payload, strict);
else if (mode === 'stop') code = handleStop(root, cfg);

process.exit(code);

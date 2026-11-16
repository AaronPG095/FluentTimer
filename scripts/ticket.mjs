#!/usr/bin/env node
// Ticket and review workflow CLI shared by every AI client (Claude, Codex, Gemini/Antigravity, Cursor) and CI.
// The process it enforces is described in AGENTS.md ("Development process").
//
//   node scripts/ticket.mjs create [<plan>] --agent <Claude|Codex|Gemini|Other>   Development Task (To Do, stable key), URL written into the plan
//   node scripts/ticket.mjs start  [<plan>]                                       Task -> Doing, branch + worktree recorded
//   node scripts/ticket.mjs log    [<plan>] --agent <client> --message "<text>"   handoff line in the plan's Progress log
//   node scripts/ticket.mjs pack   [<plan>] [--base <ref>]                        0-token review packet (plan criteria + hygiene + filtered diff)
//   node scripts/ticket.mjs review [<plan>] --agent <client> --verdict <pass|warn|block> --summary "<text>"
//   node scripts/ticket.mjs check  [<plan>]                                       fails while any checkbox is open, a ticked criterion has no
//                                                                                 "verified:" evidence, or review verdict is "block"
//   node scripts/ticket.mjs ship   [<plan>] --pr <url>                            check, link PR on the Task, add a comment
//   node scripts/ticket.mjs done   [<plan>]                                       Task -> Done (normally run by CI on merge)
//   node scripts/ticket.mjs ci-check --base <sha> --head <sha>                    CI: changed plans must pass check and keep every
//                                                                                 checkbox; "no-plan" PRs must stay small
//   node scripts/ticket.mjs ci-done  --head <merge sha> --pr-files <file>         CI: set merged plans' Tasks to Done
//
// Options: --dry-run prints Notion requests instead of sending them and does not modify the plan.
// Tracker: "notion" (default when dataSourceId is set) or "local" (offline/public markdown-only mode).
// Auth: NOTION_TOKEN from the environment, the repository's .env, or the main git checkout's .env when in a worktree.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  lstatSync,
  realpathSync,
  cpSync,
  statSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const config = JSON.parse(
  readFileSync(join(here, 'ticket.config.json'), 'utf8'),
);
const NOTION_VERSION = '2025-09-03';
if (config.tracker !== undefined && !['local', 'notion'].includes(config.tracker))
  fail('tracker must be "local" or "notion" in scripts/ticket.config.json');
if (config.tracker === 'notion' &&
    (typeof config.dataSourceId !== 'string' || !config.dataSourceId.trim()))
  fail('Notion tracker requires dataSourceId in scripts/ticket.config.json');
const isLocal = config.tracker === 'local' || !config.dataSourceId;

// Title format from .cursor/rules/notion-workspaces.mdc: {PROJECT} - {MODE} - {TYPE}: {Title}. The script adds the project prefix.
const MODES = config.titleModes || ['Plan', 'Debug', 'Ask'];
const TITLE = new RegExp(`^(${MODES.join('|')}) - [^:]+: \\S`);
// Optional plan frontmatter -> Task select properties (option names as they exist in the Tasks database).
const OPTIONAL = {
  priority: {
    property: 'Priority',
    values: {
      emergency: '‼️EMERGENCY‼️',
      critical: '🎯 Critical',
      high: '⭐ High',
      medium: '⚡Medium',
      low: '🚫 Low',
    },
  },
  state: {
    property: 'State',
    values: { quick: '💥Quick', easy: '💚Easy', flow: '🌊Flow' },
  },
};
const VERDICTS = ['pass', 'warn', 'block'];
const IMPACTS = ['none', 'patch', 'minor', 'major'];
const VERIFIED_RE = /\sverified(?:\((?:test|cmd|manual|inspect)\))?:\s*\S/i;
const EVIDENCE_TYPES = new Set(['test', 'cmd', 'manual', 'inspect']);
const DEFAULT_APPETITE = {
  S: { maxLines: 150, maxFiles: 5 },
  M: { maxLines: 450, maxFiles: 12 },
  L: { maxLines: 1000, maxFiles: 25 },
};
const DEFAULT_PACK_IGNORE = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'packages.lock.json',
  '*.min.js',
  '*.min.css',
  '*.Designer.cs',
];
const WORKFLOW_FILES = new Set([
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
const today = () =>
  new Date().toLocaleDateString('sv-SE', {
    timeZone: config.timeZone || 'Europe/Berlin',
  });

const [command, ...rest] = process.argv.slice(2);
const opts = { files: [] };
const BOOLEAN_FLAGS = new Set([
  '--dry-run',
  '--test',
  '--branch',
  '--draft',
  '--fleet',
  '--auto',
  '--all',
  '--verify',
  '--force',
  '--create',
  '--start',
  '--strict',
  '--path',
  '--prompt',
  '--no-create',
  '--worktrees',
  '--json',
  '--commit',
  '--status',
  '--spawn',
  '--no-verify',
  '--no-review',
  '--check',
  '--prune',
  '--lessons',
  '--agent-hooks',
  '--write',
]);
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  const isFleetPr = command === 'fleet' && a === '--pr';
  if ((BOOLEAN_FLAGS.has(a) && !(a === '--branch' && command === 'wt' && rest[0] === 'new')) || isFleetPr) {
    const rawKey = a.slice(2);
    const camel = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[rawKey] = true;
    opts[camel] = true;
  } else if (a.startsWith('--')) {
    const rawKey = a.slice(2);
    const camel = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = rest[++i];
    opts[rawKey] = val;
    opts[camel] = val;
  } else {
    opts.files.push(a);
  }
}

function fail(message) {
  console.error(`ticket: ${message}`);
  process.exit(1);
}

function getVerifyTiers(cfg = config) {
  if (
    cfg.verify &&
    typeof cfg.verify === 'object' &&
    !Array.isArray(cfg.verify)
  ) {
    const res = { ...cfg.verify };
    if (!res.test && cfg.verifyCommand) {
      res.test = cfg.verifyCommand;
    }
    return res;
  }
  if (cfg.verifyCommand) {
    return { test: cfg.verifyCommand };
  }
  return {};
}

function resolveVerifyCommand(cfg = config, tier = 'test') {
  const tiers = getVerifyTiers(cfg);
  if (tiers[tier]) return { tier, cmd: tiers[tier] };
  const keys = Object.keys(tiers);
  if (keys.length === 1 && (!tier || tier === 'test')) {
    return { tier: keys[0], cmd: tiers[keys[0]] };
  }
  return null;
}

function artifactPatterns(cfg = config) {
  return new Set([
    '.tmp',
    'test-results',
    'coverage',
    '.worktrees',
    ...(cfg.hygiene?.disallowedPatterns || []),
  ]);
}

function isArtifact(file, patterns) {
  return [...patterns].some((pattern) => pattern.startsWith('*.')
    ? file.endsWith(pattern.slice(1))
    : file === pattern || file.startsWith(`${pattern}/`) || file.split('/').includes(pattern));
}

function checkHygiene(cfg = config, dir = repoRoot) {
  const issues = [];
  const warnings = [];
  const maxKB = cfg.hygiene?.maxFileSizeKB || 1024;
  const patterns = artifactPatterns(cfg);
  let statusRaw = '';
  try {
    statusRaw = worktreeGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {}
  const statusLines = statusRaw.split('\0').filter(Boolean);
  for (let index = 0; index < statusLines.length; index++) {
    const line = statusLines[index];
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (/[RC]/.test(code)) index++;

    // Check conflict markers
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) {
      issues.push(`Unmerged conflict marker in ${file}`);
    }

    // Check disallowed patterns
    if (isArtifact(file, patterns))
      issues.push(`Disallowed temporary or build artifact: ${file}`);

    // Check oversized files
    const fullPath = join(dir, file);
    try {
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > maxKB * 1024) {
          warnings.push(
            `File exceeds size budget (${Math.round(stat.size / 1024)} KB > ${maxKB} KB): ${file}`,
          );
        }
      }
    } catch {}
  }

  // Check broken or prunable worktrees
  try {
    const wtOut = worktreeGit(dir, ['worktree', 'list', '--porcelain']);
    if (/prunable/i.test(wtOut)) {
      warnings.push(
        'Prunable/broken worktree detected. Run `node scripts/ticket.mjs wt prune`.',
      );
    }
  } catch {}

  return {
    clean: issues.length === 0,
    issues,
    warnings,
  };
}

function hasTicket(value) {
  return isLocal
    ? /^(https|local):\/\//.test(value || '')
    : /^https:\/\//.test(value || '');
}

// ---------- plan files ----------

function readPlan(path) {
  const full = resolve(path);
  if (!existsSync(full)) fail(`plan not found: ${path}`);
  return readPlanText(readFileSync(full, 'utf8'), full);
}

function readPlanText(text, path) {
  const full = resolve(repoRoot, path);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = text.replace(/\r\n/g, '\n');
  const m = norm.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m)
    fail(
      `${path}: no frontmatter. Start from ${config.plansDir}/_template.plan.md.`,
    );
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    meta,
    body: norm.slice(m[0].length),
    eol,
    full,
    rel: relative(repoRoot, full).replace(/\\/g, '/'),
  };
}

function writePlan(plan) {
  if (opts.dryRun) return;
  const head = Object.entries(plan.meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const out = `---\n${head}\n---\n${plan.body}`;
  writeFileSync(
    plan.full,
    plan.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out,
  );
}

function section(body, heading) {
  const out = [];
  let on = false;
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) {
      on = line.slice(3).trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (on) out.push(line);
  }
  return out.join('\n').trim();
}

function problems(plan, { requireTicket = true, ignoreReview = false, base, head, dir = repoRoot } = {}) {
  const found = [];
  if (!plan.meta.title || plan.meta.title.startsWith('<'))
    found.push('frontmatter has no title');
  else if (!TITLE.test(plan.meta.title))
    found.push(
      `title must read "<${MODES.join('|')}> - <Type>: <Title>", e.g. "Plan - Feature: Smart Shortcut Suggestions" (got "${plan.meta.title}")`,
    );
  for (const [key, { values }] of Object.entries(OPTIONAL)) {
    const v = (plan.meta[key] || '').toLowerCase();
    if (v && !Object.hasOwn(values, v))
      found.push(
        `${key} must be one of ${Object.keys(values).join(', ')}, or empty (got "${plan.meta[key]}")`,
      );
  }
  if (
    plan.meta.due &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(plan.meta.due) ||
      !Number.isFinite(Date.parse(plan.meta.due)) ||
      new Date(plan.meta.due).toISOString().slice(0, 10) !== plan.meta.due)
  )
    found.push(`due must be YYYY-MM-DD, or empty (got "${plan.meta.due}")`);
  if (
    plan.meta.appetite &&
    !['S', 'M', 'L'].includes(plan.meta.appetite.trim().toUpperCase())
  )
    found.push(`appetite must be S, M, or L, or empty (got "${plan.meta.appetite}")`);
  if (
    plan.meta.impact &&
    !IMPACTS.includes(plan.meta.impact.trim().toLowerCase())
  )
    found.push(
      `impact must be one of ${IMPACTS.join(', ')}, or empty (got "${plan.meta.impact}")`,
    );
  if (config.versioning?.enabled && config.versioning?.requireVersionOnPlans) {
    if (!plan.meta.version || !plan.meta.version.trim()) {
      found.push(
        'version is required in frontmatter when versioning.requireVersionOnPlans is enabled (e.g. "1.2.0" or "none")',
      );
    }
    if (
      !plan.meta.impact ||
      !IMPACTS.includes(plan.meta.impact.trim().toLowerCase())
    ) {
      found.push(
        `impact is required in frontmatter when versioning.requireVersionOnPlans is enabled (${IMPACTS.join(', ')})`,
      );
    }
  }
  if (requireTicket && !hasTicket(plan.meta.ticket))
    found.push(
      `no ${isLocal ? 'ticket' : 'Notion ticket'} URL (run: node scripts/ticket.mjs create ${plan.rel} --agent <client>)`,
    );
  if (!/^\s*- \[[ xX]\]/m.test(section(plan.body, 'Steps')))
    found.push('Steps section has no checkboxes');
  if (!/^\s*- \[[ xX]\]/m.test(section(plan.body, 'Acceptance criteria')))
    found.push('Acceptance criteria section has no checkboxes');
  for (const item of findCheckboxes(plan.body).items) {
    if (!item.isChecked && !/\sdeferred:\s*\S/i.test(item.text))
      found.push(`open item: ${item.text}`);
    if (item.isChecked && item.section.toLowerCase() === 'acceptance criteria' &&
        !VERIFIED_RE.test(item.text))
      found.push(
        `criterion ticked without evidence (append "verified: <how it was checked>"): ${item.text}`,
      );
  }
  if (!ignoreReview) {
    const verdict = (plan.meta.reviewVerdict || '').toLowerCase();
    if (verdict === 'block')
      found.push(
        'review verdict is block (resolve findings and re-run review)',
      );
    else if (config.requireReview && !['pass', 'warn'].includes(verdict)) {
      found.push(
        `no passing review recorded (run: node scripts/ticket.mjs pack ${plan.rel}, then node scripts/ticket.mjs review ${plan.rel} --agent <client> --verdict pass --summary "<findings>")`,
      );
    } else if (['pass', 'warn'].includes(verdict) &&
      (config.requireReview || plan.meta.reviewFingerprint) &&
      plan.meta.reviewFingerprint !== reviewFingerprint(plan, base, head, dir)) {
      found.push('review does not cover this change; run pack and review again');
    }
    if (
      config.requireReview &&
      ['pass', 'warn'].includes(verdict) &&
      plan.meta.agent &&
      plan.meta.reviewedBy &&
      plan.meta.agent.toLowerCase() === plan.meta.reviewedBy.toLowerCase() &&
      !(plan.meta.reviewSelfReason || '').trim()
    ) {
      found.push(
        `self-review blocked (reviewedBy matches agent "${plan.meta.agent}"); run review with a different agent or pass --self-review "<reason>"`,
      );
    }
  }
  return found;
}

function missingCheckboxes(original, candidate) {
  const identity = (item) => JSON.stringify([
    item.section.toLowerCase(),
    item.text.replace(/\s+(?:verified(?:\((?:test|cmd|manual|inspect)\))?|deferred):.*$/i, '').trim(),
  ]);
  const remaining = new Map();
  for (const item of findCheckboxes(candidate).items) {
    const key = identity(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  return findCheckboxes(original).items.filter((item) => {
    const key = identity(item);
    const count = remaining.get(key) || 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
}
const deferredItems = (body) =>
  body
    .split('\n')
    .filter((l) => /^\s*- \[ \]/.test(l) && /deferred:/i.test(l))
    .map((l) => l.trim());

function bodyOf(text) {
  const norm = text.replace(/\r\n/g, '\n');
  const m = norm.match(/^---\n[\s\S]*?\n---\n/);
  return m ? norm.slice(m[0].length) : norm;
}

function git(args, { allowFail = false, trim = true, cwd = repoRoot } = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return trim ? output.trim() : output;
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

// The plan as it was before this branch changed it: at the merge base if it already existed, otherwise its first commit on the branch.
function originalPlan(file, base, head) {
  const mergeBase = git(['merge-base', base, head]);
  try {
    return git(['show', `${mergeBase}:${file}`]);
  } catch {
    /* new on this branch */
  }
  const first = git([
    'log',
    '--diff-filter=A',
    '--format=%H',
    `${mergeBase}..${head}`,
    '--',
    file,
  ])
    .split('\n')
    .filter(Boolean)
    .pop();
  return first ? git(['show', `${first}:${file}`]) : null;
}

function countOpenQuestions(body) {
  const raw = section(body, 'Open questions');
  if (!raw) return 0;
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('<!--') &&
        !l.endsWith('-->') &&
        !/^<[^>]+>$/.test(l) &&
        !/^(?:\(none\)|none\.?)$/i.test(l) &&
        !/^- \[[xX]\]/.test(l),
    )
    .filter((l) => /^- /.test(l) || /\?$/.test(l)).length;
}

function checkAppetite(plan, base, head, dir = repoRoot) {
  const level = (plan.meta.appetite || '').trim().toUpperCase();
  if (!level || !Object.hasOwn(DEFAULT_APPETITE, level)) return null;
  const limits = {
    ...DEFAULT_APPETITE[level],
    ...(config.appetite?.[level] || {}),
  };
  if (!base) {
    return {
      appetite: level,
      files: 0,
      lines: 0,
      maxFiles: limits.maxFiles,
      maxLines: limits.maxLines,
      exceeded: false,
    };
  }
  const numstat = git(
    [
      'diff',
      '--numstat',
      '--no-renames',
      base,
      ...(head ? [head] : []),
      '--',
      '.',
      `:(exclude)${config.plansDir}`,
    ],
    { allowFail: true, cwd: dir },
  );
  let files = 0;
  let lines = 0;
  for (const row of numstat.split('\n').filter(Boolean)) {
    const [added, deleted] = row.split('\t');
    files++;
    if (added !== '-' && deleted !== '-') {
      lines += Number(added) + Number(deleted);
    }
  }
  return {
    appetite: level,
    files,
    lines,
    maxFiles: limits.maxFiles,
    maxLines: limits.maxLines,
    exceeded: files > limits.maxFiles || lines > limits.maxLines,
  };
}

function listFilesRel(rootDir, baseDir = rootDir) {
  if (!existsSync(rootDir)) return [];
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(full, baseDir));
    else out.push(relative(baseDir, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

function runInvariants(cfg = config, dir = repoRoot) {
  const inv = cfg.invariants;
  if (!inv || typeof inv !== 'object') {
    return { total: 0, passed: true, failures: [] };
  }
  let total = 0;
  const failures = [];

  if (Array.isArray(inv.mirrorDirs)) {
    for (const pair of inv.mirrorDirs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      total++;
      const [dirA, dirB] = pair;
      const fullA = join(dir, dirA);
      const fullB = join(dir, dirB);
      const filesA = listFilesRel(fullA);
      const filesB = listFilesRel(fullB);
      const all = new Set([...filesA, ...filesB]);
      for (const rel of all) {
        const pA = join(fullA, rel);
        const pB = join(fullB, rel);
        if (!existsSync(pA)) {
          failures.push(`mirrorDirs (${dirA} <-> ${dirB}): missing in ${dirA}: ${rel}`);
        } else if (!existsSync(pB)) {
          failures.push(`mirrorDirs (${dirA} <-> ${dirB}): missing in ${dirB}: ${rel}`);
        } else {
          const a = readFileSync(pA, 'utf8').replace(/\r\n/g, '\n');
          const b = readFileSync(pB, 'utf8').replace(/\r\n/g, '\n');
          if (a !== b) {
            failures.push(`mirrorDirs (${dirA} <-> ${dirB}): content differs for ${rel}`);
          }
        }
      }
    }
  }

  if (inv.readmeCliSync) {
    total++;
    const readmePath = join(dir, 'README.md');
    if (!existsSync(readmePath)) {
      failures.push('readmeCliSync: README.md is missing');
    } else {
      const readme = readFileSync(readmePath, 'utf8');
      const excluded = new Set([
        'ci-check',
        'ci-done',
        ...(Array.isArray(inv.readmeCliExclude) ? inv.readmeCliExclude : []),
      ]);
      for (const cmd of Object.keys(commands)) {
        if (excluded.has(cmd)) continue;
        if (!new RegExp(`\\b${cmd}\\b`).test(readme)) {
          failures.push(`readmeCliSync: CLI command "${cmd}" is not documented in README.md`);
        }
      }
    }
  }

  if (inv.zeroDependencies) {
    total++;
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const deps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        if (deps.length || devDeps.length) {
          failures.push(
            `zeroDependencies: package.json declares dependencies (${[...deps, ...devDeps].join(', ')})`,
          );
        }
      } catch (err) {
        failures.push(`zeroDependencies: invalid package.json (${err.message})`);
      }
    }
  }

  if (Array.isArray(inv.noSecretsPatterns) && inv.noSecretsPatterns.length) {
    total++;
    const exclude = new Set(Array.isArray(inv.excludePaths) ? inv.excludePaths : []);
    const tracked = git(['ls-files', '-z'], { allowFail: true, cwd: dir })
      .split('\0')
      .filter((f) => f && !exclude.has(f.replace(/\\/g, '/')));
    const regexes = inv.noSecretsPatterns.map((p) => new RegExp(p));
    for (const file of tracked) {
      const full = join(dir, file);
      if (!existsSync(full)) continue;
      let textContent = '';
      try {
        textContent = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = textContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('invariant-ignore')) continue;
        for (const re of regexes) {
          if (re.test(lines[i])) {
            failures.push(`noSecretsPatterns: potential secret in ${file}:${i + 1}`);
            break;
          }
        }
      }
    }
  }

  if (Array.isArray(inv.customChecks)) {
    for (const checkItem of inv.customChecks) {
      if (!checkItem || !checkItem.cmd) continue;
      total++;
      const res = spawnSync(checkItem.cmd, {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (res.status !== 0) {
        failures.push(
          `customCheck "${checkItem.name || checkItem.cmd}" failed (exit ${res.status ?? 1})`,
        );
      }
    }
  }

  return { total, passed: failures.length === 0, failures };
}

function lintPlan(plan) {
  const errors = [];
  const warnings = [];
  const cleanBody = plan.body.replace(/<!--[\s\S]*?-->/g, '');
  const placeholderRe = /<(?:2-3 sentences:[^>]*|Compacted research:[^>]*|Unresolved assumptions[^>]*|Observable outcome|Checkable outcome|Step|Pre-mortem:[^>]*|What could go wrong[^>]*|What this plan deliberately[^>]*)>/i;

  for (const heading of ['Summary', 'Acceptance criteria', 'Steps']) {
    const content = section(cleanBody, heading);
    if (!content) {
      errors.push(`Section "## ${heading}" is empty or missing.`);
    } else if (placeholderRe.test(content)) {
      errors.push(`Section "## ${heading}" still contains template placeholder text.`);
    }
  }
  for (const heading of ['Risks', 'Out of scope']) {
    const content = section(cleanBody, heading);
    if (!content) {
      warnings.push(`Section "## ${heading}" is empty or missing.`);
    } else if (placeholderRe.test(content)) {
      errors.push(`Section "## ${heading}" still contains template placeholder text.`);
    }
  }
  const ctxContent = section(cleanBody, 'Context');
  if (ctxContent && placeholderRe.test(ctxContent)) {
    errors.push('Section "## Context" still contains template placeholder text.');
  }

  const openQ = countOpenQuestions(plan.body);
  if (openQ > 0) {
    errors.push(`Section "## Open questions" has ${openQ} unresolved item(s).`);
  }
  if (
    plan.meta.impact &&
    !IMPACTS.includes(plan.meta.impact.trim().toLowerCase())
  ) {
    errors.push(
      `Frontmatter "impact" must be one of ${IMPACTS.join(', ')} (got "${plan.meta.impact}").`,
    );
  }
  if (config.versioning?.enabled && config.versioning?.requireVersionOnPlans) {
    if (!plan.meta.version || !plan.meta.version.trim()) {
      errors.push(
        'Frontmatter "version" is required when versioning.requireVersionOnPlans is enabled.',
      );
    }
    if (
      !plan.meta.impact ||
      !IMPACTS.includes(plan.meta.impact.trim().toLowerCase())
    ) {
      errors.push(
        `Frontmatter "impact" is required when versioning.requireVersionOnPlans is enabled (${IMPACTS.join(', ')}).`,
      );
    }
  }

  const { items } = findCheckboxes(cleanBody);
  const criteriaItems = items.filter(
    (it) => it.section.toLowerCase() === 'acceptance criteria',
  );
  const stepsText = section(cleanBody, 'Steps');
  const taskVerbRe = /^(?:implement|add|create|update|refactor|write|build|wire|move|delete|remove)\b/i;
  const vagueRe = /\b(?:robust|properly|cleanly|efficiently|seamlessly|all edge cases|appropriately)\b/i;

  const acIds = [];
  for (const item of criteriaItems) {
    const core = item.text
      .replace(/\s+(?:verified(?:\((?:test|cmd|manual|inspect)\))?|deferred):.*$/i, '')
      .trim();
    const idMatch = core.match(/^(AC\d+)\s*:\s*(.*)$/i);
    const id = idMatch ? idMatch[1].toUpperCase() : null;
    if (id) acIds.push(id);
    const bodyText = (idMatch ? idMatch[2] : core).trim();
    if (taskVerbRe.test(bodyText)) {
      warnings.push(
        `Acceptance criterion phrased as task verb instead of observable outcome: "${core.slice(0, 70)}"`,
      );
    }
    if (vagueRe.test(bodyText)) {
      warnings.push(
        `Acceptance criterion uses vague/unbounded wording: "${core.slice(0, 70)}"`,
      );
    }
  }

  const uncoveredAc = acIds.filter(
    (id) => !new RegExp(`\\b${id}\\b`, 'i').test(stepsText),
  );
  for (const id of uncoveredAc) {
    warnings.push(`Acceptance criterion ${id} is not referenced by any step in "## Steps".`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    uncoveredAc,
  };
}

function appendToSection(body, heading, entry) {
  const lines = body.split('\n');
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start === -1)
    return `${body.replace(/\s*$/, '')}\n\n## ${heading}\n\n${entry}\n`;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, entry);
  return lines.join('\n');
}

function pageId(url) {
  const id = (url || '')
    .split(/[?#]/)[0]
    .replace(/-/g, '')
    .match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i);
  if (!id) fail(`cannot read a Notion page id from "${url}"`);
  return id[0];
}

// ---------- Notion API ----------

function readEnvToken(envPath) {
  if (!existsSync(envPath)) return '';
  const m = readFileSync(envPath, 'utf8').match(
    /^\s*NOTION_TOKEN\s*=\s*"?([^"\r\n]+)"?/m,
  );
  return m ? m[1].trim() : '';
}

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  const localToken = readEnvToken(join(repoRoot, '.env'));
  if (localToken) return localToken;
  const commonDir = git(['rev-parse', '--git-common-dir'], { allowFail: true });
  if (commonDir) {
    const mainToken = readEnvToken(resolve(repoRoot, commonDir, '..', '.env'));
    if (mainToken) return mainToken;
  }
  return '';
}

async function notion(method, path, body, { soft = false } = {}) {
  if (opts.dryRun) {
    console.log(
      `[dry-run] ${method} https://api.notion.com/v1/${path}\n${JSON.stringify(body, null, 2)}`,
    );
    return {
      url: 'https://www.notion.so/dry-run-00000000000000000000000000000000',
      id: 'dry-run',
      results: [],
      has_more: false,
    };
  }
  const auth = token();
  if (!auth)
    fail(
      'NOTION_TOKEN is not set (environment, .env, or main checkout .env). Stop here and tell the user; do not create the ticket another way.',
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('retry-after') || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = `Notion ${method} ${path} failed (${res.status}): ${json.message || res.statusText}`;
      if (soft)
        throw Object.assign(new Error(message), {
          status: res.status,
          code: json.code,
        });
      fail(message);
    }
    return json;
  }
}

// Status changes through the API don't press the Doing/Done buttons, so the dates those buttons set are written here.
async function startTicket(url) {
  if (isLocal || /^local:\/\//.test(url || '')) return;
  const id = pageId(url);
  const page = await notion('GET', `pages/${id}`);
  const started = page.properties?.['Started At']?.date?.start;
  return notion('PATCH', `pages/${id}`, {
    properties: {
      Status: { status: { name: 'Doing' } },
      ...(started ? {} : { 'Started At': { date: { start: today() } } }),
    },
  });
}

// Development tickets explicitly start To Do, independently of the general Life OS default.
function ticketKey(plan) {
  if (plan.meta.devTicketKey) return plan.meta.devTicketKey;
  if (!plan.rel.startsWith(`${config.plansDir}/`))
    fail('plan must be inside the configured plansDir');
  return `${config.prefix}:${basename(plan.rel, '.plan.md')}`;
}

async function existingTicket(key) {
  const page = await notion(
    'POST',
    `data_sources/${config.dataSourceId}/query`,
    {
      filter: { property: 'Dev Ticket Key', rich_text: { equals: key } },
      page_size: 2,
    },
  );
  if (!Array.isArray(page.results))
    fail(
      'Notion returned no query results; stop rather than risk creating a duplicate',
    );
  if (page.has_more || page.results.length > 1)
    fail(
      `multiple Tasks have Dev Ticket Key "${key}"; resolve the duplicate before continuing`,
    );
  return page.results?.[0];
}

function recordTicket(plan, page, key, { recovered = false, agent } = {}) {
  if (!hasTicket(page.url || ''))
    fail(
      'Notion returned no canonical ticket URL; stop and inspect the Task before retrying',
    );
  plan.meta.ticket = page.url;
  plan.meta.devTicketKey = key;
  if (!recovered) {
    plan.meta.status = 'planned';
    plan.meta.agent = agent;
  }
  writePlan(plan);
  console.log(
    `Ticket ${recovered ? 'recovered' : 'created (To Do)'}: ${page.url}\nPlan updated: ${plan.rel}`,
  );
}

async function closeTicket(url, date = today()) {
  if (isLocal || /^local:\/\//.test(url || '')) return;
  const path = `pages/${pageId(url)}`;
  const page = await notion('GET', path);
  const status = page.properties?.Status?.status?.name;
  const completed = page.properties?.['Completed At'];
  if (!opts.dryRun && (!status || !completed || !Object.hasOwn(completed, 'date')))
    fail('Notion Task is missing Status or Completed At; cannot safely close it');
  if (status === 'Done' && completed?.date?.start) return;
  await notion('PATCH', path, {
    properties: {
      Status: { status: { name: 'Done' } },
      ...(completed?.date?.start ? {} : { 'Completed At': { date: { start: date } } }),
    },
  });
}
const text = (content) => [{ text: { content: content.slice(0, 1990) } }];

// ---------- plan resolution & diff helpers ----------

function allPlans(root = repoRoot) {
  const dir = join(root, config.plansDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.plan.md') && !entry.name.startsWith('_'))
    .map((entry) => join(dir, entry.name))
    .filter((full) => readFileSync(full, 'utf8').startsWith('---'))
    .map((full) => worktreePlan(full, root));
}

function worktreeGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function registeredWorktrees(dir = repoRoot) {
  return worktreeGit(dir, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0').filter(Boolean).map((record) => {
      const fields = new Map(record.split('\0').map((field) => {
        const space = field.indexOf(' ');
        return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
      }));
      return {
        path: resolve(fields.get('worktree')),
        head: fields.get('HEAD'),
        branch: fields.get('branch')?.replace(/^refs\/heads\//, ''),
        locked: fields.has('locked'),
        bare: fields.has('bare'),
      };
    });
}

function comparablePath(path) {
  const full = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function containsPath(root, path) {
  const parent = comparablePath(root);
  const child = comparablePath(path);
  return child === parent || child.startsWith(`${parent}/`);
}

function assertWorktreePath(root, path) {
  if (!containsPath(root, path)) fail(`path is outside the checkout: ${path}`);
  for (let entry = path; comparablePath(entry) !== comparablePath(root); entry = dirname(entry)) {
    if (lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink())
      fail(`worktree path contains a symbolic link: ${entry}`);
  }
}

function worktreeIsMerged(root, head) {
  const branches = config.protectedBranches || ['main', 'master', 'develop'];
  return branches.flatMap((branch) => [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`])
    .some((ref) => {
      try {
        worktreeGit(root, ['merge-base', '--is-ancestor', head, ref]);
        return true;
      } catch {
        return false;
      }
    });
}

function worktreePlan(full, root) {
  if (!containsPath(join(root, config.plansDir), full))
    fail(`plan is outside ${config.plansDir}: ${full}`);
  assertWorktreePath(root, full);
  const plan = readPlan(full);
  plan.rel = relative(root, full).replace(/\\/g, '/');
  return plan;
}

function planWorktreeBranch(plan) {
  return plan.meta.branch || `feat/${basename(plan.rel, '.plan.md')
    .replace(/^[^/]+-Plan-/, '').toLowerCase()}`;
}

function worktreePlanClosed(plan) {
  if (['done', 'shipped'].includes(plan.meta.status)) return true;
  const { items } = findCheckboxes(plan.body);
  return items.length > 0 && items.every((item) => item.openIndex === null);
}

function worktreeCatalog(entries) {
  const [main, ...linked] = entries;
  const plans = new Map(allPlans(main.path).map((plan) => [plan.rel, { plan, entry: main }]));
  for (const entry of linked) {
    if (!entry.branch || !existsSync(entry.path)) continue;
    for (const plan of allPlans(entry.path)) {
      if (planWorktreeBranch(plan) === entry.branch)
        plans.set(plan.rel, { plan, entry });
    }
  }
  return [...plans.values()];
}

function ensurePlanWorktree(entries, branch, plan, { name, noCreate = false } = {}) {
  const [main] = entries;
  if (main.bare) fail('worktree commands require a non-bare primary checkout');
  if (typeof branch !== 'string' || !branch || branch.startsWith('-'))
    fail('a valid worktree branch is required');
  if (plan && worktreeCatalog(entries).some(({ plan: other }) =>
    other.rel !== plan.rel && !worktreePlanClosed(other) && planWorktreeBranch(other) === branch))
    fail(`multiple active plans claim worktree branch: ${branch}`);
  const existing = entries.find((entry) => entry.branch === branch);
  if (existing) {
    if (!existsSync(existing.path)) fail(`registered worktree is missing: ${existing.path}`);
    if (plan && !existsSync(join(existing.path, plan.rel)))
      fail(`branch ${branch} is already checked out without ${plan.rel}: ${existing.path}`);
    return { path: existing.path, created: false };
  }

  const leaf = name || branch.replace(/^[^/]+\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  if (!/^[a-zA-Z0-9_-]+$/.test(leaf)) fail(`invalid worktree directory name: ${leaf}`);
  const parent = join(main.path, '.worktrees');
  let path = join(parent, leaf);
  if (!name && entries.some((entry) => comparablePath(entry.path) === comparablePath(path))) {
    const suffix = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    path = join(parent, `${leaf}-${suffix}`);
  }
  if (noCreate) fail(`worktree does not exist: ${path}`);
  if (existsSync(path) || entries.some((entry) => comparablePath(entry.path) === comparablePath(path)))
    fail(`worktree path is already occupied: ${path}`);
  assertWorktreePath(main.path, parent);
  if (opts.dryRun) return { path, created: false };
  if (existsSync(parent) && !containsPath(realpathSync(main.path), realpathSync(parent)))
    fail(`worktree directory resolves outside the primary checkout: ${parent}`);
  mkdirSync(parent, { recursive: true });
  const branchExists = Boolean(git(['show-ref', '--verify', `refs/heads/${branch}`], { allowFail: true }));
  try {
    const checkout = branchExists ? branch : worktreeGit(repoRoot, ['rev-parse', 'HEAD']).trim();
    worktreeGit(main.path, ['worktree', 'add', ...(branchExists ? [] : ['-b', branch]), '--', path, checkout]);
  } catch (error) {
    fail(`git worktree add failed: ${error.stderr?.trim() || error.message}`);
  }
  const envPath = join(main.path, '.env');
  const workerEnv = join(path, '.env');
  if (existsSync(envPath) && !lstatSync(workerEnv, { throwIfNoEntry: false }))
    cpSync(envPath, workerEnv, { force: false });
  if (plan) {
    const full = join(path, plan.rel);
    assertWorktreePath(path, full);
    if (existsSync(full) && !containsPath(realpathSync(path), realpathSync(full)))
      fail(`worktree plan resolves outside its checkout: ${full}`);
    const workerPlan = branchExists && existsSync(full)
      ? worktreePlan(full, path)
      : { ...plan, full, meta: { ...plan.meta } };
    workerPlan.meta.worktree = basename(path);
    workerPlan.meta.branch = branch;
    if (['planned', 'draft'].includes(workerPlan.meta.status))
      workerPlan.meta.status = 'in-progress';
    mkdirSync(dirname(full), { recursive: true });
    writePlan(workerPlan);
  }
  return { path, created: true };
}

function localPlanStatus(plan) {
  const status = plan.meta.status;
  const ticket = plan.meta.ticket || '';
  if (!isLocal || !ticket.startsWith('local://') ||
      !['in-progress', 'shipped'].includes(status)) return status;
  const branches = config.protectedBranches || ['main', 'master', 'develop'];
  for (const branch of branches) {
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
      const merged = git(['show', `${ref}:${plan.rel}`], { allowFail: true });
      if (!merged.startsWith('---\n')) continue;
      const committed = readPlanText(merged, plan.rel);
      if (committed.meta.ticket !== ticket) continue;
      const { items } = findCheckboxes(committed.body);
      if (items.length && items.every((item) =>
        item.isChecked || /\sdeferred:\s*\S/i.test(item.text))) return 'done';
    }
  }
  return status;
}

function resolvePlanAndTarget() {
  const planArg = opts.files.find((f) => f.endsWith('.plan.md'));
  const plan = planArg ? readPlan(planArg) : resolveActivePlan();
  const target =
    opts.files.find((f) => !f.endsWith('.plan.md')) || opts.target || '';
  return { plan, target };
}

function resolveActivePlan() {
  const plans = allPlans();
  if (!plans.length)
    fail(
      `usage: node scripts/ticket.mjs ${command} <plan-file> (no plans found in ${config.plansDir})`,
    );
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    allowFail: true,
  });
  const protectedList = [
    ...(config.protectedBranches || ['main', 'master', 'develop']),
    'HEAD',
    '',
  ];
  if (!protectedList.includes(branch)) {
    const byBranch = plans.filter((p) => p.meta.branch === branch);
    if (byBranch.length === 1) return byBranch[0];
    const base = resolveDiffBase();
    if (base) {
      const branchPlans = changedPlans([`${base}..HEAD`]);
      if (branchPlans.length === 1)
        return readPlan(join(repoRoot, branchPlans[0]));
    }
  }
  const inProgress = plans.filter((p) => localPlanStatus(p) === 'in-progress');
  if (inProgress.length === 1) return inProgress[0];
  if (plans.length === 1) return plans[0];
  fail(
    `usage: node scripts/ticket.mjs ${command} <plan-file> (multiple plans present; specify which one)`,
  );
}

function onePlan() {
  if (opts.files.length === 1) return readPlan(opts.files[0]);
  if (opts.files.length === 0) return resolveActivePlan();
  fail(`usage: node scripts/ticket.mjs ${command} <plan-file>`);
}

function changedPlans(args) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=AM', ...args, '--', config.plansDir],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.plan.md') && !basename(f).startsWith('_'))
    .filter(
      (f) =>
        existsSync(join(repoRoot, f)) &&
        readFileSync(join(repoRoot, f), 'utf8').startsWith('---'),
    );
}

function resolveDiffBase(dir = repoRoot) {
  if (opts.base)
    return (
      git(['merge-base', opts.base, 'HEAD'], { allowFail: true, cwd: dir }) || opts.base
    );
  const candidates = (
    config.protectedBranches || ['main', 'master', 'develop']
  ).flatMap((b) => [`origin/${b}`, b]);
  for (const ref of candidates) {
    const mb = git(['merge-base', ref, 'HEAD'], { allowFail: true, cwd: dir });
    if (mb) return mb;
  }
  return (
    git(['rev-parse', 'HEAD~1'], { allowFail: true, cwd: dir }) ||
    git(['rev-parse', 'HEAD'], { allowFail: true, cwd: dir })
  );
}

function reviewFingerprint(plan, base, head, dir = repoRoot) {
  base = base ?? resolveDiffBase(dir);
  if (!base) fail('review needs a Git baseline; commit the plan before reviewing');
  const diff = execFileSync('git', [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
    '--no-color', '--no-renames', base, ...(head ? [head] : []), '--',
    '.', `:(exclude,literal)${plan.rel}`,
  ], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  const scope = ['Summary', 'Acceptance criteria', 'Steps', 'Out of scope']
    .map((heading) => section(plan.body, heading));
  return createHash('sha256').update(JSON.stringify(scope)).update(diff).digest('hex');
}

function isTestFile(filePath, cfg = config) {
  const normPath = filePath.replace(/\\/g, '/');
  if (normPath.startsWith(`${cfg.plansDir || 'docs/plans'}/`)) return false;
  const custom = cfg.hygiene?.testFilePatterns;
  if (Array.isArray(custom) && custom.length) {
    return custom.some((pat) => new RegExp(pat, 'i').test(normPath));
  }
  return /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test\.|\.spec\.|_test\.)/i.test(normPath);
}

function analyzeTestIntegrity(base, head, dir = repoRoot) {
  if (!base) {
    return {
      available: false,
      deletedTestFiles: [],
      addedTestCases: 0,
      removedTestCases: 0,
      addedSkips: [],
      addedAssertions: 0,
      removedAssertions: 0,
      warnings: [],
      suspiciousDrop: false,
    };
  }
  const rangeArgs = head ? [base, head] : [base];
  const deletedTestFiles = git(
    ['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', ...rangeArgs],
    { allowFail: true, cwd: dir },
  )
    .split('\0')
    .filter((f) => f && isTestFile(f));
  const rawDiff = git(
    ['diff', '--unified=0', '--no-renames', ...rangeArgs],
    { allowFail: true, cwd: dir },
  );

  const testDeclRe = /^(?:(?:export\s+)?(?:async\s+)?function\s+test_\w+|(?:it|test|describe)\s*\(|def\s+test_\w+|func\s+Test\w+|\[(?:Fact|Test|Theory)\])/;
  const skipRe = /(?:\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|@pytest\.mark\.skip|\bt\.Skip\s*\(|\[Skip\b)/;
  const assertRe = /\b(?:assert(?:\.\w+)?\s*\(|expect\s*\(|Assert\.\w+|\.should\.)/;

  let addedTestCases = 0;
  let removedTestCases = 0;
  let addedAssertions = 0;
  let removedAssertions = 0;
  const addedSkips = [];

  for (const chunk of rawDiff.replace(/\r\n/g, '\n').split(/(?=^diff --git )/m)) {
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!headerMatch) continue;
    const filePath = headerMatch[2];
    if (!isTestFile(filePath)) continue;

    for (const line of chunk.split('\n')) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
      if (line.startsWith('+')) {
        const body = line.slice(1).trim();
        if (testDeclRe.test(body)) addedTestCases++;
        if (skipRe.test(body)) addedSkips.push(filePath);
        if (assertRe.test(body)) addedAssertions++;
      } else if (line.startsWith('-')) {
        const body = line.slice(1).trim();
        if (testDeclRe.test(body)) removedTestCases++;
        if (assertRe.test(body)) removedAssertions++;
      }
    }
  }

  const warnings = [];
  const netTestDelta = addedTestCases - removedTestCases;
  const netAssertDelta = addedAssertions - removedAssertions;
  if (deletedTestFiles.length > 0) {
    warnings.push(`Deleted test file(s): ${deletedTestFiles.join(', ')}`);
  }
  if (netTestDelta < 0) {
    warnings.push(
      `Net drop in test cases: ${netTestDelta} (+${addedTestCases}/-${removedTestCases})`,
    );
  }
  if (addedSkips.length > 0) {
    warnings.push(
      `Added test skip/only/todo marker(s) in: ${[...new Set(addedSkips)].join(', ')}`,
    );
  }
  if (netAssertDelta < 0 && removedAssertions - addedAssertions >= 2) {
    warnings.push(
      `Net drop in assertions: ${netAssertDelta} (+${addedAssertions}/-${removedAssertions})`,
    );
  }

  return {
    available: true,
    deletedTestFiles,
    addedTestCases,
    removedTestCases,
    addedSkips: [...new Set(addedSkips)],
    addedAssertions,
    removedAssertions,
    warnings,
    suspiciousDrop:
      deletedTestFiles.length > 0 || netTestDelta < 0 || addedSkips.length > 0,
  };
}

function isIgnoredDiffPath(filePath, ignorePatterns) {
  const name = basename(filePath);
  return ignorePatterns.some((pattern) => {
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return filePath === pattern || name === pattern;
  });
}

function formatFilteredDiff(
  rawDiff,
  { maxFileLines, maxLines, ignorePatterns },
) {
  if (!rawDiff.trim()) return '(no code diff against base)';
  const chunks = rawDiff
    .replace(/\r\n/g, '\n')
    .split(/(?=^diff --git )/m)
    .filter(Boolean);
  const out = [];
  let totalLines = 0;
  let skippedFiles = [];

  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const filePath = headerMatch ? headerMatch[2] : 'unknown';
    if (isIgnoredDiffPath(filePath, ignorePatterns)) {
      skippedFiles.push(filePath);
      continue;
    }
    const lines = chunk.trimEnd().split('\n');
    const slice =
      lines.length > maxFileLines
        ? [
            ...lines.slice(0, maxFileLines),
            `... [truncated ${lines.length - maxFileLines} lines in ${filePath}]`,
          ]
        : lines;
    if (totalLines + slice.length > maxLines && out.length > 0) {
      out.push(
        `... [truncated remaining diff after ${totalLines} lines; inspect specific files directly if needed]`,
      );
      break;
    }
    out.push(slice.join('\n'));
    totalLines += slice.length;
  }

  const prefix = skippedFiles.length
    ? `Skipped noisy files: ${skippedFiles.join(', ')}\n\n`
    : '';
  return prefix + (out.join('\n\n') || '(only ignored files changed)');
}

function getKnownRepoDirs() {
  const parentDir = dirname(repoRoot);
  const candidateDirs = [];
  const knownNames = config.knownRepos || [
    'FluentOverlay',
    'Fluent-Studio-Website',
    'FluentTimer',
    'TokenHUD',
    'Fluent-Studio-Atlas',
    'AI-Cortex',
    'AI-Dev-Workflow',
  ];
  for (const name of knownNames) {
    const p = join(parentDir, name);
    if (existsSync(p) && !candidateDirs.includes(p)) candidateDirs.push(p);
  }
  if (!candidateDirs.includes(repoRoot)) candidateDirs.push(repoRoot);
  return candidateDirs;
}

function readRepoConfig(dir) {
  const cfgPath = join(dir, 'scripts', 'ticket.config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function resolveHookPath(dir = repoRoot) {
  let gitDir;
  try {
    gitDir = git(['rev-parse', '--git-path', 'hooks'], { cwd: dir });
  } catch {
    gitDir = join(dir, '.git', 'hooks');
  }
  return resolve(dir, gitDir, 'pre-push');
}

function resolveRepoActivePlan(dir, branch, repoCfg = {}) {
  const plansDir = join(dir, repoCfg.plansDir || 'docs/plans');
  if (!existsSync(plansDir)) return null;
  try {
    const files = readdirSync(plansDir).filter(
      (f) => f.endsWith('.plan.md') && !f.startsWith('_'),
    );
    const plans = files.map((f) => {
      const raw = readFileSync(join(plansDir, f), 'utf8').replace(/\r\n/g, '\n');
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      const meta = match
        ? Object.fromEntries(
            match[1]
              .split('\n')
              .filter((l) => l.includes(':'))
              .map((l) => {
                const idx = l.indexOf(':');
                return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
              }),
          )
        : {};
      return { file: f, meta, raw };
    });
    let activePlan = plans.find((p) => p.meta.branch === branch);
    if (!activePlan && branch !== 'main' && branch !== 'master') {
      activePlan = plans.find((p) => p.meta.status === 'in-progress');
    }
    return activePlan || null;
  } catch {
    return null;
  }
}

function findCheckboxes(body) {
  const lines = body.split('\n');
  const items = [];
  let currentSection = '';
  let openIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      currentSection = line.replace(/^##\s+/, '').trim();
      continue;
    }
    const match = line.match(/^(\s*-\s*\[)([ xX])(\]\s*)(.*)$/);
    if (match) {
      const isChecked = match[2].toLowerCase() === 'x';
      const text = match[4].trim();
      const isDeferred = /deferred:/i.test(text);
      if (!isChecked && !isDeferred) {
        openIndex++;
      }
      items.push({
        lineIndex: i,
        prefix: match[1],
        box: match[2],
        delim: match[3],
        text,
        isChecked,
        isDeferred,
        section: currentSection,
        openIndex: !isChecked && !isDeferred ? openIndex : null,
      });
    }
  }
  return { lines, items };
}

// ---------- commands ----------

function pullRequestBody(plan, verification) {
  const summary = section(plan.body, 'Summary') || 'See plan.';
  const criteria = section(plan.body, 'Acceptance criteria');
  const deferred = deferredItems(plan.body).join('\n') || 'None.';
  const tests = [verification, criteria].filter(Boolean).join('\n\n');
  const templatePath = join(repoRoot, '.github', 'pull_request_template.md');
  if (!existsSync(templatePath)) {
    return [
      '## Summary', summary, '', '## Acceptance criteria', tests, '',
      '## Deferred', deferred, '', `Ticket: ${plan.meta.ticket}`,
    ].join('\n');
  }
  const template = readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  return template
    .replace(/^Plan: .*<file>.*$/m, () => `Plan: ${plan.rel}`)
    .replace(/^Ticket: .*<.*>.*$/m, () => `Ticket: ${plan.meta.ticket}`)
    .replace(/^Ticket:\s*\[Notion Task\]\([^)]*\)$/m, () => `Ticket: ${plan.meta.ticket}`)
    .replace(/^Review: .*<.*>.*$/m, () => `Review: ${plan.meta.reviewVerdict || 'n/a'}`)
    .replace(/<!-- 2-3 sentences: what changes and why -->/g, () => summary)
    .replace(/<!-- Paste the acceptance criteria list[\s\S]*?-->/g, () => tests)
    .replace(/<!-- Explicitly note any unticked acceptance criteria[\s\S]*?-->/g, () => deferred)
    .replace(/^(## What changed)\n\n(?=## |$)/m, (_, heading) => `${heading}\n\n${summary}\n\n`)
    .replace(/^(## How it was tested)\n\n(?=## |$)/m, (_, heading) => `${heading}\n\n${tests}\n\n`)
    .replace(/^<Plan items marked "deferred:"[^\n]*>$/m, () => deferred);
}

function assertPrSnapshot(branch, head) {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch ||
      git(['rev-parse', 'HEAD']) !== head ||
      git(['status', '--porcelain=v1', '--untracked-files=normal'])) {
    fail('pr requires a clean committed snapshot; commit or stash staged, unstaged, and untracked changes before retrying');
  }
}

function prCommand(command, args, failure, input) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail(`${failure}: ${error.stderr?.trim() || error.message}`);
  }
}

function pushPrCommit(branch, head) {
  prCommand('git', ['push', 'origin', `${head}:refs/heads/${branch}`], 'could not push PR commit');
  console.log(`Pushed ${head.slice(0, 10)} to origin/${branch}.`);
}

async function linkPullRequest(plan, prUrl, snapshot) {
  if (plan.meta.pr === prUrl && plan.meta.status === 'shipped') return snapshot?.head;

  const id = !isLocal && /^https:\/\//.test(plan.meta.ticket || '')
    ? pageId(plan.meta.ticket)
    : null;
  if (id) {
    await notion('PATCH', `pages/${id}`, { properties: { URL: { url: prUrl } } });
  }
  if (snapshot) assertPrSnapshot(snapshot.branch, snapshot.head);
  const original = readFileSync(plan.full);
  plan.meta.status = 'shipped';
  plan.meta.pr = prUrl;
  writePlan(plan);
  let linkedHead;
  if (snapshot) {
    const linkedPlan = readFileSync(plan.full);
    try {
      git(['--literal-pathspecs', 'commit', '--only', '-m', `chore: link pr ${prUrl}`, '--', plan.rel]);
    } catch (error) {
      if (git(['rev-parse', 'HEAD']) === snapshot.head && readFileSync(plan.full).equals(linkedPlan)) {
        writeFileSync(plan.full, original);
      }
      fail(`could not commit PR link; retry to reuse ${prUrl}: ${error.message}`);
    }
    linkedHead = git(['rev-parse', 'HEAD']);
    const parent = git(['rev-parse', 'HEAD^']);
    const linkedPaths = git([
      'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', linkedHead,
    ]).split('\0').filter(Boolean);
    if (parent !== snapshot.head || linkedPaths.length !== 1 || linkedPaths[0] !== plan.rel)
      fail('the PR link commit contains unexpected changes; inspect the local commit before pushing');
    assertPrSnapshot(snapshot.branch, linkedHead);
  }

  const deferred = deferredItems(plan.body).join('\n') || 'None';
  console.log(`Copy into the PR's "Deferred" section:\n${deferred}`);
  if (id) {
    try {
      await notion('POST', 'comments', {
        parent: { page_id: id },
        rich_text: text(`Shipped for review: ${prUrl}\nPlan ${plan.rel} is closed out. The Task moves to Done when the PR merges.\nDeferred: ${deferred}`),
      }, { soft: true });
    } catch (error) {
      console.warn(`ticket: could not add a comment (${error.message}).`);
    }
  }
  console.log(`Ticket linked to ${prUrl}`);
  return linkedHead;
}

function resolveStepContext(plan, { tier, maxRetries: maxRetriesOpt } = {}) {
  const branch =
    git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
    'detached';
  const parsed = findCheckboxes(plan.body);
  const items = parsed.items;
  const openCriteria = items.filter(
    (it) =>
      it.openIndex !== null &&
      it.section.toLowerCase() === 'acceptance criteria',
  );
  const openSteps = items.filter(
    (it) => it.openIndex !== null && it.section.toLowerCase() === 'steps',
  );
  const openItems = items.filter((it) => it.openIndex !== null);
  const nextItem = openSteps[0] || openCriteria[0] || openItems[0] || null;

  const cfgAgentic = config.agentic || {};
  const rawMax = maxRetriesOpt ?? opts.maxRetries;
  const maxRetries =
    rawMax !== undefined ? Number(rawMax) : (cfgAgentic.maxRetries ?? 3);
  const currentRetries = parseInt(plan.meta.retryCount || '0', 10) || 0;
  const requestedTier = tier || opts.tier || cfgAgentic.verifyTier || 'test';
  const resolvedVerify = resolveVerifyCommand(config, requestedTier);
  const fallbackVerify = resolvedVerify || resolveVerifyCommand(config, 'test');
  const verifyCmd = fallbackVerify
    ? fallbackVerify.cmd
    : config.verifyCommand || 'npm test';
  const verifyTier = fallbackVerify ? fallbackVerify.tier : 'test';

  return {
    branch,
    lines: parsed.lines,
    items,
    openCriteria,
    openSteps,
    openItems,
    nextItem,
    maxRetries,
    currentRetries,
    requestedTier,
    resolvedVerify,
    verifyCmd,
    verifyTier,
  };
}

function loadLessons(dir = repoRoot) {
  const lessonsPath = join(dir, 'docs', 'lessons.md');
  if (!existsSync(lessonsPath)) return [];
  const raw = readFileSync(lessonsPath, 'utf8');
  const lines = raw.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('- ')) continue;
    const m = trimmed.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*)\|\s*(.+)$/);
    if (m) {
      entries.push({
        date: m[1].trim(),
        meta: m[2].trim(),
        text: m[3].trim(),
        line: i + 1,
        raw: trimmed,
      });
    } else {
      entries.push({
        date: '',
        meta: 'general',
        text: trimmed.slice(2).trim(),
        line: i + 1,
        raw: trimmed,
      });
    }
  }
  return entries;
}

function appendLesson({ text, tags = [], planRel = '', dir = repoRoot }) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) fail('lesson text cannot be empty');
  const tagList = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((t) => t.trim())
    .filter(Boolean);
  const metaParts = [];
  if (tagList.length) metaParts.push(tagList.join(', '));
  if (planRel) metaParts.push(planRel.replace(/\\/g, '/'));
  const metaCol = metaParts.join(' · ') || 'general';
  const entryLine = `- ${today()} | ${metaCol} | ${cleanText}`;

  const lessonsPath = join(dir, 'docs', 'lessons.md');
  mkdirSync(dirname(lessonsPath), { recursive: true });
  if (!existsSync(lessonsPath)) {
    const header = [
      '# Workflow Lessons',
      '',
      '<!-- Captured via `node scripts/ticket.mjs lesson` or `--retro` on `ship`/`pr`. Surfaced by `recall`, `review --prompt`, and `step --role reviewer`. -->',
      '',
    ].join('\n');
    writeFileSync(lessonsPath, `${header}${entryLine}\n`, 'utf8');
  } else {
    const existing = readFileSync(lessonsPath, 'utf8').trimEnd();
    writeFileSync(lessonsPath, `${existing}\n${entryLine}\n`, 'utf8');
  }
  return { path: lessonsPath, line: entryLine };
}

function selectRelevantLessons(plan, { dir = repoRoot, limit = 5 } = {}) {
  const entries = loadLessons(dir);
  if (!entries.length) return [];
  const stopWords = new Set(['with', 'from', 'that', 'this', 'when', 'shall', 'system', 'none', 'plan', 'step']);
  const sourceText = [
    plan?.meta?.title || '',
    section(plan?.body || '', 'Summary'),
    section(plan?.body || '', 'Context'),
    section(plan?.body || '', 'Risks'),
  ]
    .join(' ')
    .toLowerCase();
  const keywords = new Set(
    (sourceText.match(/[a-z0-9_-]{4,}/g) || []).filter((w) => !stopWords.has(w)),
  );

  const scored = entries.map((entry, idx) => {
    const hay = `${entry.meta} ${entry.text}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (hay.includes(kw)) score += 1;
    }
    return { entry, score, idx };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.idx - a.idx;
  });

  return scored.slice(0, limit).map((s) => s.entry);
}

function scanPlansIncludingArchive(dir = repoRoot) {
  const plansRoot = join(dir, config.plansDir || 'docs/plans');
  if (!existsSync(plansRoot)) return [];
  const results = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.plan.md') &&
        !entry.name.startsWith('_')
      ) {
        const raw = readFileSync(full, 'utf8');
        if (!raw.startsWith('---')) continue;
        results.push(worktreePlan(full, dir));
      }
    }
  }
  walk(plansRoot);
  return results;
}

function parsePlanTypeFromMeta(meta) {
  const title = (meta?.title || '').trim();
  const m = title.match(/^(?:Plan|Debug|Ask)\s*-\s*([^:]+):/i);
  if (m) return m[1].trim();
  if (/^Debug\b/i.test(title)) return 'Debug';
  return 'Unknown';
}

function parseIsoDayOrMs(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(ms) ? null : ms;
}

function parseGitCommitLog(dir, days = 90) {
  const args = ['log', '--name-only', '--format=__COMMIT__%H|%cI|%s'];
  if (days > 0) args.push(`--since=${days} days ago`);
  let out = '';
  try {
    out = worktreeGit(dir, args);
  } catch {
    return [];
  }
  const commits = [];
  let cur = null;
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('__COMMIT__')) {
      if (cur) commits.push(cur);
      const rest = line.slice('__COMMIT__'.length);
      const firstSep = rest.indexOf('|');
      const secondSep = rest.indexOf('|', firstSep + 1);
      const hash = firstSep >= 0 ? rest.slice(0, firstSep) : rest;
      const dateStr =
        firstSep >= 0 && secondSep >= 0 ? rest.slice(firstSep + 1, secondSep) : '';
      const subject = secondSep >= 0 ? rest.slice(secondSep + 1) : '';
      cur = {
        hash,
        dateMs: parseIsoDayOrMs(dateStr) || 0,
        subject,
        files: [],
      };
    } else if (line && cur) {
      cur.files.push(line.replace(/\\/g, '/'));
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  if (sortedNums.length === 1) return sortedNums[0];
  if (p === 0.5) {
    const mid = Math.floor(sortedNums.length / 2);
    return sortedNums.length % 2 === 1
      ? sortedNums[mid]
      : Number(((sortedNums[mid - 1] + sortedNums[mid]) / 2).toFixed(2));
  }
  const idx = Math.min(sortedNums.length - 1, Math.ceil(p * sortedNums.length) - 1);
  return sortedNums[idx];
}

function round1(n) {
  return Number(n.toFixed(1));
}

function collectRepoStats(dir = repoRoot, { days = 90, filterDays = false } = {}) {
  const allFoundPlans = scanPlansIncludingArchive(dir);
  const commits = parseGitCommitLog(dir, days);
  const nowMs = Date.now();
  const cutoffMs = days > 0 ? nowMs - days * 86400000 : 0;

  const commitDateByFile = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      const prev = commitDateByFile.get(f);
      if (!prev || c.dateMs > prev) commitDateByFile.set(f, c.dateMs);
    }
  }

  const plans = filterDays && days > 0
    ? allFoundPlans.filter((p) => {
        const d =
          parseIsoDayOrMs(p.meta.completedAt) ||
          parseIsoDayOrMs(p.meta.startedAt) ||
          commitDateByFile.get(p.rel);
        return !d || d >= cutoffMs;
      })
    : allFoundPlans;

  const byStatus = {};
  const byType = {};
  const byVersion = {};
  const cycleTimes = [];
  let reviewsTotal = 0;
  let reviewsPass = 0;
  let reviewsWarn = 0;
  let reviewsBlock = 0;
  let selfReviews = 0;
  let totalItems = 0;
  let checkedItems = 0;
  let deferredItems = 0;
  let totalRetries = 0;
  let circuitBreakers = 0;

  const enrichedPlans = [];

  for (const p of plans) {
    const st = (p.meta.status || 'draft').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;

    const pType = parsePlanTypeFromMeta(p.meta);
    byType[pType] = (byType[pType] || 0) + 1;

    const pVersion = (p.meta.version || '').trim();
    if (pVersion) {
      byVersion[pVersion] = (byVersion[pVersion] || 0) + 1;
    }

    const startMs = parseIsoDayOrMs(p.meta.startedAt);
    const endMs =
      parseIsoDayOrMs(p.meta.completedAt) ||
      (st === 'done' || st === 'shipped' || st === 'merged'
        ? commitDateByFile.get(p.rel) || null
        : null);
    if (startMs && endMs && endMs >= startMs) {
      cycleTimes.push(Number(((endMs - startMs) / 86400000).toFixed(2)));
    }

    const logText = section(p.body, 'Progress log') || '';
    const reviewMatches = [
      ...logText.matchAll(/\(review:\s*(pass|warn|block)[^)]*\)/gi),
    ];
    if (reviewMatches.length) {
      for (const m of reviewMatches) {
        reviewsTotal += 1;
        const v = m[1].toLowerCase();
        if (v === 'pass') reviewsPass += 1;
        else if (v === 'warn') reviewsWarn += 1;
        else if (v === 'block') reviewsBlock += 1;
      }
    } else if (p.meta.reviewVerdict) {
      reviewsTotal += 1;
      const v = p.meta.reviewVerdict.toLowerCase();
      if (v === 'pass') reviewsPass += 1;
      else if (v === 'warn') reviewsWarn += 1;
      else if (v === 'block') reviewsBlock += 1;
    }

    const selfMatches = logText.match(/\[self-review:/gi) || [];
    if (selfMatches.length) {
      selfReviews += selfMatches.length;
    } else if (p.meta.reviewSelfReason) {
      selfReviews += 1;
    }

    const { items } = findCheckboxes(p.body);
    totalItems += items.length;
    for (const it of items) {
      if (it.isChecked) checkedItems += 1;
      else if (/\sdeferred:\s*\S/i.test(it.text)) deferredItems += 1;
    }

    const metaRetries = parseInt(p.meta.retryCount || '0', 10) || 0;
    totalRetries += metaRetries;
    if (st === 'blocked' || /circuit[- ]breaker/i.test(logText)) {
      circuitBreakers += 1;
    }

    // Collect commits and code files associated with this plan for escaped-defect correlation
    const matchingCommitIdxs = [];
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      if (
        c.files.includes(p.rel) ||
        (p.meta.branch && c.subject.includes(p.meta.branch))
      ) {
        matchingCommitIdxs.push(i);
      }
    }
    const touchedCodeFiles = new Set();
    const plansPrefix = `${(config.plansDir || 'docs/plans').replace(/\\/g, '/')}/`;
    if (matchingCommitIdxs.length) {
      const minIdx = Math.min(...matchingCommitIdxs);
      const maxIdx = Math.max(...matchingCommitIdxs);
      // Include direct commits touching the plan and sequential commits between first & last plan commit
      const spanTouchesOtherPlans = commits
        .slice(minIdx, maxIdx + 1)
        .some((c) => c.files.some((f) => f.endsWith('.plan.md') && f !== p.rel));
      const slice = spanTouchesOtherPlans
        ? matchingCommitIdxs.map((idx) => commits[idx])
        : commits.slice(minIdx, maxIdx + 1);
      for (const c of slice) {
        for (const f of c.files) {
          if (!f.startsWith(plansPrefix) && !f.endsWith('.plan.md')) {
            touchedCodeFiles.add(f);
          }
        }
      }
    }

    enrichedPlans.push({
      plan: p,
      type: pType,
      status: st,
      startMs,
      endMs: endMs || commitDateByFile.get(p.rel) || null,
      touchedCodeFiles,
    });
  }

  // AC2: Escaped defect detection (14-day window after Feature/Refactor completion)
  const escapedDefects = [];
  const windowMs = 14 * 86400000;
  const featurePlans = enrichedPlans.filter(
    (ep) =>
      /^(?:feature|refactor)$/i.test(ep.type) &&
      ep.endMs &&
      ep.touchedCodeFiles.size > 0,
  );
  const bugPlans = enrichedPlans.filter((ep) =>
    /^(?:bug|debug)$/i.test(ep.type),
  );
  const revertCommits = commits.filter((c) => /^Revert\b/i.test(c.subject));

  for (const fp of featurePlans) {
    for (const bp of bugPlans) {
      if (bp.plan.rel === fp.plan.rel) continue;
      const bpDate = bp.startMs || bp.endMs;
      if (!bpDate || bpDate < fp.endMs || bpDate - fp.endMs > windowMs) continue;
      const overlap = [...bp.touchedCodeFiles].filter((f) =>
        fp.touchedCodeFiles.has(f),
      );
      if (overlap.length) {
        escapedDefects.push({
          kind: 'bug-plan',
          sourcePlan: fp.plan.rel,
          defectRef: bp.plan.rel,
          subject: bp.plan.meta.title || bp.plan.rel,
          daysAfter: round1((bpDate - fp.endMs) / 86400000),
          overlappingFiles: overlap,
        });
      }
    }
    for (const rc of revertCommits) {
      if (!rc.dateMs || rc.dateMs < fp.endMs || rc.dateMs - fp.endMs > windowMs) {
        continue;
      }
      const overlap = rc.files.filter((f) => fp.touchedCodeFiles.has(f));
      if (overlap.length) {
        escapedDefects.push({
          kind: 'revert',
          sourcePlan: fp.plan.rel,
          defectRef: rc.hash.slice(0, 7),
          subject: rc.subject,
          daysAfter: round1((rc.dateMs - fp.endMs) / 86400000),
          overlappingFiles: overlap,
        });
      }
    }
  }

  cycleTimes.sort((a, b) => a - b);
  return {
    repo: basename(dir),
    dir,
    days,
    totalPlans: plans.length,
    byStatus,
    byType,
    byVersion,
    cycleTimeDays: {
      sampleSize: cycleTimes.length,
      median: percentile(cycleTimes, 0.5),
      p90: percentile(cycleTimes, 0.9),
      samples: cycleTimes,
    },
    reviews: {
      total: reviewsTotal,
      pass: reviewsPass,
      warn: reviewsWarn,
      block: reviewsBlock,
      selfReviews,
      passRate: reviewsTotal ? round1((reviewsPass / reviewsTotal) * 100) : 0,
      warnRate: reviewsTotal ? round1((reviewsWarn / reviewsTotal) * 100) : 0,
      blockRate: reviewsTotal ? round1((reviewsBlock / reviewsTotal) * 100) : 0,
      selfReviewRate: reviewsTotal ? round1((selfReviews / reviewsTotal) * 100) : 0,
    },
    checkboxes: {
      total: totalItems,
      checked: checkedItems,
      deferred: deferredItems,
      deferralRate: totalItems ? round1((deferredItems / totalItems) * 100) : 0,
    },
    retries: {
      totalRetries,
      circuitBreakers,
    },
    lessonsCount: loadLessons(dir).length,
    escapedDefects,
  };
}

function buildStepBrief(
  plan,
  ctx,
  { role = '', failureContext = '' } = {},
) {
  const normalizedRole = role.toLowerCase();
  const {
    branch,
    items,
    openCriteria,
    openSteps,
    nextItem,
    maxRetries,
    currentRetries,
    verifyCmd,
    verifyTier,
  } = ctx;

  if (normalizedRole === 'builder') {
    const criteriaList = openCriteria.length
      ? openCriteria.map((c) => `- [${c.openIndex}] ${c.text}`).join('\n')
      : '(all criteria ticked or none defined)';
    const summary = section(plan.body, 'Summary') || '(none)';

    const completedSteps = items.filter(
      (it) => it.isChecked && it.section.toLowerCase() === 'steps',
    );
    const progressSection = section(plan.body, 'Progress log') || '';
    const progressLines = progressSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.endsWith('-->'));
    const lastLog = progressLines.length
      ? progressLines[progressLines.length - 1]
      : '(none)';

    const brief = [
      `# Autonomous Builder Brief: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Branch: ${plan.meta.branch || branch}`,
      `Target: ${nextItem ? `[${nextItem.openIndex}] ${nextItem.text} (section: ${nextItem.section})` : 'All items completed!'}`,
      '',
      '## Objective & Scope',
      summary,
      '',
      '## Completed Steps & Latest Progress',
      completedSteps.length
        ? completedSteps.map((s) => `- [x] ${s.text}`).join('\n')
        : '- (no steps completed yet)',
      `Latest log: ${lastLog}`,
      '',
      '## Active Criteria to Keep Green',
      criteriaList,
      '',
      '## Execution Protocol',
      '1. Implement the target step cleanly in the codebase.',
      `2. Run verification: \`${verifyCmd}\` (tier: ${verifyTier}).`,
      `3. Retry budget: up to ${maxRetries} self-healing attempts (currently ${currentRetries}/${maxRetries} used). If still failing after ${maxRetries} tries, STOP, log handoff, and escalate.`,
      `4. Checkpoint & tick: node scripts/ticket.mjs checkpoint ${nextItem ? nextItem.openIndex : ''} --commit`,
    ];
    if (failureContext && failureContext.trim()) {
      brief.push('', '## Last Verification Failure', failureContext.trim());
    }
    return brief.join('\n');
  }

  if (normalizedRole === 'reviewer') {
    const criteriaList =
      section(plan.body, 'Acceptance criteria') || '(none)';
    const lessons = selectRelevantLessons(plan, { limit: 5 });
    const lines = [
      `# Adversarial Review Brief: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Branch: ${plan.meta.branch || branch}`,
      '',
      '## Review Protocol (Fresh Context Window)',
      '1. Inspect review packet with embedded test verification:',
      `   node scripts/ticket.mjs pack --test${verifyTier !== 'test' ? ` --tier ${verifyTier}` : ''}`,
      '',
      '## Acceptance Criteria to Verify',
      criteriaList,
    ];
    if (lessons.length) {
      lines.push(
        '',
        '## Recent & Relevant Lessons',
        ...lessons.map((l) => l.raw),
      );
    }
    lines.push(
      '',
      '## Evaluation Rubric',
      '- Spec Fidelity: Does the code fulfill every criterion accurately?',
      '- Verification Honesty: Does every ticked criterion cite verified evidence without fake claims?',
      '- Test Regressions: Did all tests pass cleanly?',
      '- Code Hygiene: No temporary files, conflict markers, or debris.',
      '',
      '## Verdict Command',
      `node scripts/ticket.mjs review ${plan.rel} --agent <you> --verdict <pass|warn|block> --summary "<concise findings>"`,
    );
    return lines.join('\n');
  }

  if (normalizedRole === 'fixer') {
    const progressSection = section(plan.body, 'Progress log') || '';
    const progressLines = progressSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.endsWith('-->'));
    const blockLogs = progressLines.filter((l) => /review:\s*block/i.test(l));
    const latestBlock = blockLogs.length
      ? blockLogs[blockLogs.length - 1]
      : '(no block review verdict found)';

    const criteriaList = openCriteria.length
      ? openCriteria.map((c) => `- [${c.openIndex}] ${c.text}`).join('\n')
      : section(plan.body, 'Acceptance criteria') || '(none)';

    return [
      `# Block-Fixer Brief: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Branch: ${plan.meta.branch || branch}`,
      '',
      '## Blocker Findings to Resolve',
      latestBlock,
      '',
      '## Open Acceptance Criteria',
      criteriaList,
      '',
      '## Fix & Re-Verify Protocol',
      '1. Fix the root cause identified in the blocker findings.',
      `2. Verify: \`${verifyCmd}\` (tier: ${verifyTier}).`,
      '3. Run checkpoint or re-review:',
      `   node scripts/ticket.mjs review ${plan.rel} --agent <you> --verdict pass --summary "Resolved review blocker findings"`,
    ].join('\n');
  }

  if (normalizedRole) {
    fail(`unknown --role "${role}". Allowed roles: builder, reviewer, fixer`);
  }

  const linesOut = [
    `# Next Step Brief: ${plan.meta.title || plan.rel}`,
    `Plan: ${plan.rel} | Branch: ${plan.meta.branch || branch}`,
    `Target [${nextItem.openIndex}]: ${nextItem.text}`,
    `Section: ${nextItem.section}`,
    `Remaining: ${openSteps.length} step(s), ${openCriteria.length} criterion/criteria`,
    `Verify: \`${verifyCmd}\` (${verifyTier})`,
    `Retry Budget: ${maxRetries} attempt(s) before circuit breaker (retries used: ${currentRetries}/${maxRetries})`,
    `Checkpoint: node scripts/ticket.mjs checkpoint ${nextItem.openIndex} --commit`,
  ];
  if (failureContext && failureContext.trim()) {
    linesOut.push('', '## Last Verification Failure', failureContext.trim());
  }
  return linesOut.join('\n');
}

function runVerifyCmd(cmd, { cwd = repoRoot, captureOutput = false, silent = false } = {}) {
  if (!captureOutput) {
    try {
      execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: silent ? 'ignore' : 'inherit',
        env: { ...process.env, CI: '1' },
      });
      return { ok: true, status: 0, output: '' };
    } catch (err) {
      return { ok: false, status: err.status ?? 1, output: '' };
    }
  }
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  if (!silent) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  const combined = ((res.stdout || '') + (res.stderr || '')).trim();
  const output = combined || (res.error ? res.error.message : '');
  const status = res.status ?? (res.error ? 1 : 0);
  return { ok: status === 0 && !res.error, status, output };
}

function runBootBaselineCheck() {
  if (!opts.verify) return null;
  const resolved =
    resolveVerifyCommand(config, config.bootVerifyTier || 'fast') ||
    resolveVerifyCommand(config, 'test') ||
    resolveVerifyCommand(config, 'full');
  if (!resolved) {
    return 'Baseline: SKIPPED (no verify command configured)';
  }
  const res = runVerifyCmd(resolved.cmd, { captureOutput: true, silent: true });
  if (res.ok) {
    return `Baseline: PASS (\`${resolved.cmd}\`, tier: ${resolved.tier})`;
  }
  const tail = (res.output || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join(' | ');
  return `Baseline: FAIL (\`${resolved.cmd}\`, tier: ${resolved.tier})${tail ? ` [${tail}]` : ''} — fix baseline before starting next step`;
}

function tailLines(textValue, count = 15) {
  if (!textValue) return '';
  return textValue
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

function executeCheckpoint(
  plan,
  match,
  {
    resolvedVerify,
    requestedTier = 'test',
    maxRetries = 3,
    commit = false,
    message = '',
    force = false,
    dryRun = false,
    verified = '',
    noVerify = false,
    captureOutput = false,
    exitOnFail = true,
  } = {},
) {
  const abort = (msg, extra = {}) => {
    if (exitOnFail) fail(msg);
    return {
      passed: false,
      circuitBreaker: false,
      retryable: false,
      retries: parseInt(plan.meta.retryCount || '0', 10) || 0,
      maxRetries,
      errorMessage: msg,
      verifyOutput: '',
      nextItem: null,
      ...extra,
    };
  };

  if (!resolvedVerify || noVerify)
    return abort(`checkpoint requires verification for tier "${requestedTier}"`);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1)
    return abort('checkpoint retry limit must be a positive integer');
  if (dryRun && commit)
    return abort('checkpoint --commit cannot be used with --dry-run');

  const previousRetries = parseInt(plan.meta.retryCount || '0', 10) || 0;
  const breakerText = (attempts) =>
    `CIRCUIT BREAKER TRIPPED (${attempts}/${maxRetries} failed verification attempts on \`${resolvedVerify.cmd}\`). Record a handoff before continuing.`;
  if (previousRetries >= maxRetries) {
    return abort(breakerText(previousRetries), {
      circuitBreaker: true,
      retries: previousRetries,
    });
  }

  const { lines } = findCheckboxes(plan.body);
  const originalPlanContents = readFileSync(plan.full);
  const stagedChanges = () => git(['diff', '--cached', '--binary', '--no-ext-diff']);
  const stagedPaths = () =>
    git(['diff', '--cached', '--name-only', '--no-renames', '-z'])
      .split('\0')
      .filter(Boolean);
  const originalIndexDiff = commit ? stagedChanges() : '';
  const checkpointPaths = commit ? [...new Set([...stagedPaths(), plan.rel])] : [];

  if (commit) {
    const unstagedPaths = git(['diff', '--name-only', '--no-renames', '-z'])
      .split('\0')
      .filter(Boolean);
    if (unstagedPaths.some((p) => p !== plan.rel && checkpointPaths.includes(p))) {
      return abort(
        'checkpoint has files with both staged and unstaged edits; stage the intended version first',
      );
    }
  }

  console.log(`• Running checkpoint verification (\`${resolvedVerify.cmd}\`)...`);
  const verifyRes = runVerifyCmd(resolvedVerify.cmd, {
    cwd: repoRoot,
    captureOutput,
  });
  if (!verifyRes.ok) {
    const currentRetries = previousRetries + 1;
    if (!readFileSync(plan.full).equals(originalPlanContents)) {
      return abort(
        'checkpoint verification changed the plan; inspect the change before retrying',
      );
    }
    plan.meta.retryCount = String(currentRetries);
    writePlan(plan);
    if (currentRetries >= maxRetries) {
      return abort(breakerText(currentRetries), {
        circuitBreaker: true,
        retryable: true,
        retries: currentRetries,
        verifyOutput: verifyRes.output,
      });
    }
    return abort(
      `checkpoint verification failed (attempt ${currentRetries}/${maxRetries}: \`${resolvedVerify.cmd}\`).`,
      {
        circuitBreaker: false,
        retryable: true,
        retries: currentRetries,
        verifyOutput: verifyRes.output,
      },
    );
  }

  if (!readFileSync(plan.full).equals(originalPlanContents)) {
    return abort(
      'checkpoint verification changed the plan; inspect the change before retrying',
    );
  }
  delete plan.meta.retryCount;

  if (commit) {
    const unstagedPaths = git(['diff', '--name-only', '--no-renames', '-z'])
      .split('\0')
      .filter(Boolean);
    if (
      stagedChanges() !== originalIndexDiff ||
      unstagedPaths.some((p) => p !== plan.rel && checkpointPaths.includes(p))
    ) {
      return abort(
        'checkpoint changes moved during verification; inspect the index before retrying',
      );
    }
    const hyg = checkHygiene();
    if (!hyg.clean && !force) {
      return abort(
        `checkpoint commit blocked by hygiene issues:\n- ${hyg.issues.join('\n- ')}`,
      );
    }
  }

  const inCriteria = match.section.toLowerCase() === 'acceptance criteria';
  const shortSha = git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) || 'working-tree';
  let verifiedText = verified || '';
  if (inCriteria && !verifiedText && !VERIFIED_RE.test(match.text)) {
    verifiedText = `verify ${resolvedVerify.tier} passed (exit code 0) @${shortSha}`;
  }

  let updatedText = match.text;
  if (verifiedText) {
    if (VERIFIED_RE.test(updatedText)) {
      updatedText = updatedText.replace(
        /verified(?:\((?:test|cmd|manual|inspect)\))?:.*$/i,
        `verified(test): ${verifiedText}`,
      );
    } else {
      updatedText = `${updatedText} verified(test): ${verifiedText}`;
    }
  }

  lines[match.lineIndex] = `${match.prefix}x${match.delim}${updatedText}`;
  plan.body = lines.join('\n');
  writePlan(plan);

  if (commit) {
    const commitMsg =
      message ||
      `feat(checkpoint): complete [${match.openIndex}] - ${match.text.replace(/[:"']/g, '').slice(0, 50)}`;
    try {
      execFileSync(
        'git',
        [
          '--literal-pathspecs',
          'commit',
          '--only',
          '-m',
          commitMsg,
          '--',
          ...checkpointPaths,
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      writeFileSync(plan.full, originalPlanContents);
      return abort(
        `checkpoint commit rejected; plan restored: ${error.stderr?.trim() || error.message}`,
      );
    }
    const commitHash = git(['rev-parse', '--short', 'HEAD']);
    console.log(`✓ Git checkpoint committed: ${commitHash} "${commitMsg}"`);
  }
  console.log(`✓ Ticked [${match.openIndex}]: - [x] ${updatedText}`);

  const afterItems = findCheckboxes(plan.body).items.filter(
    (it) => it.openIndex !== null,
  );
  const nextStep =
    afterItems.find((it) => it.section.toLowerCase() === 'steps') ||
    afterItems[0] ||
    null;
  if (nextStep) {
    console.log(
      `Next open item [${nextStep.openIndex}]: - [ ] ${nextStep.text} (section: ${nextStep.section})`,
    );
  } else {
    console.log(
      `All criteria and steps in ${plan.rel} are now completed! Ready for review.`,
    );
  }

  return {
    passed: true,
    circuitBreaker: false,
    retryable: false,
    retries: 0,
    maxRetries,
    errorMessage: '',
    verifyOutput: verifyRes.output,
    updatedText,
    nextItem: nextStep,
  };
}

function runExternalPrompt(cmd, brief, { planRel, stepId, role, cwd = repoRoot } = {}) {
  const promptDir = mkdtempSync(join(tmpdir(), 'adw-run-'));
  const promptFile = join(promptDir, 'prompt.md');
  writeFileSync(promptFile, brief, 'utf8');
  try {
    const res = spawnSync(cmd, {
      cwd,
      shell: true,
      input: brief,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ADW_PLAN: planRel || '',
        ADW_STEP: String(stepId || ''),
        ADW_ROLE: role || 'builder',
        ADW_PROMPT_FILE: promptFile,
      },
    });
    return {
      status: res.status ?? (res.error ? 1 : 0),
      error: res.error || null,
    };
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
}

function pruneLinkedWorktrees({ dirs, dryRun = false, filter }) {
  let totalPruned = 0;
  let candidates = 0;
  for (const dir of dirs) {
    const [main, ...linked] = registeredWorktrees(dir);
    if (main.bare) continue;
    for (const entry of linked) {
      const path = entry.path;
      if (
        entry.locked ||
        !existsSync(path) ||
        containsPath(path, repoRoot) ||
        containsPath(path, process.cwd()) ||
        !containsPath(join(realpathSync(main.path), '.worktrees'), realpathSync(path))
      ) {
        continue;
      }
      try {
        if (worktreeGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
          continue;
        }
        if (filter && !filter({ main, entry })) continue;
      } catch {
        continue;
      }
      candidates++;
      if (dryRun) {
        console.log(`[dry-run] Would prune worktree in ${basename(main.path)}: ${path}`);
        continue;
      }
      try {
        worktreeGit(main.path, ['worktree', 'remove', '--', path]);
        console.log(`Pruned worktree in ${basename(main.path)}: ${entry.branch || basename(path)}`);
        totalPruned++;
      } catch (error) {
        console.warn(`Could not prune ${path}: ${error.stderr?.trim() || error.message}`);
      }
    }
  }
  if (dryRun) console.log(`[dry-run] ${candidates} worktree(s) eligible.`);
  console.log(`Prune complete: ${totalPruned} worktree(s) pruned.`);
  return { totalPruned, candidates };
}

const commands = {
  async new() {
    const rawTopic = opts.files[0] || opts.topic || '';
    if (!rawTopic)
      fail(
        'usage: node scripts/ticket.mjs new "<Topic>" [--type Feature|Bug|Refactor|Process|Docs] [--priority <p>] [--state <s>] [--due <YYYY-MM-DD>] [--branch]',
      );
    const type = opts.type || 'Feature';
    const topic = rawTopic.replace(/^["']|["']$/g, '').trim();
    const kebabTopic = topic
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const month = today().slice(0, 7);
    const filename = `${config.prefix}-Plan-${kebabTopic}-${month}.plan.md`;
    const relPath = join(config.plansDir, filename).replace(/\\/g, '/');
    const fullPath = join(repoRoot, relPath);

    if (existsSync(fullPath)) fail(`plan already exists: ${relPath}`);

    const priority = opts.priority || '';
    const state = opts.state || '';
    const due = opts.due || '';
    const appetite = (opts.appetite || '').trim().toUpperCase();
    if (appetite && !['S', 'M', 'L'].includes(appetite)) {
      fail(`--appetite must be S, M, or L (got "${opts.appetite}")`);
    }
    const verCfg = config.versioning || {};
    const version =
      opts.version !== undefined
        ? String(opts.version).replace(/^["']|["']$/g, '').trim()
        : verCfg.enabled && verCfg.activeTrain
          ? String(verCfg.activeTrain).trim()
          : '';
    let impact =
      opts.impact !== undefined
        ? String(opts.impact).replace(/^["']|["']$/g, '').trim().toLowerCase()
        : '';
    if (impact && !IMPACTS.includes(impact)) {
      fail(`--impact must be one of ${IMPACTS.join(', ')} (got "${opts.impact}")`);
    }
    if (!impact && version) {
      if (['none', 'internal'].includes(version.toLowerCase())) {
        impact = 'none';
      } else {
        const tLower = type.toLowerCase();
        if (tLower === 'feature') impact = 'minor';
        else if (tLower === 'bug' || tLower === 'debug') impact = 'patch';
        else impact = 'none';
      }
    }

    const summary = (opts.summary || '').replace(/^["']|["']$/g, '').trim();
    const contextText = (opts.context || '').replace(/^["']|["']$/g, '').trim();
    const rawCriteria = (opts.criteria || '')
      .replace(/^["']|["']$/g, '')
      .trim();
    const rawSteps = (opts.steps || '').replace(/^["']|["']$/g, '').trim();

    const criteriaList = rawCriteria
      ? rawCriteria
          .split(/[|,\n]/)
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => `- [ ] ${c}`)
          .join('\n')
      : '- [ ] AC1: <Observable outcome>';

    const isRefactor = type.toLowerCase() === 'refactor';
    const stepsList = rawSteps
      ? rawSteps
          .split(/[|,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => `- [ ] ${s}`)
          .join('\n')
      : isRefactor
        ? '- [ ] Lock existing behaviour with characterization tests before structural changes (AC1)'
        : '- [ ] <Step> (AC1)';

    const templatePath = join(repoRoot, config.plansDir, '_template.plan.md');
    let template = existsSync(templatePath)
      ? readFileSync(templatePath, 'utf8')
      : '';

    let content;
    if (template) {
      content = template
        .replace(/^title:.*$/m, `title: Plan - ${type}: ${topic}`)
        .replace(/^priority:.*$/m, `priority: ${priority}`)
        .replace(/^state:.*$/m, `state: ${state}`)
        .replace(/^due:.*$/m, `due: ${due}`)
        .replace(/^appetite:.*$/m, `appetite: ${appetite}`)
        .replace(/^version:.*$/m, `version: ${version}`)
        .replace(/^impact:.*$/m, `impact: ${impact}`)
        .replace(/^# <Title>.*$/m, `# ${topic}`)
        .replace(/<!--[\s\S]*?-->\n*/m, '');
      if (version && !/^version:/m.test(content)) {
        content = content.replace(/^---\n/, `---\nversion: ${version}\n`);
      }
      if (impact && !/^impact:/m.test(content)) {
        content = content.replace(/^---\n/, `---\nimpact: ${impact}\n`);
      }
      if (summary) {
        content = content.replace(
          /<2-3 sentences: what changes and why\.>/,
          summary,
        );
      }
      if (contextText) {
        content = content.replace(
          /<Compacted research:[^>]*>/,
          contextText,
        );
      }
      if (rawCriteria) {
        content = content.replace(
          /- \[ \] (?:AC1: )?<[^>]+>/,
          criteriaList,
        );
      }
      if (rawSteps || isRefactor) {
        content = content.replace(
          /- \[ \] <Step>(?: \(AC1\))?/,
          stepsList,
        );
      }
    } else {
      content = [
        '---',
        `title: Plan - ${type}: ${topic}`,
        'ticket:',
        'status: draft',
        `priority: ${priority}`,
        `state: ${state}`,
        `due: ${due}`,
        `appetite: ${appetite}`,
        `version: ${version}`,
        `impact: ${impact}`,
        '---',
        `# ${topic}`,
        '',
        '## Summary',
        '',
        summary || '<2-3 sentences: what changes and why.>',
        '',
        '## Context',
        '',
        contextText || '<Compacted research: relevant files with path:line, current behaviour, constraints, and alternatives considered & rejected.>',
        '',
        '## Open questions',
        '',
        '<Unresolved assumptions or `- [ ] Question?` items to resolve before `start`; write `None` when clear.>',
        '',
        '## Acceptance criteria',
        '',
        criteriaList,
        '',
        '## Steps',
        '',
        stepsList,
        '',
        '## Risks',
        '',
        '<Pre-mortem: Assume this shipped and broke in production a week later — what failed, and what test/guardrail mitigates it?>',
        '',
        '## Out of scope',
        '',
        '<What this plan deliberately does not do.>',
        '',
        '## Notes',
        '',
        '<Discoveries and decisions during implementation.>',
        '',
        '## Progress log',
        '',
        '<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->',
      ].join('\n');
    }

    if (opts.create || opts.start) {
      content = content
        .replace(/<Compacted research:[^>]*>/g, 'None noted.')
        .replace(/<Unresolved assumptions[^>]*>/g, 'None')
        .replace(/<Pre-mortem:[^>]*>/g, 'None noted.')
        .replace(/<What this plan deliberately[^>]*>/g, 'None noted.');
    }

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${content.trimEnd()}\n`, 'utf8');
    console.log(`Created plan: ${relPath}`);

    if (opts.branch || opts.start) {
      const agent = (
        opts.agent ||
        process.env.AI_CLIENT ||
        'feat'
      ).toLowerCase();
      const branchName = `${agent}/${kebabTopic.toLowerCase()}`;
      try {
        git(['checkout', '-b', branchName]);
        console.log(`Checked out branch: ${branchName}`);
      } catch (err) {
        console.warn(`Could not checkout branch ${branchName}: ${err.message}`);
      }
    }

    if (opts.create || opts.start) {
      opts.files = [relPath];
      await commands.create();
    }
    if (opts.start) {
      opts.files = [relPath];
      await commands.start();
    }
  },

  async prime() {
    const plan = onePlan();
    const branch =
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
      'detached';
    const statusShort = git(['status', '--short'], { allowFail: true }) || '';
    const clean = !statusShort.trim();

    const progressSection = section(plan.body, 'Progress log') || '';
    const { items } = findCheckboxes(plan.body);
    const openCriteria = items.filter(
      (it) =>
        it.openIndex !== null &&
        it.section.toLowerCase() === 'acceptance criteria',
    );
    const openSteps = items.filter(
      (it) => it.openIndex !== null && it.section.toLowerCase() === 'steps',
    );

    const progressLines = progressSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.endsWith('-->'));
    const lastLog = progressLines.length
      ? progressLines[progressLines.length - 1]
      : '(none)';

    const formatNumberedItem = (it) => `[${it.openIndex}] - [ ] ${it.text}`;

    const openQuestions = countOpenQuestions(plan.body);
    const appetiteLabel = plan.meta.appetite
      ? ` | Appetite: ${plan.meta.appetite.toUpperCase()}`
      : '';
    const versionLabel = plan.meta.version
      ? ` | Version: ${plan.meta.version}${plan.meta.impact ? ` (${plan.meta.impact})` : ''}`
      : '';

    const baselineLine = runBootBaselineCheck();
    const lines = [
      `# Session Context: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Status: ${localPlanStatus(plan) || 'unknown'} | Ticket: ${plan.meta.ticket || 'none'}${appetiteLabel}${versionLabel}`,
      `Branch: ${branch} | Tree: ${clean ? 'clean' : 'dirty'} | Open questions: ${openQuestions}${plan.meta.reviewedBy ? ` | Reviewed: ${plan.meta.reviewedBy} (${plan.meta.reviewVerdict})` : ''}`,
      ...(baselineLine ? [baselineLine] : []),
      ...(() => {
        const tiers = getVerifyTiers();
        const entries = Object.entries(tiers);
        if (entries.length > 1) {
          return [
            `Verify: ${entries.map(([t, c]) => `${t}: \`${c}\``).join(' | ')}`,
          ];
        }
        if (entries.length === 1) {
          return [`Verify: \`${entries[0][1]}\``];
        }
        return [];
      })(),
      '',
      `## Open Acceptance Criteria (${openCriteria.length} remaining)`,
      ...(openCriteria.length
        ? openCriteria.slice(0, 5).map(formatNumberedItem)
        : ['- None (all ticked or none defined)']),
      ...(openCriteria.length > 5
        ? [`  ... and ${openCriteria.length - 5} more`]
        : []),
      '',
      `## Next Steps (${openSteps.length} remaining)`,
      ...(openSteps.length
        ? openSteps.slice(0, 5).map(formatNumberedItem)
        : ['- None (all ticked or none defined)']),
      ...(openSteps.length > 5
        ? [`  ... and ${openSteps.length - 5} more`]
        : []),
      '',
      '## Latest Progress',
      lastLog,
      '',
      'Tip: Run `node scripts/ticket.mjs tick <#>` to complete an item.',
    ];
    console.log(lines.join('\n'));
  },

  async tick() {
    const { plan, target } = resolvePlanAndTarget();
    if (!target) {
      fail(
        'usage: node scripts/ticket.mjs tick [<plan>] <index|substring> [--verified "<evidence>"]',
      );
    }
    const { lines, items } = findCheckboxes(plan.body);
    const openItems = items.filter((it) => it.openIndex !== null);
    if (!openItems.length) {
      fail(`all checkboxes in ${plan.rel} are already completed or deferred.`);
    }

    let match = null;
    const isNum = /^\d+$/.test(target.trim());
    if (isNum) {
      const idx = parseInt(target.trim(), 10);
      match = openItems.find((it) => it.openIndex === idx);
      if (!match) {
        fail(
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${openItems.length})`,
        );
      }
    } else {
      const query = target.toLowerCase();
      match = openItems.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        const alreadyTicked = items.find(
          (it) => it.isChecked && it.text.toLowerCase().includes(query),
        );
        if (alreadyTicked) {
          return console.log(
            `Item is already ticked in ${plan.rel}:\n  ${lines[alreadyTicked.lineIndex].trim()}`,
          );
        }
        fail(`no open checkbox found matching "${target}" in ${plan.rel}`);
      }
    }

    if (opts.red && opts.verifyCmd) {
      fail('cannot combine --red with --verify-cmd');
    }
    if (opts.red) {
      const cmdRes = runVerifyCmd(opts.red, { captureOutput: true, silent: true });
      if (cmdRes.ok) {
        fail(
          `expected failing reproduction (exit != 0) for --red "${opts.red}", but command exited 0`,
        );
      }
      const shortSha =
        git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) ||
        'working-tree';
      const redTag = `red: \`${opts.red}\` exit ${cmdRes.status || 1} @${shortSha}`;
      const stripped = match.text
        .replace(/\s+red:\s*`[^`]*`\s+exit\s+\d+\s+@\S+/i, '')
        .trim();
      const updatedRedText = `${stripped} ${redTag}`;
      lines[match.lineIndex] = `${match.prefix} ${match.delim}${updatedRedText}`;
      plan.body = lines.join('\n');
      writePlan(plan);
      console.log(
        `Red reproduction recorded on [${match.openIndex}]: - [ ] ${updatedRedText}`,
      );
      return;
    }

    const inCriteria = match.section.toLowerCase() === 'acceptance criteria';
    let verifiedText = (opts.verified || opts.v || '').trim();
    const evidenceType = (opts.evidenceType || '').toLowerCase().trim();
    if (evidenceType && !EVIDENCE_TYPES.has(evidenceType)) {
      fail(
        `--evidence-type must be one of: ${[...EVIDENCE_TYPES].join(', ')}`,
      );
    }
    if (opts.verifyCmd) {
      const cmdRes = runVerifyCmd(opts.verifyCmd, { captureOutput: true });
      if (!cmdRes.ok) {
        fail(
          `verify command failed (exit != 0); checkbox [${match.openIndex}] not ticked: ${opts.verifyCmd}`,
        );
      }
      const shortSha =
        git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) ||
        'working-tree';
      const note = verifiedText ? ` (${verifiedText})` : '';
      verifiedText = `\`${opts.verifyCmd}\` exit 0 @${shortSha}${note}`;
    }
    if (inCriteria && !verifiedText && !VERIFIED_RE.test(match.text)) {
      fail(
        `ticking an acceptance criterion requires verified evidence. Pass --verified "<how it was checked and result>" or --verify-cmd "<cmd>".`,
      );
    }

    let updatedText = match.text;
    if (verifiedText) {
      const prefix = opts.verifyCmd
        ? `verified(${evidenceType || 'cmd'})`
        : evidenceType
          ? `verified(${evidenceType})`
          : 'verified';
      if (VERIFIED_RE.test(updatedText)) {
        updatedText = updatedText.replace(
          /verified(?:\((?:test|cmd|manual|inspect)\))?:.*$/i,
          `${prefix}: ${verifiedText}`,
        );
      } else {
        updatedText = `${updatedText} ${prefix}: ${verifiedText}`;
      }
    }

    lines[match.lineIndex] = `${match.prefix}x${match.delim}${updatedText}`;
    plan.body = lines.join('\n');
    writePlan(plan);

    console.log(`Ticked [${match.openIndex}]: - [x] ${updatedText}`);

    const afterItems = findCheckboxes(plan.body).items.filter(
      (it) => it.openIndex !== null,
    );
    if (afterItems.length > 0) {
      const nextStep =
        afterItems.find((it) => it.section.toLowerCase() === 'steps') ||
        afterItems[0];
      console.log(
        `Next open item [${nextStep.openIndex}]: - [ ] ${nextStep.text} (section: ${nextStep.section})`,
      );
    } else {
      console.log('All criteria and steps in the plan are now completed!');
    }
  },

  async defer() {
    const { plan, target } = resolvePlanAndTarget();
    const reason = opts.reason || opts.message || '';
    if (!target || !reason) {
      fail(
        'usage: node scripts/ticket.mjs defer [<plan>] <index|substring> --reason "<why>"',
      );
    }
    const { lines, items } = findCheckboxes(plan.body);
    const openItems = items.filter((it) => it.openIndex !== null);
    if (!openItems.length) {
      fail(`all checkboxes in ${plan.rel} are already completed or deferred.`);
    }

    let match = null;
    const isNum = /^\d+$/.test(target.trim());
    if (isNum) {
      const idx = parseInt(target.trim(), 10);
      match = openItems.find((it) => it.openIndex === idx);
      if (!match) {
        fail(
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${openItems.length})`,
        );
      }
    } else {
      const query = target.toLowerCase();
      match = openItems.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        fail(`no open checkbox found matching "${target}" in ${plan.rel}`);
      }
    }

    const cleanText = match.text.replace(/\s*deferred:.*$/i, '').trim();
    const updatedText = `${cleanText} deferred: ${reason.replace(/\s+/g, ' ').trim()}`;
    lines[match.lineIndex] = `${match.prefix} ${match.delim}${updatedText}`;
    plan.body = lines.join('\n');
    writePlan(plan);

    console.log(`Deferred [${match.openIndex}]: - [ ] ${updatedText}`);
  },

  async step() {
    const planArg = opts.files.find((f) => f.endsWith('.plan.md'));
    const plan = planArg ? readPlan(planArg) : resolveActivePlan();
    const ctx = resolveStepContext(plan);
    const {
      branch,
      openCriteria,
      openSteps,
      nextItem,
      maxRetries,
      currentRetries,
      verifyCmd,
      verifyTier,
    } = ctx;

    if (opts.json) {
      const data = {
        plan: plan.rel,
        title: plan.meta.title || plan.rel,
        branch: plan.meta.branch || branch,
        ticket: plan.meta.ticket || null,
        nextStep: nextItem
          ? {
              index: nextItem.openIndex,
              text: nextItem.text,
              section: nextItem.section,
            }
          : null,
        remainingSteps: openSteps.length,
        remainingCriteria: openCriteria.length,
        openCriteria: openCriteria.map((c) => ({
          index: c.openIndex,
          text: c.text,
        })),
        verify: {
          tier: verifyTier,
          cmd: verifyCmd,
        },
        retryCount: currentRetries,
        maxRetries,
      };
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const role = (opts.role || '').toLowerCase();
    if (!role && !nextItem) {
      console.log(`All criteria and steps in ${plan.rel} are completed!`);
      console.log(
        `Next: run \`node scripts/ticket.mjs pack --test\` or \`node scripts/ticket.mjs step --role reviewer\``,
      );
      return;
    }

    console.log(buildStepBrief(plan, ctx, { role }));
  },

  async checkpoint() {
    const planArg = opts.files.find((f) => f.endsWith('.plan.md'));
    const plan = planArg ? readPlan(planArg) : resolveActivePlan();
    const ctx = resolveStepContext(plan);
    if (!ctx.openItems.length) {
      fail(`all checkboxes in ${plan.rel} are already completed or deferred.`);
    }

    const defaultTargetItem =
      ctx.openSteps[0] || ctx.openCriteria[0] || ctx.openItems[0];
    const rawTarget =
      opts.files.find((f) => !f.endsWith('.plan.md')) ||
      opts.target ||
      (defaultTargetItem ? String(defaultTargetItem.openIndex) : '');

    if (!rawTarget) {
      fail(
        'usage: node scripts/ticket.mjs checkpoint [<plan>] [<index|substring>] [--verified "<evidence>"] [--commit] [--tier <name>]',
      );
    }

    let match = null;
    if (/^\d+$/.test(rawTarget.trim())) {
      const idx = parseInt(rawTarget.trim(), 10);
      match = ctx.openItems.find((it) => it.openIndex === idx);
      if (!match) {
        fail(
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${ctx.openItems.length})`,
        );
      }
    } else {
      const query = rawTarget.toLowerCase();
      match = ctx.openItems.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        fail(`no open checkbox found matching "${rawTarget}" in ${plan.rel}`);
      }
    }

    executeCheckpoint(plan, match, {
      resolvedVerify: ctx.resolvedVerify,
      requestedTier: ctx.requestedTier,
      maxRetries: ctx.maxRetries,
      commit: Boolean(opts.commit),
      message: opts.message || opts.m || '',
      force: Boolean(opts.force),
      dryRun: Boolean(opts.dryRun),
      verified: opts.verified || opts.v || '',
      noVerify: Boolean(opts.noVerify),
      captureOutput: false,
      exitOnFail: true,
    });
  },

  async run() {
    const planArg = opts.files.find((f) => f.endsWith('.plan.md'));
    let plan = planArg ? readPlan(planArg) : resolveActivePlan();
    const runnerCmd = opts.cmd || config.agentic?.runnerCmd || '';
    const reviewCmd = opts.reviewCmd || runnerCmd;
    const maxSteps =
      opts.maxSteps !== undefined ? Number(opts.maxSteps) : 50;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      fail('run --max-steps must be a positive integer');
    }

    const initialCtx = resolveStepContext(plan);
    if (!Number.isSafeInteger(initialCtx.maxRetries) || initialCtx.maxRetries < 1) {
      fail('checkpoint retry limit must be a positive integer');
    }
    if (!initialCtx.resolvedVerify) {
      fail(`run requires verification for tier "${initialCtx.requestedTier}"`);
    }
    if (!runnerCmd && !opts.dryRun) {
      fail(
        'run requires --cmd "<runner>" or agentic.runnerCmd in scripts/ticket.config.json',
      );
    }

    if (opts.dryRun) {
      console.log(`=== Dry-Run Agentic Supervisor ===`);
      console.log(`Plan:        ${plan.rel}`);
      console.log(`Runner:      ${runnerCmd || '(none — pass --cmd)'}`);
      console.log(`Verify:      ${initialCtx.verifyCmd} (${initialCtx.verifyTier})`);
      console.log(`Retries:     ${initialCtx.currentRetries}/${initialCtx.maxRetries}`);
      console.log(`Max steps:   ${maxSteps}`);
      console.log(`Review pass: ${opts.noReview ? 'disabled' : (reviewCmd ? 'enabled' : 'skipped (no runner)')}`);
      if (initialCtx.nextItem) {
        console.log(`Next target: [${initialCtx.nextItem.openIndex}] ${initialCtx.nextItem.text}`);
        console.log('\n--- Prompt Preview ---');
        console.log(buildStepBrief(plan, initialCtx, { role: 'builder' }));
      } else {
        console.log('All steps and criteria are already completed.');
      }
      return;
    }

    let failureContext = '';
    let completed = 0;
    for (let iter = 1; iter <= maxSteps; iter++) {
      plan = readPlan(plan.full);
      const ctx = resolveStepContext(plan);
      if (!ctx.nextItem) break;
      if (ctx.currentRetries >= ctx.maxRetries) {
        fail(
          `CIRCUIT BREAKER TRIPPED (${ctx.currentRetries}/${ctx.maxRetries} failed verification attempts on \`${ctx.resolvedVerify.cmd}\`). Record a handoff before continuing.`,
        );
      }

      const target = ctx.nextItem;
      console.log(
        `\n=== Supervisor Step ${iter} (target [${target.openIndex}]: ${target.text}) ===`,
      );
      const brief = buildStepBrief(plan, ctx, {
        role: 'builder',
        failureContext,
      });
      const execRes = runExternalPrompt(runnerCmd, brief, {
        planRel: plan.rel,
        stepId: target.openIndex,
        role: 'builder',
      });
      if (execRes.error) {
        fail(`runner failed to execute: ${execRes.error.message}`);
      }
      if (execRes.status !== 0) {
        const nextRetry = ctx.currentRetries + 1;
        plan = readPlan(plan.full);
        plan.meta.retryCount = String(nextRetry);
        writePlan(plan);
        if (nextRetry >= ctx.maxRetries) {
          fail(
            `CIRCUIT BREAKER TRIPPED (${nextRetry}/${ctx.maxRetries} failed attempts; runner exited ${execRes.status}). Record a handoff before continuing.`,
          );
        }
        failureContext = `Runner command exited with code ${execRes.status}.`;
        continue;
      }

      // Re-read plan in case runner itself updated or checkpointed checkboxes on disk.
      const planAfter = readPlan(plan.full);
      const postItems = findCheckboxes(planAfter.body).items;
      const stripEvidence = (s) =>
        s.replace(/\s+(?:verified|deferred):.*$/i, '').trim();
      const targetCore = stripEvidence(target.text);
      const sameLine = postItems.find(
        (it) =>
          it.lineIndex === target.lineIndex &&
          it.section.toLowerCase() === target.section.toLowerCase(),
      );
      const sameText = postItems.find(
        (it) =>
          it.section.toLowerCase() === target.section.toLowerCase() &&
          stripEvidence(it.text) === targetCore,
      );
      const resolvedItem = sameLine || sameText;

      if (resolvedItem && resolvedItem.isChecked) {
        const verifyRes = runVerifyCmd(ctx.resolvedVerify.cmd, {
          cwd: repoRoot,
          captureOutput: true,
        });
        if (!verifyRes.ok) {
          const nextRetry =
            (parseInt(planAfter.meta.retryCount || '0', 10) || 0) + 1;
          planAfter.meta.retryCount = String(nextRetry);
          writePlan(planAfter);
          if (nextRetry >= ctx.maxRetries) {
            fail(
              `CIRCUIT BREAKER TRIPPED (${nextRetry}/${ctx.maxRetries} failed verification attempts on \`${ctx.resolvedVerify.cmd}\`). Record a handoff before continuing.`,
            );
          }
          failureContext = tailLines(verifyRes.output, 15);
          continue;
        }
        let planModified = false;
        if (
          resolvedItem.section.toLowerCase() === 'acceptance criteria' &&
          !/\sverified:\s*\S/i.test(resolvedItem.text)
        ) {
          const parsedLines = planAfter.body.split('\n');
          parsedLines[resolvedItem.lineIndex] =
            `${resolvedItem.prefix}x${resolvedItem.delim}${resolvedItem.text} verified: verify ${ctx.resolvedVerify.tier} passed (exit code 0)`;
          planAfter.body = parsedLines.join('\n');
          planModified = true;
        }
        if (planAfter.meta.retryCount) {
          delete planAfter.meta.retryCount;
          planModified = true;
        }
        if (planModified) writePlan(planAfter);
        failureContext = '';
        completed++;
        continue;
      }

      const freshCtx = resolveStepContext(planAfter);
      const freshMatch =
        (resolvedItem && resolvedItem.openIndex !== null ? resolvedItem : null) ||
        freshCtx.openItems.find((it) => stripEvidence(it.text) === targetCore) ||
        freshCtx.nextItem;
      if (!freshMatch) break;

      const chk = executeCheckpoint(planAfter, freshMatch, {
        resolvedVerify: freshCtx.resolvedVerify,
        requestedTier: freshCtx.requestedTier,
        maxRetries: freshCtx.maxRetries,
        commit: Boolean(opts.commit),
        message: opts.message || opts.m || '',
        force: Boolean(opts.force),
        captureOutput: true,
        exitOnFail: false,
      });
      if (!chk.passed) {
        if (!chk.retryable || chk.circuitBreaker) {
          fail(chk.errorMessage);
        }
        failureContext = tailLines(chk.verifyOutput, 15) || chk.errorMessage;
        continue;
      }
      failureContext = '';
      completed++;
    }

    plan = readPlan(plan.full);
    const finalCtx = resolveStepContext(plan);
    if (finalCtx.nextItem) {
      fail(
        `run reached max-steps limit (${maxSteps}) with remaining open items in ${plan.rel}`,
      );
    }

    if (!opts.noReview && reviewCmd) {
      const verdict = (plan.meta.reviewVerdict || '').toLowerCase();
      if (verdict !== 'pass') {
        console.log(`\n=== Supervisor Reviewer Pass (${plan.rel}) ===`);
        const reviewBrief = buildStepBrief(plan, finalCtx, {
          role: 'reviewer',
        });
        const revRes = runExternalPrompt(reviewCmd, reviewBrief, {
          planRel: plan.rel,
          stepId: 'review',
          role: 'reviewer',
        });
        if (revRes.error) {
          fail(`reviewer runner failed to execute: ${revRes.error.message}`);
        }
        if (revRes.status !== 0) {
          fail(`reviewer runner exited with code ${revRes.status}`);
        }
        plan = readPlan(plan.full);
        if ((plan.meta.reviewVerdict || '').toLowerCase() === 'block') {
          fail(
            `review returned verdict "block" on ${plan.rel}. Run 'node scripts/ticket.mjs step --role fixer' to resolve.`,
          );
        }
      }
    }

    console.log(
      `\nRun complete: ${plan.rel} finished (${completed} step attempt(s) succeeded).`,
    );
  },

  async create() {
    const plan = onePlan();
    if (hasTicket(plan.meta.ticket))
      fail(`${plan.rel} already has a ticket: ${plan.meta.ticket}`);
    const pre = problems(plan, {
      requireTicket: false,
      ignoreReview: true,
    }).filter((p) => !p.startsWith('open item'));
    if (pre.length) fail(`fix the plan first:\n- ${pre.join('\n- ')}`);
    const lintRes = lintPlan(plan);
    for (const w of lintRes.warnings) console.warn(`lint warning: ${w}`);
    if (!lintRes.ok) fail(`plan lint failed:\n- ${lintRes.errors.join('\n- ')}`);
    const agent = opts.agent || process.env.AI_CLIENT || '';
    if (!config.captureSources.includes(agent))
      fail(`--agent must be one of: ${config.captureSources.join(', ')}`);
    if (opts.status && opts.status !== 'To Do')
      fail(
        'development tickets start To Do; use start after creation to begin work',
      );
    const key = ticketKey(plan);
    if (isLocal) {
      return recordTicket(plan, { url: `local://${key}` }, key, { agent });
    }
    const description = [
      section(plan.body, 'Summary'),
      `Acceptance criteria:\n${section(plan.body, 'Acceptance criteria')}`,
      `Plan: ${plan.rel}`,
    ].join('\n\n');
    const existing = await existingTicket(key);
    if (existing) return recordTicket(plan, existing, key, { recovered: true });
    const parent = {
      type: 'data_source_id',
      data_source_id: config.dataSourceId,
    };
    const properties = {
      Name: { title: text(`${config.prefix} - ${plan.meta.title}`) },
      Status: { status: { name: 'To Do' } },
      'Task Lane': { select: { name: 'Development' } },
      'Dev Ticket Key': { rich_text: text(key) },
      Project: { relation: [{ id: config.projectPageId }] },
      Tag: { select: { name: config.tag } },
      Description: { rich_text: text(description) },
      'Capture Source': { select: { name: agent } },
      'Capture State': { select: { name: 'Pending' } },
    };
    for (const [key, { property, values }] of Object.entries(OPTIONAL)) {
      const v = (plan.meta[key] || '').toLowerCase();
      if (v) properties[property] = { select: { name: values[v] } };
    }
    if (plan.meta.due)
      properties['Due Date'] = { date: { start: plan.meta.due } };
    const targetVersion = (plan.meta.version || '').trim();
    const shouldStampVersion =
      Boolean(targetVersion) &&
      !['none', 'internal'].includes(targetVersion.toLowerCase());
    if (shouldStampVersion) {
      properties['Target Version'] = { rich_text: text(targetVersion) };
    }
    const postTaskPage = async (props) => {
      try {
        return await notion(
          'POST',
          'pages',
          { parent, properties: props },
          { soft: true },
        );
      } catch (e) {
        if (
          props['Target Version'] &&
          e.status === 400 &&
          e.code === 'validation_error' &&
          /Target Version/i.test(e.message)
        ) {
          console.warn(
            `ticket: creating the Task with Target Version failed (${e.message}); retrying without it.`,
          );
          const { 'Target Version': _omit, ...restProps } = props;
          return notion(
            'POST',
            'pages',
            { parent, properties: restProps },
            { soft: Boolean(props['Life Area']) },
          );
        }
        throw e;
      }
    };
    let page;
    if (config.lifeAreaPageId) {
      try {
        page = await postTaskPage({
          ...properties,
          'Life Area': { relation: [{ id: config.lifeAreaPageId }] },
        });
      } catch (e) {
        if (!(
          (e.status === 400 &&
            e.code === 'validation_error' &&
            /Life Area/i.test(e.message)) ||
          (e.status === 404 && e.code === 'object_not_found')
        ))
          throw e;
        console.warn(
          `ticket: creating the Task with Life Area failed (${e.message}); retrying without it. To fix, share the Life Areas database with the Notion connection.`,
        );
      }
    }
    if (!page) page = await postTaskPage(properties);
    recordTicket(plan, page, key, { agent });
  },

  async start() {
    let plan = onePlan();
    if (!hasTicket(plan.meta.ticket)) {
      if (opts.create) {
        await commands.create();
        plan = readPlan(plan.full);
      } else {
        fail(
          `${plan.rel} has no ticket yet; run create first, or pass --create.`,
        );
      }
    }
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (
      [
        ...(config.protectedBranches || ['main', 'master', 'develop']),
        'HEAD',
      ].includes(branch)
    )
      fail(`you are on "${branch}". Create a branch for this plan first.`);
    const openQuestions = countOpenQuestions(plan.body);
    if (openQuestions > 0) {
      const msg = `${plan.rel} has ${openQuestions} unresolved item(s) under "## Open questions". Resolve assumptions before implementing.`;
      if (opts.strict) fail(msg);
      console.warn(`Warning: ${msg}`);
    }
    await startTicket(plan.meta.ticket);
    plan.meta.status = 'in-progress';
    plan.meta.branch = branch;
    plan.meta.worktree = basename(git(['rev-parse', '--show-toplevel']));
    if (isLocal && !plan.meta.startedAt) plan.meta.startedAt = today();
    writePlan(plan);
    console.log(
      `Ticket set to Doing: ${plan.meta.ticket}\nBranch ${branch} recorded in ${plan.rel}`,
    );
  },

  async log() {
    const plan = onePlan();
    if (!opts.message)
      fail(
        'usage: node scripts/ticket.mjs log [<plan>] --agent <client> --message "<done>; next: <step>; open: <questions>"',
      );
    const agent = opts.agent || process.env.AI_CLIENT || 'Unknown';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    plan.body = appendToSection(
      plan.body,
      'Progress log',
      `- ${stamp} UTC, ${agent}: ${opts.message.replace(/\s+/g, ' ').trim()}`,
    );
    writePlan(plan);
    console.log(`Progress logged in ${plan.rel}`);
  },

  async handoff() {
    const plan = onePlan();
    const agent = opts.agent || process.env.AI_CLIENT || 'Unknown';
    const done = opts.done || opts.message || '';
    const next = opts.next || '';
    const open = opts.open || opts.questions || 'none';

    if (!done && !next) {
      fail(
        'usage: node scripts/ticket.mjs handoff --agent <agent> --done "<completed>" --next "<next step>" [--open "<questions>"]',
      );
    }

    const branch =
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
      'detached';
    const statusShort = git(['status', '--short'], { allowFail: true }) || '';
    const dirtyCount = statusShort.split('\n').filter(Boolean).length;

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const logLine = `- ${stamp} UTC, ${agent} (handoff): Done: ${done || 'in-flight'}; Next: ${next || 'continue'}; Open: ${open}; Tree: ${dirtyCount ? `${dirtyCount} dirty file(s)` : 'clean'}`;

    plan.body = appendToSection(plan.body, 'Progress log', logLine);
    writePlan(plan);

    console.log(`\n=== Session Handoff Stamped ===`);
    console.log(`Agent: ${agent} | Branch: ${branch}`);
    console.log(`Done:  ${done || '(in-flight)'}`);
    console.log(`Next:  ${next || '(see plan)'}`);
    console.log(`Open:  ${open}`);
    console.log(
      `Tree:  ${dirtyCount ? `${dirtyCount} uncommitted file(s)` : 'clean'}`,
    );
    console.log(`Logged in: ${plan.rel}\n`);
  },

  async resume() {
    const plan = onePlan();
    const branch =
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
      'detached';
    const statusShort = git(['status', '--short'], { allowFail: true }) || '';
    const clean = !statusShort.trim();

    const progressSection = section(plan.body, 'Progress log') || '';
    const progressLines = progressSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<!--') && !l.endsWith('-->'));
    const lastHandoff =
      progressLines
        .slice()
        .reverse()
        .find((l) => l.includes('(handoff):')) ||
      progressLines[progressLines.length - 1] ||
      '(none)';

    const stepsSection = section(plan.body, 'Steps') || '';
    const openSteps = stepsSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- [ ]'));
    const nextStep = openSteps[0]
      ? openSteps[0].slice(6)
      : '(all steps ticked)';

    const criteriaSection = section(plan.body, 'Acceptance criteria') || '';
    const openCriteria = criteriaSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- [ ]'));

    const baselineLine = runBootBaselineCheck();
    console.log(`\n=== Resuming Session ===`);
    console.log(`Plan:         ${plan.rel} (${localPlanStatus(plan) || 'unknown'})`);
    console.log(`Branch:       ${branch} (${clean ? 'clean' : 'dirty'})`);
    if (plan.meta.version) {
      console.log(
        `Version:      ${plan.meta.version}${plan.meta.impact ? ` (${plan.meta.impact})` : ''}`,
      );
    }
    if (baselineLine) {
      console.log(baselineLine);
    }
    if (statusShort) {
      console.log(
        `Dirty files:\n${statusShort
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}`,
      );
    }
    console.log(`Last Handoff: ${lastHandoff}`);
    console.log(`Next Action:  ${nextStep}`);
    console.log(`Criteria:     ${openCriteria.length} remaining open`);
    const tiers = getVerifyTiers();
    const tierEntries = Object.entries(tiers);
    if (tierEntries.length > 1) {
      console.log(
        `Verify with:  ${tierEntries.map(([t, c]) => `${t}: "${c}"`).join(' | ')}`,
      );
    } else if (tierEntries.length === 1) {
      console.log(`Verify with:  ${tierEntries[0][1]}`);
    }
    console.log(`========================\n`);
  },

  async pack() {
    const plan = onePlan();
    const base = resolveDiffBase();
    const maxFileLines = Number(
      opts['max-file-lines'] || config.packMaxFileLines || 120,
    );
    const maxLines = Number(opts['max-lines'] || config.packMaxLines || 400);
    const ignorePatterns = [
      ...DEFAULT_PACK_IGNORE,
      ...(config.packIgnore || []),
    ];
    const checkIssues = problems(plan, {
      requireTicket: false,
      ignoreReview: true,
    });
    const deferred = deferredItems(plan.body);
    const statusShort = git(['status', '--short'], { allowFail: true });
    const untracked = git(['ls-files', '--others', '--exclude-standard'], {
      allowFail: true,
    });
    const diffStat = base
      ? git(['diff', '--stat', base], { allowFail: true })
      : '';
    const rawDiff = base
      ? git(
          [
            'diff',
            '--unified=3',
            base,
            '--',
            '.',
            `:(exclude)${config.plansDir}`,
          ],
          { allowFail: true },
        )
      : '';
    const filteredDiff = formatFilteredDiff(rawDiff, {
      maxFileLines,
      maxLines,
      ignorePatterns,
    });

    let testOutput = '';
    let testPassed = true;
    const requestedTier = opts.tier || 'test';
    const resolvedTest = resolveVerifyCommand(config, requestedTier);
    if (opts.test && resolvedTest) {
      try {
        const out = execSync(resolvedTest.cmd, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CI: '1' },
        });
        const outLines = out.trim().split('\n').filter(Boolean);
        testOutput = outLines.slice(-5).join('\n');
      } catch (err) {
        testPassed = false;
        const out = (err.stdout || '') + (err.stderr || '');
        const outLines = out.trim().split('\n').filter(Boolean);
        testOutput = outLines.slice(-8).join('\n') || err.message;
      }
    }

    const hygieneRes = checkHygiene();
    const appetiteRes = checkAppetite(plan, base);
    const testIntegrity = analyzeTestIntegrity(base);
    const lintRes = lintPlan(plan);

    const lines = [
      `# Review Packet: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Status: ${localPlanStatus(plan) || 'unknown'} | Branch: ${plan.meta.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })}`,
      `Ticket: ${plan.meta.ticket || 'none'} | Reviewed: ${plan.meta.reviewedBy ? `${plan.meta.reviewedBy} (${plan.meta.reviewVerdict || 'unknown'})` : 'not yet'}${appetiteRes ? ` | Appetite: ${appetiteRes.appetite} (${appetiteRes.lines}/${appetiteRes.maxLines} lines, ${appetiteRes.files}/${appetiteRes.maxFiles} files${appetiteRes.exceeded ? ' — EXCEEDED' : ''})` : ''}${plan.meta.version ? ` | Version: ${plan.meta.version}${plan.meta.impact ? ` (${plan.meta.impact})` : ''}` : ''}`,
      ...(resolvedTest
        ? [
            `Verify command: \`${resolvedTest.cmd}\`${resolvedTest.tier !== 'test' ? ` (${resolvedTest.tier})` : ''}`,
          ]
        : []),
      '',
      ...(opts.test && resolvedTest
        ? [
            '## Test Verification',
            `Command: \`${resolvedTest.cmd}\`${resolvedTest.tier !== 'test' ? ` (${resolvedTest.tier})` : ''}`,
            `Result: ${testPassed ? 'PASS (exit code 0)' : 'FAIL'}`,
            '```',
            testOutput || '(no output)',
            '```',
            '',
          ]
        : []),
      '## Plan Summary',
      section(plan.body, 'Summary') || '(none)',
      '',
      '## Acceptance Criteria',
      section(plan.body, 'Acceptance criteria') || '(none)',
      ...(deferred.length ? ['', '## Deferred Items', ...deferred] : []),
      '',
      '## Hygiene & Plan Gate',
      checkIssues.length
        ? `Plan issues:\n- ${checkIssues.join('\n- ')}`
        : 'Plan checkboxes & evidence: OK',
      ...(lintRes.uncoveredAc.length
        ? [`Uncovered AC IDs: ${lintRes.uncoveredAc.join(', ')}`]
        : []),
      ...(hygieneRes.clean
        ? ['Hygiene check: clean']
        : ['Hygiene issues:', ...hygieneRes.issues.map((i) => `- ✗ ${i}`)]),
      ...(hygieneRes.warnings.length
        ? ['Hygiene warnings:', ...hygieneRes.warnings.map((w) => `- ⚠ ${w}`)]
        : []),
      statusShort
        ? `Working tree status:\n${statusShort}`
        : 'Working tree: clean',
      '',
      '## Test Integrity',
      ...(!testIntegrity.available
        ? ['(no baseline available)']
        : testIntegrity.warnings.length
          ? testIntegrity.warnings.map((w) => `- ⚠ ${w}`)
          : [
              `OK (+${testIntegrity.addedTestCases}/-${testIntegrity.removedTestCases} test cases, +${testIntegrity.addedAssertions}/-${testIntegrity.removedAssertions} assertions)`,
            ]),
      '',
      `## Diff Stat (base: ${base ? base.slice(0, 10) : 'none'})`,
      diffStat || '(no changes)',
      '',
      '## Code Diff (filtered)',
      ...(untracked ? ['Untracked files omitted from the diff:', untracked, ''] : []),
      filteredDiff,
    ];
    console.log(lines.join('\n'));
  },

  async review() {
    const plan = onePlan();

    if (opts.prompt) {
      const branch =
        plan.meta.branch ||
        git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
        'main';
      const resolvedVerify =
        resolveVerifyCommand(config, 'full') ||
        resolveVerifyCommand(config, 'test');
      const verifyCmd = resolvedVerify
        ? resolvedVerify.cmd
        : config.verifyCommand || 'npm test';
      const criteria = section(plan.body, 'Acceptance criteria') || '(none)';
      const lessons = selectRelevantLessons(plan, { limit: 5 });

      const promptLines = [
        `# Single-Pass Review Request: ${plan.meta.title || plan.rel}`,
        `Plan: ${plan.rel} | Branch: ${branch}`,
        `Verify Command: \`${verifyCmd}\``,
        '',
        '## Acceptance Criteria to Verify',
        criteria,
      ];
      if (lessons.length) {
        promptLines.push(
          '',
          '## Recent & Relevant Lessons',
          ...lessons.map((l) => l.raw),
        );
      }
      promptLines.push(
        '',
        '## Review Rubric',
        '1. Spec Fidelity: Does the implementation satisfy every acceptance criterion above?',
        '2. Test & Regressions: Does the verify command pass without test failures or regressions?',
        '3. Verification Honesty: Is every ticked criterion backed by genuine evidence?',
        '4. Code Quality & Standards: Does the change conform to repository standards with clean hygiene?',
        '',
        '## Verdict Stamp Instructions',
        `Run: node scripts/ticket.mjs review ${plan.rel} --agent <you> --verdict <pass|warn|block> --summary "<concise findings>"`,
        'Or dual-pass: --standards <pass|warn|block> --spec <pass|warn|block>',
      );

      console.log(promptLines.join('\n'));
      return;
    }

    const agent = opts.agent || process.env.AI_CLIENT || '';
    if (!config.captureSources.includes(agent))
      fail(`--agent must be one of: ${config.captureSources.join(', ')}`);

    let verdict = (opts.verdict || '').toLowerCase();
    let dualPassMeta = '';

    if (opts.standards || opts.spec) {
      const standards = (opts.standards || 'pass').toLowerCase();
      const spec = (opts.spec || 'pass').toLowerCase();
      if (!VERDICTS.includes(standards))
        fail(`--standards must be one of: ${VERDICTS.join(', ')}`);
      if (!VERDICTS.includes(spec))
        fail(`--spec must be one of: ${VERDICTS.join(', ')}`);

      dualPassMeta = ` [standards: ${standards}, spec: ${spec}]`;
      if (standards === 'block' || spec === 'block') {
        verdict = 'block';
      } else if (standards === 'warn' || spec === 'warn') {
        verdict = 'warn';
      } else {
        verdict = 'pass';
      }
    }

    if (!verdict) verdict = 'pass';
    if (!VERDICTS.includes(verdict))
      fail(`--verdict must be one of: ${VERDICTS.join(', ')}`);

    const summary = (
      opts.summary ||
      opts.message ||
      (dualPassMeta ? `Dual-pass review${dualPassMeta}` : '')
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!summary)
      fail(
        'usage: node scripts/ticket.mjs review [<plan>] --agent <client> --verdict <pass|warn|block> --summary "<findings>"',
      );

    const selfReviewReason = (opts.selfReview || '').replace(/\s+/g, ' ').trim();
    const allowTestDropReason = (opts.allowTestDrop || '').replace(/\s+/g, ' ').trim();
    if (
      config.requireReview &&
      verdict !== 'block' &&
      !opts.force &&
      plan.meta.agent &&
      plan.meta.agent.toLowerCase() === agent.toLowerCase() &&
      !selfReviewReason
    ) {
      fail(
        `cannot stamp review verdict "${verdict}": self-review blocked (reviewedBy "${agent}" matches plan agent "${plan.meta.agent}"). Use an independent reviewer or pass --self-review "<reason>".`,
      );
    }

    // Guardrail: if stamping "pass", verify criteria, test integrity & hygiene
    if (verdict === 'pass' && !opts.force) {
      const openCriteria = section(plan.body, 'Acceptance criteria')
        .split('\n')
        .filter((l) => /^\s*- \[ \]/.test(l) && !/\sdeferred:\s*\S/i.test(l));
      if (openCriteria.length > 0) {
        fail(
          `cannot stamp review verdict "pass": ${openCriteria.length} acceptance criteria remain unticked. Complete criteria first or pass --force.`,
        );
      }
      const unverified = section(plan.body, 'Acceptance criteria')
        .split('\n')
        .filter((l) => /^\s*- \[[xX]\]/.test(l) && !VERIFIED_RE.test(l));
      if (unverified.length > 0) {
        fail(
          `cannot stamp review verdict "pass": ${unverified.length} criterion ticked without verified evidence. Pass --force to override.`,
        );
      }
      const integrity = analyzeTestIntegrity(resolveDiffBase());
      if (integrity.available && integrity.suspiciousDrop && !allowTestDropReason) {
        fail(
          `cannot stamp review verdict "pass": test integrity check flagged potential test weakening:\n- ${integrity.warnings.join('\n- ')}\nPass --allow-test-drop "<reason>" (or --force) to override.`,
        );
      }
      const hyg = checkHygiene();
      if (!hyg.clean) {
        fail(
          `cannot stamp review verdict "pass": working tree has hygiene issues:\n- ${hyg.issues.join('\n- ')}\nPass --force to override.`,
        );
      }
    }

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    plan.meta.reviewedBy = agent;
    plan.meta.reviewVerdict = verdict;
    if (selfReviewReason && verdict !== 'block') {
      plan.meta.reviewSelfReason = selfReviewReason;
    } else {
      delete plan.meta.reviewSelfReason;
    }
    if (allowTestDropReason && verdict === 'pass') {
      plan.meta.reviewTestDropReason = allowTestDropReason;
    } else {
      delete plan.meta.reviewTestDropReason;
    }
    if (verdict === 'block') {
      delete plan.meta.reviewFingerprint;
    } else {
      if (git(['ls-files', '--others', '--exclude-standard', '--', '.', `:(exclude,literal)${plan.rel}`]))
        fail('review omits untracked files; stage the reviewed files before stamping a verdict');
      plan.meta.reviewFingerprint = reviewFingerprint(plan);
    }
    const extraTags = [
      selfReviewReason && verdict !== 'block' ? ` [self-review: ${selfReviewReason}]` : '',
      allowTestDropReason && verdict === 'pass' ? ` [test-drop: ${allowTestDropReason}]` : '',
    ].join('');
    plan.body = appendToSection(
      plan.body,
      'Progress log',
      `- ${stamp} UTC, ${agent} (review: ${verdict}${dualPassMeta}): ${summary}${extraTags}`,
    );
    writePlan(plan);
    console.log(
      `Review (${verdict}${dualPassMeta}) recorded in ${plan.rel} by ${agent}`,
    );
  },

  async check() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`${plan.rel} is not closed out:\n- ${found.join('\n- ')}`);
    const appetiteRes = checkAppetite(plan, resolveDiffBase());
    if (appetiteRes && appetiteRes.exceeded) {
      const msg = `Appetite ${appetiteRes.appetite} exceeded (${appetiteRes.lines}/${appetiteRes.maxLines} lines, ${appetiteRes.files}/${appetiteRes.maxFiles} files). Consider running \`node scripts/ticket.mjs split ${plan.rel} --after <#>\`.`;
      if (opts.strict) fail(msg);
      console.warn(`Warning: ${msg}`);
    }
    if (opts.strict && resolveVerifyCommand(config)) {
      const checkedCriteria = findCheckboxes(plan.body).items.filter(
        (it) => it.isChecked && it.section.toLowerCase() === 'acceptance criteria',
      );
      if (
        checkedCriteria.length > 0 &&
        checkedCriteria.every((it) => /\sverified\(manual\):/i.test(it.text))
      ) {
        fail(
          `${plan.rel}: --strict requires at least one automated verification proof (verified(test): or verified(cmd):) when a verify command is configured.`,
        );
      }
    }
    const hyg = checkHygiene();
    if (!hyg.clean) {
      if (opts.strict || config.hygiene?.strict) {
        fail(`working tree hygiene failed:\n- ${hyg.issues.join('\n- ')}`);
      } else {
        console.warn(`Hygiene issues detected:\n- ${hyg.issues.join('\n- ')}`);
      }
    }
    const inv = runInvariants(config, repoRoot);
    if (!inv.passed) {
      fail(`repository invariants failed:\n- ${inv.failures.join('\n- ')}`);
    }
    console.log(`${plan.rel}: closed out.`);
  },

  async lint() {
    const plan = onePlan();
    const res = lintPlan(plan);
    if (opts.json) {
      console.log(JSON.stringify({ plan: plan.rel, ...res }, null, 2));
    } else {
      console.log(`=== Plan Lint: ${plan.rel} ===`);
      if (res.errors.length) {
        console.log('Errors:');
        for (const e of res.errors) console.log(`  ✗ ${e}`);
      }
      if (res.warnings.length) {
        console.log('Warnings:');
        for (const w of res.warnings) console.log(`  ⚠ ${w}`);
      }
      if (res.ok && res.warnings.length === 0) {
        console.log('✓ Plan lint clean (0 errors, 0 warnings).');
      }
    }
    if (!res.ok || (opts.strict && res.warnings.length > 0)) {
      fail(`plan lint failed (${res.errors.length} error(s), ${res.warnings.length} warning(s))`);
    }
  },

  async ship() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`${plan.rel} is not closed out:\n- ${found.join('\n- ')}`);
    if (!/^https:\/\//.test(opts.pr || ''))
      fail('ship needs --pr <pull request URL>; open the PR first.');
    await linkPullRequest(plan, opts.pr);
    if ((opts.retro || '').trim()) {
      const tagList = (opts.tags || 'retro').split(',').map((t) => t.trim()).filter(Boolean);
      const res = appendLesson({ text: opts.retro, tags: tagList, planRel: plan.rel });
      console.log(`Retro lesson recorded in docs/lessons.md: ${res.line}`);
    }
  },

  async pr() {
    const plan = onePlan();
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const protectedList = config.protectedBranches || ['main', 'master', 'develop'];
    if (!branch || branch === 'HEAD' || protectedList.includes(branch))
      fail(`cannot open PR directly from protected branch "${branch}". Checkout a feature branch first.`);

    const head = git(['rev-parse', 'HEAD']);
    const shouldVerify = opts.verify || opts.test;
    if (!opts.dryRun || shouldVerify) {
      assertPrSnapshot(branch, head);
      if (!git(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', plan.rel], { allowFail: true }))
        fail('pr needs a plan committed in this repository');
    }
    const found = problems(plan);
    if (found.length) fail(`plan is not closed out:\n- ${found.join('\n- ')}`);

    let verification = '';
    if (shouldVerify) {
      const tier = resolveVerifyCommand(config, 'full') || resolveVerifyCommand(config, 'test');
      if (!tier) fail('pr --verify needs a configured full or test verification command');
      console.log(`Running verification on ${head.slice(0, 10)} (${tier.tier}): ${tier.cmd}`);
      try {
        execSync(tier.cmd, {
          cwd: repoRoot,
          stdio: 'inherit',
          env: { ...process.env, CI: '1' },
        });
      } catch (error) {
        fail(`verification failed before opening PR: ${error.message}`);
      }
      assertPrSnapshot(branch, head);
      verification = `- \`${tier.cmd}\` passed on commit \`${head.slice(0, 10)}\`.`;
    }

    const title = plan.meta.title || plan.rel;
    const body = pullRequestBody(plan, verification);
    if (opts.dryRun) {
      console.log('--- Dry Run: PR Title ---');
      console.log(title);
      console.log('--- Dry Run: PR Body ---');
      console.log(body);
      return;
    }

    pushPrCommit(branch, head);
    prCommand('git', ['branch', `--set-upstream-to=origin/${branch}`, branch],
      'could not configure the pushed branch as upstream');
    const existing = JSON.parse(prCommand('gh', [
      'pr', 'list', '--state', 'open', '--head', branch,
      '--json', 'url,isCrossRepository',
    ], 'could not look up existing pull request')).filter((pr) => !pr.isCrossRepository);
    if (existing.length > 1)
      fail(`multiple open pull requests use branch "${branch}"; link the intended PR manually`);

    let prUrl = existing[0]?.url;
    if (prUrl) {
      console.log(`Reusing pull request: ${prUrl}`);
    } else {
      const args = ['pr', 'create', '--title', title, '--body-file', '-', '--head', branch];
      if (opts.draft) args.push('--draft');
      prUrl = prCommand('gh', args, 'could not create pull request', body);
      console.log(`Pull request created: ${prUrl}`);
    }
    if (!/^https:\/\//.test(prUrl || ''))
      fail('GitHub CLI did not return a pull request URL; retry to look up the existing PR');

    assertPrSnapshot(branch, head);
    let finalHead = (await linkPullRequest(plan, prUrl, { branch, head })) || head;
    if ((opts.retro || '').trim()) {
      const tagList = (opts.tags || 'retro').split(',').map((t) => t.trim()).filter(Boolean);
      const res = appendLesson({ text: opts.retro, tags: tagList, planRel: plan.rel });
      git(['add', '--', 'docs/lessons.md']);
      git(['--literal-pathspecs', 'commit', '--only', '-m', 'chore(retro): record workflow lesson', '--', 'docs/lessons.md']);
      finalHead = git(['rev-parse', 'HEAD']);
      console.log(`Retro lesson recorded in docs/lessons.md: ${res.line}`);
    }
    if (finalHead !== head) pushPrCommit(branch, finalHead);

    if (opts.auto) {
      prCommand('gh', [
        'pr', 'merge', prUrl, '--auto', '--squash', '--delete-branch',
        '--match-head-commit', finalHead,
      ], 'could not enable auto-merge');
      console.log(`Auto-merge enabled for ${prUrl}.`);
    }
  },

  async done() {
    const plan = onePlan();
    if (!hasTicket(plan.meta.ticket)) fail(`${plan.rel} has no ticket.`);
    await closeTicket(plan.meta.ticket);
    if (isLocal) {
      plan.meta.status = 'done';
      plan.meta.completedAt = today();
      writePlan(plan);
    }
    console.log(`Ticket set to Done: ${plan.meta.ticket}`);
  },

  async 'ci-check'() {
    if (!opts.base || !opts.head)
      fail('usage: ci-check --base <sha> --head <sha>');
    const range = `${opts.base}...${opts.head}`;
    const diffPaths = (filter) => git([
      'diff', '--name-only', '--no-renames', `--diff-filter=${filter}`, '-z', range,
    ]).split('\0').filter(Boolean);
    const changedPaths = diffPaths('AMT');
    const removedPaths = diffPaths('D');
    const patterns = artifactPatterns();
    const debris = changedPaths.filter((file) => isArtifact(file, patterns));
    if (debris.length) fail(`committed hygiene issues:\n- ${debris.join('\n- ')}`);
    const isPlanPath = (file) => file.startsWith(`${config.plansDir}/`) &&
        file.endsWith('.plan.md') && !basename(file).startsWith('_') &&
        !file.startsWith(`${config.plansDir}/archive/`);
    const isArchivePath = (file) => file.startsWith(`${config.plansDir}/archive/`) &&
        file.endsWith('.plan.md') && !basename(file).startsWith('_');
    const isClosed = (rawText) => {
      const text = (rawText || '').replace(/\r\n/g, '\n');
      if (/^status:\s*(?:done|shipped)\s*$/im.test(text.split('\n---\n')[0])) return true;
      // Earlier merges sometimes kept in-progress metadata on completed plans.
      const { items } = findCheckboxes(bodyOf(text));
      return items.length > 0 && items.every((item) =>
        item.isChecked || /\sdeferred:\s*\S/i.test(item.text));
    };
    const removedPlans = removedPaths.filter(isPlanPath);
    for (const file of removedPlans) {
      if (!isClosed(git(['show', `${opts.base}:${file}`], { allowFail: true })))
        fail(`active plan removed or renamed: ${file}`);
    }
    const archivedFiles = changedPaths.filter(isArchivePath);
    for (const file of archivedFiles) {
      const archivedText = git(['show', `${opts.head}:${file}`], { allowFail: true });
      if (!archivedText || !isClosed(archivedText)) {
        fail(`archived plan is not closed out: ${file}`);
      }
    }
    const removedPlanSet = new Set(removedPlans);
    const removedBasenames = new Set(removedPlans.map((file) => basename(file)));
    const verifiedArchiveMoves = new Set(
      archivedFiles.filter((file) => removedBasenames.has(basename(file))),
    );
    const movedBasenames = new Set([...verifiedArchiveMoves].map((file) => basename(file)));
    const isArchiveMovePath = (file) =>
      verifiedArchiveMoves.has(file) ||
      (removedPlanSet.has(file) && movedBasenames.has(basename(file)));
    const plans = changedPaths
      .filter(isPlanPath)
      .map((file) => ({
        plan: readPlanText(git(['show', `${opts.head}:${file}`]), file),
        original: originalPlan(file, opts.base, opts.head),
        baseline: git(['show', `${opts.base}:${file}`], { allowFail: true }),
      }))
      .filter(({ baseline }) => !isClosed(baseline));
    if (!plans.length) {
      const isPureArchiveMove =
        verifiedArchiveMoves.size > 0 &&
        changedPaths.every((file) => isArchiveMovePath(file)) &&
        removedPaths.every((file) => isArchiveMovePath(file));
      if (isPureArchiveMove) {
        return console.log(
          `Closed-plan archive PR (${verifiedArchiveMoves.size} archived plan(s)); no new plan required.`,
        );
      }
      if (process.env.NO_PLAN !== '1')
        fail(
          `no plan with a ticket header changed in this PR. Add one under ${config.plansDir}/ (see AGENTS.md), or add the "no-plan" label for a trivial change.`,
        );
      const { maxChangedLines, noNewFilesUnder } = config.noPlan;
      const changed = git(['diff', '--numstat', '--no-renames', range])
        .split('\n')
        .filter(Boolean)
        .reduce((n, l) => {
          const [a, d, ...rest] = l.split('\t');
          const file = rest.join('\t');
          if (isArchiveMovePath(file)) return n;
          return a === '-' || d === '-' ? Infinity : n + Number(a) + Number(d);
        }, 0);
      const newFiles = git([
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=A',
        range,
        '--',
        ...noNewFilesUnder,
      ])
        .split('\n')
        .filter(Boolean)
        .filter((file) => !verifiedArchiveMoves.has(file));
      const policyChanged = [...changedPaths, ...removedPaths]
        .some((file) => WORKFLOW_FILES.has(file) || file.startsWith('.github/workflows/'));
      if (policyChanged) {
        const allManagedSyncFiles =
          removedPaths.length === 0 &&
          changedPaths.length > 0 &&
          changedPaths.every(
            (file) =>
              WORKFLOW_FILES.has(file) && file !== 'scripts/ticket.config.json',
          );
        const syncScript = join(repoRoot, 'scripts', 'sync.mjs');
        if (allManagedSyncFiles && existsSync(syncScript)) {
          try {
            execFileSync(
              process.execPath,
              [syncScript, repoRoot, '--remote', '--check'],
              {
                cwd: repoRoot,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            return console.log(
              `Verified upstream workflow sync (${changedPaths.length} managed file(s)); allowed under no-plan.`,
            );
          } catch {}
        }
      }
      if (policyChanged || changed > maxChangedLines || newFiles.length) {
        fail(
          `the no-plan label only covers trivial changes (at most ${maxChangedLines} changed lines, no new files under ${noNewFilesUnder.join(', ')}, and no workflow policy changes). Add a plan instead.`,
        );
      }
      return console.log(
        `No plan in this PR; allowed by the no-plan label (${changed} changed lines).`,
      );
    }
    const baseline = git(['merge-base', opts.base, opts.head]);
    let failed = false;
    for (const { plan, original } of plans) {
      const f = plan.rel;
      const found = problems(plan, {
        base: baseline,
        head: opts.head,
      });
      const ticket = plan.meta.ticket || '';
      const validIdentity = isLocal
        ? ticket === `local://${ticketKey(plan)}`
        : /^https:\/\/(?:(?:www\.)?notion\.so\/|app\.notion\.com\/p\/)[^?#]*[\da-f]{8}(?:-?[\da-f]{4}){3}-?[\da-f]{12}(?:[?#].*)?$/i.test(ticket);
      if (!validIdentity) found.push('ticket does not match the configured tracker and plan identity');
      if (original) {
        for (const item of missingCheckboxes(bodyOf(original), plan.body))
          found.push(`checkbox removed or replaced: ${item.text}`);
      }
      if (found.length) {
        failed = true;
        console.error(`${f}:\n- ${found.join('\n- ')}`);
        continue;
      }
      const deferred = deferredItems(plan.body);
      console.log(
        `${f}: closed out.${deferred.length ? `\n  Deferred:\n  ${deferred.join('\n  ')}` : ''}`,
      );
    }
    if (failed)
      fail(
        'close out the plan(s) above: tick every item or mark it "deferred: <reason>".',
      );
    const inv = runInvariants(config, repoRoot);
    if (!inv.passed) {
      fail(`repository invariants failed:\n- ${inv.failures.join('\n- ')}`);
    }
  },

  async 'ci-done'() {
    if (!opts.head) fail('usage: ci-done --head <merge sha>');
    if (isLocal) return console.log('Local tracker: plan completion is derived from the protected branch.');
    const mergedAt = opts.mergedAt ? new Date(opts.mergedAt) : new Date();
    if (!Number.isFinite(mergedAt.valueOf())) fail('invalid --merged-at timestamp');
    const date = mergedAt.toLocaleDateString('sv-SE', {
      timeZone: config.timeZone || 'Europe/Berlin',
    });
    let files;
    if (opts.prFiles) {
      const pages = JSON.parse(readFileSync(opts.prFiles, 'utf8'));
      if (!Array.isArray(pages) || !pages.every(Array.isArray))
        fail('invalid GitHub PR file list');
      files = pages.flat();
      const expected = Number(opts.changedFiles);
      if (!opts.pr || !opts.mergedAt || !/^\d+$/.test(opts.changedFiles || '') ||
          !Number.isSafeInteger(expected) || expected < 0 || files.length !== expected)
        fail('incomplete GitHub PR file list or missing --pr');
    } else {
      const base = opts.base || `${opts.head}^1`;
      files = git(['diff', '--name-only', '--diff-filter=AMR', '-z', base, opts.head, '--', config.plansDir])
        .split('\0').filter(Boolean).map((filename) => ({ filename, status: 'added' }));
    }
    for (const { filename, status } of files) {
      if (typeof filename !== 'string' || !['added', 'modified', 'renamed'].includes(status) ||
          !filename.startsWith(`${config.plansDir}/`) || !filename.endsWith('.plan.md') ||
          basename(filename).startsWith('_') || filename.startsWith(`${config.plansDir}/archive/`)) continue;
      const plan = readPlanText(git(['show', `${opts.head}:${filename}`]), filename);
      if (opts.pr && plan.meta.pr !== opts.pr && (plan.meta.pr || status !== 'added')) continue;
      if (!hasTicket(plan.meta.ticket)) continue;
      await closeTicket(plan.meta.ticket, date);
      console.log(`${filename}: ticket is Done.`);
    }
  },

  async overview() {
    const candidateDirs = getKnownRepoDirs();

    const rows = [];
    for (const dir of candidateDirs) {
      const name = basename(dir);
      const isGit = existsSync(join(dir, '.git'));
      if (!isGit) continue;

      let branch = '(unknown)';
      try {
        branch = execFileSync(
          'git',
          ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {}

      let statusShort = '';
      try {
        statusShort = execFileSync('git', ['-C', dir, 'status', '--short'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      } catch {}
      const clean = !statusShort;

      const repoCfg = readRepoConfig(dir);
      const activePlan = resolveRepoActivePlan(dir, branch, repoCfg);
      let openBoxes = '-';
      let state = 'Idle';

      if (activePlan) {
        state =
          activePlan.meta.status === 'in-progress'
            ? 'Doing'
            : activePlan.meta.status || 'Active';
        if (activePlan.meta.version && activePlan.meta.version !== 'none') {
          state += ` (v${activePlan.meta.version.replace(/^v/i, '')})`;
        }
        const openCriteria = (activePlan.raw.match(/^- \[ \] /gm) || []).length;
        openBoxes = String(openCriteria);
      } else if (repoCfg.versioning?.enabled && repoCfg.versioning?.activeTrain) {
        state = `Idle (v${String(repoCfg.versioning.activeTrain).replace(/^v/i, '')})`;
      }

      rows.push({
        repo: name,
        branch: branch + (clean ? '' : '*'),
        plan: activePlan
          ? activePlan.file.replace(/\.plan\.md$/, '')
          : '(none)',
        open: openBoxes,
        state,
      });
    }

    const colWidths = {
      repo: Math.max(4, ...rows.map((r) => r.repo.length)),
      branch: Math.max(6, ...rows.map((r) => r.branch.length)),
      plan: Math.max(4, ...rows.map((r) => r.plan.length)),
      open: Math.max(4, ...rows.map((r) => r.open.length)),
      state: Math.max(5, ...rows.map((r) => r.state.length)),
    };

    const header = [
      'Repo'.padEnd(colWidths.repo),
      'Branch'.padEnd(colWidths.branch),
      'Plan'.padEnd(colWidths.plan),
      'Open'.padStart(colWidths.open),
      'State'.padEnd(colWidths.state),
    ].join('  ');
    const divider = '-'.repeat(header.length);

    console.log(header);
    console.log(divider);
    for (const r of rows) {
      console.log(
        [
          r.repo.padEnd(colWidths.repo),
          r.branch.padEnd(colWidths.branch),
          r.plan.padEnd(colWidths.plan),
          r.open.padStart(colWidths.open),
          r.state.padEnd(colWidths.state),
        ].join('  '),
      );
    }
  },

  async hook() {
    const action = opts.files[0] || 'status';
    if (!['install', 'uninstall', 'status'].includes(action)) {
      fail('usage: node scripts/ticket.mjs hook [install|uninstall|status] [--agent-hooks] [--fleet]');
    }
    const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];

    const isAdwHookEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (typeof entry.command === 'string' && entry.command.includes('adw-hook.mjs')) {
        return true;
      }
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some(
          (h) => typeof h?.command === 'string' && h.command.includes('adw-hook.mjs'),
        );
      }
      return false;
    };

    const manageAgentHooks = (dir, label) => {
      const settingsPath = join(dir, '.claude', 'settings.json');
      let settings = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        } catch (err) {
          fail(`${label}invalid JSON in ${settingsPath}: ${err.message}`);
        }
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        settings = {};
      }
      const existingHooks =
        settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
          ? { ...settings.hooks }
          : {};

      const spec = [
        { event: 'PreToolUse', matcher: '*', sub: 'pre-tool' },
        { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', sub: 'post-tool' },
        { event: 'Stop', matcher: '*', sub: 'stop' },
      ];

      if (action === 'install') {
        for (const { event, matcher, sub } of spec) {
          const prevList = Array.isArray(existingHooks[event])
            ? existingHooks[event].filter((e) => !isAdwHookEntry(e))
            : [];
          prevList.push({
            matcher,
            hooks: [
              {
                type: 'command',
                command: `node scripts/hooks/adw-hook.mjs ${sub}`,
              },
            ],
          });
          existingHooks[event] = prevList;
        }
        settings.hooks = existingHooks;
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        console.log(`${label}Agent runtime hooks installed: ${settingsPath}`);
      } else if (action === 'uninstall') {
        for (const { event } of spec) {
          if (!Array.isArray(existingHooks[event])) continue;
          const remaining = existingHooks[event].filter((e) => !isAdwHookEntry(e));
          if (remaining.length) existingHooks[event] = remaining;
          else delete existingHooks[event];
        }
        if (Object.keys(existingHooks).length) {
          settings.hooks = existingHooks;
        } else {
          delete settings.hooks;
        }
        if (existsSync(settingsPath)) {
          writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
          console.log(`${label}Agent runtime hooks removed from ${settingsPath}`);
        } else {
          console.log(`${label}Agent runtime hooks not present: ${settingsPath}`);
        }
      } else {
        const wired = spec.filter(
          ({ event }) =>
            Array.isArray(existingHooks[event]) &&
            existingHooks[event].some((e) => isAdwHookEntry(e)),
        );
        console.log(
          wired.length === spec.length
            ? `${label}Agent runtime hooks installed (${wired.length}/${spec.length} events) in ${settingsPath}`
            : `${label}Agent runtime hooks NOT fully installed (${wired.length}/${spec.length} events). Run 'node scripts/ticket.mjs hook install --agent-hooks'.`,
        );
      }
    };

    const applyHook = (dir) => {
      if (opts.fleet && !existsSync(join(dir, '.git'))) return;
      const hookPath = resolveHookPath(dir);
      const label = opts.fleet ? `[${basename(dir)}] ` : '';

      if (opts.agentHooks) {
        manageAgentHooks(dir, label);
        return;
      }

      if (action === 'install') {
        mkdirSync(dirname(hookPath), { recursive: true });
      const script = [
        '#!/bin/sh',
        '# AI-Dev-Workflow pre-push hook: guardrails against direct push to protected branches',
        '# and warns if the active plan check fails.',
        '',
        'remote="$1"',
        'url="$2"',
        '',
        'protected_branches="main master develop"',
        'if [ -f "scripts/ticket.config.json" ]; then',
        "  custom=$(node -e \"try{console.log((JSON.parse(require('fs').readFileSync('scripts/ticket.config.json','utf8')).protectedBranches||[]).join(' '))}catch(e){}\" 2>/dev/null)",
        '  if [ -n "$custom" ]; then',
        '    protected_branches="$custom"',
        '  fi',
        'fi',
        '',
        'while read -r local_ref local_oid remote_ref remote_oid; do',
        '  branch=$(echo "$remote_ref" | sed \'s@^refs/heads/@@\')',
        '  for pb in $protected_branches; do',
        '    if [ "$branch" = "$pb" ]; then',
        '      if [ "$GIT_ALLOW_PROTECTED_PUSH" != "1" ]; then',
        '        echo "================================================================================"',
        '        echo "BLOCKED: Direct push to protected branch \'$branch\' is disallowed by AI-Dev-Workflow."',
        '        echo "Please push to a feature branch (e.g. gemini/<topic>) and open a Pull Request."',
        '        echo "(Emergency bypass: GIT_ALLOW_PROTECTED_PUSH=1 git push)"',
        '        echo "================================================================================"',
        '        exit 1',
        '      fi',
        '    fi',
        '  done',
        'done',
        '',
        'if [ -f "scripts/ticket.mjs" ]; then',
        '  node scripts/ticket.mjs check >/dev/null 2>&1',
        '  if [ $? -ne 0 ]; then',
        '    echo "Note: Active plan check did not pass yet. CI will enforce plan completion on PR."',
        '  fi',
        'fi',
        '',
        'exit 0',
      ].join('\n');
        writeFileSync(hookPath, `${script}\n`, { mode: 0o755 });
        console.log(`${label}Pre-push hook installed: ${hookPath}`);
      } else if (action === 'uninstall') {
        if (existsSync(hookPath)) {
          unlinkSync(hookPath);
          console.log(`${label}Pre-push hook removed: ${hookPath}`);
        } else {
          console.log(`${label}Pre-push hook not present: ${hookPath}`);
        }
      } else if (action === 'status') {
        console.log(
          existsSync(hookPath)
            ? `${label}Pre-push hook is installed at ${hookPath}`
            : `${label}Pre-push hook is NOT installed. Run 'node scripts/ticket.mjs hook install' to install.`,
        );
      }
    };
    for (const dir of dirs) applyHook(dir);
  },

  async adr() {
    const rawTitle = opts.files[0] || opts.title || '';
    if (!rawTitle) {
      fail(
        'usage: node scripts/ticket.mjs adr "<Decision Title>" [--agent <client>]',
      );
    }
    const title = rawTitle.replace(/^["']|["']$/g, '').trim();
    const kebab = title
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const decisionsDir = join(repoRoot, 'docs', 'decisions');
    mkdirSync(decisionsDir, { recursive: true });

    let nextNum = 1;
    if (existsSync(decisionsDir)) {
      const existing = readdirSync(decisionsDir).filter((f) =>
        f.endsWith('.md'),
      );
      for (const f of existing) {
        const m = f.match(/^ADR-(\d+)/i);
        if (m) {
          const num = parseInt(m[1], 10);
          if (num >= nextNum) nextNum = num + 1;
        }
      }
    }

    const numStr = String(nextNum).padStart(3, '0');
    const filename = `ADR-${numStr}-${kebab}.md`;
    const fullPath = join(decisionsDir, filename);
    const relPath = join('docs', 'decisions', filename).replace(/\\/g, '/');

    const agent = opts.agent || process.env.AI_CLIENT || 'Gemini';
    const content = [
      `# ADR ${numStr}: ${title}`,
      '',
      `- **Status:** Accepted`,
      `- **Date:** ${today()}`,
      `- **Author:** ${agent}`,
      `- **Deciders:** Aaron, ${agent}`,
      '',
      '## Context',
      '<What problem, requirement, or architecture choice are we facing?>',
      '',
      '## Decision',
      '<What architecture or technical choice was made, and why?>',
      '',
      '## Consequences',
      '',
      '### Positive',
      '- <What becomes easier, cleaner, or faster?>',
      '',
      '### Negative / Trade-offs',
      '- <What constraints or follow-ups does this introduce?>',
      '',
    ].join('\n');

    writeFileSync(fullPath, content, 'utf8');
    console.log(`Created ADR: ${relPath}`);
  },

  async exec() {
    const cmd = opts.files.join(' ') || opts.cmd || '';
    if (!cmd) {
      fail('usage: node scripts/ticket.mjs exec "<shell-command>"');
    }
    const candidateDirs = getKnownRepoDirs();

    console.log(
      `Running across ${candidateDirs.length} repositories: "${cmd}"\n`,
    );
    const results = [];
    for (const dir of candidateDirs) {
      const name = basename(dir);
      try {
        const out = execSync(cmd, {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000,
        }).trim();
        const firstLine = out.split('\n')[0] || '(empty)';
        results.push({
          repo: name,
          status: 'OK',
          message: firstLine.slice(0, 50),
        });
      } catch (err) {
        const errLine =
          (err.stderr || err.stdout || err.message).trim().split('\n')[0] ||
          'failed';
        results.push({
          repo: name,
          status: 'FAIL',
          message: errLine.slice(0, 50),
        });
      }
    }

    const colWidths = {
      repo: Math.max(4, ...results.map((r) => r.repo.length)),
      status: Math.max(6, ...results.map((r) => r.status.length)),
      message: Math.max(7, ...results.map((r) => r.message.length)),
    };
    const header = [
      'Repo'.padEnd(colWidths.repo),
      'Status'.padEnd(colWidths.status),
      'Output'.padEnd(colWidths.message),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of results) {
      console.log(
        [
          r.repo.padEnd(colWidths.repo),
          r.status.padEnd(colWidths.status),
          r.message.padEnd(colWidths.message),
        ].join('  '),
      );
    }
  },

  async wt() {
    const sub = opts.files[0] || 'list';
    if (sub === 'list') {
      const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];
      for (const dir of dirs) {
        const repoName = basename(dir);
        let out = '';
        try {
          out = execFileSync('git', ['-C', dir, 'worktree', 'list'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }).trim();
        } catch {
          continue;
        }
        if (opts.fleet) console.log(`=== ${repoName} ===`);
        console.log(out || '(no worktrees)');
        if (opts.fleet) console.log('');
      }
      return;
    }

    if (sub === 'new') {
      const entries = registeredWorktrees();
      const planArg = opts.files.slice(1).find((f) => f.endsWith('.plan.md'));
      const plan = planArg ? worktreePlan(resolve(planArg), repoRoot)
        : opts.branch || opts.name ? undefined : resolveActivePlan();
      const branch = opts.branch || (plan && planWorktreeBranch(plan)) ||
        (opts.name ? `feat/${opts.name}` : null);
      if (!branch) fail('usage: node scripts/ticket.mjs wt new [<plan>] [--name <dir>] [--branch <branch>]');
      const worktree = ensurePlanWorktree(entries, branch, plan, { name: opts.name });
      const action = opts.dryRun ? '[dry-run] Worktree target:' :
        worktree.created ? 'Created worktree at' : 'Worktree exists at';
      console.log(`${action} ${worktree.path} (branch: ${branch})`);
      console.log(`To switch: cd "${worktree.path}"`);
      return;
    }

    if (sub === 'prune') {
      const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];
      pruneLinkedWorktrees({
        dirs,
        dryRun: Boolean(opts.dryRun),
        filter: ({ main, entry }) =>
          Boolean((opts.all && entry.branch) || worktreeIsMerged(main.path, entry.head)),
      });
      return;
    }

    fail(
      'usage: node scripts/ticket.mjs wt [list|new|prune] [--fleet] [--all]',
    );
  },

  async recall() {
    const query = (opts.files.join(' ') || opts.query || '').trim();
    if (!query && !opts.lessons) {
      fail('usage: node scripts/ticket.mjs recall "<keyword>" [--lessons] [--fleet]');
    }
    const qLower = query.toLowerCase();
    const queryTerms = qLower ? qLower.split(/\s+/).filter(Boolean) : [];
    const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];

    const results = [];
    for (const dir of dirs) {
      const repoName = basename(dir);

      const lessonEntries = loadLessons(dir);
      if (lessonEntries.length) {
        const matchedLessons = [];
        for (const entry of lessonEntries) {
          const lineLower = entry.raw.toLowerCase();
          const lineMatches =
            !queryTerms.length ||
            lineLower.includes(qLower) ||
            queryTerms.every((term) => lineLower.includes(term));
          if (lineMatches) {
            matchedLessons.push({ line: entry.line, text: entry.raw });
          }
        }
        if (matchedLessons.length) {
          results.push({
            repo: repoName,
            type: 'Lesson',
            file: 'docs/lessons.md',
            title: 'Workflow Lessons',
            matches: matchedLessons.slice(0, 12),
          });
        }
      }

      if (opts.lessons) continue;

      const searchDirs = [
        join(dir, 'docs', 'decisions'),
        join(dir, 'docs', 'plans'),
        join(dir, 'docs', 'plans', 'archive'),
      ];

      function scanRecursive(d) {
        if (!existsSync(d)) return [];
        let files = [];
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          if (entry.isDirectory()) files.push(...scanRecursive(full));
          else if (entry.name.endsWith('.md')) files.push(full);
        }
        return files;
      }

      const files = searchDirs.flatMap(scanRecursive);
      for (const f of files) {
        try {
          const content = readFileSync(f, 'utf8');
          const contentLower = content.toLowerCase();

          // Match if full phrase is present OR all individual search terms are present
          const matchesAllTerms =
            contentLower.includes(qLower) ||
            (queryTerms.length > 1 &&
              queryTerms.every((term) => contentLower.includes(term)));
          if (!matchesAllTerms) continue;

          const lines = content.split('\n');
          const relPath = relative(dir, f).replace(/\\/g, '/');
          const isAdr = relPath.startsWith('docs/decisions/');
          const titleLine = lines.find((l) => /^#\s+/.test(l)) || '';
          const title = titleLine.replace(/^#\s+/, '').trim() || basename(f);

          const matches = [];
          for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            const lineMatches =
              lineLower.includes(qLower) ||
              queryTerms.some((term) => lineLower.includes(term));
            if (lineMatches) {
              matches.push({ line: i + 1, text: lines[i].trim() });
              if (matches.length >= 4) break;
            }
          }

          results.push({
            repo: repoName,
            type: isAdr ? 'ADR' : 'Plan',
            file: relPath,
            title,
            matches,
          });
        } catch {}
      }
    }

    if (!results.length) {
      return console.log(
        query
          ? `No records found matching "${query}".`
          : 'No workflow lessons found in docs/lessons.md.',
      );
    }

    console.log(
      `=== Recall${query ? `: "${query}"` : ' (lessons)'} (${results.length} match${results.length === 1 ? '' : 'es'}${opts.fleet ? ' across fleet' : ''}) ===\n`,
    );
    for (const r of results) {
      console.log(
        `[${r.type}] ${opts.fleet ? `${r.repo} / ` : ''}${r.file} — ${r.title}`,
      );
      for (const m of r.matches) {
        console.log(`  L${m.line}: ${m.text.slice(0, 100)}`);
      }
      console.log('');
    }
  },

  async archive() {
    const plansDir = join(repoRoot, config.plansDir || 'docs/plans');
    const plans = opts.files[0]
      ? [readPlan(opts.files[0])]
      : opts.all
        ? allPlans()
        : [resolveActivePlan()];

    let count = 0;
    for (const plan of plans) {
      const isDone =
        plan.meta.status === 'done' ||
        plan.meta.status === 'shipped' ||
        problems(plan, { requireTicket: false, ignoreReview: true }).length ===
          0;

      if (!isDone && !opts.force) {
        console.warn(
          `Skipping ${plan.rel}: plan has open items or is not marked done/shipped (use --force to archive anyway).`,
        );
        continue;
      }

      const month = plan.meta.completedAt?.slice(0, 7) || today().slice(0, 7);
      const archiveDir = join(plansDir, 'archive', month);
      mkdirSync(archiveDir, { recursive: true });

      const destFile = join(archiveDir, basename(plan.full));
      const relDest = relative(repoRoot, destFile).replace(/\\/g, '/');

      let moved = false;
      try {
        git(['mv', plan.rel, relDest]);
        moved = true;
      } catch {
        try {
          renameSync(plan.full, destFile);
          moved = true;
        } catch (e) {
          console.error(`Failed to move ${plan.rel}: ${e.message}`);
        }
      }

      if (moved) {
        console.log(`Archived: ${plan.rel} -> ${relDest}`);
        count++;
      }
    }
    console.log(`Archived ${count} plan(s).`);
  },

  async doctor() {
    const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];
    console.log(
      `=== AI-Dev-Workflow Doctor (${dirs.length} repo${dirs.length === 1 ? '' : 's'}) ===\n`,
    );

    for (const dir of dirs) {
      const name = basename(dir);
      const isGit = existsSync(join(dir, '.git'));
      if (!isGit) {
        console.log(`[${name}] NOT A GIT REPOSITORY\n`);
        continue;
      }

      const cfgPath = join(dir, 'scripts', 'ticket.config.json');
      const hasCfg = existsSync(cfgPath);
      let repoCfg = {};
      if (hasCfg) {
        try {
          repoCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        } catch {}
      }

      let branch = '(unknown)';
      try {
        branch = execFileSync(
          'git',
          ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {}

      let statusShort = '';
      try {
        statusShort = execFileSync('git', ['-C', dir, 'status', '--short'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      } catch {}
      const dirty = statusShort.split('\n').filter(Boolean).length;

      let wtCount = 1;
      try {
        const wtOut = execFileSync(
          'git',
          ['-C', dir, 'worktree', 'list', '--porcelain'],
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          },
        );
        wtCount = (wtOut.match(/^worktree /gm) || []).length;
      } catch {}

      const hookPath = resolveHookPath(dir);
      const hasHook = existsSync(hookPath);

      const tracker = repoCfg.tracker || 'notion';
      const hasToken = !(
        !process.env.NOTION_TOKEN && !readEnvToken(join(dir, '.env'))
      );

      const syncCheck = spawnSync(process.execPath, [
        join(here, 'sync.mjs'), dir, '--check', '--bundle-only',
      ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
      const syncDrift = syncCheck.status === 0 ? 'synced to local bundle' :
        syncCheck.status === 1 ? 'drift detected' : 'incomplete (run sync --check)';

      console.log(`Repo:      ${name} (${dir})`);
      console.log(
        `Branch:    ${branch} (${dirty === 0 ? 'clean' : `${dirty} uncommitted file(s)`})`,
      );
      console.log(`Worktrees: ${wtCount}`);
      console.log(
        `Tracker:   ${tracker}${tracker === 'notion' ? ` (Token: ${hasToken ? 'present' : 'MISSING'})` : ' (offline mode)'}`,
      );
      console.log(`Pre-push:  ${hasHook ? 'installed' : 'not installed'}`);
      console.log(`Workflow:  ${syncDrift}`);
      const inv = runInvariants(repoCfg, dir);
      console.log(
        `Invariants:${inv.total ? (inv.passed ? ` ${inv.total}/${inv.total} passed` : ` FAILED (${inv.failures[0]})`) : ' none configured'}`,
      );
      if (repoCfg.versioning?.enabled) {
        const vCfg = repoCfg.versioning;
        const rmPath = join(dir, vCfg.roadmapPath || 'docs/ROADMAP.md');
        const clPath = join(dir, vCfg.changelogPath || 'CHANGELOG.md');
        console.log(
          `Version:   current=${vCfg.currentVersion || 'unset'}, train=${vCfg.activeTrain || 'unset'} (roadmap: ${existsSync(rmPath) ? 'present' : 'missing'}, changelog: ${existsSync(clPath) ? 'present' : 'missing'})`,
        );
      }
      const tiers = getVerifyTiers(repoCfg);
      const tierEntries = Object.entries(tiers);
      if (tierEntries.length > 1) {
        console.log(
          `Verify:    ${tierEntries.map(([t, c]) => `${t}: "${c}"`).join(' | ')}`,
        );
      } else if (tierEntries.length === 1) {
        console.log(`Verify:    ${tierEntries[0][1]}`);
      }
      console.log('---');
    }
  },

  async verify() {
    const tiers = getVerifyTiers();
    const tierKeys = Object.keys(tiers);
    if (tierKeys.length === 0) {
      fail(
        'no verification commands configured in ticket.config.json (set "verify" or "verifyCommand")',
      );
    }

    if (opts.all) {
      console.log(`Running all verification tiers: ${tierKeys.join(' -> ')}\n`);
      for (const t of tierKeys) {
        console.log(`=== Tier: ${t} (${tiers[t]}) ===`);
        try {
          execSync(tiers[t], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'inherit',
            env: { ...process.env, CI: '1' },
          });
          console.log(`✓ Tier "${t}" passed.\n`);
        } catch (err) {
          fail(`verification tier "${t}" failed: ${err.message}`);
        }
      }
      console.log('All verification tiers passed.');
      return;
    }

    const requestedTier = opts.tier || 'test';
    const resolved = resolveVerifyCommand(config, requestedTier);
    if (!resolved) {
      fail(
        `unknown verification tier "${requestedTier}". Available tiers: ${tierKeys.join(', ')}`,
      );
    }

    console.log(`Running verification (${resolved.tier}): ${resolved.cmd}...`);
    try {
      execSync(resolved.cmd, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'inherit',
        env: { ...process.env, CI: '1' },
      });
      console.log(`✓ Verification (${resolved.tier}) passed.`);
    } catch (err) {
      fail(`verification (${resolved.tier}) failed: ${err.message}`);
    }
  },

  async hygiene() {
    console.log('=== Working-Tree Hygiene Check ===\n');
    const res = checkHygiene();
    if (res.issues.length > 0) {
      console.log('Issues found:');
      for (const iss of res.issues) {
        console.log(`  ✗ ${iss}`);
      }
    }
    if (res.warnings.length > 0) {
      console.log('Warnings:');
      for (const warn of res.warnings) {
        console.log(`  ⚠ ${warn}`);
      }
    }
    if (res.clean && res.warnings.length === 0) {
      console.log('✓ Working tree hygiene clean.');
    } else if (res.clean) {
      console.log('\n✓ No critical hygiene issues (see warnings above).');
    } else {
      fail('working tree hygiene check failed');
    }
  },

  async switch() {
    const entries = registeredWorktrees();
    const [main] = entries;
    const rawArg = opts.files[0] || opts.branch || opts.plan || '';
    const catalog = worktreeCatalog(entries);
    const explicit = rawArg.endsWith('.plan.md');
    const full = explicit ? resolve(rawArg) : null;
    const owner = explicit && entries.find((entry) => containsPath(join(entry.path, config.plansDir), full));
    if (explicit && !owner) fail(`plan is outside the registered checkouts: ${full}`);
    const targetPlan = explicit
      ? worktreePlan(full, owner.path)
      : rawArg
        ? catalog.find(({ plan }) => planWorktreeBranch(plan) === rawArg ||
          basename(plan.rel, '.plan.md').toLowerCase().includes(rawArg.toLowerCase()))?.plan
        : resolveActivePlan();
    const branch = targetPlan ? planWorktreeBranch(targetPlan) : rawArg;
    if (['main', 'master'].includes(rawArg) || !branch || ['main', 'master'].includes(branch)) {
      if (opts.path) return console.log(main.path);
      if (comparablePath(process.cwd()) === comparablePath(main.path))
        return console.log(`Already on main repository checkout: ${main.path}`);
      console.log(`Main repository checkout: ${main.path}`);
      return console.log(`Run: cd "${main.path}"`);
    }

    const worktree = ensurePlanWorktree(entries, branch, targetPlan, { noCreate: opts.noCreate });
    if (opts.path) return console.log(worktree.path);
    const action = opts.dryRun ? '[dry-run] Worktree target:' :
      worktree.created ? 'Created worktree at:' : 'Worktree exists at:';
    console.log(`${action} ${worktree.path} (branch: ${branch})`);
    console.log(`Run: cd "${worktree.path}"`);
  },

  async split() {
    const planArg = opts.files.find((f) => f.endsWith('.plan.md')) || opts.plan;
    let plan = null;
    try {
      plan = planArg ? readPlan(planArg) : resolveActivePlan();
    } catch {
      fail(
        'usage: node scripts/ticket.mjs split [<plan>] --after <#|query> [--title "<Part 2 Title>"]',
      );
    }

    const after = opts.after || opts.at;
    if (!after) {
      fail(
        'split requires --after <#|query> specifying the last item of Part 1. Example: node scripts/ticket.mjs split --after 3',
      );
    }

    const { lines, items } = findCheckboxes(plan.body);
    const criteriaItems = items.filter(
      (it) => it.section.toLowerCase() === 'acceptance criteria',
    );
    const stepItems = items.filter(
      (it) => it.section.toLowerCase() === 'steps',
    );

    let splitCriteriaIndex = -1;
    let splitStepIndex = -1;

    const isNum = /^\d+$/.test(String(after).trim());
    if (isNum) {
      const idx = parseInt(String(after).trim(), 10);
      if (idx >= 1 && idx <= criteriaItems.length) {
        splitCriteriaIndex = idx - 1;
        splitStepIndex = Math.min(idx - 1, stepItems.length - 1);
      } else {
        const match = items.find((it) => it.openIndex === idx);
        if (match) {
          if (match.section.toLowerCase() === 'acceptance criteria') {
            splitCriteriaIndex = criteriaItems.indexOf(match);
            splitStepIndex = Math.floor(stepItems.length / 2);
          } else {
            splitStepIndex = stepItems.indexOf(match);
            splitCriteriaIndex = Math.floor(criteriaItems.length / 2);
          }
        } else {
          splitCriteriaIndex = Math.min(idx - 1, criteriaItems.length - 1);
          splitStepIndex = Math.floor(stepItems.length / 2);
        }
      }
    } else {
      const query = String(after).toLowerCase();
      const match = items.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        fail(`split target "${after}" not found in ${plan.rel}`);
      }
      if (match.section.toLowerCase() === 'acceptance criteria') {
        splitCriteriaIndex = criteriaItems.indexOf(match);
        splitStepIndex = Math.floor(stepItems.length / 2);
      } else {
        splitStepIndex = stepItems.indexOf(match);
        splitCriteriaIndex = Math.floor(criteriaItems.length / 2);
      }
    }

    if (splitCriteriaIndex < 0 && criteriaItems.length > 1) {
      splitCriteriaIndex = Math.floor(criteriaItems.length / 2) - 1;
    }
    if (splitStepIndex < 0 && stepItems.length > 1) {
      splitStepIndex = Math.floor(stepItems.length / 2) - 1;
    }

    const part1Criteria = criteriaItems.slice(0, splitCriteriaIndex + 1);
    const part2Criteria = criteriaItems.slice(splitCriteriaIndex + 1);
    const part1Steps = stepItems.slice(0, splitStepIndex + 1);
    const part2Steps = stepItems.slice(splitStepIndex + 1);

    if (part2Criteria.length === 0 && part2Steps.length === 0) {
      fail(
        'cannot split plan: no items remain for Part 2 after the split point.',
      );
    }

    const baseName = basename(plan.rel, '.plan.md');
    const month = today().slice(0, 7);
    let part2File = '';
    if (/-Part-\d+/.test(baseName)) {
      part2File =
        baseName.replace(
          /-Part-(\d+)/,
          (_, n) => `-Part-${parseInt(n, 10) + 1}`,
        ) + '.plan.md';
    } else if (new RegExp(`-${month}$`).test(baseName)) {
      part2File = baseName.replace(
        new RegExp(`-${month}$`),
        `-Part-2-${month}.plan.md`,
      );
    } else {
      part2File = `${baseName}-Part-2.plan.md`;
    }
    const part2Rel = join(config.plansDir, part2File).replace(/\\/g, '/');
    const part2Full = join(repoRoot, part2Rel);

    if (existsSync(part2Full)) {
      fail(`target Part 2 plan already exists: ${part2Rel}`);
    }

    const part1Title = plan.meta.title || baseName;
    let part2Title = opts.title || '';
    if (!part2Title) {
      if (/\(Part \d+\)/.test(part1Title)) {
        part2Title = part1Title.replace(
          /\(Part (\d+)\)/,
          (_, n) => `(Part ${parseInt(n, 10) + 1})`,
        );
      } else {
        part2Title = `${part1Title} (Part 2)`;
      }
    }

    if (!/\(Part \d+\)/.test(plan.meta.title)) {
      plan.meta.title = `${plan.meta.title} (Part 1)`;
    }

    const movedSet = new Set([
      ...part2Criteria.map((it) => it.lineIndex),
      ...part2Steps.map((it) => it.lineIndex),
    ]);

    for (const lineIdx of movedSet) {
      const it = items.find((item) => item.lineIndex === lineIdx);
      if (it && !it.isDeferred) {
        lines[lineIdx] =
          `${it.prefix} ${it.delim}${it.text} deferred: moved to Part 2 (${part2Rel})`;
      }
    }

    plan.body = lines.join('\n');
    plan.body = appendToSection(
      plan.body,
      'Notes',
      `Split into Part 2: [Part 2](${part2Rel})`,
    );
    writePlan(plan);

    const part2CriteriaText = part2Criteria.length
      ? part2Criteria
          .map((it) => `- [ ] ${it.text.replace(/\s*deferred:.*$/i, '')}`)
          .join('\n')
      : '- [ ] <Checkable outcome>';

    const part2StepsText = part2Steps.length
      ? part2Steps
          .map((it) => `- [ ] ${it.text.replace(/\s*deferred:.*$/i, '')}`)
          .join('\n')
      : '- [ ] <Step>';

    const part2Summary = `Part 2 continuation of ${plan.rel}.\nCovers subsequent milestones and remaining acceptance criteria.`;

    const part2Content = [
      '---',
      `title: ${part2Title}`,
      'ticket:',
      'status: draft',
      `priority: ${plan.meta.priority || 'medium'}`,
      `state: ${plan.meta.state || 'flow'}`,
      `due: ${plan.meta.due || ''}`,
      `appetite: ${plan.meta.appetite || ''}`,
      `version: ${plan.meta.version || ''}`,
      `impact: ${plan.meta.impact || ''}`,
      '---',
      `# ${part2Title.replace(/^[^:]+:\s*/, '')}`,
      '',
      '## Summary',
      '',
      part2Summary,
      '',
      '## Acceptance criteria',
      '',
      part2CriteriaText,
      '',
      '## Steps',
      '',
      part2StepsText,
      '',
      '## Risks',
      '',
      'Inherited risks from Part 1; consult parent plan for architectural context.',
      '',
      '## Out of scope',
      '',
      `Scope completed in Part 1 (${plan.rel}).`,
      '',
      '## Notes',
      '',
      `Part 1 plan: [Part 1](${plan.rel})`,
      '',
      '## Progress log',
      '',
      '<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->',
      '',
    ].join('\n');

    writeFileSync(part2Full, part2Content);

    console.log(`Plan split successfully.`);
    console.log(
      `Part 1: ${plan.rel} (${part1Criteria.length} criteria, ${part1Steps.length} steps remaining; ${movedSet.size} deferred to Part 2)`,
    );
    console.log(
      `Part 2: ${part2Rel} (${part2Criteria.length} criteria, ${part2Steps.length} steps)`,
    );
    console.log(
      `To ticket Part 2: node scripts/ticket.mjs create ${part2Rel} --agent <client>`,
    );
  },

  async fleet() {
    const sub = (opts.files[0] || '').toLowerCase();

    // 1. Fleet Verification Matrix Runner
    if (sub === 'verify' || opts.verify) {
      const dirs = getKnownRepoDirs();
      const requestedTier = opts.tier || 'test';
      console.log(
        `=== Fleet Verification (${opts.all ? 'all tiers' : `tier: ${requestedTier}`}) ===\n`,
      );

      const results = [];
      const startTime = Date.now();

      for (const dir of dirs) {
        const repoName = basename(dir);
        let repoCfg = {};
        const cfgPath = join(dir, 'scripts/ticket.config.json');
        if (existsSync(cfgPath)) {
          try {
            repoCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
          } catch {}
        }

        const tiers = getVerifyTiers(repoCfg);
        const tierKeys = Object.keys(tiers);

        if (!tierKeys.length) {
          console.log(`- ${repoName}: SKIPPED (no verification configured)`);
          results.push({
            repo: repoName,
            status: 'skipped',
            reason: 'no verify command',
          });
          continue;
        }

        const runTiers = opts.all ? tierKeys : [requestedTier];
        for (const t of runTiers) {
          const resolved = resolveVerifyCommand(repoCfg, t);
          if (!resolved) {
            console.log(`- ${repoName} (${t}): SKIPPED (tier not defined)`);
            results.push({
              repo: repoName,
              tier: t,
              status: 'skipped',
              reason: 'tier not defined',
            });
            continue;
          }

          process.stdout.write(`• ${repoName} (${resolved.tier}): running... `);
          const t0 = Date.now();
          try {
            execSync(resolved.cmd, {
              cwd: dir,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
              env: { ...process.env, CI: '1' },
            });
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            process.stdout.write(
              `\r✓ ${repoName} (${resolved.tier}): PASS (${dur}s)\n`,
            );
            results.push({
              repo: repoName,
              tier: resolved.tier,
              status: 'pass',
              duration: dur,
            });
          } catch (err) {
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            process.stdout.write(
              `\r✗ ${repoName} (${resolved.tier}): FAIL (${dur}s)\n`,
            );
            results.push({
              repo: repoName,
              tier: resolved.tier,
              status: 'fail',
              duration: dur,
              error: err.message,
            });
          }
        }
      }

      const totalDur = ((Date.now() - startTime) / 1000).toFixed(1);
      const passed = results.filter((r) => r.status === 'pass').length;
      const failed = results.filter((r) => r.status === 'fail').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;

      console.log(
        `\nFleet Verification: ${passed} passed, ${failed} failed, ${skipped} skipped (${totalDur}s total).`,
      );

      if (failed > 0) {
        fail(`${failed} repository verification(s) failed across the fleet.`);
      }
      return;
    }

    // 2. Fleet PRs
    if (sub === 'pr' || opts.pr) {
      const dirs = getKnownRepoDirs();
      console.log('=== Fleet Open Pull Requests ===\n');
      const prs = [];

      for (const dir of dirs) {
        const repoName = basename(dir);
        let out = '';
        try {
          out = execFileSync(
            'gh',
            [
              'pr',
              'list',
              '--state',
              'open',
              '--json',
              'number,title,author,headRefName,url',
            ],
            { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
          );
        } catch {
          continue;
        }

        if (out) {
          try {
            const list = JSON.parse(out);
            for (const item of list) {
              prs.push({
                repo: repoName,
                number: `#${item.number}`,
                title: item.title,
                branch: item.headRefName || '',
                author: item.author?.login || 'unknown',
                url: item.url,
              });
            }
          } catch {}
        }
      }

      if (!prs.length) {
        console.log('No open pull requests found across the fleet.');
        return;
      }

      const colWidths = {
        repo: Math.max(4, ...prs.map((p) => p.repo.length)),
        number: Math.max(4, ...prs.map((p) => p.number.length)),
        branch: Math.max(6, ...prs.map((p) => p.branch.length)),
        author: Math.max(6, ...prs.map((p) => p.author.length)),
        title: Math.max(5, ...prs.map((p) => p.title.slice(0, 40).length)),
      };

      const header = [
        'Repo'.padEnd(colWidths.repo),
        'PR'.padEnd(colWidths.number),
        'Branch'.padEnd(colWidths.branch),
        'Author'.padEnd(colWidths.author),
        'Title'.padEnd(colWidths.title),
      ].join('  ');
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const p of prs) {
        console.log(
          [
            p.repo.padEnd(colWidths.repo),
            p.number.padEnd(colWidths.number),
            p.branch.padEnd(colWidths.branch),
            p.author.padEnd(colWidths.author),
            p.title.slice(0, 40).padEnd(colWidths.title),
          ].join('  '),
        );
      }
      return;
    }

    // 3. Fleet Worktrees
    if (sub === 'worktrees' || sub === 'wt' || opts.worktrees) {
      opts.fleet = true;
      opts.files = ['list'];
      return commands.wt();
    }

    // 4. Default Fleet Dashboard Table
    const dirs = getKnownRepoDirs();
    const rows = [];

    for (const dir of dirs) {
      const repoName = basename(dir);
      const isGit = existsSync(join(dir, '.git'));
      if (!isGit) continue;

      let branch = '(unknown)';
      try {
        branch = execFileSync(
          'git',
          ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        ).trim();
      } catch {}

      let statusShort = '';
      try {
        statusShort = execFileSync('git', ['-C', dir, 'status', '--short'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      } catch {}

      const dirtyCount = statusShort
        ? statusShort.split('\n').filter(Boolean).length
        : 0;
      const treeDisplay = dirtyCount === 0 ? 'clean' : `${dirtyCount} dirty`;

      let wtCount = 1;
      try {
        const wtOut = execFileSync(
          'git',
          ['-C', dir, 'worktree', 'list', '--porcelain'],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        wtCount = (wtOut.match(/^worktree /gm) || []).length || 1;
      } catch {}

      const repoCfg = readRepoConfig(dir);
      const activePlan = resolveRepoActivePlan(dir, branch, repoCfg);
      let activePlanName = '-';
      let reviewStatus = '-';

      if (activePlan) {
        activePlanName = activePlan.file.replace(/\.plan\.md$/, '').slice(0, 32);
        reviewStatus =
          activePlan.meta.reviewVerdict ||
          (activePlan.meta.reviewedBy ? 'reviewed' : 'unreviewed');
      }

      rows.push({
        repo: repoName,
        branch: branch.slice(0, 28),
        tree: treeDisplay,
        worktrees: String(wtCount),
        plan: activePlanName,
        review: reviewStatus,
      });
    }

    const colWidths = {
      repo: Math.max(4, ...rows.map((r) => r.repo.length)),
      branch: Math.max(6, ...rows.map((r) => r.branch.length)),
      tree: Math.max(4, ...rows.map((r) => r.tree.length)),
      worktrees: Math.max(2, ...rows.map((r) => r.worktrees.length)),
      plan: Math.max(4, ...rows.map((r) => r.plan.length)),
      review: Math.max(6, ...rows.map((r) => r.review.length)),
    };

    console.log(
      `=== Fleet Status Dashboard (${rows.length} repositories) ===\n`,
    );
    const header = [
      'Repo'.padEnd(colWidths.repo),
      'Branch'.padEnd(colWidths.branch),
      'Tree'.padEnd(colWidths.tree),
      'WT'.padStart(colWidths.worktrees),
      'Active Plan'.padEnd(colWidths.plan),
      'Review'.padEnd(colWidths.review),
    ].join('  ');

    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of rows) {
      console.log(
        [
          r.repo.padEnd(colWidths.repo),
          r.branch.padEnd(colWidths.branch),
          r.tree.padEnd(colWidths.tree),
          r.worktrees.padStart(colWidths.worktrees),
          r.plan.padEnd(colWidths.plan),
          r.review.padEnd(colWidths.review),
        ].join('  '),
      );
    }
    console.log('\nTips:');
    console.log('  node scripts/ticket.mjs fleet verify [--tier <name>|--all]');
    console.log('  node scripts/ticket.mjs fleet --pr');
    console.log('  node scripts/ticket.mjs fleet --worktrees');
  },

  async wave() {
    const entries = registeredWorktrees();
    const [main] = entries;
    const catalog = worktreeCatalog(entries);
    const specifiedPlans = opts.files.filter((f) => f.endsWith('.plan.md'));
    const active = ({ plan }) => ['in-progress', 'planned'].includes(plan.meta.status)
      && !worktreePlanClosed(plan);
    const dashboardActive = (item) =>
      active(item) || (item.entry !== main && item.plan.meta.status === 'in-progress');
    const printTable = (columns, rows) => {
      const widths = Object.fromEntries(
        columns.map((c) => [c.key, Math.max(c.label.length, ...rows.map((r) => String(r[c.key]).length))]),
      );
      const formatRow = (obj, isHeader = false) =>
        columns
          .map((c) => {
            const val = String(isHeader ? c.label : obj[c.key]);
            return c.align === 'right' ? val.padStart(widths[c.key]) : val.padEnd(widths[c.key]);
          })
          .join('  ');
      const headerLine = formatRow(null, true);
      console.log(headerLine);
      console.log('-'.repeat(headerLine.length));
      for (const r of rows) console.log(formatRow(r));
    };

    if (opts.spawn || opts.files[0] === 'spawn') {
      const targetPlans = specifiedPlans.length
        ? specifiedPlans.map((path) => {
          const full = resolve(path);
          const owner = entries.find((entry) => containsPath(join(entry.path, config.plansDir), full));
          if (!owner) fail(`plan is outside the registered checkouts: ${full}`);
          const requested = worktreePlan(full, owner.path);
          return catalog.find(({ plan }) => plan.rel === requested.rel)?.plan || requested;
        })
        : catalog.filter(active).map(({ plan }) => plan);
      if (!targetPlans.length) fail('no active or planned plans found to spawn in wave.');
      console.log(`=== Wave Orchestration: Spawning ${targetPlans.length} Worktree(s) ===\n`);
      const claimed = new Set();
      for (const plan of targetPlans) {
        if (worktreePlanClosed(plan)) fail(`cannot spawn a closed plan: ${plan.rel}`);
        const branch = planWorktreeBranch(plan);
        if (claimed.has(branch)) fail(`multiple plans claim worktree branch: ${branch}`);
        claimed.add(branch);
      }
      const allocations = [...entries];
      for (const plan of targetPlans) {
        const branch = planWorktreeBranch(plan);
        const worktree = ensurePlanWorktree(allocations, branch, plan);
        if (!allocations.some((entry) => entry.branch === branch))
          allocations.push({ branch, path: worktree.path });
        const path = relative(main.path, worktree.path).replace(/\\/g, '/');
        console.log(`• Plan: ${plan.rel}`);
        console.log(`  Branch: ${branch} | Worktree: ${path || '(main)'}`);
        if (!opts.dryRun)
          console.log(`  Builder brief: cd "${worktree.path}" && node scripts/ticket.mjs step --role builder\n`);
      }
      if (opts.dryRun) return console.log(`[dry-run] ${targetPlans.length} worktree target(s).`);
      return console.log(`Wave spawn complete: ${targetPlans.length} worktree(s) active.`);
    }

    if (opts.prune || opts.files[0] === 'prune') {
      console.log('=== Wave Lifecycle: Pruning Closed Wave Worktrees ===\n');
      pruneLinkedWorktrees({
        dirs: [main.path],
        dryRun: Boolean(opts.dryRun),
        filter: ({ main: mainEntry, entry }) => {
          if (!entry.branch) return false;
          const matching = allPlans(entry.path).filter(
            (p) => planWorktreeBranch(p) === entry.branch,
          );
          if (!matching.length || !matching.every((p) => worktreePlanClosed(p))) {
            return false;
          }
          return Boolean(opts.all || worktreeIsMerged(mainEntry.path, entry.head));
        },
      });
      return;
    }

    if (opts.check || opts.files[0] === 'check') {
      console.log('=== Wave Lifecycle Check ===\n');
      const targetItems = specifiedPlans.length
        ? specifiedPlans.map((path) => {
            const full = resolve(path);
            const owner = entries.find((entry) =>
              containsPath(join(entry.path, config.plansDir), full),
            );
            if (!owner) fail(`plan is outside the registered checkouts: ${full}`);
            const requested = worktreePlan(full, owner.path);
            return (
              catalog.find(({ plan }) => plan.rel === requested.rel) || {
                plan: requested,
                entry: owner,
              }
            );
          })
        : catalog.filter((item) => opts.all || dashboardActive(item));
      if (!targetItems.length) {
        return console.log('No active plans or wave worktrees found.');
      }

      const verifyTier = opts.tier || config.agentic?.verifyTier || 'test';
      const resolvedVerify = opts.test
        ? resolveVerifyCommand(config, verifyTier) || resolveVerifyCommand(config, 'test')
        : null;
      if (opts.test && !resolvedVerify) {
        fail(`wave --check --test requires a configured verification command for tier "${verifyTier}"`);
      }

      const details = [];
      let anyFailed = false;
      const rows = targetItems.map(({ plan, entry }) => {
        const workerPath = relative(main.path, entry.path).replace(/\\/g, '/');
        const planIssues = problems(plan, { dir: entry.path });
        const hyg = checkHygiene(config, entry.path);
        const hygieneProblems = [
          ...hyg.issues,
          ...((opts.strict || config.hygiene?.strict) ? hyg.warnings : []),
        ];
        let testStatus = 'skipped';
        let testFailed = false;
        if (opts.test && resolvedVerify) {
          const vRes = runVerifyCmd(resolvedVerify.cmd, {
            cwd: entry.path,
            captureOutput: true,
          });
          testFailed = !vRes.ok;
          testStatus = vRes.ok ? 'PASS' : 'FAIL';
        }
        const ok = !planIssues.length && !hygieneProblems.length && !testFailed;
        if (!ok) {
          anyFailed = true;
          details.push({
            plan: plan.rel,
            worktree: workerPath || '(main)',
            planIssues,
            hygieneProblems,
            testFailed,
          });
        }
        return {
          plan: plan.rel.replace(/^docs\/plans\/|\.plan\.md$/g, '').slice(0, 36),
          worktree: (workerPath || '(main)').slice(0, 30),
          problems: planIssues.length ? `${planIssues.length} issue(s)` : '0',
          hygiene: hygieneProblems.length ? `${hygieneProblems.length} fail` : 'clean',
          ...(opts.test ? { test: testStatus } : {}),
          status: ok ? 'PASS' : 'FAIL',
        };
      });

      const columns = [
        { key: 'plan', label: 'Plan' },
        { key: 'worktree', label: 'Worktree' },
        { key: 'problems', label: 'Problems' },
        { key: 'hygiene', label: 'Hygiene' },
        ...(opts.test ? [{ key: 'test', label: 'Test' }] : []),
        { key: 'status', label: 'Status' },
      ];
      printTable(columns, rows);

      if (anyFailed) {
        console.log('\nFailures:');
        for (const d of details) {
          console.log(`• ${d.plan} (${d.worktree}):`);
          for (const iss of d.planIssues) console.log(`  - [plan] ${iss}`);
          for (const h of d.hygieneProblems) console.log(`  - [hygiene] ${h}`);
          if (d.testFailed) console.log(`  - [test] ${resolvedVerify.cmd} failed`);
        }
        fail('wave --check detected failing worktree(s).');
      }
      return console.log(`\nWave check passed: ${rows.length} worktree(s) clean.`);
    }

    console.log('=== Wave Orchestration Dashboard ===\n');
    const activePlans = catalog.filter((item) => opts.all || dashboardActive(item));
    if (!activePlans.length) return console.log('No active plans or wave worktrees found.');

    const rows = activePlans.map(({ plan, entry }) => {
      const { items } = findCheckboxes(plan.body);
      const closed = items.filter((item) => item.openIndex === null).length;
      const workerPath = relative(main.path, entry.path).replace(/\\/g, '/');
      const review = plan.meta.reviewVerdict || (plan.meta.reviewedBy ? 'reviewed' : 'unreviewed');
      const ownCheckout = comparablePath(entry.path) === comparablePath(repoRoot);
      const issues = problems(plan, { ignoreReview: !ownCheckout, dir: entry.path });
      const ready = issues.length || review === 'block' ? 'no' : ownCheckout ? 'YES' : 'check there';
      return {
        plan: plan.rel.replace(/^docs\/plans\/|\.plan\.md$/g, '').slice(0, 36),
        branch: (plan.meta.branch || entry.branch || '-').slice(0, 24),
        worktree: (workerPath || '(main)').slice(0, 30),
        progress: `${closed}/${items.length}`,
        review,
        ready,
      };
    });

    printTable(
      [
        { key: 'plan', label: 'Plan' },
        { key: 'branch', label: 'Branch' },
        { key: 'worktree', label: 'Worktree' },
        { key: 'progress', label: 'Progress', align: 'right' },
        { key: 'review', label: 'Review' },
        { key: 'ready', label: 'Ready' },
      ],
      rows,
    );

    console.log('\nCommands:');
    console.log('  node scripts/ticket.mjs wave --spawn');
    console.log('  node scripts/ticket.mjs wave --status');
    console.log('  node scripts/ticket.mjs wave --check [--test]');
    console.log('  node scripts/ticket.mjs wave --prune [--dry-run]');
    console.log('  node scripts/ticket.mjs step --role builder');
  },

  async lesson() {
    const textVal = (opts.files.join(' ') || opts.text || '').trim();
    if (!textVal) {
      fail('usage: node scripts/ticket.mjs lesson "<takeaway>" [--tags <a,b>] [--plan <path>]');
    }
    const tags = (opts.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const planRel = opts.plan ? relative(repoRoot, resolve(repoRoot, opts.plan)).replace(/\\/g, '/') : '';
    const res = appendLesson({ text: textVal, tags, planRel });
    console.log(`Lesson recorded in docs/lessons.md: ${res.line}`);
  },

  async stats() {
    const explicitDays = opts.days !== undefined;
    const days = explicitDays ? Math.max(0, parseInt(opts.days, 10) || 0) : 90;
    const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];
    const perRepo = dirs.map((d) => collectRepoStats(d, { days, filterDays: explicitDays }));

    if (perRepo.length === 1) {
      const s = perRepo[0];
      if (opts.json) {
        return console.log(JSON.stringify(s, null, 2));
      }
      printRepoStatsReport(s);
      return;
    }

    const combinedStatus = {};
    const combinedType = {};
    const combinedVersion = {};
    const allSamples = [];
    let totalPlans = 0;
    let reviewsTotal = 0;
    let reviewsPass = 0;
    let reviewsWarn = 0;
    let reviewsBlock = 0;
    let selfReviews = 0;
    let cbTotal = 0;
    let cbChecked = 0;
    let cbDeferred = 0;
    let totalRetries = 0;
    let circuitBreakers = 0;
    let lessonsCount = 0;
    const allEscaped = [];

    for (const r of perRepo) {
      totalPlans += r.totalPlans;
      for (const [k, v] of Object.entries(r.byStatus)) {
        combinedStatus[k] = (combinedStatus[k] || 0) + v;
      }
      for (const [k, v] of Object.entries(r.byType)) {
        combinedType[k] = (combinedType[k] || 0) + v;
      }
      for (const [k, v] of Object.entries(r.byVersion || {})) {
        combinedVersion[k] = (combinedVersion[k] || 0) + v;
      }
      allSamples.push(...r.cycleTimeDays.samples);
      reviewsTotal += r.reviews.total;
      reviewsPass += r.reviews.pass;
      reviewsWarn += r.reviews.warn;
      reviewsBlock += r.reviews.block;
      selfReviews += r.reviews.selfReviews;
      cbTotal += r.checkboxes.total;
      cbChecked += r.checkboxes.checked;
      cbDeferred += r.checkboxes.deferred;
      totalRetries += r.retries.totalRetries;
      circuitBreakers += r.retries.circuitBreakers;
      lessonsCount += r.lessonsCount;
      for (const ed of r.escapedDefects) {
        allEscaped.push({ repo: r.repo, ...ed });
      }
    }
    allSamples.sort((a, b) => a - b);

    const fleetSummary = {
      fleet: true,
      days,
      repoCount: perRepo.length,
      totalPlans,
      byStatus: combinedStatus,
      byType: combinedType,
      byVersion: combinedVersion,
      cycleTimeDays: {
        sampleSize: allSamples.length,
        median: percentile(allSamples, 0.5),
        p90: percentile(allSamples, 0.9),
      },
      reviews: {
        total: reviewsTotal,
        pass: reviewsPass,
        warn: reviewsWarn,
        block: reviewsBlock,
        selfReviews,
        passRate: reviewsTotal ? round1((reviewsPass / reviewsTotal) * 100) : 0,
        warnRate: reviewsTotal ? round1((reviewsWarn / reviewsTotal) * 100) : 0,
        blockRate: reviewsTotal ? round1((reviewsBlock / reviewsTotal) * 100) : 0,
        selfReviewRate: reviewsTotal ? round1((selfReviews / reviewsTotal) * 100) : 0,
      },
      checkboxes: {
        total: cbTotal,
        checked: cbChecked,
        deferred: cbDeferred,
        deferralRate: cbTotal ? round1((cbDeferred / cbTotal) * 100) : 0,
      },
      retries: {
        totalRetries,
        circuitBreakers,
      },
      lessonsCount,
      escapedDefects: allEscaped,
      repos: perRepo,
    };

    if (opts.json) {
      return console.log(JSON.stringify(fleetSummary, null, 2));
    }
    printRepoStatsReport(fleetSummary, { isFleet: true });
  },

  async release() {
    const rawSub = (opts.files[0] || '').trim().toLowerCase();
    const isKnownSub = ['status', 'notes', 'closeout', 'init'].includes(rawSub);
    const sub = isKnownSub ? rawSub : 'status';
    const verArg = isKnownSub
      ? opts.files[1] || opts.version || ''
      : opts.files[0] || opts.version || '';

    const verCfg = config.versioning || {};
    const tagPrefix = verCfg.tagPrefix ?? 'v';
    const roadmapRel = (verCfg.roadmapPath || 'docs/ROADMAP.md').replace(/\\/g, '/');
    const roadmapFull = join(repoRoot, roadmapRel);
    const changelogRel = (verCfg.changelogPath || 'CHANGELOG.md').replace(/\\/g, '/');
    const changelogFull = join(repoRoot, changelogRel);

    const normalizeVer = (v) =>
      String(v || '')
        .trim()
        .replace(/^v(?=\d)/i, '');

    if (sub === 'init') {
      if (existsSync(roadmapFull) && !opts.force) {
        fail(`${roadmapRel} already exists (pass --force to overwrite)`);
      }
      const curVer = verCfg.currentVersion || '1.0.0';
      const activeTrain = verCfg.activeTrain || '1.1.0';
      const roadmapTemplate = [
        `# ${config.prefix || basename(repoRoot)} Product & Release Roadmap`,
        '',
        'Canonical single-file release roadmap connecting strategic forward version trains with per-PR plan execution (`docs/plans/*.plan.md`).',
        '',
        '## Current Shipped Release',
        '',
        `### ${curVer}`,
        '- Status: **Shipped**',
        '- Baseline production release.',
        '',
        '## Active Release Train',
        '',
        `### ${activeTrain}`,
        '- Status: **In Progress**',
        '- Target plans carry `version: ' + activeTrain + '` in `docs/plans/*.plan.md`.',
        '- Run `node scripts/ticket.mjs release status ' + activeTrain + '` to inspect train progress.',
        '',
        '## Upcoming Release Trains',
        '',
        '### Next Minor / Major Train',
        '- Status: **Planned**',
        '- Candidate capabilities queued for future trains.',
        '',
        '## Candidate Backlog (Unassigned)',
        '',
        '- Ideas and capabilities awaiting version-train assignment.',
        '',
      ].join('\n');
      mkdirSync(dirname(roadmapFull), { recursive: true });
      writeFileSync(roadmapFull, roadmapTemplate, 'utf8');
      console.log(`Initialized canonical roadmap: ${roadmapRel}`);
      return;
    }

    const allFound = scanPlansIncludingArchive(repoRoot);
    const impactRank = { none: 0, patch: 1, minor: 2, major: 3 };
    const rankToImpact = ['none', 'patch', 'minor', 'major'];

    const existingTags = new Set(
      git(['tag', '-l'], { allowFail: true })
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean),
    );

    const isVersionTagged = (ver) =>
      existingTags.has(`${tagPrefix}${ver}`) || existingTags.has(ver);

    const classifyPlan = (p) => {
      const st = (p.meta.status || 'draft').toLowerCase();
      const ver = normalizeVer(p.meta.version);
      const tagged = ver ? isVersionTagged(ver) : false;
      const openCheckboxes = findCheckboxes(p.body).items.filter(
        (it) => it.openIndex !== null,
      ).length;
      const isClosedOut =
        st === 'done' ||
        st === 'shipped' ||
        st === 'merged' ||
        (openCheckboxes === 0 && Boolean(p.meta.pr || p.meta.reviewedBy));
      const title = p.meta.title || basename(p.rel, '.plan.md');
      const isCloseout =
        /^(?:Plan\s*-\s*Process:\s*)?Release Closeout\b/i.test(title) ||
        /(?:^|\/)[^/]*-Plan-Release-Closeout-/i.test(p.rel);

      let releaseState = 'planned';
      if (isClosedOut) {
        releaseState = tagged ? 'shipped' : 'ready';
      } else if (st === 'in-progress') {
        releaseState = 'in-progress';
      }
      return {
        rel: p.rel,
        title,
        shortTitle: title
          .replace(/^(?:Plan|Debug|Ask)\s*-\s*[^:]+:\s*/i, '')
          .trim(),
        type: parsePlanTypeFromMeta(p.meta),
        status: st,
        releaseState,
        version: ver,
        impact: (p.meta.impact || 'none').toLowerCase(),
        isCloseout,
        pr: p.meta.pr || '',
        ticket: p.meta.ticket || '',
        summary: section(p.body, 'Summary') || '',
        openCheckboxes,
      };
    };

    const parsedRoadmapTrains = new Set();
    if (existsSync(roadmapFull)) {
      const rmText = readFileSync(roadmapFull, 'utf8');
      for (const m of rmText.matchAll(/^#{2,3}\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\]?/gm)) {
        parsedRoadmapTrains.add(normalizeVer(m[1]));
      }
    }

    if (sub === 'notes') {
      const targetVer = normalizeVer(verArg || verCfg.activeTrain);
      if (!targetVer) {
        fail(
          'usage: node scripts/ticket.mjs release notes <version> [--write] [--all]',
        );
      }
      const allForVer = allFound
        .map(classifyPlan)
        .filter((p) => p.version === targetVer && !p.isCloseout);
      const closedForVer = allForVer.filter((p) =>
        ['ready', 'shipped'].includes(p.releaseState),
      );
      const openForVer = allForVer.filter(
        (p) => !['ready', 'shipped'].includes(p.releaseState),
      );
      const matching = opts.all ? allForVer : closedForVer;
      if (!matching.length) {
        if (!opts.all && openForVer.length) {
          fail(
            `no closed-out plans found targeting version "${targetVer}" (${openForVer.length} still open; close them out or pass --all to preview)`,
          );
        }
        fail(`no plans found targeting version "${targetVer}"`);
      }
      if (!opts.all && openForVer.length) {
        console.warn(
          `Warning: skipping ${openForVer.length} unclosed plan(s) for ${targetVer} (${openForVer.map((p) => basename(p.rel)).join(', ')}); pass --all to include.`,
        );
      }

      const added = [];
      const changed = [];
      const fixed = [];

      for (const p of matching) {
        const firstSentence = (p.summary.split(/\r?\n/)[0] || p.shortTitle)
          .replace(/\s+/g, ' ')
          .trim();
        let prRef = '';
        if (p.pr) {
          const prNumMatch = p.pr.match(/\/pull\/(\d+)/);
          prRef = prNumMatch ? ` ([#$1](${p.pr}))`.replace('$1', prNumMatch[1]) : ` (${p.pr})`;
        }
        const bullet = `- **${p.shortTitle}**: ${firstSentence}${prRef}`;
        const tLower = p.type.toLowerCase();
        if (tLower === 'bug' || tLower === 'debug') {
          fixed.push(bullet);
        } else if (tLower === 'feature') {
          added.push(bullet);
        } else {
          changed.push(bullet);
        }
      }

      const noteLines = [`## [${targetVer}] - ${today()}`];
      if (added.length) {
        noteLines.push('', '### Added', ...added);
      }
      if (changed.length) {
        noteLines.push('', '### Changed', ...changed);
      }
      if (fixed.length) {
        noteLines.push('', '### Fixed', ...fixed);
      }
      const notesBlock = noteLines.join('\n');

      if (opts.write) {
        mkdirSync(dirname(changelogFull), { recursive: true });
        if (!existsSync(changelogFull)) {
          const initCl = [
            '# Changelog',
            '',
            'All notable changes to this project will be documented in this file.',
            '',
            notesBlock,
            '',
          ].join('\n');
          writeFileSync(changelogFull, initCl, 'utf8');
        } else {
          const existingCl = readFileSync(changelogFull, 'utf8').replace(/\r\n/g, '\n');
          const verHeaderRe = new RegExp(
            `^## \\[${targetVer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\n]*\\n[\\s\\S]*?(?=^## \\[|$)`,
            'm',
          );
          let updatedCl;
          if (verHeaderRe.test(existingCl)) {
            updatedCl = existingCl.replace(verHeaderRe, `${notesBlock}\n\n`);
          } else {
            const firstReleaseIdx = existingCl.search(/^## \[/m);
            if (firstReleaseIdx >= 0) {
              updatedCl = `${existingCl.slice(0, firstReleaseIdx)}${notesBlock}\n\n${existingCl.slice(firstReleaseIdx)}`;
            } else {
              updatedCl = `${existingCl.trimEnd()}\n\n${notesBlock}\n`;
            }
          }
          writeFileSync(changelogFull, `${updatedCl.trimEnd()}\n`, 'utf8');
        }
        console.log(`Updated ${changelogRel} for release ${targetVer}.`);
        return;
      }

      console.log(notesBlock);
      return;
    }

    if (sub === 'closeout') {
      const targetVer = normalizeVer(verArg || verCfg.activeTrain);
      if (!targetVer) {
        fail(
          'usage: node scripts/ticket.mjs release closeout <version> [--branch]',
        );
      }
      const matching = allFound
        .map(classifyPlan)
        .filter((p) => p.version === targetVer && !p.isCloseout);
      const openPlans = matching.filter(
        (p) => p.releaseState !== 'ready' && p.releaseState !== 'shipped',
      );

      const kebabVer = targetVer.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const month = today().slice(0, 7);
      const filename = `${config.prefix}-Plan-Release-Closeout-${kebabVer}-${month}.plan.md`;
      const relPath = join(config.plansDir, filename).replace(/\\/g, '/');
      const fullPath = join(repoRoot, relPath);

      if (existsSync(fullPath)) {
        fail(`release closeout plan already exists: ${relPath}`);
      }

      const trainListLines = matching.length
        ? matching.map(
            (p) =>
              `- \`${p.rel}\` (${p.releaseState}, impact: ${p.impact}) — ${p.title}`,
          )
        : [`- (no plans currently tagged with version: ${targetVer})`];

      const closeoutContent = [
        '---',
        `title: Plan - Process: Release Closeout ${targetVer}`,
        'ticket:',
        'status: draft',
        'priority: high',
        'state: flow',
        'due:',
        'appetite: S',
        `version: ${targetVer}`,
        'impact: none',
        '---',
        `# Release Closeout ${targetVer}`,
        '',
        '## Summary',
        '',
        `Close out release train ${targetVer}, reconcile ${roadmapRel} and ${changelogRel}, update currentVersion in scripts/ticket.config.json, and verify all release gates.`,
        '',
        '## Context',
        '',
        `Plans in release train ${targetVer} (${matching.length} total, ${openPlans.length} still open):`,
        ...trainListLines,
        '',
        '## Open questions',
        '',
        'None',
        '',
        '## Acceptance criteria',
        '',
        `- [ ] AC1: All plans targeting version \`${targetVer}\` are closed out and \`node scripts/ticket.mjs release status ${targetVer}\` reports 0 open/in-progress plans.`,
        `- [ ] AC2: \`${changelogRel}\` contains the generated \`## [${targetVer}]\` section via \`node scripts/ticket.mjs release notes ${targetVer} --write\`.`,
        `- [ ] AC3: \`${roadmapRel}\` marks \`${targetVer}\` as Shipped and \`scripts/ticket.config.json\` updates \`versioning.currentVersion\` to \`${targetVer}\`.`,
        `- [ ] AC4: Full verification (\`node scripts/ticket.mjs verify --all\`) passes cleanly on the release closeout branch.`,
        '',
        '## Steps',
        '',
        `- [ ] Verify all train plans for ${targetVer} are closed out with \`node scripts/ticket.mjs release status ${targetVer}\` (AC1)`,
        `- [ ] Generate and write release notes to ${changelogRel} with \`node scripts/ticket.mjs release notes ${targetVer} --write\` (AC2)`,
        `- [ ] Update ${roadmapRel} and set \`versioning.currentVersion\` to \`${targetVer}\` in \`scripts/ticket.config.json\` (AC3)`,
        '- [ ] Run `node scripts/ticket.mjs verify --all` and record verification evidence (AC4)',
        '',
        '## Risks',
        '',
        'Shipping a release while a train plan is still in-progress or unverified — mitigated by checking `release status` in AC1 before writing release notes.',
        '',
        '## Out of scope',
        '',
        'Features assigned to subsequent release trains.',
        '',
        '## Notes',
        '',
        `Scaffolded via \`node scripts/ticket.mjs release closeout ${targetVer}\`.`,
        '',
        '## Progress log',
        '',
        '<!-- One line per session/review, added with `ticket.mjs log` or `ticket.mjs review` -->',
        '',
      ].join('\n');

      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, closeoutContent, 'utf8');
      console.log(`Created release closeout plan: ${relPath}`);
      if (openPlans.length) {
        console.warn(
          `Warning: ${openPlans.length} plan(s) targeting ${targetVer} are still open (${openPlans.map((p) => basename(p.rel)).join(', ')}).`,
        );
      }

      if (opts.branch) {
        const agent = (opts.agent || process.env.AI_CLIENT || 'feat').toLowerCase();
        const branchName = `${agent}/release-closeout-${kebabVer.toLowerCase()}`;
        try {
          git(['checkout', '-b', branchName]);
          console.log(`Checked out branch: ${branchName}`);
        } catch (err) {
          console.warn(`Could not checkout branch ${branchName}: ${err.message}`);
        }
      }
      return;
    }

    // Default sub === 'status'
    const filterVer = normalizeVer(verArg);
    const classified = allFound
      .map(classifyPlan)
      .filter((p) => {
        if (!p.version || p.isCloseout) return false;
        if (!opts.all && ['none', 'internal'].includes(p.version.toLowerCase())) {
          return false;
        }
        return !filterVer || p.version === filterVer;
      });

    const trainsMap = new Map();
    if (filterVer) {
      trainsMap.set(filterVer, []);
    } else if (verCfg.activeTrain) {
      trainsMap.set(normalizeVer(verCfg.activeTrain), []);
    }
    for (const p of classified) {
      if (!trainsMap.has(p.version)) trainsMap.set(p.version, []);
      trainsMap.get(p.version).push(p);
    }

    const trains = [];
    for (const [ver, list] of trainsMap.entries()) {
      let maxRank = 0;
      const counts = { shipped: 0, ready: 0, 'in-progress': 0, planned: 0 };
      for (const item of list) {
        counts[item.releaseState] = (counts[item.releaseState] || 0) + 1;
        const r = impactRank[item.impact] ?? 0;
        if (r > maxRank) maxRank = r;
      }
      const tagged = isVersionTagged(ver);
      const inRoadmap = parsedRoadmapTrains.has(ver);
      trains.push({
        version: ver,
        tag: `${tagPrefix}${ver}`,
        tagged,
        inRoadmap,
        highestImpact: rankToImpact[maxRank] || 'none',
        totalPlans: list.length,
        counts,
        plans: list,
      });
    }

    const statusPayload = {
      repo: basename(repoRoot),
      versioningEnabled: Boolean(verCfg.enabled),
      currentVersion: verCfg.currentVersion || null,
      activeTrain: verCfg.activeTrain || null,
      roadmapPath: roadmapRel,
      roadmapExists: existsSync(roadmapFull),
      changelogPath: changelogRel,
      changelogExists: existsSync(changelogFull),
      trains,
    };

    if (opts.json) {
      console.log(JSON.stringify(statusPayload, null, 2));
      return;
    }

    console.log(
      `=== Release Train Status: ${statusPayload.repo}${filterVer ? ` (${filterVer})` : ''} ===`,
    );
    console.log(
      `Current Version: ${statusPayload.currentVersion || 'unset'} | Active Train: ${statusPayload.activeTrain || 'unset'} | Versioning: ${statusPayload.versioningEnabled ? 'enabled' : 'opt-in (disabled)'}`,
    );
    console.log(
      `Roadmap: ${roadmapRel} (${statusPayload.roadmapExists ? 'present' : 'missing'}) | Changelog: ${changelogRel} (${statusPayload.changelogExists ? 'present' : 'missing'})`,
    );

    if (!trains.length) {
      console.log('\nNo versioned plans found.');
      return;
    }

    for (const t of trains) {
      console.log(
        `\nTrain ${t.version} [tag: ${t.tag} (${t.tagged ? 'tagged' : 'unreleased'}), impact: ${t.highestImpact}, roadmap: ${t.inRoadmap ? 'listed' : 'unlisted'}] — ${t.totalPlans} plan(s) (shipped: ${t.counts.shipped}, ready: ${t.counts.ready}, in-progress: ${t.counts['in-progress']}, planned: ${t.counts.planned})`,
      );
      for (const p of t.plans) {
        console.log(
          `  • [${p.releaseState}] ${p.rel} (${p.type}, impact: ${p.impact}) — ${p.shortTitle}`,
        );
      }
    }
  },
};

function printRepoStatsReport(s, { isFleet = false } = {}) {
  const header = isFleet
    ? `=== Fleet Workflow Stats (${s.repoCount} repos, window: ${s.days || 'all'}d) ===`
    : `=== Workflow Stats: ${s.repo} (window: ${s.days || 'all'}d) ===`;
  console.log(header);
  const statusStr = Object.entries(s.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || 'none';
  const typeStr = Object.entries(s.byType)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || 'none';
  console.log(`Plans:           ${s.totalPlans} (${statusStr})`);
  console.log(`Types:           ${typeStr}`);
  const verEntries = Object.entries(s.byVersion || {});
  if (verEntries.length) {
    console.log(
      `Versions:        ${verEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    );
  }
  const ct = s.cycleTimeDays;
  console.log(
    `Cycle time:      ${ct.sampleSize ? `median ${ct.median}d, p90 ${ct.p90}d (n=${ct.sampleSize})` : 'n/a'}`,
  );
  const rv = s.reviews;
  console.log(
    `Reviews:         ${rv.total} total (pass ${rv.passRate}%, warn ${rv.warnRate}%, block ${rv.blockRate}%, self-review ${rv.selfReviewRate}%)`,
  );
  const cb = s.checkboxes;
  console.log(
    `Checkboxes:      ${cb.checked}/${cb.total} ticked, ${cb.deferred} deferred (${cb.deferralRate}%)`,
  );
  console.log(
    `Retries/Breaks:  ${s.retries.totalRetries} retry(ies), ${s.retries.circuitBreakers} circuit-breaker(s)`,
  );
  console.log(`Lessons logged:  ${s.lessonsCount}`);
  if (s.escapedDefects.length) {
    console.log(`Escaped defects: ${s.escapedDefects.length} potential within 14d:`);
    for (const ed of s.escapedDefects) {
      const prefix = ed.repo ? `[${ed.repo}] ` : '';
      console.log(
        `  - ${prefix}${ed.kind}: ${ed.defectRef} -> ${ed.sourcePlan} (+${ed.daysAfter}d, files: ${ed.overlappingFiles.join(', ')})`,
      );
    }
  } else {
    console.log('Escaped defects: 0 detected');
  }
}

if (!commands[command])
  fail(
    `unknown command "${command || ''}". Commands: ${Object.keys(commands).join(', ')}`,
  );
await commands[command]();

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
} from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

function checkHygiene(cfg = config) {
  const issues = [];
  const warnings = [];
  const maxKB = cfg.hygiene?.maxFileSizeKB || 1024;
  const patterns = artifactPatterns(cfg);
  const statusLines = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    allowFail: true, trim: false,
  }).split('\0').filter(Boolean);
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
    const fullPath = join(repoRoot, file);
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
    const wtOut = git(['worktree', 'list', '--porcelain'], { allowFail: true });
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

function problems(plan, { requireTicket = true, ignoreReview = false, base, head } = {}) {
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
        !/\sverified:\s*\S/i.test(item.text))
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
      plan.meta.reviewFingerprint !== reviewFingerprint(plan, base, head)) {
      found.push('review does not cover this change; run pack and review again');
    }
  }
  return found;
}

function missingCheckboxes(original, candidate) {
  const identity = (item) => JSON.stringify([
    item.section.toLowerCase(),
    item.text.replace(/\s+(?:verified|deferred):.*$/i, '').trim(),
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

function git(args, { allowFail = false, trim = true } = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd: repoRoot,
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

function resolveDiffBase() {
  if (opts.base)
    return (
      git(['merge-base', opts.base, 'HEAD'], { allowFail: true }) || opts.base
    );
  const candidates = (
    config.protectedBranches || ['main', 'master', 'develop']
  ).flatMap((b) => [`origin/${b}`, b]);
  for (const ref of candidates) {
    const mb = git(['merge-base', ref, 'HEAD'], { allowFail: true });
    if (mb) return mb;
  }
  return (
    git(['rev-parse', 'HEAD~1'], { allowFail: true }) ||
    git(['rev-parse', 'HEAD'], { allowFail: true })
  );
}

function reviewFingerprint(plan, base = resolveDiffBase(), head) {
  if (!base) fail('review needs a Git baseline; commit the plan before reviewing');
  const diff = execFileSync('git', [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
    '--no-color', '--no-renames', base, ...(head ? [head] : []), '--',
    '.', `:(exclude,literal)${plan.rel}`,
  ], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const scope = ['Summary', 'Acceptance criteria', 'Steps', 'Out of scope']
    .map((heading) => section(plan.body, heading));
  return createHash('sha256').update(JSON.stringify(scope)).update(diff).digest('hex');
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

    const summary = (opts.summary || '').replace(/^["']|["']$/g, '').trim();
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
      : '- [ ] <Checkable outcome>';

    const stepsList = rawSteps
      ? rawSteps
          .split(/[|,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => `- [ ] ${s}`)
          .join('\n')
      : '- [ ] <Step>';

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
        .replace(/^# <Title>.*$/m, `# ${topic}`)
        .replace(/<!--[\s\S]*?-->\n*/m, '');
      if (summary) {
        content = content.replace(
          /<2-3 sentences: what changes and why\.>/,
          summary,
        );
      }
      if (rawCriteria) {
        content = content.replace(/- \[ \] <Checkable outcome>/, criteriaList);
      }
      if (rawSteps) {
        content = content.replace(/- \[ \] <Step>/, stepsList);
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
        '---',
        `# ${topic}`,
        '',
        '## Summary',
        '',
        summary || '<2-3 sentences: what changes and why.>',
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
        '<What could go wrong and how it is contained.>',
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

    const lines = [
      `# Session Context: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Status: ${localPlanStatus(plan) || 'unknown'} | Ticket: ${plan.meta.ticket || 'none'}`,
      `Branch: ${branch} | Tree: ${clean ? 'clean' : 'dirty'}${plan.meta.reviewedBy ? ` | Reviewed: ${plan.meta.reviewedBy} (${plan.meta.reviewVerdict})` : ''}`,
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

    const inCriteria = match.section.toLowerCase() === 'acceptance criteria';
    let verifiedText = opts.verified || opts.v || '';
    if (inCriteria && !verifiedText && !/verified:/i.test(match.text)) {
      fail(
        `ticking an acceptance criterion requires verified evidence. Pass --verified "<how it was checked and result>".`,
      );
    }

    let updatedText = match.text;
    if (verifiedText) {
      if (/verified:/i.test(updatedText)) {
        updatedText = updatedText.replace(
          /verified:.*$/i,
          `verified: ${verifiedText}`,
        );
      } else {
        updatedText = `${updatedText} verified: ${verifiedText}`;
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
    const branch =
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ||
      'detached';

    const { items } = findCheckboxes(plan.body);
    const openCriteria = items.filter(
      (it) =>
        it.openIndex !== null &&
        it.section.toLowerCase() === 'acceptance criteria',
    );
    const openSteps = items.filter(
      (it) => it.openIndex !== null && it.section.toLowerCase() === 'steps',
    );

    const nextItem = openSteps[0] || openCriteria[0] || null;
    const cfgAgentic = config.agentic || {};
    const maxRetries = opts.maxRetries
      ? parseInt(opts.maxRetries, 10)
      : (cfgAgentic.maxRetries ?? 3);
    const currentRetries = parseInt(plan.meta.retryCount || '0', 10) || 0;
    const requestedTier = opts.tier || cfgAgentic.verifyTier || 'test';
    const resolvedVerify =
      resolveVerifyCommand(config, requestedTier) ||
      resolveVerifyCommand(config, 'test');
    const verifyCmd = resolvedVerify
      ? resolvedVerify.cmd
      : config.verifyCommand || 'npm test';
    const verifyTier = resolvedVerify ? resolvedVerify.tier : 'test';

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
    if (role) {
      if (role === 'builder') {
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
        console.log(brief.join('\n'));
        return;
      }

      if (role === 'reviewer') {
        const criteriaList =
          section(plan.body, 'Acceptance criteria') || '(none)';
        const brief = [
          `# Adversarial Review Brief: ${plan.meta.title || plan.rel}`,
          `Plan: ${plan.rel} | Branch: ${plan.meta.branch || branch}`,
          '',
          '## Review Protocol (Fresh Context Window)',
          '1. Inspect review packet with embedded test verification:',
          `   node scripts/ticket.mjs pack --test${verifyTier !== 'test' ? ` --tier ${verifyTier}` : ''}`,
          '',
          '## Acceptance Criteria to Verify',
          criteriaList,
          '',
          '## Evaluation Rubric',
          '- Spec Fidelity: Does the code fulfill every criterion accurately?',
          '- Verification Honesty: Does every ticked criterion cite verified evidence without fake claims?',
          '- Test Regressions: Did all tests pass cleanly?',
          '- Code Hygiene: No temporary files, conflict markers, or debris.',
          '',
          '## Verdict Command',
          `node scripts/ticket.mjs review ${plan.rel} --agent <you> --verdict <pass|warn|block> --summary "<concise findings>"`,
        ];
        console.log(brief.join('\n'));
        return;
      }

      if (role === 'fixer') {
        const progressSection = section(plan.body, 'Progress log') || '';
        const progressLines = progressSection
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('<!--') && !l.endsWith('-->'));
        const blockLogs = progressLines.filter((l) =>
          /review:\s*block/i.test(l),
        );
        const latestBlock = blockLogs.length
          ? blockLogs[blockLogs.length - 1]
          : '(no block review verdict found)';

        const criteriaList = openCriteria.length
          ? openCriteria.map((c) => `- [${c.openIndex}] ${c.text}`).join('\n')
          : section(plan.body, 'Acceptance criteria') || '(none)';

        const brief = [
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
        ];
        console.log(brief.join('\n'));
        return;
      }

      fail(
        `unknown --role "${opts.role}". Allowed roles: builder, reviewer, fixer`,
      );
    }

    if (!nextItem) {
      console.log(`All criteria and steps in ${plan.rel} are completed!`);
      console.log(
        `Next: run \`node scripts/ticket.mjs pack --test\` or \`node scripts/ticket.mjs step --role reviewer\``,
      );
      return;
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
    console.log(linesOut.join('\n'));
  },

  async checkpoint() {
    const planArg = opts.files.find((f) => f.endsWith('.plan.md'));
    const plan = planArg ? readPlan(planArg) : resolveActivePlan();

    const { lines, items } = findCheckboxes(plan.body);
    const openCriteria = items.filter(
      (it) =>
        it.openIndex !== null &&
        it.section.toLowerCase() === 'acceptance criteria',
    );
    const openSteps = items.filter(
      (it) => it.openIndex !== null && it.section.toLowerCase() === 'steps',
    );
    const openItems = items.filter((it) => it.openIndex !== null);
    if (!openItems.length) {
      fail(`all checkboxes in ${plan.rel} are already completed or deferred.`);
    }

    const defaultTargetItem = openSteps[0] || openCriteria[0] || openItems[0];
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
    const isNum = /^\d+$/.test(rawTarget.trim());
    if (isNum) {
      const idx = parseInt(rawTarget.trim(), 10);
      match = openItems.find((it) => it.openIndex === idx);
      if (!match) {
        fail(
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${openItems.length})`,
        );
      }
    } else {
      const query = rawTarget.toLowerCase();
      match = openItems.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        fail(`no open checkbox found matching "${rawTarget}" in ${plan.rel}`);
      }
    }

    const cfgAgentic = config.agentic || {};
    const maxRetries = opts.maxRetries
      ? Number(opts.maxRetries)
      : (cfgAgentic.maxRetries ?? 3);
    const requestedTier = opts.tier || cfgAgentic.verifyTier || 'test';
    const resolvedVerify = resolveVerifyCommand(config, requestedTier);
    if (!resolvedVerify || opts.noVerify)
      fail(`checkpoint requires verification for tier "${requestedTier}"`);
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 1)
      fail('checkpoint retry limit must be a positive integer');
    if (opts.dryRun && opts.commit)
      fail('checkpoint --commit cannot be used with --dry-run');

    const previousRetries = parseInt(plan.meta.retryCount || '0', 10) || 0;
    const stopAtLimit = (attempts) => fail(
      `CIRCUIT BREAKER TRIPPED (${attempts}/${maxRetries} failed verification attempts on \`${resolvedVerify.cmd}\`). Record a handoff before continuing.`,
    );
    if (previousRetries >= maxRetries) stopAtLimit(previousRetries);

    const originalPlanContents = readFileSync(plan.full);
    const stagedChanges = () => git(['diff', '--cached', '--binary', '--no-ext-diff']);
    const stagedPaths = () => git(['diff', '--cached', '--name-only', '--no-renames', '-z'])
      .split('\0').filter(Boolean);
    const originalIndexDiff = opts.commit ? stagedChanges() : '';
    const checkpointPaths = opts.commit ? [...new Set([...stagedPaths(), plan.rel])] : [];

    if (opts.commit) {
      const unstagedPaths = git(['diff', '--name-only', '--no-renames', '-z'])
        .split('\0').filter(Boolean);
      if (unstagedPaths.some((path) => path !== plan.rel && checkpointPaths.includes(path)))
        fail('checkpoint has files with both staged and unstaged edits; stage the intended version first');
    }

    console.log(`• Running checkpoint verification (\`${resolvedVerify.cmd}\`)...`);
    try {
      execSync(resolvedVerify.cmd, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'inherit',
        env: { ...process.env, CI: '1' },
      });
    } catch {
      const currentRetries = previousRetries + 1;
      if (!readFileSync(plan.full).equals(originalPlanContents))
        fail('checkpoint verification changed the plan; inspect the change before retrying');
      plan.meta.retryCount = String(currentRetries);
      writePlan(plan);
      if (currentRetries >= maxRetries) stopAtLimit(currentRetries);
      fail(`checkpoint verification failed (attempt ${currentRetries}/${maxRetries}: \`${resolvedVerify.cmd}\`).`);
    }
    if (!readFileSync(plan.full).equals(originalPlanContents))
      fail('checkpoint verification changed the plan; inspect the change before retrying');
    delete plan.meta.retryCount;

    if (opts.commit) {
      const unstagedPaths = git(['diff', '--name-only', '--no-renames', '-z'])
        .split('\0').filter(Boolean);
      if (stagedChanges() !== originalIndexDiff ||
          unstagedPaths.some((path) => path !== plan.rel && checkpointPaths.includes(path)))
        fail('checkpoint changes moved during verification; inspect the index before retrying');
      const hyg = checkHygiene();
      if (!hyg.clean && !opts.force) {
        fail(
          `checkpoint commit blocked by hygiene issues:\n- ${hyg.issues.join('\n- ')}`,
        );
      }
    }

    const inCriteria = match.section.toLowerCase() === 'acceptance criteria';
    let verifiedText = opts.verified || opts.v || '';
    if (inCriteria && !verifiedText && !/\sverified:\s*\S/i.test(match.text)) {
      verifiedText = `verify ${resolvedVerify.tier} passed (exit code 0)`;
    }

    let updatedText = match.text;
    if (verifiedText) {
      if (/verified:/i.test(updatedText)) {
        updatedText = updatedText.replace(
          /verified:.*$/i,
          `verified: ${verifiedText}`,
        );
      } else {
        updatedText = `${updatedText} verified: ${verifiedText}`;
      }
    }

    lines[match.lineIndex] = `${match.prefix}x${match.delim}${updatedText}`;
    plan.body = lines.join('\n');
    writePlan(plan);

    if (opts.commit) {
      const commitMsg =
        opts.message ||
        opts.m ||
        `feat(checkpoint): complete [${match.openIndex}] - ${match.text.replace(/[:"']/g, '').slice(0, 50)}`;
      try {
        execFileSync('git', [
          '--literal-pathspecs', 'commit', '--only', '-m', commitMsg, '--', ...checkpointPaths,
        ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        writeFileSync(plan.full, originalPlanContents);
        fail(`checkpoint commit rejected; plan restored: ${error.stderr?.trim() || error.message}`);
      }
      const commitHash = git(['rev-parse', '--short', 'HEAD']);
      console.log(`✓ Git checkpoint committed: ${commitHash} "${commitMsg}"`);
    }
    console.log(`✓ Ticked [${match.openIndex}]: - [x] ${updatedText}`);

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
      console.log(
        `All criteria and steps in ${plan.rel} are now completed! Ready for review.`,
      );
    }
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
    let page;
    if (config.lifeAreaPageId) {
      try {
        page = await notion(
          'POST',
          'pages',
          {
            parent,
            properties: {
              ...properties,
              'Life Area': { relation: [{ id: config.lifeAreaPageId }] },
            },
          },
          { soft: true },
        );
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
    if (!page) page = await notion('POST', 'pages', { parent, properties });
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

    console.log(`\n=== Resuming Session ===`);
    console.log(`Plan:         ${plan.rel} (${localPlanStatus(plan) || 'unknown'})`);
    console.log(`Branch:       ${branch} (${clean ? 'clean' : 'dirty'})`);
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

    const lines = [
      `# Review Packet: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Status: ${localPlanStatus(plan) || 'unknown'} | Branch: ${plan.meta.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })}`,
      `Ticket: ${plan.meta.ticket || 'none'} | Reviewed: ${plan.meta.reviewedBy ? `${plan.meta.reviewedBy} (${plan.meta.reviewVerdict || 'unknown'})` : 'not yet'}`,
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

      const promptText = [
        `# Single-Pass Review Request: ${plan.meta.title || plan.rel}`,
        `Plan: ${plan.rel} | Branch: ${branch}`,
        `Verify Command: \`${verifyCmd}\``,
        '',
        '## Acceptance Criteria to Verify',
        criteria,
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
      ].join('\n');

      console.log(promptText);
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

    // Guardrail: if stamping "pass", verify criteria & hygiene
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
        .filter((l) => /^\s*- \[[xX]\]/.test(l) && !/\sverified:\s*\S/i.test(l));
      if (unverified.length > 0) {
        fail(
          `cannot stamp review verdict "pass": ${unverified.length} criterion ticked without verified evidence. Pass --force to override.`,
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
    if (verdict === 'block') {
      delete plan.meta.reviewFingerprint;
    } else {
      if (git(['ls-files', '--others', '--exclude-standard', '--', '.', `:(exclude,literal)${plan.rel}`]))
        fail('review omits untracked files; stage the reviewed files before stamping a verdict');
      plan.meta.reviewFingerprint = reviewFingerprint(plan);
    }
    plan.body = appendToSection(
      plan.body,
      'Progress log',
      `- ${stamp} UTC, ${agent} (review: ${verdict}${dualPassMeta}): ${summary}`,
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
    const hyg = checkHygiene();
    if (!hyg.clean) {
      if (opts.strict || config.hygiene?.strict) {
        fail(`working tree hygiene failed:\n- ${hyg.issues.join('\n- ')}`);
      } else {
        console.warn(`Hygiene issues detected:\n- ${hyg.issues.join('\n- ')}`);
      }
    }
    console.log(`${plan.rel}: closed out.`);
  },

  async ship() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`${plan.rel} is not closed out:\n- ${found.join('\n- ')}`);
    if (!/^https:\/\//.test(opts.pr || ''))
      fail('ship needs --pr <pull request URL>; open the PR first.');
    await linkPullRequest(plan, opts.pr);
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
    const linkedHead = await linkPullRequest(plan, prUrl, { branch, head });
    if (linkedHead !== head) pushPrCommit(branch, linkedHead);

    if (opts.auto) {
      prCommand('gh', [
        'pr', 'merge', prUrl, '--auto', '--squash', '--delete-branch',
        '--match-head-commit', linkedHead,
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
    const isClosed = (text) => {
      if (/^status:\s*(?:done|shipped)\s*$/im.test(text.split('\n---\n')[0])) return true;
      // Earlier merges sometimes kept in-progress metadata on completed plans.
      const { items } = findCheckboxes(bodyOf(text));
      return items.length > 0 && items.every((item) =>
        item.isChecked || /\sdeferred:\s*\S/i.test(item.text));
    };
    for (const file of removedPaths.filter(isPlanPath)) {
      if (!isClosed(git(['show', `${opts.base}:${file}`], { allowFail: true })))
        fail(`active plan removed or renamed: ${file}`);
    }
    const plans = changedPaths
      .filter(isPlanPath)
      .map((file) => ({
        plan: readPlanText(git(['show', `${opts.head}:${file}`]), file),
        original: originalPlan(file, opts.base, opts.head),
        baseline: git(['show', `${opts.base}:${file}`], { allowFail: true }),
      }))
      .filter(({ baseline }) => !isClosed(baseline));
    if (!plans.length) {
      if (process.env.NO_PLAN !== '1')
        fail(
          `no plan with a ticket header changed in this PR. Add one under ${config.plansDir}/ (see AGENTS.md), or add the "no-plan" label for a trivial change.`,
        );
      const { maxChangedLines, noNewFilesUnder } = config.noPlan;
      const changed = git(['diff', '--numstat', range])
        .split('\n')
        .filter(Boolean)
        .reduce((n, l) => {
          const [a, d] = l.split('\t');
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
        .filter(Boolean);
      const policyChanged = [...changedPaths, ...removedPaths]
        .some((file) => WORKFLOW_FILES.has(file) || file.startsWith('.github/workflows/'));
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

      const plansDir = join(dir, 'docs/plans');
      let activePlan = null;
      let openBoxes = '-';
      let state = 'Idle';

      if (existsSync(plansDir)) {
        try {
          const files = readdirSync(plansDir).filter(
            (f) => f.endsWith('.plan.md') && !f.startsWith('_'),
          );
          const plans = files.map((f) => {
            const raw = readFileSync(join(plansDir, f), 'utf8');
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

          activePlan = plans.find((p) => p.meta.branch === branch);
          if (!activePlan && branch !== 'main' && branch !== 'master') {
            activePlan = plans.find((p) => p.meta.status === 'in-progress');
          }
          if (activePlan) {
            state =
              activePlan.meta.status === 'in-progress'
                ? 'Doing'
                : activePlan.meta.status || 'Active';
            const openCriteria = (activePlan.raw.match(/^- \[ \] /gm) || [])
              .length;
            openBoxes = String(openCriteria);
          }
        } catch {}
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
    let gitDir;
    try {
      gitDir = git(['rev-parse', '--git-path', 'hooks']);
    } catch {
      gitDir = join(repoRoot, '.git', 'hooks');
    }
    const hookPath = resolve(repoRoot, gitDir, 'pre-push');

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
      console.log(`Pre-push hook installed: ${hookPath}`);
    } else if (action === 'uninstall') {
      if (existsSync(hookPath)) {
        unlinkSync(hookPath);
        console.log(`Pre-push hook removed: ${hookPath}`);
      } else {
        console.log(`Pre-push hook not present: ${hookPath}`);
      }
    } else if (action === 'status') {
      console.log(
        existsSync(hookPath)
          ? `Pre-push hook is installed at ${hookPath}`
          : `Pre-push hook is NOT installed. Run 'node scripts/ticket.mjs hook install' to install.`,
      );
    } else {
      fail('usage: node scripts/ticket.mjs hook [install|uninstall|status]');
    }
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
      let totalPruned = 0;
      let candidates = 0;
      for (const dir of dirs) {
        const [main, ...linked] = registeredWorktrees(dir);
        if (main.bare) continue;
        for (const entry of linked) {
          const path = entry.path;
          if (entry.locked || !existsSync(path) ||
            containsPath(path, repoRoot) || containsPath(path, process.cwd()) ||
            !containsPath(join(realpathSync(main.path), '.worktrees'), realpathSync(path))) continue;
          try {
            if (worktreeGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) continue;
            if ((!opts.all || !entry.branch) && !worktreeIsMerged(main.path, entry.head)) continue;
          } catch {
            continue;
          }
          candidates++;
          if (opts.dryRun) {
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
      if (opts.dryRun) console.log(`[dry-run] ${candidates} worktree(s) eligible.`);
      console.log(`Prune complete: ${totalPruned} worktree(s) pruned.`);
      return;
    }

    fail(
      'usage: node scripts/ticket.mjs wt [list|new|prune] [--fleet] [--all]',
    );
  },

  async recall() {
    const query = (opts.files.join(' ') || opts.query || '').trim();
    if (!query) {
      fail('usage: node scripts/ticket.mjs recall "<keyword>" [--fleet]');
    }
    const qLower = query.toLowerCase();
    const queryTerms = qLower.split(/\s+/).filter(Boolean);
    const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];

    const results = [];
    for (const dir of dirs) {
      const repoName = basename(dir);
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
      return console.log(`No records found matching "${query}".`);
    }

    console.log(
      `=== Recall: "${query}" (${results.length} match${results.length === 1 ? '' : 'es'}${opts.fleet ? ' across fleet' : ''}) ===\n`,
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

      const hookPath = join(dir, '.git', 'hooks', 'pre-push');
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

      const plansDir = join(dir, 'docs/plans');
      let activePlanName = '-';
      let reviewStatus = '-';

      if (existsSync(plansDir)) {
        try {
          const files = readdirSync(plansDir).filter(
            (f) => f.endsWith('.plan.md') && !f.startsWith('_'),
          );
          for (const f of files) {
            const raw = readFileSync(join(plansDir, f), 'utf8');
            const match = raw.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
              const meta = Object.fromEntries(
                match[1]
                  .split('\n')
                  .filter((l) => l.includes(':'))
                  .map((l) => {
                    const idx = l.indexOf(':');
                    return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
                  }),
              );
              if (
                meta.branch === branch ||
                (branch !== 'main' && meta.status === 'in-progress')
              ) {
                activePlanName = f.replace(/\.plan\.md$/, '').slice(0, 32);
                reviewStatus =
                  meta.reviewVerdict ||
                  (meta.reviewedBy ? 'reviewed' : 'unreviewed');
                break;
              }
            }
          }
        } catch {}
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

    console.log('=== Wave Orchestration Dashboard ===\n');
    const activePlans = catalog.filter((item) => opts.all || active(item) ||
      (item.entry !== main && item.plan.meta.status === 'in-progress'));
    if (!activePlans.length) return console.log('No active plans or wave worktrees found.');

    const rows = activePlans.map(({ plan, entry }) => {
      const { items } = findCheckboxes(plan.body);
      const closed = items.filter((item) => item.openIndex === null).length;
      const workerPath = relative(main.path, entry.path).replace(/\\/g, '/');
      const review = plan.meta.reviewVerdict || (plan.meta.reviewedBy ? 'reviewed' : 'unreviewed');
      const ownCheckout = comparablePath(entry.path) === comparablePath(repoRoot);
      const issues = problems(plan, { ignoreReview: !ownCheckout });
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

    const colWidths = {
      plan: Math.max(4, ...rows.map((r) => r.plan.length)),
      branch: Math.max(6, ...rows.map((r) => r.branch.length)),
      worktree: Math.max(8, ...rows.map((r) => r.worktree.length)),
      progress: Math.max(8, ...rows.map((r) => r.progress.length)),
      review: Math.max(6, ...rows.map((r) => r.review.length)),
      ready: Math.max(5, ...rows.map((r) => r.ready.length)),
    };

    const header = [
      'Plan'.padEnd(colWidths.plan),
      'Branch'.padEnd(colWidths.branch),
      'Worktree'.padEnd(colWidths.worktree),
      'Progress'.padStart(colWidths.progress),
      'Review'.padEnd(colWidths.review),
      'Ready'.padEnd(colWidths.ready),
    ].join('  ');

    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of rows) {
      console.log(
        [
          r.plan.padEnd(colWidths.plan),
          r.branch.padEnd(colWidths.branch),
          r.worktree.padEnd(colWidths.worktree),
          r.progress.padStart(colWidths.progress),
          r.review.padEnd(colWidths.review),
          r.ready.padEnd(colWidths.ready),
        ].join('  '),
      );
    }

    console.log('\nCommands:');
    console.log('  node scripts/ticket.mjs wave --spawn');
    console.log('  node scripts/ticket.mjs wave --status');
    console.log('  node scripts/ticket.mjs step --role builder');
  },
};

if (!commands[command])
  fail(
    `unknown command "${command || ''}". Commands: ${Object.keys(commands).join(', ')}`,
  );
await commands[command]();

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
//   node scripts/ticket.mjs ci-done  --head <merge sha>                           CI: set merged plans' Tasks to Done
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
  rmSync,
  cpSync,
} from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const config = JSON.parse(
  readFileSync(join(here, 'ticket.config.json'), 'utf8')
);
const NOTION_VERSION = '2025-09-03';
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
]);
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (BOOLEAN_FLAGS.has(a)) {
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

function hasTicket(value) {
  return isLocal
    ? /^(https|local):\/\//.test(value || '')
    : /^https:\/\//.test(value || '');
}

// ---------- plan files ----------

function readPlan(path) {
  const full = resolve(path);
  if (!existsSync(full)) fail(`plan not found: ${path}`);
  const text = readFileSync(full, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = text.replace(/\r\n/g, '\n');
  const m = norm.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m)
    fail(
      `${path}: no frontmatter. Start from ${config.plansDir}/_template.plan.md.`
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
    plan.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out
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

function problems(plan, { requireTicket = true, ignoreReview = false } = {}) {
  const found = [];
  if (!plan.meta.title || plan.meta.title.startsWith('<'))
    found.push('frontmatter has no title');
  else if (!TITLE.test(plan.meta.title))
    found.push(
      `title must read "<${MODES.join('|')}> - <Type>: <Title>", e.g. "Plan - Feature: Smart Shortcut Suggestions" (got "${plan.meta.title}")`
    );
  for (const [key, { values }] of Object.entries(OPTIONAL)) {
    const v = (plan.meta[key] || '').toLowerCase();
    if (v && !Object.hasOwn(values, v))
      found.push(
        `${key} must be one of ${Object.keys(values).join(', ')}, or empty (got "${plan.meta[key]}")`
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
      `no ${isLocal ? 'ticket' : 'Notion ticket'} URL (run: node scripts/ticket.mjs create ${plan.rel} --agent <client>)`
    );
  if (!/^\s*- \[[ xX]\]/m.test(section(plan.body, 'Steps')))
    found.push('Steps section has no checkboxes');
  if (!/^\s*- \[[ xX]\]/m.test(section(plan.body, 'Acceptance criteria')))
    found.push('Acceptance criteria section has no checkboxes');
  for (const line of plan.body.split('\n')) {
    if (/^\s*- \[ \]/.test(line) && !/deferred:/i.test(line))
      found.push(`open item: ${line.trim()}`);
  }
  for (const line of section(plan.body, 'Acceptance criteria').split('\n')) {
    if (/^\s*- \[[xX]\]/.test(line) && !/verified:/i.test(line))
      found.push(
        `criterion ticked without evidence (append "verified: <how it was checked>"): ${line.trim()}`
      );
  }
  if (!ignoreReview) {
    const verdict = (plan.meta.reviewVerdict || '').toLowerCase();
    if (verdict === 'block')
      found.push(
        'review verdict is block (resolve findings and re-run review)'
      );
    else if (config.requireReview && !['pass', 'warn'].includes(verdict)) {
      found.push(
        `no passing review recorded (run: node scripts/ticket.mjs pack ${plan.rel}, then node scripts/ticket.mjs review ${plan.rel} --agent <client> --verdict pass --summary "<findings>")`
      );
    }
  }
  return found;
}

const BOX = /^\s*- \[[ xX]\]/gm;
const countBoxes = (body) =>
  ['Acceptance criteria', 'Steps'].reduce(
    (n, h) => n + (section(body, h).match(BOX) || []).length,
    0
  );
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

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
    (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase()
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
    /^\s*NOTION_TOKEN\s*=\s*"?([^"\r\n]+)"?/m
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
      `[dry-run] ${method} https://api.notion.com/v1/${path}\n${JSON.stringify(body, null, 2)}`
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
      'NOTION_TOKEN is not set (environment, .env, or main checkout .env). Stop here and tell the user; do not create the ticket another way.'
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
    }
  );
  if (!Array.isArray(page.results))
    fail(
      'Notion returned no query results; stop rather than risk creating a duplicate'
    );
  if (page.has_more || page.results.length > 1)
    fail(
      `multiple Tasks have Dev Ticket Key "${key}"; resolve the duplicate before continuing`
    );
  return page.results?.[0];
}

function recordTicket(plan, page, key, { recovered = false, agent } = {}) {
  if (!hasTicket(page.url || ''))
    fail(
      'Notion returned no canonical ticket URL; stop and inspect the Task before retrying'
    );
  plan.meta.ticket = page.url;
  plan.meta.devTicketKey = key;
  if (!recovered) {
    plan.meta.status = 'planned';
    plan.meta.agent = agent;
  }
  writePlan(plan);
  console.log(
    `Ticket ${recovered ? 'recovered' : 'created (To Do)'}: ${page.url}\nPlan updated: ${plan.rel}`
  );
}

const closeTicket = (url) => {
  if (isLocal || /^local:\/\//.test(url || '')) return Promise.resolve();
  return notion('PATCH', `pages/${pageId(url)}`, {
    properties: {
      Status: { status: { name: 'Done' } },
      'Completed At': { date: { start: today() } },
    },
  });
};
const text = (content) => [{ text: { content: content.slice(0, 1990) } }];

// ---------- plan resolution & diff helpers ----------

function allPlans() {
  const dir = join(repoRoot, config.plansDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.plan.md') && !f.startsWith('_'))
    .map((f) => join(dir, f))
    .filter((full) => readFileSync(full, 'utf8').startsWith('---'))
    .map((full) => readPlan(full));
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
      `usage: node scripts/ticket.mjs ${command} <plan-file> (no plans found in ${config.plansDir})`
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
  const inProgress = plans.filter((p) => p.meta.status === 'in-progress');
  if (inProgress.length === 1) return inProgress[0];
  if (plans.length === 1) return plans[0];
  fail(
    `usage: node scripts/ticket.mjs ${command} <plan-file> (multiple plans present; specify which one)`
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
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.plan.md') && !basename(f).startsWith('_'))
    .filter(
      (f) =>
        existsSync(join(repoRoot, f)) &&
        readFileSync(join(repoRoot, f), 'utf8').startsWith('---')
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

function isIgnoredDiffPath(filePath, ignorePatterns) {
  const name = basename(filePath);
  return ignorePatterns.some((pattern) => {
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return filePath === pattern || name === pattern;
  });
}

function formatFilteredDiff(
  rawDiff,
  { maxFileLines, maxLines, ignorePatterns }
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
        `... [truncated remaining diff after ${totalLines} lines; inspect specific files directly if needed]`
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

const commands = {
  async new() {
    const rawTopic = opts.files[0] || opts.topic || '';
    if (!rawTopic)
      fail(
        'usage: node scripts/ticket.mjs new "<Topic>" [--type Feature|Bug|Refactor|Process|Docs] [--priority <p>] [--state <s>] [--due <YYYY-MM-DD>] [--branch]'
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
          summary
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
        it.section.toLowerCase() === 'acceptance criteria'
    );
    const openSteps = items.filter(
      (it) => it.openIndex !== null && it.section.toLowerCase() === 'steps'
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
      `Plan: ${plan.rel} | Status: ${plan.meta.status || 'unknown'} | Ticket: ${plan.meta.ticket || 'none'}`,
      `Branch: ${branch} | Tree: ${clean ? 'clean' : 'dirty'}${plan.meta.reviewedBy ? ` | Reviewed: ${plan.meta.reviewedBy} (${plan.meta.reviewVerdict})` : ''}`,
      ...(config.verifyCommand ? [`Verify: \`${config.verifyCommand}\``] : []),
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
        'usage: node scripts/ticket.mjs tick [<plan>] <index|substring> [--verified "<evidence>"]'
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
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${openItems.length})`
        );
      }
    } else {
      const query = target.toLowerCase();
      match = openItems.find((it) => it.text.toLowerCase().includes(query));
      if (!match) {
        const alreadyTicked = items.find(
          (it) => it.isChecked && it.text.toLowerCase().includes(query)
        );
        if (alreadyTicked) {
          return console.log(
            `Item is already ticked in ${plan.rel}:\n  ${lines[alreadyTicked.lineIndex].trim()}`
          );
        }
        fail(`no open checkbox found matching "${target}" in ${plan.rel}`);
      }
    }

    const inCriteria = match.section.toLowerCase() === 'acceptance criteria';
    let verifiedText = opts.verified || opts.v || '';
    if (inCriteria && !verifiedText && !/verified:/i.test(match.text)) {
      fail(
        `ticking an acceptance criterion requires verified evidence. Pass --verified "<how it was checked and result>".`
      );
    }

    let updatedText = match.text;
    if (verifiedText) {
      if (/verified:/i.test(updatedText)) {
        updatedText = updatedText.replace(
          /verified:.*$/i,
          `verified: ${verifiedText}`
        );
      } else {
        updatedText = `${updatedText} verified: ${verifiedText}`;
      }
    }

    lines[match.lineIndex] = `${match.prefix}x${match.delim}${updatedText}`;
    plan.body = lines.join('\n');
    writePlan(plan);

    console.log(`Ticked [${match.openIndex}]: - [x] ${updatedText}`);

    const remaining = items.filter(
      (it) => it.openIndex !== null && it.lineIndex !== match.lineIndex
    );
    if (remaining.length > 0) {
      const next = remaining[0];
      console.log(
        `Next open item: - [ ] ${next.text} (section: ${next.section})`
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
        'usage: node scripts/ticket.mjs defer [<plan>] <index|substring> --reason "<why>"'
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
          `open item [${idx}] not found in ${plan.rel} (available open items: 1..${openItems.length})`
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
        'development tickets start To Do; use start after creation to begin work'
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
          { soft: true }
        );
      } catch (e) {
        if (
          !(
            (e.status === 400 &&
              e.code === 'validation_error' &&
              /Life Area/i.test(e.message)) ||
            (e.status === 404 && e.code === 'object_not_found')
          )
        )
          throw e;
        console.warn(
          `ticket: creating the Task with Life Area failed (${e.message}); retrying without it. To fix, share the Life Areas database with the Notion connection.`
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
          `${plan.rel} has no ticket yet; run create first, or pass --create.`
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
      `Ticket set to Doing: ${plan.meta.ticket}\nBranch ${branch} recorded in ${plan.rel}`
    );
  },

  async log() {
    const plan = onePlan();
    if (!opts.message)
      fail(
        'usage: node scripts/ticket.mjs log [<plan>] --agent <client> --message "<done>; next: <step>; open: <questions>"'
      );
    const agent = opts.agent || process.env.AI_CLIENT || 'Unknown';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    plan.body = appendToSection(
      plan.body,
      'Progress log',
      `- ${stamp} UTC, ${agent}: ${opts.message.replace(/\s+/g, ' ').trim()}`
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
        'usage: node scripts/ticket.mjs handoff --agent <agent> --done "<completed>" --next "<next step>" [--open "<questions>"]'
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
      `Tree:  ${dirtyCount ? `${dirtyCount} uncommitted file(s)` : 'clean'}`
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
    console.log(`Plan:         ${plan.rel} (${plan.meta.status || 'unknown'})`);
    console.log(`Branch:       ${branch} (${clean ? 'clean' : 'dirty'})`);
    if (statusShort) {
      console.log(
        `Dirty files:\n${statusShort
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}`
      );
    }
    console.log(`Last Handoff: ${lastHandoff}`);
    console.log(`Next Action:  ${nextStep}`);
    console.log(`Criteria:     ${openCriteria.length} remaining open`);
    if (config.verifyCommand) {
      console.log(`Verify with:  ${config.verifyCommand}`);
    }
    console.log(`========================\n`);
  },

  async pack() {
    const plan = onePlan();
    const base = resolveDiffBase();
    const maxFileLines = Number(
      opts['max-file-lines'] || config.packMaxFileLines || 120
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
          { allowFail: true }
        )
      : '';
    const filteredDiff = formatFilteredDiff(rawDiff, {
      maxFileLines,
      maxLines,
      ignorePatterns,
    });

    let testOutput = '';
    let testPassed = true;
    if (opts.test && config.verifyCommand) {
      try {
        const out = execSync(config.verifyCommand, {
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

    const lines = [
      `# Review Packet: ${plan.meta.title || plan.rel}`,
      `Plan: ${plan.rel} | Status: ${plan.meta.status || 'unknown'} | Branch: ${plan.meta.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })}`,
      `Ticket: ${plan.meta.ticket || 'none'} | Reviewed: ${plan.meta.reviewedBy ? `${plan.meta.reviewedBy} (${plan.meta.reviewVerdict || 'unknown'})` : 'not yet'}`,
      ...(config.verifyCommand
        ? [`Verify command: \`${config.verifyCommand}\``]
        : []),
      '',
      ...(opts.test && config.verifyCommand
        ? [
            '## Test Verification',
            `Command: \`${config.verifyCommand}\``,
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
      statusShort
        ? `Working tree status:\n${statusShort}`
        : 'Working tree: clean',
      '',
      `## Diff Stat (base: ${base ? base.slice(0, 10) : 'none'})`,
      diffStat || '(no changes)',
      '',
      '## Code Diff (filtered)',
      filteredDiff,
    ];
    console.log(lines.join('\n'));
  },

  async review() {
    const plan = onePlan();
    const agent = opts.agent || process.env.AI_CLIENT || '';
    if (!config.captureSources.includes(agent))
      fail(`--agent must be one of: ${config.captureSources.join(', ')}`);
    const verdict = (opts.verdict || 'pass').toLowerCase();
    if (!VERDICTS.includes(verdict))
      fail(`--verdict must be one of: ${VERDICTS.join(', ')}`);
    const summary = (opts.summary || opts.message || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!summary)
      fail(
        'usage: node scripts/ticket.mjs review [<plan>] --agent <client> --verdict <pass|warn|block> --summary "<findings>"'
      );
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    plan.meta.reviewedBy = agent;
    plan.meta.reviewVerdict = verdict;
    plan.body = appendToSection(
      plan.body,
      'Progress log',
      `- ${stamp} UTC, ${agent} (review: ${verdict}): ${summary}`
    );
    writePlan(plan);
    console.log(`Review (${verdict}) recorded in ${plan.rel} by ${agent}`);
  },

  async check() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`${plan.rel} is not closed out:\n- ${found.join('\n- ')}`);
    console.log(`${plan.rel}: closed out.`);
  },

  async ship() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`${plan.rel} is not closed out:\n- ${found.join('\n- ')}`);
    if (!/^https:\/\//.test(opts.pr || ''))
      fail('ship needs --pr <pull request URL>; open the PR first.');
    const deferred = deferredItems(plan.body);
    const deferredText = deferred.length
      ? `Deferred (${deferred.length}):\n${deferred.join('\n')}`
      : 'Deferred: none';
    if (!isLocal && /^https:\/\//.test(plan.meta.ticket || '')) {
      const id = pageId(plan.meta.ticket);
      await notion('PATCH', `pages/${id}`, {
        properties: { URL: { url: opts.pr } },
      });
      console.log(
        `Copy into the PR's "Deferred" section:\n${deferred.length ? deferred.join('\n') : 'None'}`
      );
      try {
        await notion(
          'POST',
          'comments',
          {
            parent: { page_id: id },
            rich_text: text(
              `Shipped for review: ${opts.pr}\nPlan ${plan.rel} is closed out. The Task moves to Done when the PR merges.\n${deferredText}`
            ),
          },
          { soft: true }
        );
      } catch (e) {
        console.warn(
          `ticket: could not add a comment (${e.message}); the PR link is set.`
        );
      }
    } else {
      console.log(
        `Copy into the PR's "Deferred" section:\n${deferred.length ? deferred.join('\n') : 'None'}`
      );
    }
    plan.meta.status = 'shipped';
    plan.meta.pr = opts.pr;
    writePlan(plan);
    console.log(`Ticket linked to ${opts.pr}`);
  },

  async pr() {
    const plan = onePlan();
    const found = problems(plan);
    if (found.length)
      fail(`plan is not closed out:\n- ${found.join('\n- ')}`);

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const protectedList = [
      ...(config.protectedBranches || ['main', 'master', 'develop']),
      'HEAD',
      '',
    ];
    if (protectedList.includes(branch)) {
      fail(
        `cannot open PR directly from protected branch "${branch}". Checkout a feature branch first.`
      );
    }

    const summary = section(plan.body, 'Summary') || '';
    const criteria = section(plan.body, 'Acceptance criteria') || '';
    const deferred = deferredItems(plan.body);
    const deferredText = deferred.length ? deferred.join('\n') : 'None';

    const prTemplatePath = join(
      repoRoot,
      '.github',
      'pull_request_template.md'
    );
    let body = '';
    if (existsSync(prTemplatePath)) {
      const template = readFileSync(prTemplatePath, 'utf8');
      body = template
        .replace(/<!-- 2-3 sentences: what changes and why -->/g, summary)
        .replace(
          /<!-- Paste the acceptance criteria list[\s\S]*?-->/g,
          criteria
        )
        .replace(
          /<!-- Explicitly note any unticked acceptance criteria[\s\S]*?-->/g,
          deferredText
        );
      if (plan.meta.ticket) {
        body = body.replace(
          /Ticket:\s*\[Notion Task\]\([^\)]*\)/g,
          `Ticket: ${plan.meta.ticket}`
        );
      }
    } else {
      body = [
        '## Summary',
        summary,
        '',
        '## Acceptance criteria',
        criteria,
        '',
        '## Deferred',
        deferredText,
        '',
        `Ticket: ${plan.meta.ticket || 'none'}`,
      ].join('\n');
    }

    if (opts.verify || opts.test) {
      if (config.verifyCommand) {
        console.log(`Running verifyCommand: ${config.verifyCommand}...`);
        try {
          execSync(config.verifyCommand, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'inherit',
            env: { ...process.env, CI: '1' },
          });
          console.log('Verification passed.');
        } catch (err) {
          fail(`verifyCommand failed before opening PR: ${err.message}`);
        }
      }
    }

    if (opts.dryRun || opts['dry-run']) {
      console.log('--- Dry Run: PR Title ---');
      console.log(plan.meta.title || plan.rel);
      console.log('--- Dry Run: PR Body ---');
      console.log(body);
      return;
    }

    try {
      git(['push', '-u', 'origin', branch]);
      console.log(`Branch ${branch} pushed to origin.`);
    } catch (err) {
      console.warn(
        `Could not push branch ${branch} automatically: ${err.message}`
      );
    }

    const title = plan.meta.title || plan.rel;
    const ghArgs = [
      'pr',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--head',
      branch,
    ];
    if (opts.draft) ghArgs.push('--draft');

    let prUrl = '';
    try {
      prUrl = execFileSync('gh', ghArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      console.error(
        'ticket: gh pr create failed. Ensure GitHub CLI (gh) is installed and authenticated (`gh auth login`).'
      );
      console.log('\n--- Generated PR Title ---');
      console.log(title);
      console.log('\n--- Generated PR Body ---');
      console.log(body);
      fail(err.message);
    }

    console.log(`Pull Request created: ${prUrl}`);
    opts.pr = prUrl;
    await commands.ship();

    try {
      git(['add', plan.rel]);
      git(['commit', '-m', `chore: link pr ${prUrl}`]);
      git(['push', 'origin', branch]);
      console.log(`Branch ${branch} updated with shipped ticket state.`);
    } catch (err) {
      console.warn(
        `Could not commit/push shipped state automatically: ${err.message}`
      );
    }

    if (opts.auto) {
      try {
        console.log(`Enabling auto-merge on ${prUrl}...`);
        execFileSync(
          'gh',
          ['pr', 'merge', prUrl, '--auto', '--squash', '--delete-branch'],
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        console.log(`Auto-merge enabled for ${prUrl}.`);
      } catch (err) {
        console.warn(
          `Could not enable auto-merge: ${err.stderr || err.message}`
        );
      }
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
    const plans = changedPlans([range]);
    if (!plans.length) {
      if (process.env.NO_PLAN !== '1')
        fail(
          `no plan with a ticket header changed in this PR. Add one under ${config.plansDir}/ (see AGENTS.md), or add the "no-plan" label for a trivial change.`
        );
      const { maxChangedLines, noNewFilesUnder } = config.noPlan;
      const changedFiles = git(['diff', '--name-only', range])
        .split('\n')
        .map(f => f.trim().replace(/\\/g, '/'))
        .filter(Boolean);
      const isWorkflowSync =
        changedFiles.length > 0 &&
        changedFiles.every(f => WORKFLOW_FILES.has(f));
      const changed = git(['diff', '--numstat', range])
        .split('\n')
        .filter(Boolean)
        .reduce((n, l) => {
          const [a, d] = l.split('\t');
          return n + (Number(a) || 0) + (Number(d) || 0);
        }, 0);
      if (isWorkflowSync) {
        return console.log(
          `No plan in this PR; allowed as workflow infrastructure sync (${changed} changed lines across ${changedFiles.length} workflow files).`
        );
      }
      const newFiles = git([
        'diff',
        '--name-only',
        '--diff-filter=A',
        range,
        '--',
        ...noNewFilesUnder,
      ])
        .split('\n')
        .filter(Boolean);
      if (changed > maxChangedLines || newFiles.length) {
        fail(
          `the no-plan label only covers trivial changes (at most ${maxChangedLines} changed lines, no new files under ${noNewFilesUnder.join(', ')}). This PR changes ${changed} lines${newFiles.length ? ` and adds ${newFiles.join(', ')}` : ''}. Add a plan instead.`
        );
      }
      return console.log(
        `No plan in this PR; allowed by the no-plan label (${changed} changed lines).`
      );
    }
    let failed = false;
    for (const f of plans) {
      const plan = readPlan(join(repoRoot, f));
      const found = problems(plan);
      const original = originalPlan(f, opts.base, opts.head);
      if (original) {
        const before = countBoxes(bodyOf(original));
        const now = countBoxes(plan.body);
        if (now < before)
          found.push(
            `${before - now} checkbox(es) removed since the plan was first committed. Restore them and mark any you won't do "deferred: <reason>".`
          );
      }
      if (found.length) {
        failed = true;
        console.error(`${f}:\n- ${found.join('\n- ')}`);
        continue;
      }
      const deferred = deferredItems(plan.body);
      console.log(
        `${f}: closed out.${deferred.length ? `\n  Deferred:\n  ${deferred.join('\n  ')}` : ''}`
      );
    }
    if (failed)
      fail(
        'close out the plan(s) above: tick every item or mark it "deferred: <reason>".'
      );
  },

  async 'ci-done'() {
    if (!opts.head) fail('usage: ci-done --head <merge sha>');
    if (!isLocal && !token() && !opts.dryRun)
      return console.log('NOTION_TOKEN secret not set; skipping ticket close.');
    for (const f of changedPlans([`${opts.head}^1`, opts.head])) {
      const plan = readPlan(join(repoRoot, f));
      if (hasTicket(plan.meta.ticket)) {
        await closeTicket(plan.meta.ticket);
        console.log(`${f}: ticket set to Done.`);
      }
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
          }
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
            (f) => f.endsWith('.plan.md') && !f.startsWith('_')
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
                    })
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
        plan: activePlan ? activePlan.file.replace(/\.plan\.md$/, '') : '(none)',
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
        ].join('  ')
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
        '  custom=$(node -e "try{console.log((JSON.parse(require(\'fs\').readFileSync(\'scripts/ticket.config.json\',\'utf8\')).protectedBranches||[]).join(\' \'))}catch(e){}" 2>/dev/null)',
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
          : `Pre-push hook is NOT installed. Run 'node scripts/ticket.mjs hook install' to install.`
      );
    } else {
      fail('usage: node scripts/ticket.mjs hook [install|uninstall|status]');
    }
  },

  async adr() {
    const rawTitle = opts.files[0] || opts.title || '';
    if (!rawTitle) {
      fail(
        'usage: node scripts/ticket.mjs adr "<Decision Title>" [--agent <client>]'
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
        f.endsWith('.md')
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
      `Running across ${candidateDirs.length} repositories: "${cmd}"\n`
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
        ].join('  ')
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
      const planArg = opts.files.slice(1).find((f) => f.endsWith('.plan.md'));
      let plan = null;
      try {
        plan = planArg ? readPlan(planArg) : resolveActivePlan();
      } catch {}

      const branch =
        opts.branch ||
        (plan && plan.meta.branch ? plan.meta.branch : null) ||
        (opts.name ? `feat/${opts.name}` : null);
      if (!branch) {
        fail(
          'usage: node scripts/ticket.mjs wt new [<plan>] [--name <dir>] [--branch <branch>]'
        );
      }

      const name =
        opts.name ||
        branch.replace(/^[^/]+\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      const targetDir = resolve(repoRoot, '.worktrees', name);
      mkdirSync(resolve(repoRoot, '.worktrees'), { recursive: true });

      if (existsSync(targetDir)) {
        fail(`target worktree directory already exists: ${targetDir}`);
      }

      const branchExists = !!git(['rev-parse', '--verify', branch], {
        allowFail: true,
      });
      const addArgs = ['worktree', 'add'];
      if (!branchExists) addArgs.push('-b', branch);
      addArgs.push(targetDir);
      if (branchExists) addArgs.push(branch);

      try {
        execFileSync('git', addArgs, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        fail(`git worktree add failed: ${err.stderr || err.message}`);
      }

      const envPath = join(repoRoot, '.env');
      if (existsSync(envPath)) {
        try {
          writeFileSync(join(targetDir, '.env'), readFileSync(envPath));
        } catch {}
      }

      if (plan) {
        plan.meta.worktree = name;
        plan.meta.branch = branch;
        writePlan(plan);
      }

      console.log(`Created worktree at .worktrees/${name} (branch: ${branch})`);
      console.log(`To switch: cd .worktrees/${name}`);
      return;
    }

    if (sub === 'prune') {
      const dirs = opts.fleet ? getKnownRepoDirs() : [repoRoot];
      let totalPruned = 0;

      for (const dir of dirs) {
        const repoName = basename(dir);
        let listOut = '';
        try {
          listOut = execFileSync(
            'git',
            ['-C', dir, 'worktree', 'list', '--porcelain'],
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
          );
        } catch {
          continue;
        }

        const entries = [];
        let cur = {};
        for (const line of listOut.split('\n')) {
          const l = line.trim();
          if (!l) {
            if (cur.worktree) entries.push(cur);
            cur = {};
          } else if (l.startsWith('worktree ')) cur.worktree = l.slice(9);
          else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
          else if (l.startsWith('branch '))
            cur.branch = l.slice(7).replace('refs/heads/', '');
        }
        if (cur.worktree) entries.push(cur);

        const nonMain = entries.slice(1);
        if (!nonMain.length) continue;

        for (const entry of nonMain) {
          const wtPath = resolve(entry.worktree);
          let isMerged = false;
          if (entry.head) {
            try {
              execFileSync(
                'git',
                ['-C', dir, 'merge-base', '--is-ancestor', entry.head, 'HEAD'],
                { stdio: 'ignore' }
              );
              isMerged = true;
            } catch {}
          }

          if (isMerged || opts.all || !existsSync(wtPath)) {
            if (opts.dryRun) {
              console.log(
                `[dry-run] Would prune worktree in ${repoName}: ${wtPath} (branch: ${entry.branch || 'detached'})`
              );
              totalPruned++;
              continue;
            }

            let removed = false;
            try {
              execFileSync(
                'git',
                ['-C', dir, 'worktree', 'remove', wtPath, '--force'],
                { stdio: 'ignore' }
              );
              removed = true;
            } catch {}

            if (existsSync(wtPath)) {
              try {
                const extended =
                  process.platform === 'win32' && !wtPath.startsWith('\\\\?\\')
                    ? `\\\\?\\${wtPath.replace(/\//g, '\\')}`
                    : wtPath;
                rmSync(extended, { recursive: true, force: true });
                removed = true;
              } catch {}
            }

            try {
              execFileSync('git', ['-C', dir, 'worktree', 'prune'], {
                stdio: 'ignore',
              });
            } catch {}

            if (removed) {
              console.log(
                `Pruned worktree in ${repoName}: ${entry.branch || basename(wtPath)}`
              );
              totalPruned++;
            }
          }
        }
      }
      console.log(`Prune complete: ${totalPruned} worktree(s) pruned.`);
      return;
    }

    fail('usage: node scripts/ticket.mjs wt [list|new|prune] [--fleet] [--all]');
  },

  async recall() {
    const query = (opts.files.join(' ') || opts.query || '').trim();
    if (!query) {
      fail('usage: node scripts/ticket.mjs recall "<keyword>" [--fleet]');
    }
    const qLower = query.toLowerCase();
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
          if (!content.toLowerCase().includes(qLower)) continue;

          const lines = content.split('\n');
          const relPath = relative(dir, f).replace(/\\/g, '/');
          const isAdr = relPath.startsWith('docs/decisions/');
          const titleLine = lines.find((l) => /^#\s+/.test(l)) || '';
          const title = titleLine.replace(/^#\s+/, '').trim() || basename(f);

          const matches = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(qLower)) {
              matches.push({ line: i + 1, text: lines[i].trim() });
              if (matches.length >= 3) break;
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
      `=== Recall: "${query}" (${results.length} match${results.length === 1 ? '' : 'es'}) ===\n`
    );
    for (const r of results) {
      console.log(
        `[${r.type}] ${opts.fleet ? `${r.repo} / ` : ''}${r.file} — ${r.title}`
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
          `Skipping ${plan.rel}: plan has open items or is not marked done/shipped (use --force to archive anyway).`
        );
        continue;
      }

      const month =
        plan.meta.completedAt?.slice(0, 7) || today().slice(0, 7);
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
      `=== AI-Dev-Workflow Doctor (${dirs.length} repo${dirs.length === 1 ? '' : 's'}) ===\n`
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
          }
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
          }
        );
        wtCount = (wtOut.match(/^worktree /gm) || []).length;
      } catch {}

      const hookPath = join(dir, '.git', 'hooks', 'pre-push');
      const hasHook = existsSync(hookPath);

      const tracker = repoCfg.tracker || 'notion';
      const hasToken = !(
        !process.env.NOTION_TOKEN && !readEnvToken(join(dir, '.env'))
      );

      let syncDrift = 'synced';
      const ticketScript = join(dir, 'scripts', 'ticket.mjs');
      const canonicalTicket = join(repoRoot, 'scripts', 'ticket.mjs');
      if (
        dir !== repoRoot &&
        existsSync(ticketScript) &&
        existsSync(canonicalTicket)
      ) {
        try {
          const canonical = readFileSync(canonicalTicket, 'utf8');
          const current = readFileSync(ticketScript, 'utf8');
          if (canonical !== current) syncDrift = 'drift detected';
        } catch {}
      }

      console.log(`Repo:      ${name} (${dir})`);
      console.log(
        `Branch:    ${branch} (${dirty === 0 ? 'clean' : `${dirty} uncommitted file(s)`})`
      );
      console.log(`Worktrees: ${wtCount}`);
      console.log(
        `Tracker:   ${tracker}${tracker === 'notion' ? ` (Token: ${hasToken ? 'present' : 'MISSING'})` : ' (offline mode)'}`
      );
      console.log(`Pre-push:  ${hasHook ? 'installed' : 'not installed'}`);
      console.log(`Workflow:  ${syncDrift}`);
      if (repoCfg.verifyCommand) {
        console.log(`Verify:    ${repoCfg.verifyCommand}`);
      }
      console.log('---');
    }
  },
};

if (!commands[command])
  fail(
    `unknown command "${command || ''}". Commands: ${Object.keys(commands).join(', ')}`
  );
await commands[command]();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
const url = 'https://www.notion.so/40a0b9c6786f817fab0ff2059ad410e3';

const defaultNotionConfig = {
  prefix: 'FO',
  dataSourceId: '00000000-0000-0000-0000-000000000001',
  projectPageId: '00000000-0000-0000-0000-000000000002',
  tag: 'Work / Fluent Studio',
  lifeAreaPageId: '00000000-0000-0000-0000-000000000003',
  timeZone: 'Europe/Berlin',
  plansDir: 'docs/plans',
  protectedBranches: ['main', 'develop'],
  captureSources: [
    'Claude',
    'Codex',
    'Gemini',
    'ChatGPT',
    'Notion AI',
    'Other',
  ],
  verifyCommand: 'npm test',
  noPlan: {
    maxChangedLines: 40,
    noNewFilesUnder: ['src'],
  },
};

function fixture(t, front = '', responses = [], configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ticket-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  copyFileSync(join(scripts, 'ticket.mjs'), join(root, 'scripts/ticket.mjs'));
  writeFileSync(
    join(root, 'scripts/ticket.config.json'),
    JSON.stringify({ ...defaultNotionConfig, ...configOverrides }, null, 2)
  );
  const plan = join(root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    plan,
    `---\ntitle: Plan - Process: Test\nstatus: draft\n${front}---\n# Test\n\n## Summary\nTest fixture\n\n## Acceptance criteria\n- [x] Works verified: fixture\n\n## Steps\n- [x] Implement\n`
  );
  const requests = join(root, 'requests.jsonl');
  const preload = join(root, 'mock.mjs');
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs';
const responses = JSON.parse(process.env.MOCK_RESPONSES);
globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.MOCK_REQUESTS, JSON.stringify({url, method:init.method, body: init.body ? JSON.parse(init.body) : null}) + '\\n');
  const response = responses.shift();
  if (!response) throw new Error('unexpected API request');
  if (response.throw) throw new Error(response.throw);
  return new Response(JSON.stringify(response.body), {status: response.status || 200});
};`
  );
  function run(
    command,
    options = [],
    replies = responses,
    { omitPlan = false, envOverrides = {}, cwd = root } = {}
  ) {
    const args = [
      '--import',
      pathToFileURL(preload).href,
      join(root, 'scripts/ticket.mjs'),
      command,
      ...(omitPlan ? [] : ['docs/plans/FO-Plan-Test.plan.md']),
      ...options,
    ];
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NOTION_TOKEN: 'test-token',
        MOCK_RESPONSES: JSON.stringify(replies),
        MOCK_REQUESTS: requests,
        ...envOverrides,
      },
    });
    const calls = (() => {
      try {
        return readFileSync(requests, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse);
      } catch {
        return [];
      }
    })();
    return {
      ...result,
      calls,
      plan: existsSync(plan) ? readFileSync(plan, 'utf8') : '',
    };
  }
  function git(...args) {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  return { root, plan, run, git };
}

const empty = { body: { results: [], has_more: false } };
const created = { body: { url, id: '40a0b9c6786f817fab0ff2059ad410e3' } };

test('create stamps development fields, optional fields and canonical provenance', (t) => {
  const f = fixture(t, 'priority: high\nstate: flow\ndue: 2026-11-15\n', [
    empty,
    created,
  ]);
  const r = f.run('create', ['--agent', 'Codex']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].body.filter.rich_text.equals, 'FO:FO-Plan-Test');
  const p = r.calls[1].body.properties;
  assert.equal(p.Status.status.name, 'To Do');
  assert.equal(p['Task Lane'].select.name, 'Development');
  assert.equal(
    p['Dev Ticket Key'].rich_text[0].text.content,
    'FO:FO-Plan-Test'
  );
  assert.equal(p['Capture Source'].select.name, 'Codex');
  assert.equal(p['Capture State'].select.name, 'Pending');
  assert.equal(p.Priority.select.name, '⭐ High');
  assert.equal(p.State.select.name, '🌊Flow');
  assert.equal(p['Due Date'].date.start, '2026-11-15');
  assert.equal(p['Life Area'].relation.length, 1);
  assert.equal(p.Project.relation.length, 1);
  for (const key of ['Date', 'Focus Slot', 'Started At'])
    assert.equal(p[key], undefined);
  assert.match(r.plan, /devTicketKey: FO:FO-Plan-Test/);
  assert.match(r.plan, /ticket: https:\/\/www.notion.so/);
  const again = f.run('create', ['--agent', 'Codex'], []);
  assert.notEqual(again.status, 0);
  assert.equal(
    again.calls.length,
    2,
    'recorded URL prevents additional API calls'
  );
});

test('default create has no due date and does not read generic status setting', (t) => {
  const r = fixture(t, '', [empty, created]).run('create', [
    '--agent',
    'Codex',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every((c) => c.method === 'POST'));
  assert.equal(r.calls[1].body.properties['Due Date'], undefined);
});

test('lost local URL recovers by persisted key without modifying existing Task', (t) => {
  const r = fixture(t, 'devTicketKey: FO:original-plan\n', [
    { body: { results: [{ url }], has_more: false } },
  ]).run('create', ['--agent', 'Codex']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.filter.rich_text.equals, 'FO:original-plan');
  assert.match(r.plan, /ticket: https:\/\/www.notion.so/);
  assert.match(r.plan, /status: draft/);
  assert.doesNotMatch(r.plan, /agent:/);
});

test('ambiguous existing key stops creation', (t) => {
  const r = fixture(t, '', [
    { body: { results: [{ url }, { url }], has_more: false } },
  ]).run('create', ['--agent', 'Codex']);
  assert.notEqual(r.status, 0);
  assert.equal(r.calls.length, 1);
  assert.doesNotMatch(r.plan, /ticket:/);
});

for (const [name, front, options] of [
  ['priority', 'priority: urgent\n', []],
  ['inherited option name', 'priority: constructor\n', []],
  ['state', 'state: hard\n', []],
  ['date format', 'due: 15.11.2026\n', []],
  ['impossible date', 'due: 2026-02-30\n', []],
  ['status override', '', ['--status', 'Doing']],
])
  test(`invalid ${name} is rejected before API calls`, (t) => {
    const r = fixture(t, front).run('create', ['--agent', 'Codex', ...options]);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 0);
  });

test('invalid title fails both create and check before API calls', (t) => {
  const f = fixture(t);
  writeFileSync(
    f.plan,
    readFileSync(f.plan, 'utf8').replace('Plan - Process: Test', 'Fix this')
  );
  for (const command of ['create', 'check']) {
    const r = f.run(command, ['--agent', 'Codex']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /title must read/);
    assert.equal(r.calls.length, 0);
  }
});

test('known Life Area refusal retries once while keeping development fields', (t) => {
  const r = fixture(t, '', [
    empty,
    {
      status: 404,
      body: { code: 'object_not_found', message: 'Life Area unavailable' },
    },
    created,
  ]).run('create', ['--agent', 'Codex']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /share the Life Areas database/);
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[2].body.properties['Life Area'], undefined);
  assert.equal(
    r.calls[2].body.properties['Task Lane'].select.name,
    'Development'
  );
});

for (const error of [
  { throw: 'network response lost' },
  { status: 500, body: { message: 'internal error' } },
  {
    status: 400,
    body: { code: 'validation_error', message: 'Task Lane missing' },
  },
]) {
  test(`uncertain or unrelated creation failure never retries: ${JSON.stringify(error)}`, (t) => {
    const r = fixture(t, '', [empty, error]).run('create', [
      '--agent',
      'Codex',
    ]);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 2);
    assert.doesNotMatch(r.plan, /ticket:/);
  });
}

for (const started of [null, '2026-10-31'])
  test(`start preserves existing date (${started})`, (t) => {
    const f = fixture(t, `ticket: ${url}\n`, [
      {
        body: {
          properties: {
            'Started At': { date: started ? { start: started } : null },
          },
        },
      },
      { body: {} },
    ]);
    f.git('init', '-b', 'test-ticket');
    f.git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'base'
    );
    const r = f.run('start');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls[1].body.properties.Status.status.name, 'Doing');
    if (started)
      assert.equal(r.calls[1].body.properties['Started At'], undefined);
    else
      assert.match(
        r.calls[1].body.properties['Started At'].date.start,
        /^\d{4}-\d{2}-\d{2}$/
      );
  });

test('done writes Done and Completed At together', (t) => {
  const r = fixture(t, `ticket: ${url}\n`, [{ body: {} }]).run('done');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].body.properties.Status.status.name, 'Done');
  assert.match(
    r.calls[0].body.properties['Completed At'].date.start,
    /^\d{4}-\d{2}-\d{2}$/
  );
});

test('ci-done closes the merged plan with Completed At', (t) => {
  const f = fixture(t, `ticket: ${url}\n`, [{ body: {} }]);
  f.git('init', '-b', 'test-ticket');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base'
  );
  f.git('add', 'docs/plans');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'plan'
  );
  const r = f.run('ci-done', ['--head', f.git('rev-parse', 'HEAD')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].body.properties.Status.status.name, 'Done');
  assert.match(
    r.calls[0].body.properties['Completed At'].date.start,
    /^\d{4}-\d{2}-\d{2}$/
  );
});

test('malformed lookup response fails closed before creating a Task', (t) => {
  const r = fixture(t, '', [{ body: {} }]).run('create', ['--agent', 'Codex']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no query results/);
  assert.equal(r.calls.length, 1);
});

test('dry-run prints lookup and creation without persisting the ticket', (t) => {
  const r = fixture(t).run('create', ['--agent', 'Codex', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  assert.match(r.stdout, /data_sources\/.*\/query/);
  assert.match(r.stdout, /Development/);
  assert.doesNotMatch(r.plan, /ticket:/);
});

// ---------- New tests: local tracker mode, auto-plan resolution, worktree .env, pack, review ----------

test('local tracker mode supports full lifecycle without Notion API calls', (t) => {
  const f = fixture(t, '', [], { tracker: 'local', dataSourceId: '' });
  f.git('init', '-b', 'feat/local-test');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base'
  );

  const c = f.run('create', ['--agent', 'Gemini']);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.calls.length, 0);
  assert.match(c.plan, /ticket: local:\/\/FO:FO-Plan-Test/);
  assert.match(c.plan, /status: planned/);

  const s = f.run('start');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.plan, /status: in-progress/);
  assert.match(s.plan, /branch: feat\/local-test/);
  assert.match(s.plan, /startedAt: \d{4}-\d{2}-\d{2}/);

  const chk = f.run('check');
  assert.equal(chk.status, 0, chk.stderr);

  const shp = f.run('ship', ['--pr', 'https://github.com/example/repo/pull/1']);
  assert.equal(shp.status, 0, shp.stderr);
  assert.match(shp.plan, /status: shipped/);
  assert.match(shp.plan, /pr: https:\/\/github\.com\/example\/repo\/pull\/1/);

  const dn = f.run('done');
  assert.equal(dn.status, 0, dn.stderr);
  assert.match(dn.plan, /status: done/);
  assert.match(dn.plan, /completedAt: \d{4}-\d{2}-\d{2}/);
});

test('auto-resolves active plan when plan argument is omitted', (t) => {
  const f = fixture(
    t,
    `ticket: ${url}\nstatus: in-progress\nbranch: feat/auto\n`
  );
  f.git('init', '-b', 'feat/auto');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base'
  );

  const chk = f.run('check', [], [], { omitPlan: true });
  assert.equal(chk.status, 0, chk.stderr);
  assert.match(chk.stdout, /FO-Plan-Test\.plan\.md: closed out/);
});

test('review command records verdict and blocks check when verdict is block', (t) => {
  const f = fixture(t, `ticket: ${url}\n`, [], { requireReview: true });
  const unreviewed = f.run('check');
  assert.notEqual(unreviewed.status, 0);
  assert.match(unreviewed.stderr, /no passing review recorded/);

  const blocked = f.run('review', [
    '--agent',
    'Gemini',
    '--verdict',
    'block',
    '--summary',
    'Missing null check in handler',
  ]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.plan, /reviewedBy: Gemini/);
  assert.match(blocked.plan, /reviewVerdict: block/);
  assert.match(
    blocked.plan,
    /\(review: block\): Missing null check in handler/
  );

  const blockedCheck = f.run('check');
  assert.notEqual(blockedCheck.status, 0);
  assert.match(blockedCheck.stderr, /review verdict is block/);

  const passed = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'Null check added and verified',
  ]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.plan, /reviewedBy: Codex/);
  assert.match(passed.plan, /reviewVerdict: pass/);

  const passedCheck = f.run('check');
  assert.equal(passedCheck.status, 0, passedCheck.stderr);
});

test('pack outputs compact review packet, filters lockfiles, and truncates large diffs', (t) => {
  const f = fixture(
    t,
    `ticket: ${url}\nstatus: in-progress\nbranch: feat/pack\n`,
    [],
    { packMaxFileLines: 8 }
  );
  f.git('init', '-b', 'main');
  mkdirSync(join(f.root, 'src'), { recursive: true });
  writeFileSync(join(f.root, 'src/app.js'), 'export const x = 1;\n');
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'base'
  );

  f.git('checkout', '-b', 'feat/pack');
  writeFileSync(
    join(f.root, 'src/app.js'),
    Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join(
      '\n'
    ) + '\n'
  );
  writeFileSync(
    join(f.root, 'pnpm-lock.yaml'),
    'lockfileVersion: 9.0\npackages: {}\n'
  );

  const p = f.run('pack', [], [], { omitPlan: true });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /# Review Packet: Plan - Process: Test/);
  assert.match(p.stdout, /Verify command: `npm test`/);
  assert.match(p.stdout, /Skipped noisy files: pnpm-lock\.yaml/);
  assert.match(p.stdout, /truncated \d+ lines in src\/app\.js/);
});

test('worktree .env fallback reads NOTION_TOKEN from main checkout', (t) => {
  const f = fixture(t, `ticket: ${url}\n`, [{ body: {} }]);
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'base'
  );
  writeFileSync(
    join(f.root, '.env'),
    'NOTION_TOKEN="main-repo-secret-token"\n'
  );

  const wt = join(f.root, '.worktrees/wt-test');
  f.git('worktree', 'add', wt, '-b', 'feat/wt');
  const r = f.run('done', [], [{ body: {} }], {
    envOverrides: { NOTION_TOKEN: '' },
    cwd: wt,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
});

test('sync.mjs patches AGENTS.md Development process section while preserving surrounding blocks', async (t) => {
  if (!existsSync(join(scripts, 'sync.mjs')))
    return t.skip('sync.mjs only present in upstream AI-Dev-Workflow repo');
  const { patchAgentsMd, patchClaudeMd } = await import('./sync.mjs');
  const original = `# Fluent Studio Website\n\nIntro line.\n\n## Development process (every AI: Claude, Codex, Gemini/Antigravity, Cursor)\n\nOld 5-step text.\n\n<!-- BEGIN:nextjs-agent-rules -->\n## Next.js rules\nKeep this block.\n<!-- END:nextjs-agent-rules -->\n`;
  const updated = patchAgentsMd(original, 'Fluent-Studio-Website', {
    prefix: 'FS',
    noNewFilesUnder: ['src'],
    maxChangedLines: 40,
  });
  assert.match(updated, /# Fluent Studio Website/);
  assert.match(updated, /Non-trivial changes follow these six steps/);
  assert.match(updated, /FS-Plan-<Topic>-<YYYY-MM>\.plan\.md/);
  assert.match(updated, /node scripts\/ticket\.mjs pack/);
  assert.match(
    updated,
    /<!-- BEGIN:nextjs-agent-rules -->\n## Next\.js rules\nKeep this block\.\n<!-- END:nextjs-agent-rules -->/
  );
  assert.doesNotMatch(updated, /Old 5-step text/);
  assert.equal(patchClaudeMd(''), '@AGENTS.md\n');
});

test('new command scaffolds a valid plan doc with slugified title and frontmatter', (t) => {
  const f = fixture(t);
  const r = f.run(
    'new',
    ['"Smart Shortcut Suggestions"', '--type', 'Feature', '--priority', 'high'],
    [],
    { omitPlan: true }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created plan: docs\/plans\/FO-Plan-Smart-Shortcut-Suggestions-/);

  const plans = readdirSync(join(f.root, 'docs/plans')).filter((p) =>
    p.startsWith('FO-Plan-Smart-Shortcut-Suggestions-')
  );
  assert.equal(plans.length, 1);
  const content = readFileSync(join(f.root, 'docs/plans', plans[0]), 'utf8');
  assert.match(content, /title: Plan - Feature: Smart Shortcut Suggestions/);
  assert.match(content, /priority: high/);
  assert.match(content, /# Smart Shortcut Suggestions/);
  assert.match(content, /## Acceptance criteria/);
});

test('prime command outputs compact session context with open criteria and steps', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: local://FO:FO-Plan-Test\nbranch: feat/test\n'
  );
  f.git('init', '-b', 'feat/test');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );
  const r = f.run('prime', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# Session Context:/);
  assert.match(r.stdout, /Plan: docs\/plans\/FO-Plan-Test\.plan\.md/);
  assert.match(r.stdout, /Status: in-progress/);
  assert.match(r.stdout, /Branch: feat\/test/);
  assert.match(r.stdout, /## Open Acceptance Criteria/);
  assert.match(r.stdout, /## Next Steps/);
});

test('pack with --test embeds test execution result into review packet', (t) => {
  const f = fixture(t, 'status: in-progress\n', [], {
    verifyCommand: 'node -e "console.log(\'mock tests 10 passed\')"',
  });
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'base'
  );
  const r = f.run('pack', ['--test']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Test Verification/);
  assert.match(r.stdout, /Result: PASS \(exit code 0\)/);
  assert.match(r.stdout, /mock tests 10 passed/);
});

test('overview command outputs table with repo branches and plans', (t) => {
  const f = fixture(t, 'status: in-progress\n');
  f.git('init', '-b', 'main');
  const r = f.run('overview', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Repo\s+Branch\s+Plan\s+Open\s+State/);
});

test('hook install, status, and uninstall manages pre-push guardrail script', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  const rInstall = f.run('hook', ['install'], [], { omitPlan: true });
  assert.equal(rInstall.status, 0, rInstall.stderr);

  const hookPath = join(f.root, '.git', 'hooks', 'pre-push');
  assert.equal(existsSync(hookPath), true);
  const content = readFileSync(hookPath, 'utf8');
  assert.match(content, /AI-Dev-Workflow pre-push hook/);

  const rStatus = f.run('hook', ['status'], [], { omitPlan: true });
  assert.match(rStatus.stdout, /Pre-push hook is installed/);

  const rUninstall = f.run('hook', ['uninstall'], [], { omitPlan: true });
  assert.equal(rUninstall.status, 0, rUninstall.stderr);
  assert.equal(existsSync(hookPath), false);
});

test('handoff and resume commands record and display multi-model handoff context', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: local://FO:FO-Plan-Test\nbranch: feat/test\n'
  );
  f.git('init', '-b', 'feat/test');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );

  const rHandoff = f.run(
    'handoff',
    [
      '--agent',
      'Gemini',
      '--done',
      'Implemented parser',
      '--next',
      'Run unit tests',
      '--open',
      'none',
    ],
    [],
    { omitPlan: true }
  );
  assert.equal(rHandoff.status, 0, rHandoff.stderr);
  assert.match(rHandoff.stdout, /=== Session Handoff Stamped ===/);
  assert.match(rHandoff.stdout, /Done:\s+Implemented parser/);
  assert.match(rHandoff.stdout, /Next:\s+Run unit tests/);

  const rResume = f.run('resume', [], [], { omitPlan: true });
  assert.equal(rResume.status, 0, rResume.stderr);
  assert.match(rResume.stdout, /=== Resuming Session ===/);
  assert.match(rResume.stdout, /Last Handoff:.*Implemented parser/);
});

test('adr command scaffolds in-repo architectural decision records', (t) => {
  const f = fixture(t);
  const r1 = f.run(
    'adr',
    ['"Use Native Child Process"', '--agent', 'Gemini'],
    [],
    { omitPlan: true }
  );
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(
    r1.stdout,
    /Created ADR: docs\/decisions\/ADR-001-use-native-child-process\.md/
  );

  const adrPath = join(
    f.root,
    'docs/decisions/ADR-001-use-native-child-process.md'
  );
  assert.equal(existsSync(adrPath), true);
  const content = readFileSync(adrPath, 'utf8');
  assert.match(content, /# ADR 001: Use Native Child Process/);
  assert.match(content, /Author:\*\* Gemini/);

  const r2 = f.run('adr', ['"Second Decision"'], [], { omitPlan: true });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /ADR-002-second-decision\.md/);
});

test('exec command runs shell commands across repositories', (t) => {
  const f = fixture(t);
  const r = f.run('exec', ['git --version'], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Repo\s+Status\s+Output/);
  assert.match(r.stdout, /git version/i);
});

test('pr command validates plan closeout and outputs PR body in dry-run mode', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/pr-test\nreviewedBy: Gemini\nreviewVerdict: pass\n'
  );
  f.git('init', '-b', 'feat/pr-test');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );

  const r = f.run('pr', ['--dry-run'], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--- Dry Run: PR Title ---/);
  assert.match(r.stdout, /--- Dry Run: PR Body ---/);
  assert.match(r.stdout, /Test fixture/);
  assert.match(r.stdout, /Works verified: fixture/);
});

test('ci-check allows workflow infrastructure sync under no-plan', (t) => {
  const f = fixture(t, 'status: in-progress\nticket: https://www.notion.so/test\n');
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );
  const baseSha = f.git('rev-parse', 'HEAD').trim();

  // Create a branch modifying workflow files
  f.git('checkout', '-b', 'chore/sync-workflow');
  writeFileSync(join(f.root, 'AGENTS.md'), '# Updated Development Process\n');
  f.git('add', 'AGENTS.md');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'chore(workflow): sync'
  );
  const headSha = f.git('rev-parse', 'HEAD').trim();

  const r = f.run('ci-check', ['--base', baseSha, '--head', headSha], [], {
    envOverrides: { NO_PLAN: '1' },
    omitPlan: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /allowed as workflow infrastructure sync/i);
});

test('tick and defer commands update plan checkboxes without manual markdown edits', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/test\n'
  );

  const planPath = f.plan;
  writeFileSync(
    planPath,
    `---
title: Plan - Feature: Tick Test
ticket: https://www.notion.so/test
status: in-progress
branch: feat/test
---
# Tick Test

## Summary
Testing tick and defer.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Steps
- [ ] Step 1
- [ ] Step 2
`
  );

  const rFail = f.run('tick', ['1'], [], { omitPlan: true });
  assert.equal(rFail.status, 1);
  assert.match(rFail.stderr, /requires verified evidence/i);

  const rTick1 = f.run(
    'tick',
    ['1', '--verified', 'tested manually'],
    [],
    { omitPlan: true }
  );
  assert.equal(rTick1.status, 0, rTick1.stderr);
  assert.match(rTick1.stdout, /Ticked \[1\]/);

  const rDefer = f.run(
    'defer',
    ['Step 2', '--reason', 'out of scope'],
    [],
    { omitPlan: true }
  );
  assert.equal(rDefer.status, 0, rDefer.stderr);
  assert.match(rDefer.stdout, /Deferred/);

  const updated = readFileSync(planPath, 'utf8');
  assert.match(updated, /- \[x\] Criterion 1 verified: tested manually/);
  assert.match(updated, /- \[ \] Step 2 deferred: out of scope/);
});

test('prime command numbers open checkboxes sequentially', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/prime-test\n'
  );
  writeFileSync(
    f.plan,
    `---
title: Plan - Process: Test
status: in-progress
ticket: https://www.notion.so/test
branch: feat/prime-test
---
# Test

## Summary
Test fixture

## Acceptance criteria
- [ ] Works

## Steps
- [ ] Implement
`
  );
  const r = f.run('prime', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[1\] - \[ \] Works/);
  assert.match(r.stdout, /Tip: Run `node scripts\/ticket\.mjs tick <#>`/);
});

test('new command with --summary, --criteria, --steps, and --create scaffolds and tickets in one shot', (t) => {
  const f = fixture(t, 'status: draft\n', [], { tracker: 'local' });
  const r = f.run(
    'new',
    [
      '"Fast Feature"',
      '--summary',
      '"Fast summary text"',
      '--criteria',
      '"C1|C2"',
      '--steps',
      '"S1|S2"',
      '--create',
      '--agent',
      'Gemini',
    ],
    [],
    { omitPlan: true }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created plan: docs\/plans\/FO-Plan-Fast-Feature/);
  assert.match(r.stdout, /Ticket created/);

  const month = new Date().toISOString().slice(0, 7);
  const planPath = join(
    f.root,
    `docs/plans/FO-Plan-Fast-Feature-${month}.plan.md`
  );
  assert.equal(existsSync(planPath), true);
  const content = readFileSync(planPath, 'utf8');
  assert.match(content, /Fast summary text/);
  assert.match(content, /- \[ \] C1/);
  assert.match(content, /- \[ \] S1/);
});

test('recall command searches across ADRs and plans', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\n'
  );
  f.run('adr', ['"Use SQLite for Cache"'], [], { omitPlan: true });

  const r = f.run('recall', ['SQLite'], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== Recall: "SQLite"/);
  assert.match(r.stdout, /ADR-001-use-sqlite-for-cache\.md/);
});

test('archive command safely moves completed plans into archive folder', (t) => {
  const f = fixture(
    t,
    'status: done\nticket: https://www.notion.so/test\ncompletedAt: 2026-11-01\n'
  );
  const r = f.run('archive', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /Archived: docs\/plans\/FO-Plan-Test\.plan\.md -> docs\/plans\/archive\/2026-11\/FO-Plan-Test\.plan\.md/
  );

  const archivePath = join(
    f.root,
    'docs/plans/archive/2026-11/FO-Plan-Test.plan.md'
  );
  assert.equal(existsSync(archivePath), true);
});

test('doctor command reports repository diagnostics', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\n'
  );
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );
  const r = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== AI-Dev-Workflow Doctor/);
  assert.match(r.stdout, /Branch:\s+main/);
  assert.match(r.stdout, /Worktrees:/);
});

test('wt command lists worktrees and supports prune in dry-run mode', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\n'
  );
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'init'
  );

  const rList = f.run('wt', ['list'], [], { omitPlan: true });
  assert.equal(rList.status, 0, rList.stderr);

  const rPrune = f.run('wt', ['prune', '--dry-run'], [], { omitPlan: true });
  assert.equal(rPrune.status, 0, rPrune.stderr);
  assert.match(rPrune.stdout, /Prune complete: 0 worktree\(s\) pruned\./);
});

test('public distribution and installer files integrity', () => {
  const repoRoot = join(scripts, '..');
  
  // 1. Verify installer scripts exist
  const ps1Path = join(repoRoot, 'scripts', 'install.ps1');
  const shPath = join(repoRoot, 'scripts', 'install.sh');
  assert.equal(existsSync(ps1Path), true, 'install.ps1 should exist');
  assert.equal(existsSync(shPath), true, 'install.sh should exist');

  const shContent = readFileSync(shPath, 'utf8');
  assert.match(shContent, /AI-Dev-Workflow Installer/);
  assert.match(shContent, /PREFIX=/);

  // 2. Verify ticket.config.example.json is sanitized if present (upstream repo)
  const examplePath = join(repoRoot, 'ticket.config.example.json');
  if (existsSync(examplePath)) {
    const exampleCfg = JSON.parse(readFileSync(examplePath, 'utf8'));
    assert.deepEqual(exampleCfg.knownRepos, ['my-backend', 'my-frontend', 'my-shared-lib']);
  }

  // 3. Verify scripts/ticket.mjs WORKFLOW_FILES includes install.sh
  const ticketMjsContent = readFileSync(join(repoRoot, 'scripts', 'ticket.mjs'), 'utf8');
  assert.match(ticketMjsContent, /'scripts\/install\.sh'/);
  assert.match(ticketMjsContent, /'scripts\/install\.ps1'/);
});

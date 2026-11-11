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
import { join, dirname, basename } from 'node:path';
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
    JSON.stringify({ ...defaultNotionConfig, ...configOverrides }, null, 2),
  );
  const plan = join(root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    plan,
    `---\ntitle: Plan - Process: Test\nstatus: draft\n${front}---\n# Test\n\n## Summary\nTest fixture\n\n## Acceptance criteria\n- [x] Works verified: fixture\n\n## Steps\n- [x] Implement\n`,
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
};`,
  );
  function run(
    command,
    options = [],
    replies = responses,
    { omitPlan = false, envOverrides = {}, cwd = root } = {},
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
    'FO:FO-Plan-Test',
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
    'recorded URL prevents additional API calls',
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
    readFileSync(f.plan, 'utf8').replace('Plan - Process: Test', 'Fix this'),
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
    'Development',
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
      'base',
    );
    const r = f.run('start');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls[1].body.properties.Status.status.name, 'Doing');
    if (started)
      assert.equal(r.calls[1].body.properties['Started At'], undefined);
    else
      assert.match(
        r.calls[1].body.properties['Started At'].date.start,
        /^\d{4}-\d{2}-\d{2}$/,
      );
  });

const completionState = (status = 'Doing', start = null) => ({
  body: {
    properties: {
      Status: { status: { name: status } },
      'Completed At': { date: start ? { start } : null },
    },
  },
});

test('done writes Done and Completed At together', (t) => {
  const r = fixture(t, `ticket: ${url}\n`, [completionState(), { body: {} }]).run('done');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].method, 'GET');
  assert.equal(r.calls[1].body.properties.Status.status.name, 'Done');
  assert.match(
    r.calls[1].body.properties['Completed At'].date.start,
    /^\d{4}-\d{2}-\d{2}$/,
  );
});

test('done preserves existing completion and skips a redundant update', (t) => {
  const open = fixture(t, `ticket: ${url}\n`, [
    completionState('Doing', '2025-10-20'),
    { body: {} },
  ]).run('done');
  assert.equal(open.status, 0, open.stderr);
  assert.deepEqual(open.calls[1].body.properties, { Status: { status: { name: 'Done' } } });
  const closed = fixture(t, `ticket: ${url}\n`, [
    completionState('Done', '2025-10-20'),
  ]).run('done');
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(closed.calls.map((call) => call.method), ['GET']);
});

test('ci-done reads the full PR file list and the committed plan after a linear merge', (t) => {
  const pr = 'https://github.com/example/repo/pull/1';
  const f = fixture(t, `ticket: ${url}\npr: ${pr}\n`, [completionState(), { body: {} }]);
  f.git('init', '-b', 'test-ticket');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  f.git('add', 'docs/plans');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'plan',
  );
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'last rebased commit does not touch plan');
  writeFileSync(f.plan, 'This dirty checkout is not the merged plan.');
  const list = join(f.root, 'pr-files.json');
  writeFileSync(list, JSON.stringify([
    [{ filename: 'docs/plans/FO-Plan-Test.plan.md', status: 'added' }],
    [{ filename: 'README.md', status: 'modified' }],
  ]));
  const args = [
    '--head', f.git('rev-parse', 'HEAD'), '--pr-files', list, '--pr', pr,
    '--changed-files', '2', '--merged-at', '2025-10-20T22:30:00Z',
  ];
  const r = f.run('ci-done', args, undefined, { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[1].body.properties.Status.status.name, 'Done');
  assert.equal(r.calls[1].body.properties['Completed At'].date.start, '2025-10-21');
  const truncated = f.run('ci-done', [...args, '--changed-files', '3'], undefined, { omitPlan: true });
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /incomplete GitHub PR file list/);
  assert.equal(truncated.calls.length, r.calls.length);
  const missingSecret = f.run('ci-done', args, undefined, {
    omitPlan: true,
    envOverrides: { NOTION_TOKEN: '' },
  });
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /NOTION_TOKEN is not set/);
});

test('explicit Notion mode fails before making a local ticket without a data source', (t) => {
  const f = fixture(t, '', [], { tracker: 'notion', dataSourceId: '' });
  const r = f.run('create', ['--agent', 'Codex']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Notion tracker requires dataSourceId/);
  assert.equal(r.calls.length, 0);
  assert.doesNotMatch(r.plan, /local:\/\//);
});

for (const method of ['merge commit', 'squash']) {
  test(`ci-done reads the committed plan after a ${method} merge`, (t) => {
    const pr = 'https://github.com/example/repo/pull/2';
    const f = fixture(t, `ticket: ${url}\npr: ${pr}\n`, [
      completionState(),
      { body: {} },
    ]);
    f.git('init', '-b', 'main');
    f.git('config', 'user.name', 'Test');
    f.git('config', 'user.email', 'test@example.invalid');
    f.git('commit', '--allow-empty', '-m', 'base');
    f.git('switch', '-c', 'feature');
    f.git('add', 'docs/plans');
    f.git('commit', '-m', 'plan');
    f.git('commit', '--allow-empty', '-m', 'follow-up');
    f.git('switch', 'main');
    if (method === 'squash') {
      f.git('merge', '--squash', 'feature');
      f.git('commit', '-m', 'squash merge');
    } else {
      f.git('merge', '--no-ff', '-m', 'merge commit', 'feature');
    }
    const list = join(f.root, 'pr-files.json');
    writeFileSync(list, JSON.stringify([
      [{ filename: 'docs/plans/FO-Plan-Test.plan.md', status: 'added' }],
    ]));
    const r = f.run('ci-done', [
      '--head', f.git('rev-parse', 'HEAD'), '--pr-files', list, '--pr', pr,
      '--changed-files', '1', '--merged-at', '2025-10-20T12:30:00Z',
    ], undefined, { omitPlan: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls[1].body.properties['Completed At'].date.start, '2025-10-20');
  });
}

test('local plan status is derived from the protected branch without rewriting the plan', (t) => {
  const f = fixture(t, 'status: in-progress\nticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
  });
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'merged plan');
  const r = f.run('prime');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Status: done/);
  assert.match(r.plan, /status: in-progress/);
  assert.equal(r.calls.length, 0);
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
    'base',
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
    `ticket: ${url}\nstatus: in-progress\nbranch: feat/auto\n`,
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
    'base',
  );

  const chk = f.run('check', [], [], { omitPlan: true });
  assert.equal(chk.status, 0, chk.stderr);
  assert.match(chk.stdout, /FO-Plan-Test\.plan\.md: closed out/);
});

test('review command records verdict and blocks check when verdict is block', (t) => {
  const f = fixture(t, `ticket: ${url}\n`, [], { requireReview: true });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
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
    /\(review: block\): Missing null check in handler/,
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
    { packMaxFileLines: 8 },
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
    'base',
  );

  f.git('checkout', '-b', 'feat/pack');
  writeFileSync(
    join(f.root, 'src/app.js'),
    Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join(
      '\n',
    ) + '\n',
  );
  writeFileSync(
    join(f.root, 'pnpm-lock.yaml'),
    'lockfileVersion: 9.0\npackages: {}\n',
  );

  const p = f.run('pack', [], [], { omitPlan: true });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /# Review Packet: Plan - Process: Test/);
  assert.match(p.stdout, /Verify command: `npm test`/);
  assert.match(p.stdout, /Skipped noisy files: pnpm-lock\.yaml/);
  assert.match(p.stdout, /truncated \d+ lines in src\/app\.js/);
});

test('worktree .env fallback reads NOTION_TOKEN from main checkout', (t) => {
  const f = fixture(t, `ticket: ${url}\n`, [completionState(), { body: {} }]);
  f.git('init', '-b', 'main');
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'base',
  );
  writeFileSync(
    join(f.root, '.env'),
    'NOTION_TOKEN="main-repo-secret-token"\n',
  );

  const wt = join(f.root, '.worktrees/wt-test');
  f.git('worktree', 'add', wt, '-b', 'feat/wt');
  const r = f.run('done', [], undefined, {
    envOverrides: { NOTION_TOKEN: '' },
    cwd: wt,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((call) => call.method), ['GET', 'PATCH']);
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
    /<!-- BEGIN:nextjs-agent-rules -->\n## Next\.js rules\nKeep this block\.\n<!-- END:nextjs-agent-rules -->/,
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
    { omitPlan: true },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /Created plan: docs\/plans\/FO-Plan-Smart-Shortcut-Suggestions-/,
  );

  const plans = readdirSync(join(f.root, 'docs/plans')).filter((p) =>
    p.startsWith('FO-Plan-Smart-Shortcut-Suggestions-'),
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
    'status: in-progress\nticket: local://FO:FO-Plan-Test\nbranch: feat/test\n',
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
    'init',
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
    'base',
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
    'status: in-progress\nticket: local://FO:FO-Plan-Test\nbranch: feat/test\n',
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
    'init',
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
    { omitPlan: true },
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
    { omitPlan: true },
  );
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(
    r1.stdout,
    /Created ADR: docs\/decisions\/ADR-001-use-native-child-process\.md/,
  );

  const adrPath = join(
    f.root,
    'docs/decisions/ADR-001-use-native-child-process.md',
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
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/pr-test\nreviewedBy: Gemini\nreviewVerdict: pass\n',
  );
  mkdirSync(join(f.root, '.github'));
  copyFileSync(
    join(scripts, '../.github/pull_request_template.md'),
    join(f.root, '.github/pull_request_template.md'),
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
    'init',
  );

  const r = f.run('pr', ['--dry-run'], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--- Dry Run: PR Title ---/);
  assert.match(r.stdout, /--- Dry Run: PR Body ---/);
  assert.match(r.stdout, /Test fixture/);
  assert.match(r.stdout, /Works verified: fixture/);
  assert.match(r.stdout, /Plan: docs\/plans\/FO-Plan-Test.plan.md/);
  assert.match(r.stdout, /Ticket: https:\/\/www.notion.so\/test/);
  assert.match(r.stdout, /Review: pass/);
  assert.match(r.stdout, /## What changed\s+Test fixture/);
  assert.match(r.stdout, /## Deferred\s+None\./);
});

test('pr pins verified commits and resumes an open PR after a failed link commit', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    verifyCommand: 'node -e "console.log(\'verified fixture\')"',
  });
  const remote = mkdtempSync(join(tmpdir(), 'ticket-pr-remote-'));
  const mock = mkdtempSync(join(tmpdir(), 'ticket-pr-mock-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  t.after(() => rmSync(mock, { recursive: true, force: true }));
  const preload = join(mock, 'mock.cjs');
  const log = join(mock, 'calls.jsonl');
  const url = 'https://github.com/example/repo/pull/1';
  writeFileSync(preload, `
    const child = require('node:child_process');
    const fs = require('node:fs');
    const real = child.execFileSync;
    child.execFileSync = (bin, args, options) => {
      if (bin !== 'gh') return real(bin, args, options);
      const calls = fs.existsSync(process.env.PR_MOCK_LOG)
        ? fs.readFileSync(process.env.PR_MOCK_LOG, 'utf8') : '';
      fs.appendFileSync(process.env.PR_MOCK_LOG, JSON.stringify({args, body: options.input}) + '\\n');
      if (args[1] === 'list') return calls.includes('"create"')
        ? '[{"url":"${url}","isCrossRepository":false}]' : '[]';
      if (args[1] === 'create') return '${url}';
      throw Error('unexpected gh command');
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const runPr = () => f.run('pr', ['--verify'], [], {
    omitPlan: true,
    envOverrides: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PR_MOCK_LOG: log },
  });
  f.git('init', '-b', 'feat/pr-test');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'baseline');

  writeFileSync(join(f.root, 'staged.txt'), 'staged\n');
  f.git('add', 'staged.txt');
  const dirty = runPr();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /requires a clean committed snapshot/);
  assert.equal(existsSync(log), false);
  f.git('commit', '-m', 'include staged work deliberately');
  const verifiedHead = f.git('rev-parse', 'HEAD');

  const failedPush = runPr();
  assert.notEqual(failedPush.status, 0);
  assert.match(failedPush.stderr, /could not push PR commit/);
  assert.equal(existsSync(log), false);

  f.git('init', '--bare', remote);
  f.git('remote', 'add', 'origin', remote);
  writeFileSync(join(mock, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.git('config', 'core.hooksPath', mock);
  const original = readFileSync(f.plan, 'utf8');
  const rejectedLink = runPr();
  assert.notEqual(rejectedLink.status, 0);
  assert.match(rejectedLink.stderr, /could not commit PR link; retry to reuse/);
  assert.equal(f.git('rev-parse', 'HEAD'), verifiedHead);
  assert.match(f.git('ls-remote', 'origin', 'refs/heads/feat/pr-test'), new RegExp(verifiedHead));
  assert.equal(readFileSync(f.plan, 'utf8'), original);
  assert.equal(f.git('status', '--porcelain'), '');

  f.git('config', '--unset', 'core.hooksPath');
  const retry = runPr();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Reusing pull request/);
  assert.match(retry.plan, /status: shipped/);
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'),
    'docs/plans/FO-Plan-Test.plan.md');
  const linkedHead = f.git('rev-parse', 'HEAD');
  assert.match(f.git('ls-remote', 'origin', 'refs/heads/feat/pr-test'), new RegExp(linkedHead));
  assert.equal(f.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat/pr-test');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(({ args }) => args[1]), ['list', 'create', 'list']);
  assert.match(calls[1].body, /passed on commit/);
  assert.match(calls[1].body, new RegExp(verifiedHead.slice(0, 10)));
});

test('ci-check requires a plan for workflow policy changes', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\n',
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
    'init',
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
    'chore(workflow): sync',
  );
  const headSha = f.git('rev-parse', 'HEAD').trim();

  const r = f.run('ci-check', ['--base', baseSha, '--head', headSha], [], {
    envOverrides: { NO_PLAN: '1' },
    omitPlan: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no workflow policy changes/);
  writeFileSync(join(f.root, 'notes.txt'), 'Small documentation change.\n');
  f.git('add', 'notes.txt');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'docs: clarify notes');
  const trivial = f.run('ci-check', ['--base', headSha, '--head', 'HEAD'], [], {
    envOverrides: { NO_PLAN: '1' },
    omitPlan: true,
  });
  assert.equal(trivial.status, 0, trivial.stderr);
});

test('ci-check accepts the canonical Notion app page URL only on a trusted host', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', 'scripts');
  f.git('commit', '-m', 'base');
  const base = f.git('rev-parse', 'HEAD');
  const plan = readFileSync(f.plan, 'utf8');
  const check = (host) => {
    writeFileSync(f.plan, plan.replace('status: draft', `status: in-progress\nticket: https://${host}/p/Test-40a0b9c6786f817fab0ff2059ad410e3`));
    f.git('add', 'docs/plans');
    f.git('commit', '-m', 'set ticket URL');
    return f.run('ci-check', ['--base', base, '--head', 'HEAD'], [], { omitPlan: true });
  };
  assert.equal(check('app.notion.com').status, 0);
  assert.match(check('app.notion.com.example.org').stderr, /ticket does not match/);
});

test('ci-check validates committed plan identity, evidence, hygiene, and review scope', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: true,
  });
  const approved = readFileSync(f.plan, 'utf8');
  writeFileSync(f.plan, approved.replace('status: draft', 'status: in-progress'));
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'historical plan');
  const base = f.git('rev-parse', 'HEAD');
  f.git('switch', '-c', 'fix/test-gate');
  const commit = () => {
    f.git('add', '.');
    f.git('commit', '-m', 'candidate');
  };
  const check = () => f.run('ci-check', ['--base', base, '--head', 'HEAD'], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '' },
  });
  const review = (plan) => f.run('review', [
    plan, '--agent', 'Codex', '--verdict', 'pass', '--summary', 'fixture',
  ], [], { omitPlan: true });

  writeFileSync(f.plan, approved + '\n<!-- unrelated edit -->\n');
  writeFileSync(join(f.root, 'app.mjs'), 'export const value = 1;\n');
  commit();
  assert.match(check().stderr, /no plan with a ticket header changed/);

  const plan = 'docs/plans/FO-Plan-Current.plan.md';
  const planPath = join(f.root, plan);
  const current = approved.replace('local://FO:FO-Plan-Test', 'local://FO:FO-Plan-Current');
  writeFileSync(planPath, current);
  commit();
  assert.match(check().stderr, /no passing review recorded/);
  const stamped = review(plan);
  assert.equal(stamped.status, 0, stamped.stderr);
  const reviewed = readFileSync(planPath, 'utf8');
  writeFileSync(planPath, reviewed.replace('status: draft', 'status: shipped'));
  commit();
  assert.equal(check().status, 0, check().stderr);
  writeFileSync(planPath, 'invalid working-copy plan');
  assert.equal(check().status, 0, check().stderr);

  writeFileSync(planPath, reviewed.replace('local://FO:FO-Plan-Current', 'local://'));
  commit();
  assert.match(check().stderr, /ticket does not match/);

  writeFileSync(planPath, reviewed.replace('Works verified: fixture', 'Replacement verified:'));
  commit();
  const replacement = check();
  assert.match(replacement.stderr, /criterion ticked without evidence/);
  assert.match(replacement.stderr, /checkbox removed or replaced/);
  writeFileSync(planPath, reviewed.replace('- [x] Implement', '- [ ] Implement deferred:'));
  commit();
  assert.match(check().stderr, /open item: Implement deferred:/);
  writeFileSync(planPath, reviewed);
  writeFileSync(join(f.root, 'app.mjs'), 'export const value = 2;\n');
  commit();
  assert.match(check().stderr, /review does not cover this change/);

  mkdirSync(join(f.root, 'src/coverage'), { recursive: true });
  writeFileSync(join(f.root, 'src/coverage/debris.txt'), 'artifact');
  commit();
  assert.match(check().stderr, /committed hygiene issues/);
  writeFileSync(join(f.root, 'src/coverage/debris.txt'), 'updated artifact');
  const hygiene = f.run('hygiene', [], [], { omitPlan: true });
  assert.equal(hygiene.status, 1);
  assert.match(hygiene.stdout, /src\/coverage\/debris\.txt/);
});

test('tick and defer commands update plan checkboxes without manual markdown edits', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/test\n',
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
`,
  );

  const rFail = f.run('tick', ['1'], [], { omitPlan: true });
  assert.equal(rFail.status, 1);
  assert.match(rFail.stderr, /requires verified evidence/i);

  const rTick1 = f.run('tick', ['1', '--verified', 'tested manually'], [], {
    omitPlan: true,
  });
  assert.equal(rTick1.status, 0, rTick1.stderr);
  assert.match(rTick1.stdout, /Ticked \[1\]/);

  const rDefer = f.run('defer', ['Step 2', '--reason', 'out of scope'], [], {
    omitPlan: true,
  });
  assert.equal(rDefer.status, 0, rDefer.stderr);
  assert.match(rDefer.stdout, /Deferred/);

  const updated = readFileSync(planPath, 'utf8');
  assert.match(updated, /- \[x\] Criterion 1 verified: tested manually/);
  assert.match(updated, /- \[ \] Step 2 deferred: out of scope/);
});

test('prime command numbers open checkboxes sequentially', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\nbranch: feat/prime-test\n',
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
`,
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
    { omitPlan: true },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created plan: docs\/plans\/FO-Plan-Fast-Feature/);
  assert.match(r.stdout, /Ticket created/);

  const month = new Date().toISOString().slice(0, 7);
  const planPath = join(
    f.root,
    `docs/plans/FO-Plan-Fast-Feature-${month}.plan.md`,
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
    'status: in-progress\nticket: https://www.notion.so/test\n',
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
    'status: done\nticket: https://www.notion.so/test\ncompletedAt: 2026-11-01\n',
  );
  const r = f.run('archive', [], [], { omitPlan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /Archived: docs\/plans\/FO-Plan-Test\.plan\.md -> docs\/plans\/archive\/2026-11\/FO-Plan-Test\.plan\.md/,
  );

  const archivePath = join(
    f.root,
    'docs/plans/archive/2026-11/FO-Plan-Test.plan.md',
  );
  assert.equal(existsSync(archivePath), true);
});

test('doctor command reports repository diagnostics', (t) => {
  const f = fixture(
    t,
    'status: in-progress\nticket: https://www.notion.so/test\n',
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
    'init',
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
    'status: in-progress\nticket: https://www.notion.so/test\n',
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
    'init',
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
    assert.deepEqual(exampleCfg.knownRepos, [
      'my-backend',
      'my-frontend',
      'my-shared-lib',
    ]);
  }

  // 3. Verify scripts/ticket.mjs WORKFLOW_FILES includes install.sh
  const ticketMjsContent = readFileSync(
    join(repoRoot, 'scripts', 'ticket.mjs'),
    'utf8',
  );
  assert.match(ticketMjsContent, /['"]scripts\/install\.sh['"]/);
  assert.match(ticketMjsContent, /['"]scripts\/install\.ps1['"]/);
});

test('the pinned workflow bundle installs and upgrades without replacing target config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-distribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  mkdirSync(target);
  const preload = join(root, 'fetch.mjs');
  const release = 'a'.repeat(40);
  writeFileSync(preload, `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    globalThis.fetch = async (url) => {
      if (url === 'https://api.github.com/repos/example/workflow/commits/main')
        return Response.json({ sha: '${release}' });
      const pinned = 'https://raw.githubusercontent.com/example/workflow/${release}/';
      if (!url.startsWith(pinned)) throw new Error('unversioned file request ' + url);
      const path = url.slice(pinned.length);
      if (path === process.env.MISSING_BUNDLE_FILE) return new Response('', { status: 404 });
      return new Response(readFileSync(join(process.env.BUNDLE_ROOT, path), 'utf8'));
    };
  `);
  const run = (flags = [], extraEnv = {}) => spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href, join(scripts, 'sync.mjs'),
    '--remote', '--upstream', 'example/workflow', target, ...flags,
  ], {
    encoding: 'utf8',
    env: { ...process.env, BUNDLE_ROOT: join(scripts, '..'), ...extraEnv },
  });

  const incomplete = run(['--init-prefix', 'DEMO'], {
    MISSING_BUNDLE_FILE: '.github/workflows/ticket-done.yml',
  });
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.deepEqual(readdirSync(target), []);
  const missingConfig = run(['--check']);
  assert.equal(missingConfig.status, 2, missingConfig.stderr);
  assert.match(missingConfig.stderr, /missing scripts\/ticket.config.json/);

  const installed = run(['--init-prefix', 'DEMO']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, new RegExp(release));
  assert.match(readFileSync(join(target, '.agents/skills/dev-workflow/SKILL.md'), 'utf8'), /DEMO-Plan-/);
  assert.equal(run(['--check']).status, 0);

  const configPath = join(target, 'scripts/ticket.config.json');
  const custom = JSON.stringify({ prefix: 'APP', tracker: 'local', protectedBranches: ['release'] });
  writeFileSync(configPath, custom);
  const updater = join(target, 'scripts/sync.mjs');
  writeFileSync(updater, '// Previous installer placed this older updater.\n');
  const drift = run(['--check']);
  assert.equal(drift.status, 1, drift.stderr);
  assert.match(drift.stdout, /\[DRIFT\].*scripts\/sync.mjs/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(configPath, 'utf8'), custom);
  assert.match(readFileSync(updater, 'utf8'), /workflow-manifest\.json/);
  assert.match(readFileSync(join(target, '.github/workflows/plan-check.yml'), 'utf8'), /branches: \["release"\]/);
  assert.equal(run(['--check']).status, 0);
});

test('verify command executes tiered commands and falls back to legacy verifyCommand', (t) => {
  // 1. Tiered config
  const fTiered = fixture(t, '', [], {
    verify: {
      fast: 'node -e "console.log(\'fast-passed\')"',
      test: 'node -e "console.log(\'test-passed\')"',
      full: 'node -e "console.log(\'full-passed\')"',
    },
  });

  // Default tier is 'test'
  const rDefault = fTiered.run('verify', [], [], { omitPlan: true });
  assert.equal(rDefault.status, 0, rDefault.stderr);
  assert.match(rDefault.stdout, /Running verification \(test\)/);
  assert.match(rDefault.stdout, /test-passed/);

  // Custom tier --tier full
  const rFull = fTiered.run('verify', ['--tier', 'full'], [], {
    omitPlan: true,
  });
  assert.equal(rFull.status, 0, rFull.stderr);
  assert.match(rFull.stdout, /Running verification \(full\)/);
  assert.match(rFull.stdout, /full-passed/);

  // --all executes all tiers sequentially
  const rAll = fTiered.run('verify', ['--all'], [], { omitPlan: true });
  assert.equal(rAll.status, 0, rAll.stderr);
  assert.match(
    rAll.stdout,
    /Running all verification tiers: fast -> test -> full/,
  );
  assert.match(rAll.stdout, /Tier "fast" passed/);
  assert.match(rAll.stdout, /Tier "test" passed/);
  assert.match(rAll.stdout, /Tier "full" passed/);

  // Unknown tier fails with exit code 1
  const rUnknown = fTiered.run('verify', ['--tier', 'lint'], [], {
    omitPlan: true,
  });
  assert.equal(rUnknown.status, 1);
  assert.match(rUnknown.stderr, /unknown verification tier "lint"/);

  // 2. Legacy fallback to verifyCommand
  const fLegacy = fixture(t, '', [], {
    verifyCommand: 'node -e "console.log(\'legacy-passed\')"',
  });
  const rLegacy = fLegacy.run('verify', [], [], { omitPlan: true });
  assert.equal(rLegacy.status, 0, rLegacy.stderr);
  assert.match(rLegacy.stdout, /Running verification \(test\)/);
  assert.match(rLegacy.stdout, /legacy-passed/);
});

test('hygiene command detects unmerged conflicts, disallowed files, oversized files and integrates with check and pack', (t) => {
  const f = fixture(
    t,
    'ticket: https://www.notion.so/40a0b9c6786f817fab0ff2059ad410e3\n',
    [],
    {
      hygiene: {
        maxFileSizeKB: 1,
        disallowedPatterns: ['*.dump'],
      },
    },
  );

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  // Clean hygiene check
  const rClean = f.run('hygiene', [], [], { omitPlan: true });
  assert.equal(rClean.status, 0, rClean.stderr);
  assert.match(rClean.stdout, /Working tree hygiene clean\./);

  // Pack reports clean hygiene
  const rPackClean = f.run('pack', [], [], { omitPlan: true });
  assert.equal(rPackClean.status, 0, rPackClean.stderr);
  assert.match(rPackClean.stdout, /Hygiene check: clean/);

  // Introduce a disallowed directory and pattern
  mkdirSync(join(f.root, '.tmp'), { recursive: true });
  writeFileSync(join(f.root, '.tmp/cache.json'), '{}');
  writeFileSync(join(f.root, 'error.dump'), 'dump');

  const rDirty = f.run('hygiene', [], [], { omitPlan: true });
  assert.equal(rDirty.status, 1);
  assert.match(rDirty.stdout, /Disallowed temporary or build artifact: \.tmp/);
  assert.match(
    rDirty.stdout,
    /Disallowed temporary or build artifact: error\.dump/,
  );

  // Introduce oversized file (> 1KB)
  writeFileSync(join(f.root, 'bigfile.dat'), 'A'.repeat(2048));
  const rWarn = f.run('hygiene', [], [], { omitPlan: true });
  assert.match(rWarn.stdout, /File exceeds size budget/);

  // Check with --strict fails when hygiene issues exist
  const rCheckStrict = f.run('check', ['--strict']);
  assert.equal(rCheckStrict.status, 1);
  assert.match(rCheckStrict.stderr, /working tree hygiene failed/);

  // Check without --strict warns but succeeds
  const rCheckWarn = f.run('check', []);
  assert.equal(rCheckWarn.status, 0);
  assert.match(rCheckWarn.stderr, /Hygiene issues detected/);
});

test('pack with --tier executes specific tier and embeds output', (t) => {
  const f = fixture(t, '', [], {
    verify: {
      fast: 'node -e "console.log(\'fast-pack-verified\')"',
      test: 'node -e "console.log(\'test-pack-verified\')"',
    },
  });

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const rPack = f.run('pack', ['--test', '--tier', 'fast'], [], {
    omitPlan: true,
  });
  assert.equal(rPack.status, 0, rPack.stderr);
  assert.match(rPack.stdout, /Verify command: `node -e .*` \(fast\)/);
  assert.match(rPack.stdout, /## Test Verification/);
  assert.match(rPack.stdout, /fast-pack-verified/);
  assert.match(rPack.stdout, /Hygiene check: clean/);
});

test('switch command navigates to main checkout, creates worktrees, and supports --path', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  // Switch to main
  const rMain = f.run('switch', ['main'], [], { omitPlan: true });
  assert.equal(rMain.status, 0, rMain.stderr);
  assert.match(rMain.stdout, /Already on main repository checkout/);

  // Switch to main with --path outputs raw repoRoot
  const rMainPath = f.run('switch', ['main', '--path'], [], { omitPlan: true });
  assert.equal(rMainPath.status, 0, rMainPath.stderr);
  assert.equal(rMainPath.stdout.trim(), f.root);

  // Create .env in root
  writeFileSync(join(f.root, '.env'), 'SECRET_TOKEN=xyz123\n');

  // Switch to plan creates worktree on-demand and propagates .env
  const rPlanSwitch = f.run('switch', [f.plan], [], { omitPlan: true });
  assert.equal(rPlanSwitch.status, 0, rPlanSwitch.stderr);
  assert.match(rPlanSwitch.stdout, /Created worktree at/);

  const wtDir = join(f.root, '.worktrees', 'test');
  assert.equal(existsSync(wtDir), true, 'worktree directory should exist');
  assert.equal(
    existsSync(join(wtDir, '.env')),
    true,
    'worktree should inherit .env',
  );

  // Switching again detects existing worktree
  const rPlanExisting = f.run('switch', [f.plan], [], { omitPlan: true });
  assert.equal(rPlanExisting.status, 0, rPlanExisting.stderr);
  assert.match(rPlanExisting.stdout, /Worktree exists at:/);

  // Switching with --path returns path
  const rPlanPath = f.run('switch', [f.plan, '--path'], [], { omitPlan: true });
  assert.equal(rPlanPath.status, 0, rPlanPath.stderr);
  assert.equal(rPlanPath.stdout.trim(), wtDir);

  // Switch with --no-create on non-existent branch fails
  const rNoCreate = f.run(
    'switch',
    ['non-existent-branch', '--no-create'],
    [],
    {
      omitPlan: true,
    },
  );
  assert.equal(rNoCreate.status, 1);
  assert.match(rNoCreate.stderr, /worktree does not exist/);
});

test('split command partitions plan into Part 1 and Part 2 with deferred items and traceability', (t) => {
  const f = fixture(t);
  const planPath = f.plan;
  const multiPlanContent = `---
title: Plan - Feature: Mega Refactor
ticket: local://FO:Mega-Refactor
status: in-progress
priority: high
state: flow
due: 2026-12-01
---
# Mega Refactor

## Summary

Mega refactor across multiple areas.

## Acceptance criteria

- [x] Phase 1 core model verified: manual
- [ ] Phase 2 API endpoints
- [ ] Phase 3 Frontend view

## Steps

- [x] Implement core model
- [ ] Implement API endpoints
- [ ] Implement frontend view

## Notes

Initial scope.
`;
  writeFileSync(planPath, multiPlanContent);

  // Split after item 1
  const rSplit = f.run('split', [planPath, '--after', '1'], [], {
    omitPlan: true,
  });
  assert.equal(rSplit.status, 0, rSplit.stderr);
  assert.match(rSplit.stdout, /Plan split successfully/);

  // Verify Part 1 contents
  const part1Updated = readFileSync(planPath, 'utf8');
  assert.match(part1Updated, /title: Plan - Feature: Mega Refactor \(Part 1\)/);
  assert.match(
    part1Updated,
    /- \[ \] Phase 2 API endpoints deferred: moved to Part 2/,
  );
  assert.match(
    part1Updated,
    /- \[ \] Phase 3 Frontend view deferred: moved to Part 2/,
  );
  assert.match(
    part1Updated,
    /Split into Part 2: \[Part 2\]\(docs\/plans\/FO-Plan-Test-Part-2\.plan\.md\)/,
  );

  // Verify Part 2 was created
  const part2Path = join(f.root, 'docs/plans/FO-Plan-Test-Part-2.plan.md');
  assert.equal(existsSync(part2Path), true, 'Part 2 plan should exist');

  const part2Content = readFileSync(part2Path, 'utf8');
  assert.match(part2Content, /title: Plan - Feature: Mega Refactor \(Part 2\)/);
  assert.match(part2Content, /status: draft/);
  assert.match(part2Content, /priority: high/);
  assert.match(part2Content, /- \[ \] Phase 2 API endpoints/);
  assert.match(part2Content, /- \[ \] Phase 3 Frontend view/);
  assert.match(part2Content, /- \[ \] Implement API endpoints/);
  assert.match(part2Content, /- \[ \] Implement frontend view/);
  assert.match(
    part2Content,
    /Part 1 plan: \[Part 1\]\(docs\/plans\/FO-Plan-Test\.plan\.md\)/,
  );
});

test('review enhancements: --prompt, dual-pass metadata, and verdict guardrails', (t) => {
  const f = fixture(
    t,
    'ticket: https://www.notion.so/40a0b9c6786f817fab0ff2059ad410e3\n',
    [],
    { verifyCommand: 'npm test' },
  );

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  // 1. review --prompt emits formatted review request
  const rPrompt = f.run('review', ['--prompt'], [], { omitPlan: true });
  assert.equal(rPrompt.status, 0, rPrompt.stderr);
  assert.match(rPrompt.stdout, /# Single-Pass Review Request/);
  assert.match(rPrompt.stdout, /## Acceptance Criteria to Verify/);
  assert.match(rPrompt.stdout, /## Review Rubric/);

  // 2. review guardrail: unticked criteria rejects pass verdict without --force
  writeFileSync(
    f.plan,
    readFileSync(f.plan, 'utf8').replace(
      '- [x] Works verified: fixture',
      '- [ ] Works to be done',
    ),
  );

  const rGuardFail = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'premature pass',
  ]);
  assert.equal(rGuardFail.status, 1);
  assert.match(
    rGuardFail.stderr,
    /cannot stamp review verdict "pass": 1 acceptance criteria remain unticked/,
  );

  // Passing --force overrides the guardrail
  const rGuardForce = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'forced pass',
    '--force',
  ]);
  assert.equal(rGuardForce.status, 0, rGuardForce.stderr);

  // 3. dual-pass review flags
  const rDualWarn = f.run('review', [
    '--agent',
    'Gemini',
    '--standards',
    'warn',
    '--spec',
    'pass',
    '--summary',
    'minor standards warning',
  ]);
  assert.equal(rDualWarn.status, 0, rDualWarn.stderr);
  assert.match(
    rDualWarn.stdout,
    /Review \(warn \[standards: warn, spec: pass\]\) recorded/,
  );

  const rDualBlock = f.run('review', [
    '--agent',
    'Gemini',
    '--standards',
    'pass',
    '--spec',
    'block',
    '--summary',
    'spec regression found',
  ]);
  assert.equal(rDualBlock.status, 0, rDualBlock.stderr);
  assert.match(
    rDualBlock.stdout,
    /Review \(block \[standards: pass, spec: block\]\) recorded/,
  );
});

test('fleet dashboard and fleet --worktrees report multi-repo status', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  // Dashboard table
  const rFleet = f.run('fleet', [], [], { omitPlan: true });
  assert.equal(rFleet.status, 0, rFleet.stderr);
  assert.match(rFleet.stdout, /=== Fleet Status Dashboard/);
  assert.match(
    rFleet.stdout,
    /Repo\s+Branch\s+Tree\s+WT\s+Active Plan\s+Review/,
  );

  // Worktrees listing
  const rWt = f.run('fleet', ['--worktrees'], [], { omitPlan: true });
  assert.equal(rWt.status, 0, rWt.stderr);
  assert.match(rWt.stdout, /main/);
});

test('fleet verify runs verification across repositories and reports summary', (t) => {
  const f = fixture(t, '', [], {
    verify: {
      test: 'node -e "console.log(\'fleet-verify-ok\')"',
    },
  });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const rVerify = f.run('fleet', ['verify'], [], { omitPlan: true });
  assert.equal(rVerify.status, 0, rVerify.stderr);
  assert.match(rVerify.stdout, /=== Fleet Verification/);
  assert.match(rVerify.stdout, /PASS/);
  assert.match(rVerify.stdout, /Fleet Verification: \d+ passed/);
});

test('enhanced recall searches across multiple words with line citations', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'docs/decisions'), { recursive: true });
  writeFileSync(
    join(f.root, 'docs/decisions/001-architecture.md'),
    '# Architecture Core\n\nWe decided to use native child processes.\nLine three with extra details.\n',
  );

  const rRecall = f.run('recall', ['Architecture Core'], [], {
    omitPlan: true,
  });
  assert.equal(rRecall.status, 0, rRecall.stderr);
  assert.match(rRecall.stdout, /=== Recall: "Architecture Core"/);
  assert.match(
    rRecall.stdout,
    /\[ADR\] docs\/decisions\/001-architecture\.md — Architecture Core/,
  );
  assert.match(rRecall.stdout, /L1: # Architecture Core/);
});

test('step command supports text output, --json, and role briefs', (t) => {
  const f = fixture(
    t,
    'branch: feat/test\n',
    [],
    {
      agentic: { maxRetries: 3, verifyTier: 'test' },
      verify: { test: 'node -e "console.log(\'test-ok\')"' },
    },
  );
  const planPath = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    planPath,
    `---\ntitle: Plan - Feature: Agentic Test\nstatus: in-progress\nbranch: feat/test\n---\n# Agentic Test\n\n## Summary\nAgentic summary\n\n## Acceptance criteria\n- [ ] Criterion 1\n\n## Steps\n- [ ] Step 1\n\n## Progress log\n- 2026-11-10 10:00 UTC, Codex (review: block): Missing edge case handling\n`,
  );

  // 1. Text output
  const rText = f.run('step', ['docs/plans/FO-Plan-Test.plan.md'], [], {
    omitPlan: true,
  });
  assert.equal(rText.status, 0, rText.stderr);
  assert.match(rText.stdout, /# Next Step Brief: Plan - Feature: Agentic Test/);
  assert.match(rText.stdout, /Target \[2\]: Step 1/);
  assert.match(rText.stdout, /Retry Budget: 3 attempt\(s\)/);

  // 2. JSON output
  const rJson = f.run('step', ['docs/plans/FO-Plan-Test.plan.md', '--json'], [], {
    omitPlan: true,
  });
  assert.equal(rJson.status, 0, rJson.stderr);
  const data = JSON.parse(rJson.stdout);
  assert.equal(data.nextStep.index, 2);
  assert.equal(data.nextStep.text, 'Step 1');
  assert.equal(data.maxRetries, 3);
  assert.equal(data.retryCount, 0);
  assert.equal(data.remainingSteps, 1);
  assert.equal(data.remainingCriteria, 1);

  // 3. Builder brief
  const rBuilder = f.run(
    'step',
    ['docs/plans/FO-Plan-Test.plan.md', '--role', 'builder'],
    [],
    { omitPlan: true },
  );
  assert.equal(rBuilder.status, 0, rBuilder.stderr);
  assert.match(rBuilder.stdout, /# Autonomous Builder Brief:/);
  assert.match(rBuilder.stdout, /Target: \[2\] Step 1/);
  assert.match(rBuilder.stdout, /## Completed Steps & Latest Progress/);
  assert.match(rBuilder.stdout, /Execution Protocol/);

  // 4. Reviewer brief
  const rReviewer = f.run(
    'step',
    ['docs/plans/FO-Plan-Test.plan.md', '--role', 'reviewer'],
    [],
    { omitPlan: true },
  );
  assert.equal(rReviewer.status, 0, rReviewer.stderr);
  assert.match(rReviewer.stdout, /# Adversarial Review Brief:/);
  assert.match(rReviewer.stdout, /ticket\.mjs pack --test/);

  // 5. Fixer brief
  const rFixer = f.run(
    'step',
    ['docs/plans/FO-Plan-Test.plan.md', '--role', 'fixer'],
    [],
    { omitPlan: true },
  );
  assert.equal(rFixer.status, 0, rFixer.stderr);
  assert.match(rFixer.stdout, /# Block-Fixer Brief:/);
  assert.match(rFixer.stdout, /Missing edge case handling/);
});

test('checkpoint command verifies, ticks checkbox, and creates git commit', (t) => {
  const f = fixture(
    t,
    'branch: feat/checkpoint-test\n',
    [],
    {
      verify: { test: 'node -e "console.log(\'chk-ok\')"' },
    },
  );
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const planPath = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    planPath,
    `---\ntitle: Plan - Feature: Checkpoint Test\nstatus: in-progress\nbranch: main\n---\n# Checkpoint Test\n\n## Acceptance criteria\n- [ ] First criterion\n\n## Steps\n- [ ] First step\n`,
  );
  f.git('commit', '-am', 'add test plan');
  const skipped = f.run('checkpoint', ['--no-verify']);
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /checkpoint requires verification/);
  assert.doesNotMatch(skipped.plan, /- \[x\]/);
  const unknownTier = f.run('checkpoint', ['--tier', 'typo']);
  assert.equal(unknownTier.status, 1);
  assert.match(unknownTier.stderr, /checkpoint requires verification/);

  // Checkpoint criterion 1 (runs verify, adds verified stamp, and reports accurately re-indexed next item [1])
  const rChk1 = f.run(
    'checkpoint',
    ['docs/plans/FO-Plan-Test.plan.md', '1', '--commit'],
    [],
    { omitPlan: true },
  );
  assert.equal(rChk1.status, 0, rChk1.stderr);
  assert.match(rChk1.stdout, /✓ Ticked \[1\]: - \[x\] First criterion verified:/);
  assert.match(rChk1.stdout, /✓ Git checkpoint committed:/);
  assert.match(rChk1.stdout, /Next open item \[1\]: - \[ \] First step \(section: Steps\)/);

  const updatedPlan = readFileSync(planPath, 'utf8');
  assert.match(updatedPlan, /- \[x\] First criterion verified:/);

  // Default target alignment: calling checkpoint without index picks First step [1]
  const rDefault = f.run('step', ['docs/plans/FO-Plan-Test.plan.md'], [], {
    omitPlan: true,
  });
  assert.match(rDefault.stdout, /Target \[1\]: First step/);

  // Deterministic retry circuit breaker on failing verify
  writeFileSync(
    join(f.root, 'scripts/ticket.config.json'),
    JSON.stringify(
      {
        ...defaultNotionConfig,
        agentic: { maxRetries: 2, verifyTier: 'test' },
        verify: { test: 'node -e "process.exit(1)"' },
      },
      null,
      2,
    ),
  );

  // Attempt 1/2
  const rChkFail1 = f.run(
    'checkpoint',
    ['docs/plans/FO-Plan-Test.plan.md', '1'],
    [],
    { omitPlan: true },
  );
  assert.equal(rChkFail1.status, 1);
  assert.match(rChkFail1.stderr, /checkpoint verification failed \(attempt 1\/2:/);
  const planAfterFail1 = readFileSync(planPath, 'utf8');
  assert.match(planAfterFail1, /retryCount:\s*['"]?1['"]?/);

  // Attempt 2/2 -> Circuit breaker trips
  const rChkFail2 = f.run(
    'checkpoint',
    ['docs/plans/FO-Plan-Test.plan.md', '1'],
    [],
    { omitPlan: true },
  );
  assert.equal(rChkFail2.status, 1);
  assert.match(rChkFail2.stderr, /CIRCUIT BREAKER TRIPPED \(2\/2 failed verification attempts/);
  const exhausted = f.run('checkpoint');
  assert.equal(exhausted.status, 1);
  assert.match(exhausted.stderr, /CIRCUIT BREAKER TRIPPED \(2\/2/);
  assert.doesNotMatch(exhausted.stdout, /Running checkpoint verification/);
  assert.match(exhausted.plan, /retryCount: 2/);

  // Hygiene guardrail prevents checkpoint --commit with junk files
  writeFileSync(
    join(f.root, 'scripts/ticket.config.json'),
    JSON.stringify(
      {
        ...defaultNotionConfig,
        agentic: { maxRetries: 3, verifyTier: 'test' },
        verify: { test: 'node -e "console.log(\'pass\')"' },
        hygiene: { disallowedPatterns: ['.tmp'] },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(f.root, '.tmp'), { recursive: true });
  writeFileSync(join(f.root, '.tmp/junk.txt'), 'garbage');

  const rHygieneBlock = f.run(
    'checkpoint',
    ['docs/plans/FO-Plan-Test.plan.md', '1', '--commit'],
    [],
    { omitPlan: true },
  );
  assert.equal(rHygieneBlock.status, 1);
  assert.match(rHygieneBlock.stderr, /checkpoint commit blocked by hygiene issues/);

  // Clean hygiene allows checkpoint (with no target index argument) to default to First step [1], pass, and clear retryCount
  rmSync(join(f.root, '.tmp'), { recursive: true, force: true });
  writeFileSync(join(f.root, 'scoped.mjs'), 'export const scoped = true;\n');
  writeFileSync(join(f.root, 'unrelated.txt'), 'Unrelated work.\n');
  f.git('add', 'scoped.mjs');
  const originalIndex = f.git('diff', '--cached');
  const beforeRejection = readFileSync(planPath, 'utf8');
  const hookPath = join(f.root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = f.run('checkpoint', ['--commit']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /checkpoint commit rejected; plan restored/);
  assert.equal(readFileSync(planPath, 'utf8'), beforeRejection);
  assert.equal(f.git('diff', '--cached'), originalIndex);
  rmSync(hookPath);
  const rPass = f.run(
    'checkpoint',
    ['docs/plans/FO-Plan-Test.plan.md', '--commit'],
    [],
    { omitPlan: true },
  );
  assert.equal(rPass.status, 0, rPass.stderr);
  assert.match(rPass.stdout, /All criteria and steps in docs\/plans\/FO-Plan-Test\.plan\.md are now completed!/);
  const planAfterPass = readFileSync(planPath, 'utf8');
  assert.doesNotMatch(planAfterPass, /retryCount:/);
  assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split(/\r?\n/), [
    'docs/plans/FO-Plan-Test.plan.md',
    'scoped.mjs',
  ]);
  assert.equal(readFileSync(join(f.root, 'unrelated.txt'), 'utf8'), 'Unrelated work.\n');
});

test('wave command renders dashboard status and spawns worktrees', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  // Status check
  const rStatus = f.run('wave', ['--status'], [], { omitPlan: true });
  assert.equal(rStatus.status, 0, rStatus.stderr);
  assert.match(rStatus.stdout, /=== Wave Orchestration Dashboard ===/);

  // Spawn worktrees for planned plans
  const plan2 = join(f.root, 'docs/plans/FO-Plan-Wave-Worker.plan.md');
  writeFileSync(
    plan2,
    `---\ntitle: Plan - Feature: Wave Worker\nstatus: planned\nbranch: feat/wave-worker\n---\n# Wave Worker\n\n## Acceptance criteria\n- [ ] Criterion A\n\n## Steps\n- [ ] Step A\n`,
  );

  const rSpawn = f.run(
    'wave',
    ['docs/plans/FO-Plan-Wave-Worker.plan.md', '--spawn'],
    [],
    { omitPlan: true },
  );
  assert.equal(rSpawn.status, 0, rSpawn.stderr);
  assert.match(rSpawn.stdout, /=== Wave Orchestration: Spawning 1 Worktree/);
  assert.match(rSpawn.stdout, /Wave spawn complete: 1 worktree\(s\) active/);
  const wtDir = join(f.root, '.worktrees/wave-worker');
  assert.ok(existsSync(wtDir));

  // Verify plan doc was synced into worktree
  const wtPlanPath = join(wtDir, 'docs/plans/FO-Plan-Wave-Worker.plan.md');
  assert.ok(existsSync(wtPlanPath));

  // Simulate subagent progress in worktree
  writeFileSync(
    wtPlanPath,
    `---\ntitle: Plan - Feature: Wave Worker\nstatus: in-progress\nbranch: feat/wave-worker\nworktree: wave-worker\n---\n# Wave Worker\n\n## Acceptance criteria\n- [x] Criterion A verified: pass\n\n## Steps\n- [ ] Step A\n`,
  );

  // wave --status reads live worktree progress (1/2 completed)
  const rLive = f.run('wave', ['--status'], [], { omitPlan: true });
  assert.equal(rLive.status, 0, rLive.stderr);
  assert.match(rLive.stdout, /FO-Plan-Wave-Worker\s+feat\/wave-worker\s+\.worktrees\/wave-worker\s+1\/2/);

  // Closed plans filtering
  const planClosed = join(f.root, 'docs/plans/FO-Plan-Closed.plan.md');
  writeFileSync(
    planClosed,
    `---\ntitle: Plan - Feature: Closed\nstatus: done\nbranch: main\n---\n# Closed\n`,
  );
  const rFilter = f.run('wave', ['--status'], [], { omitPlan: true });
  assert.doesNotMatch(rFilter.stdout, /FO-Plan-Closed/);

  const rAll = f.run('wave', ['--status', '--all'], [], { omitPlan: true });
  assert.match(rAll.stdout, /FO-Plan-Closed/);
});

test("wave uses registered branches and keeps sibling worktree progress", (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const planContent = (branch, complete = false) =>
    `---\ntitle: Plan - Feature: Worker\nstatus: in-progress\nbranch: ${branch}\nworktree: ${basename(f.root)}\n---\n` +
    `## Acceptance criteria\n- [${complete ? 'x' : ' '}] Criterion${complete ? ' verified: pass' : ''}\n\n` +
    `## Steps\n- [${complete ? 'x' : ' '}] Implement\n`;
  for (let i = 0; i < 6; i++)
    writeFileSync(join(f.root, `docs/plans/FO-Plan-Historical-${i}.plan.md`), planContent(`old/${i}`, true));
  const first = 'docs/plans/FO-Plan-One.plan.md';
  const second = 'docs/plans/FO-Plan-Two.plan.md';
  writeFileSync(join(f.root, first), planContent('feat/shared'));
  writeFileSync(join(f.root, second), planContent('fix/shared'));

  const dry = f.run('wave', ['--spawn', '--dry-run'], [], { omitPlan: true });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry-run\] 2 worktree target\(s\)/);
  assert.doesNotMatch(dry.stdout, /Historical/);
  assert.equal(existsSync(join(f.root, '.worktrees')), false);

  const spawned = f.run('wave', ['--spawn'], [], { omitPlan: true });
  assert.equal(spawned.status, 0, spawned.stderr);
  const switched = (branch) => f.run('switch', [branch, '--path'], [], { omitPlan: true }).stdout.trim();
  const one = switched('feat/shared');
  const two = switched('fix/shared');
  assert.notEqual(one, two);
  assert.equal(readFileSync(join(f.root, first), 'utf8'), planContent('feat/shared'));
  const live = join(two, second);
  const progress = readFileSync(live, 'utf8').replace('- [ ] Implement', '- [x] Implement');
  writeFileSync(live, progress);
  const rerun = f.run('wave', [second, '--spawn'], [], { omitPlan: true });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(readFileSync(live, 'utf8'), progress);

  const worker = [join(one, 'scripts/ticket.mjs')];
  const fromSibling = execFileSync(process.execPath, [...worker, 'wave', '--status'], {
    cwd: one, encoding: 'utf8',
  });
  assert.match(fromSibling, /FO-Plan-Two\s+fix\/shared\s+\.worktrees\/shared-\w+\s+1\/2/);
  const main = execFileSync(process.execPath, [...worker, 'switch', 'main', '--path'], {
    cwd: one, encoding: 'utf8',
  });
  assert.equal(main.trim(), f.root);
});

test("wt prune preserves dirty, locked, and invoking worktrees", (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const parent = join(f.root, '.worktrees');
  for (const name of ['current', 'dirty', 'locked', 'clean']) {
    f.git('worktree', 'add', '-b', `feat/${name}`, join(parent, name));
  }
  f.git('worktree', 'lock', join(parent, 'locked'));
  writeFileSync(join(parent, 'dirty', 'untracked.txt'), 'preserve');
  const current = join(parent, 'current');
  const worker = [join(current, 'scripts/ticket.mjs'), 'wt', 'prune', '--all'];
  const dry = execFileSync(process.execPath, [...worker, '--dry-run'], { cwd: current, encoding: 'utf8' });
  assert.match(dry, /\[dry-run\] 1 worktree\(s\) eligible/);
  assert.equal(existsSync(join(parent, 'clean')), true);
  const result = execFileSync(process.execPath, worker, { cwd: current, encoding: 'utf8' });
  assert.match(result, /Prune complete: 1 worktree\(s\) pruned/);
  for (const name of ['current', 'dirty', 'locked']) assert.ok(existsSync(join(parent, name)));
  assert.equal(existsSync(join(parent, 'clean')), false);
});

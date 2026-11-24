import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
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
  requireReview: false,
  noPlan: {
    maxChangedLines: 40,
    noNewFilesUnder: ['src'],
  },
};

let cachedGitTemplateDir = null;
function getGitTemplateDir() {
  if (!cachedGitTemplateDir) {
    cachedGitTemplateDir = mkdtempSync(join(tmpdir(), 'ticket-git-tpl-'));
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: cachedGitTemplateDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: cachedGitTemplateDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: cachedGitTemplateDir,
      stdio: 'ignore',
    });
    process.on('exit', () => {
      try {
        rmSync(cachedGitTemplateDir, { recursive: true, force: true });
      } catch {}
    });
  }
  return cachedGitTemplateDir;
}

function fixture(t, front = '', responses = [], configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ticket-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  copyFileSync(join(scripts, 'ticket.mjs'), join(root, 'scripts/ticket.mjs'));
  if (existsSync(join(scripts, 'lib'))) {
    cpSync(join(scripts, 'lib'), join(root, 'scripts/lib'), { recursive: true });
  }
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
  const ghRequests = join(root, 'gh-requests.jsonl');
  const preload = join(root, 'mock.mjs');
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const responses = JSON.parse(process.env.MOCK_RESPONSES);
globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.MOCK_REQUESTS, JSON.stringify({url, method:init.method, body: init.body ? JSON.parse(init.body) : null}) + '\\n');
  const response = responses.shift();
  if (!response) throw new Error('unexpected API request');
  if (response.throw) throw new Error(response.throw);
  return new Response(JSON.stringify(response.body), {status: response.status || 200});
};
const github = JSON.parse(process.env.MOCK_GITHUB);
if (github) {
  const cp = createRequire(import.meta.url)('node:child_process');
  const original = cp.execFileSync;
  cp.execFileSync = function (cmd, args, options) {
    if (cmd !== 'gh') return original(cmd, args, options);
    appendFileSync(process.env.MOCK_GH_REQUESTS, JSON.stringify(args) + '\\n');
    if (!github.length) throw new Error('unexpected GitHub call ' + args.join(' '));
    const result = github.shift();
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  syncBuiltinESMExports();
}`,
  );
  function run(
    command,
    options = [],
    replies = responses,
    { omitPlan = false, envOverrides = {}, cwd = root, github = null } = {},
  ) {
    const args = [
      '--import',
      pathToFileURL(preload).href,
      join(cwd, 'scripts/ticket.mjs'),
      command,
      ...(omitPlan ? [] : ['docs/plans/FO-Plan-Test.plan.md']),
      ...options,
    ];
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        NOTION_TOKEN: 'test-token',
        MOCK_RESPONSES: JSON.stringify(replies),
        MOCK_REQUESTS: requests,
        MOCK_GITHUB: JSON.stringify(github),
        MOCK_GH_REQUESTS: ghRequests,
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
      ghCalls: existsSync(ghRequests)
        ? readFileSync(ghRequests, 'utf8').trim().split('\n').map(JSON.parse) : [],
      plan: existsSync(plan) ? readFileSync(plan, 'utf8') : '',
    };
  }
  function git(...args) {
    if (args[0] === 'init' && !existsSync(join(root, '.git'))) {
      cpSync(join(getGitTemplateDir(), '.git'), join(root, '.git'), {
        recursive: true,
      });
      if (args[1] === '-b' && args[2] && args[2] !== 'main') {
        writeFileSync(
          join(root, '.git', 'HEAD'),
          `ref: refs/heads/${args[2]}\n`,
          'utf8',
        );
      }
      return '';
    }
    if (
      args[0] === 'config' &&
      ((args[1] === 'user.name' && args[2] === 'Test') ||
        (args[1] === 'user.email' && args[2] === 'test@example.invalid')) &&
      existsSync(join(root, '.git'))
    ) {
      return '';
    }
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
const repository = { url: 'https://github.com/example/repo' };
const planFilename = 'docs/plans/FO-Plan-Test.plan.md';
const changedPlan = { filename: planFilename, status: 'added' };
const mergedPull = (number, sha, fields = {}) => ({
  html_url: `${repository.url}/pull/${number}`,
  base: { ref: 'main', repo: { full_name: 'example/repo' }, sha },
  state: 'closed',
  merged: true,
  merged_at: '2025-10-20T22:30:00Z',
  merge_commit_sha: sha,
  changed_files: 1,
  ...fields,
});
const taskPage = (properties = {}, id = created.body.id) => ({
  body: {
    id,
    parent: { type: 'data_source_id', data_source_id: defaultNotionConfig.dataSourceId },
    properties: {
      'Task Lane': { select: { name: 'Development' } },
      'Dev Ticket Key': { rich_text: [{ plain_text: 'FO:FO-Plan-Test' }] },
      Project: { relation: [{ id: defaultNotionConfig.projectPageId }] },
      Description: { rich_text: [{ plain_text: `Earlier summary\n\nPlan: ${planFilename}` }] },
      ...properties,
    },
  },
});

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

test('create preserves the canonical plan path in a long Task description', (t) => {
  const f = fixture(t, '', [empty, created]);
  writeFileSync(f.plan, readFileSync(f.plan, 'utf8').replace('Test fixture', 'A'.repeat(2500)));
  const result = f.run('create', ['--agent', 'Codex']);
  assert.equal(result.status, 0, result.stderr);
  const description = result.calls[1].body.properties.Description.rich_text[0].text.content;
  assert.ok(description.length < 1990);
  assert.equal(description.split('\n').at(-1), `Plan: ${planFilename}`);
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
      taskPage({ 'Started At': { date: started ? { start: started } : null } }),
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

const completionState = (status = 'Doing', start = null, id) => taskPage({
  Status: { status: { name: status } },
  'Completed At': { date: start ? { start } : null },
}, id);

function doneGitHubFixture(plan, fields) {
  return [repository, mergedPull(1, '1'.repeat(40), fields), [[changedPlan]], plan];
}

test('ship refuses to write to a Task with mismatched identity', (t) => {
  const f = fixture(t, `ticket: ${url}\n`);
  const valid = taskPage().body;
  for (const [index, body] of [
    { ...valid, parent: { ...valid.parent, data_source_id: defaultNotionConfig.projectPageId } },
    ...Object.entries({
      'Dev Ticket Key': { rich_text: [{ plain_text: 'FO:Other-Plan' }] },
      'Task Lane': { select: { name: 'Life OS' } },
      Project: { relation: [] },
      Description: { rich_text: [{ plain_text: `ADW plan: ${planFilename}\n\nPlan: docs/plans/FO-Plan-Other.plan.md` }] },
    }).map(([key, value]) => ({ ...valid, properties: { ...valid.properties, [key]: value } })),
  ].entries()) {
    const r = f.run('ship', ['--pr', `${repository.url}/pull/1`], [{ body }]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Notion Task does not match this plan/);
    assert.equal(r.calls.length, index + 1);
    assert.ok(r.calls.every((call) => call.method === 'GET'));
  }
});

test('done writes Done and Completed At together', (t) => {
  const f = fixture(t, `ticket: ${url}\npr: ${repository.url}/pull/1\n`, [completionState(), { body: {} }]);
  const r = f.run('done', [], undefined, { github: doneGitHubFixture(readFileSync(f.plan, 'utf8')) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].method, 'GET');
  assert.equal(r.calls[1].body.properties.Status.status.name, 'Done');
  assert.match(
    r.calls[1].body.properties['Completed At'].date.start,
    /^\d{4}-\d{2}-\d{2}$/,
  );
});

test('done preserves existing completion and skips a redundant update', (t) => {
  const pending = fixture(t, `ticket: ${url}\npr: ${repository.url}/pull/1\n`, [
    completionState(),
  ]);
  const unmerged = pending.run('done', [], undefined, {
    github: doneGitHubFixture('', { merged: false, state: 'open' }),
  });
  assert.match(unmerged.stderr, /GitHub has not confirmed/);
  assert.equal(unmerged.calls.length, 0);

  const openFixture = fixture(t, `ticket: ${url}\npr: ${repository.url}/pull/1\n`, [
    completionState('Doing', '2025-10-20'),
    { body: {} },
  ]);
  const open = openFixture.run('done', [], undefined, {
    github: doneGitHubFixture(readFileSync(openFixture.plan, 'utf8')),
  });
  assert.equal(open.status, 0, open.stderr);
  assert.deepEqual(open.calls[1].body.properties, { Status: { status: { name: 'Done' } } });
  const closedFixture = fixture(t, `ticket: ${url}\npr: ${repository.url}/pull/1\n`, [
    completionState('Done', '2025-10-20'),
  ]);
  const closed = closedFixture.run('done', [], undefined, {
    github: doneGitHubFixture(readFileSync(closedFixture.plan, 'utf8')),
  });
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
  const files = [
    [changedPlan],
    [{ filename: 'README.md', status: 'modified' }],
  ];
  const sha = f.git('rev-parse', 'HEAD');
  const args = ['--pr-number', '1'];
  const github = [repository, mergedPull(1, sha, { changed_files: 2 }), files];
  const r = f.run('ci-done', args, undefined, {
    omitPlan: true,
    github: github.slice(1),
    envOverrides: {
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'example/repo',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[1].body.properties.Status.status.name, 'Done');
  assert.equal(r.calls[1].body.properties['Completed At'].date.start, '2025-10-21');
  const truncated = f.run('ci-done', args, undefined, {
    omitPlan: true, github: [repository, mergedPull(1, sha, { changed_files: 3 }), files],
  });
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /incomplete GitHub pull request file list/);
  assert.equal(truncated.calls.length, r.calls.length);
  for (const [pull, error] of [
    [mergedPull(1, sha, { merged: false }), /GitHub has not confirmed/],
    [mergedPull(1, sha, { base: { ref: 'feature', repo: { full_name: 'example/repo' } } }),
      /does not target a protected branch/],
  ]) {
    const rejected = f.run('ci-done', args, undefined, { omitPlan: true, github: [repository, pull] });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, error);
    assert.equal(rejected.calls.length, r.calls.length);
  }
  const missingSecret = f.run('ci-done', args, undefined, {
    omitPlan: true, github,
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
    const github = [repository, mergedPull(2, f.git('rev-parse', 'HEAD'), {
      merged_at: '2025-10-20T12:30:00Z',
    }), [[changedPlan]]];
    const r = f.run('ci-done', ['--pr-number', '2'], undefined, { omitPlan: true, github });
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
  const f = fixture(t, `ticket: ${url}\nagent: Gemini\n`, [], { requireReview: true });
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
  const f = fixture(t, `ticket: ${url}\npr: ${repository.url}/pull/1\n`, [completionState(), { body: {} }]);
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
    github: [repository, mergedPull(1, f.git('rev-parse', 'HEAD')), [[changedPlan]]],
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

test('pr pins its verified base and head and retains the review when shipping a retrospective', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\nagent: Gemini\n', [], {
    tracker: 'local',
    requireReview: true,
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
        ? '[{"url":"${url}","isCrossRepository":false,"baseRefName":"develop"}]' : '[]';
      if (args[1] === 'create') return '${url}';
      throw Error('unexpected gh command');
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const runPr = () => f.run('pr', ['--verify', '--retro', 'Keep the final head verified'], [], {
    omitPlan: true,
    envOverrides: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PR_MOCK_LOG: log },
  });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', 'scripts', 'mock.mjs');
  f.git('commit', '-m', 'main baseline');
  f.git('switch', '-c', 'develop');
  writeFileSync(join(f.root, 'develop.txt'), 'develop baseline\n');
  f.git('add', 'develop.txt');
  f.git('commit', '-m', 'develop baseline');
  const develop = f.git('rev-parse', 'HEAD');
  f.git('switch', '-c', 'feat/pr-test');
  f.git('add', 'docs/plans');
  f.git('commit', '-m', 'initial plan');

  writeFileSync(join(f.root, 'staged.txt'), 'staged\n');
  f.git('add', 'staged.txt');
  const dirty = runPr();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /requires a clean committed snapshot/);
  assert.equal(existsSync(log), false);
  f.git('commit', '-m', 'include staged work deliberately');
  const review = f.run('review', ['--base', 'develop', '--agent', 'Codex',
    '--verdict', 'pass', '--summary', 'fixture review']);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.plan, /baseBranch: develop/);
  const packed = f.run('pack');
  assert.match(packed.stdout, new RegExp(develop.slice(0, 10)));
  assert.equal(f.run('check').status, 0);
  f.git('add', 'docs/plans');
  f.git('commit', '-m', 'record review for develop');
  const verifiedHead = f.git('rev-parse', 'HEAD');

  const failedPush = runPr();
  assert.notEqual(failedPush.status, 0);
  assert.match(failedPush.stderr, /could not push PR commit/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /"create"/);
  rmSync(log);

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
  assert.match(retry.plan, /Retrospective \(retro\): Keep the final head verified/);
  assert.equal(existsSync(join(f.root, 'docs/lessons.md')), false);
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'),
    'docs/plans/FO-Plan-Test.plan.md');
  const linkedHead = f.git('rev-parse', 'HEAD');
  assert.match(retry.stdout, new RegExp(`Running verification on ${linkedHead.slice(0, 10)}`));
  const check = f.run('ci-check', ['--base', develop, '--head', linkedHead], [], { omitPlan: true });
  assert.equal(check.status, 0, check.stderr);
  const wrongBase = f.run('ci-check', ['--base', 'main', '--head', linkedHead], [], { omitPlan: true });
  assert.match(wrongBase.stderr, /review does not cover this change/);
  assert.match(f.git('ls-remote', 'origin', 'refs/heads/feat/pr-test'), new RegExp(linkedHead));
  assert.equal(f.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat/pr-test');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(({ args }) => args[1]), ['list', 'create', 'list']);
  assert.deepEqual(calls[1].args.slice(-2), ['--base', 'develop']);
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
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\nagent: Gemini\n', [], {
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

  const selfReview = reviewed.replace('reviewedBy: Codex', 'reviewedBy: Gemini');
  writeFileSync(planPath, selfReview);
  commit();
  assert.match(check().stderr, /self-review blocked/);
  writeFileSync(planPath, selfReview.replace('reviewedBy: Gemini', 'reviewedBy: Gemini\nreviewSession: fixture-independent-review'));
  commit();
  assert.equal(check().status, 0, check().stderr);
  for (const field of ['agent', 'reviewedBy']) {
    writeFileSync(planPath, reviewed.replace(new RegExp(`^${field}:.*\\n`, 'm'), ''));
    f.git('add', '--', plan);
    f.git('commit', '-m', `remove ${field}`);
    assert.match(check().stderr, /configured implementing agent and reviewer/);
  }

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
      '"C1, with comma|C2"',
      '--steps',
      '"S1, with comma|S2"',
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
  assert.match(content, /- \[ \] C1, with comma\r?\n- \[ \] C2/);
  assert.match(content, /- \[ \] S1, with comma\r?\n- \[ \] S2/);
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
  assert.match(rChk1.stdout, /✓ Ticked \[1\]: - \[x\] First criterion verified\(test\):/);
  assert.match(rChk1.stdout, /✓ Git checkpoint committed:/);
  assert.match(rChk1.stdout, /Next open item \[1\]: - \[ \] First step \(section: Steps\)/);

  const updatedPlan = readFileSync(planPath, 'utf8');
  assert.match(updatedPlan, /- \[x\] First criterion verified\(test\):/);

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

test('run command executes outer-loop steps, self-heals on retry, invokes reviewer, and trips circuit breaker', (t) => {
  const f = fixture(
    t,
    'branch: feat/run-test\n',
    [],
    {
      agentic: { maxRetries: 2, verifyTier: 'test' },
      verify: { test: 'node verify.mjs' },
    },
  );
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  writeFileSync(
    join(f.root, 'verify.mjs'),
    `import { readFileSync } from 'node:fs';
const state = readFileSync('state.txt', 'utf8').trim();
if (state !== 'fixed') {
  console.error('STATE_ERR: expected fixed, got ' + state);
  process.exit(1);
}
console.log('VERIFY_OK');
`,
  );
  writeFileSync(join(f.root, 'state.txt'), 'broken\n');
  writeFileSync(
    join(f.root, 'runner.mjs'),
    `import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const stdinText = readFileSync(0, 'utf8');
const promptFile = process.env.ADW_PROMPT_FILE;
if (!promptFile || !existsSync(promptFile)) throw new Error('missing ADW_PROMPT_FILE');
const fileText = readFileSync(promptFile, 'utf8');
if (stdinText !== fileText) throw new Error('stdin mismatch with ADW_PROMPT_FILE');
appendFileSync('.git/prompt-paths.log', promptFile + '\\n');
const role = process.env.ADW_ROLE;
if (role === 'builder') {
  if (/## Last Verification Failure/.test(fileText)) {
    writeFileSync('state.txt', 'fixed\\n');
    execFileSync('git', ['add', 'state.txt']);
  }
} else if (role === 'reviewer') {
  execFileSync(process.execPath, [
    'scripts/ticket.mjs', 'review', process.env.ADW_PLAN,
    '--agent', 'Gemini', '--verdict', 'pass', '--summary', 'Supervisor auto-review pass',
  ], { stdio: 'inherit' });
}
`,
  );
  const planPath = join(f.root, 'docs/plans/FO-Plan-Run.plan.md');
  writeFileSync(
    planPath,
    `---\ntitle: Plan - Feature: Supervisor Loop\nstatus: in-progress\nbranch: feat/run-test\n---\n# Supervisor Loop\n\n## Summary\nOuter loop supervisor test\n\n## Acceptance criteria\n- [ ] Self-heals via failure context\n\n## Steps\n- [ ] Fix state file\n`,
  );
  f.git('add', '.');
  f.git('commit', '-m', 'initial');

  // Dry-run leaves disk untouched
  const dry = f.run('run', ['docs/plans/FO-Plan-Run.plan.md', '--dry-run'], [], { omitPlan: true });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /=== Dry-Run Agentic Supervisor ===/);
  assert.equal(existsSync(join(f.root, '.git/prompt-paths.log')), false);

  // Full supervisor run: attempt 1 fails verify -> injects STATE_ERR -> attempt 2 fixes & commits -> item 2 completes -> reviewer stamps pass
  const res = f.run(
    'run',
    ['docs/plans/FO-Plan-Run.plan.md', '--cmd', 'node runner.mjs', '--commit'],
    [],
    { omitPlan: true },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Run complete: docs\/plans\/FO-Plan-Run\.plan\.md finished/);
  const finalPlan = readFileSync(planPath, 'utf8');
  assert.doesNotMatch(finalPlan, /- \[ \]/);
  assert.match(finalPlan, /reviewVerdict: pass/);
  assert.equal(readFileSync(join(f.root, 'state.txt'), 'utf8').trim(), 'fixed');
  const loggedPromptPaths = readFileSync(join(f.root, '.git/prompt-paths.log'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(loggedPromptPaths.length, 4); // 2 attempts for step + 1 criterion + 1 reviewer
  for (const p of loggedPromptPaths) assert.equal(existsSync(p), false);

  // Circuit breaker trips cleanly when failing reaches maxRetries
  writeFileSync(join(f.root, 'state.txt'), 'broken\n');
  writeFileSync(
    planPath,
    `---\ntitle: Plan - Feature: Breaker\nstatus: in-progress\nbranch: feat/run-test\n---\n# Breaker\n\n## Acceptance criteria\n- [ ] Never passes\n\n## Steps\n- [ ] Step 1\n`,
  );
  const broken = f.run(
    'run',
    ['docs/plans/FO-Plan-Run.plan.md', '--cmd', 'node -e "0"'],
    [],
    { omitPlan: true },
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /CIRCUIT BREAKER TRIPPED \(2\/2/);
  assert.match(readFileSync(planPath, 'utf8'), /retryCount: 2/);
});

test('run reopens a runner-ticked final step when verification fails', (t) => {
  const f = fixture(t, '', [], {
    agentic: { maxRetries: 2, verifyTier: 'test' },
    verify: { test: 'node verify.cjs' },
  });
  const pending = readFileSync(f.plan, 'utf8').replace('- [x] Implement', '- [ ] Implement');
  writeFileSync(f.plan, pending);
  writeFileSync(join(f.root, 'verify.cjs'), "process.exit(require('node:fs').existsSync('repaired') ? 0 : 1);");
  writeFileSync(join(f.root, 'runner.cjs'), `
const fs = require('node:fs');
const plan = process.env.ADW_PLAN;
const brief = fs.readFileSync(0, 'utf8');
let body = fs.readFileSync(plan, 'utf8');
if (process.env.ADWFIX_REORDER && !body.includes('- [ ] Other')) {
  body = body.replace('- [ ] Implement', '- [ ] Other\\n- [ ] Implement');
}
if (process.env.ADWFIX_REPAIR && brief.includes('Last Verification Failure')) fs.writeFileSync('repaired', '');
fs.writeFileSync(plan, body.replace('- [ ] Implement', '- [x] Implement'));
`);
  const args = ['--cmd', 'node runner.cjs', '--no-review'];
  const blocked = f.run('run', args);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /CIRCUIT BREAKER TRIPPED \(2\/2/);
  assert.doesNotMatch(blocked.stdout, /Run complete/);
  assert.match(blocked.plan, /- \[ \] Implement/);
  assert.equal([...blocked.stdout.matchAll(/target \[1\]: Implement/g)].length, 2);

  writeFileSync(f.plan, pending);
  const repaired = f.run('run', args, [], { envOverrides: { ADWFIX_REPAIR: '1' } });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Run complete/);
  assert.match(repaired.plan, /- \[x\] Implement/);
  assert.doesNotMatch(repaired.plan, /retryCount/);

  rmSync(join(f.root, 'repaired'));
  writeFileSync(f.plan, pending);
  const reordered = f.run('run', [...args, '--max-steps', '2'], [], {
    envOverrides: { ADWFIX_REPAIR: '1', ADWFIX_REORDER: '1' },
  });
  assert.match(reordered.stderr, /max-steps limit/);
  assert.equal([...reordered.stdout.matchAll(/target \[[12]\]: Implement/g)].length, 2);
  assert.match(reordered.plan, /- \[ \] Other\n- \[x\] Implement/);

  writeFileSync(f.plan, pending);
  writeFileSync(join(f.root, 'verify.cjs'), `
require('node:fs').appendFileSync('docs/plans/FO-Plan-Test.plan.md', '\\n## Notes\\nVerifier note\\n');
process.exit(1);
`);
  const changed = f.run('run', args);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /verification changed the plan; the target was reopened/);
  assert.match(changed.plan, /- \[ \] Implement/);
  assert.match(changed.plan, /Verifier note/);
});

test('wave --check and wave --prune verify and clean closed wave worktrees safely', (t) => {
  const f = fixture(
    t,
    '',
    [],
    {
      tracker: 'local',
      verify: { test: 'node -e "console.log(\'wave-test-ok\')"' },
      hygiene: { disallowedPatterns: ['.tmp', '.worktrees'] },
    },
  );
  rmSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'), { force: true });
  writeFileSync(join(f.root, '.gitignore'), '.worktrees/\n');
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'initial commit');

  const planPass = 'docs/plans/FO-Plan-Wave-Pass.plan.md';
  const planFail = 'docs/plans/FO-Plan-Wave-Fail.plan.md';
  writeFileSync(
    join(f.root, planFail),
    `---\ntitle: Plan - Feature: Wave Fail\nticket: local://FO:FO-Plan-Wave-Fail\nstatus: in-progress\nbranch: feat/wave-fail\n---\n# Wave Fail\n\n## Acceptance criteria\n- [ ] Criterion F\n\n## Steps\n- [ ] Step F\n`,
  );

  // Add completed pass worktree and spawn fail worktree
  f.git('worktree', 'add', '-b', 'feat/wave-pass', join(f.root, '.worktrees/wave-pass'));
  mkdirSync(join(f.root, '.worktrees/wave-pass/docs/plans'), { recursive: true });
  writeFileSync(
    join(f.root, '.worktrees/wave-pass', planPass),
    `---\ntitle: Plan - Feature: Wave Pass\nticket: local://FO:FO-Plan-Wave-Pass\nstatus: in-progress\nbranch: feat/wave-pass\nworktree: wave-pass\n---\n# Wave Pass\n\n## Acceptance criteria\n- [x] Criterion P verified: pass\n\n## Steps\n- [x] Step P\n`,
  );
  execFileSync('git', ['-C', join(f.root, '.worktrees/wave-pass'), 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', join(f.root, '.worktrees/wave-pass'), 'commit', '-m', 'complete pass plan'], { stdio: 'ignore' });

  const spawned = f.run('wave', [planFail, '--spawn'], [], { omitPlan: true });
  assert.equal(spawned.status, 0, spawned.stderr);
  const failWt = join(f.root, '.worktrees/wave-fail');
  mkdirSync(join(failWt, '.tmp'), { recursive: true });
  writeFileSync(join(failWt, '.tmp/junk.txt'), 'junk');

  // Check detects hygiene & open plan problems in wave-fail while wave-pass is clean
  const chkFail = f.run('wave', ['--check'], [], { omitPlan: true });
  assert.equal(chkFail.status, 1);
  assert.match(chkFail.stdout, /FO-Plan-Wave-Pass\s+\.worktrees\/wave-pass\s+0\s+clean\s+PASS/);
  assert.match(chkFail.stdout, /FO-Plan-Wave-Fail\s+\.worktrees\/wave-fail\s+2 issue\(s\)\s+1 fail\s+FAIL/);
  assert.match(chkFail.stdout, /\[hygiene\] Disallowed temporary or build artifact: \.tmp\/junk\.txt/);
  assert.match(chkFail.stderr, /wave --check detected failing worktree/);

  // Fix wave-fail and verify --check --test passes across active wave worktrees
  rmSync(join(failWt, '.tmp'), { recursive: true, force: true });
  writeFileSync(
    join(failWt, planFail),
    `---\ntitle: Plan - Feature: Wave Fail\nticket: local://FO:FO-Plan-Wave-Fail\nstatus: in-progress\nbranch: feat/wave-fail\nworktree: wave-fail\n---\n# Wave Fail\n\n## Acceptance criteria\n- [x] Criterion F verified: pass\n\n## Steps\n- [x] Step F\n`,
  );
  execFileSync('git', ['-C', failWt, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', failWt, 'commit', '-m', 'finish fail plan'], { stdio: 'ignore' });

  const chkPass = f.run('wave', ['--check', '--test'], [], { omitPlan: true });
  assert.equal(chkPass.status, 0, chkPass.stderr);
  assert.match(chkPass.stdout, /Wave check passed: 2 worktree\(s\) clean/);

  // Merge only wave-pass into main so only wave-pass is eligible for default wave --prune
  f.git('merge', '--no-ff', 'feat/wave-pass', '-m', 'merge wave pass');
  const dryPrune = f.run('wave', ['--prune', '--dry-run'], [], { omitPlan: true });
  assert.equal(dryPrune.status, 0, dryPrune.stderr);
  assert.match(dryPrune.stdout, /\[dry-run\] 1 worktree\(s\) eligible/);

  const pruned = f.run('wave', ['--prune'], [], { omitPlan: true });
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.match(pruned.stdout, /Prune complete: 1 worktree\(s\) pruned/);
  assert.equal(existsSync(join(f.root, '.worktrees/wave-pass')), false);
  assert.equal(existsSync(failWt), true);

  // Also assert starterConfig alignment in workflow-manifest.json
  const manifest = JSON.parse(readFileSync(join(scripts, 'workflow-manifest.json'), 'utf8'));
  assert.equal(manifest.starterConfig.verify?.test, 'npm test');
  assert.equal(manifest.starterConfig.agentic?.maxRetries, 3);
  assert.deepEqual(manifest.starterConfig.hygiene?.disallowedPatterns, ['.tmp', 'test-results', 'coverage', '.worktrees']);
});

test('fleet/overview active-plan parity, ci-check archive validation/exemption, and hook --fleet with custom hooksPath', (t) => {
  // Part 1 & 3: multi-repo fleet fixture with custom plansDir and core.hooksPath
  const fleetRoot = mkdtempSync(join(tmpdir(), 'ticket-fleet-polish-'));
  t.after(() => rmSync(fleetRoot, { recursive: true, force: true }));

  const initRepo = (name, cfg, setupFn) => {
    const dir = join(fleetRoot, name);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(join(scripts, 'ticket.mjs'), join(dir, 'scripts/ticket.mjs'));
    if (existsSync(join(scripts, 'lib'))) {
      cpSync(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
    }
    writeFileSync(
      join(dir, 'scripts/ticket.config.json'),
      JSON.stringify({ ...defaultNotionConfig, tracker: 'local', ...cfg }, null, 2),
    );
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('checkout', '-B', 'main');
    setupFn(dir, git);
    return dir;
  };

  const repoA = initRepo(
    'repo-a',
    { knownRepos: ['repo-a', 'repo-b'] },
    (dir, git) => {
      mkdirSync(join(dir, 'docs/plans'), { recursive: true });
      writeFileSync(
        join(dir, 'docs/plans/FO-Plan-Alpha-Old.plan.md'),
        '---\ntitle: Plan - Feature: Alpha Old\nticket: local://FO:Alpha\nstatus: in-progress\nbranch: feat/other\n---\n# Alpha\n\n## Steps\n- [ ] Pending\n',
      );
      writeFileSync(
        join(dir, 'docs/plans/FO-Plan-Zeta-Match.plan.md'),
        '---\ntitle: Plan - Feature: Zeta Match\nticket: local://FO:Zeta\nstatus: in-progress\nbranch: feat/target-branch\nreviewVerdict: pass\n---\n# Zeta\n\n## Steps\n- [x] Done\n',
      );
      git('add', '.');
      git('commit', '-m', 'init repo-a');
      git('checkout', '-b', 'feat/target-branch');
    },
  );

  const repoB = initRepo(
    'repo-b',
    { plansDir: 'custom/plans' },
    (dir, git) => {
      mkdirSync(join(dir, 'custom/plans'), { recursive: true });
      mkdirSync(join(dir, '.githooks'), { recursive: true });
      writeFileSync(
        join(dir, 'custom/plans/FO-Plan-Custom-Active.plan.md'),
        '---\ntitle: Plan - Feature: Custom Active\nticket: local://FO:Custom\nstatus: in-progress\nbranch: feat/custom-plan\nreviewVerdict: warn\n---\n# Custom\n\n## Steps\n- [ ] Pending\n',
      );
      git('add', '.');
      git('commit', '-m', 'init repo-b');
      git('checkout', '-b', 'feat/custom-plan');
      git('config', 'core.hooksPath', '.githooks');
    },
  );

  const runInRepoA = (...args) =>
    spawnSync(process.execPath, [join(repoA, 'scripts/ticket.mjs'), ...args], {
      cwd: repoA,
      encoding: 'utf8',
    });

  const ov = runInRepoA('overview');
  assert.equal(ov.status, 0, ov.stderr);
  assert.match(ov.stdout, /FO-Plan-Zeta-Match/);
  assert.doesNotMatch(ov.stdout, /FO-Plan-Alpha-Old/);
  assert.match(ov.stdout, /FO-Plan-Custom-Active/);

  const fl = runInRepoA('fleet');
  assert.equal(fl.status, 0, fl.stderr);
  assert.match(fl.stdout, /FO-Plan-Zeta-Match/);
  assert.doesNotMatch(fl.stdout, /FO-Plan-Alpha-Old/);
  assert.match(fl.stdout, /FO-Plan-Custom-Active/);

  const hi = runInRepoA('hook', 'install', '--fleet');
  assert.equal(hi.status, 0, hi.stderr);
  assert.equal(existsSync(join(repoA, '.git/hooks/pre-push')), true);
  assert.equal(existsSync(join(repoB, '.githooks/pre-push')), true);

  const hs = runInRepoA('hook', 'status', '--fleet');
  assert.equal(hs.status, 0, hs.stderr);
  assert.match(hs.stdout, /\[repo-a\] Pre-push hook is installed/);
  assert.match(hs.stdout, /\[repo-b\] Pre-push hook is installed/);

  const dr = runInRepoA('doctor', '--fleet');
  assert.equal(dr.status, 0, dr.stderr);
  const installedCount = (dr.stdout.match(/Pre-push:\s+installed/g) || []).length;
  assert.equal(installedCount, 2, dr.stdout);

  const hu = runInRepoA('hook', 'uninstall', '--fleet');
  assert.equal(hu.status, 0, hu.stderr);
  assert.equal(existsSync(join(repoA, '.git/hooks/pre-push')), false);
  assert.equal(existsSync(join(repoB, '.githooks/pre-push')), false);

  // Part 2: ci-check closed-archive validation and no-plan maxChangedLines exemption
  const ci = fixture(t, '', [], {
    tracker: 'local', invariants: { noSecretsPatterns: ['forbidden-fixture-marker'], excludePaths: ['scripts/ticket.config.json'] },
  });
  ci.git('init');
  ci.git('config', 'user.name', 'Test');
  ci.git('config', 'user.email', 'test@example.com');
  ci.git('checkout', '-B', 'main');
  const filler = Array.from({ length: 24 }, (_, i) => `- [x] Item ${i + 1} verified: ok`).join('\n');
  writeFileSync(join(ci.root, 'README.md'), '# Repo\n');
  writeFileSync(join(ci.root, 'large-baseline.txt'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(
    join(ci.root, 'docs/plans/FO-Plan-Old-1.plan.md'),
    `---\ntitle: Plan - Feature: Old 1\nticket: local://FO:Old1\nstatus: done\n---\n# Old 1\n\n## Acceptance criteria\n${filler}\n\n## Steps\n- [x] Done\n`,
  );
  writeFileSync(
    join(ci.root, 'docs/plans/FO-Plan-Old-2.plan.md'),
    `---\ntitle: Plan - Feature: Old 2\nticket: local://FO:Old2\nstatus: done\n---\n# Old 2\n\n## Acceptance criteria\n${filler}\n\n## Steps\n- [x] Done\n`,
  );
  ci.git('add', '.');
  ci.git('commit', '-m', 'base commit');
  const base = ci.git('rev-parse', 'HEAD');

  ci.git('checkout', '-b', 'chore/pure-archive');
  mkdirSync(join(ci.root, 'docs/plans/archive/2026-11'), { recursive: true });
  ci.git('mv', 'docs/plans/FO-Plan-Old-1.plan.md', 'docs/plans/archive/2026-11/FO-Plan-Old-1.plan.md');
  ci.git('mv', 'docs/plans/FO-Plan-Old-2.plan.md', 'docs/plans/archive/2026-11/FO-Plan-Old-2.plan.md');
  ci.git('commit', '-m', 'archive two closed plans');
  const headPure = ci.git('rev-parse', 'HEAD');

  const pureRes = ci.run('ci-check', ['--base', base, '--head', headPure], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '0' },
  });
  assert.equal(pureRes.status, 0, pureRes.stderr);
  assert.match(pureRes.stdout, /Closed-plan archive PR/);

  writeFileSync(join(ci.root, 'README.md'), '# Repo\nSmall note.\n');
  ci.git('add', 'README.md');
  ci.git('commit', '-m', 'small readme note with archive');
  const headCombo = ci.git('rev-parse', 'HEAD');

  const comboNoLabel = ci.run('ci-check', ['--base', base, '--head', headCombo], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '0' },
  });
  assert.notEqual(comboNoLabel.status, 0);

  const comboWithLabel = ci.run('ci-check', ['--base', base, '--head', headCombo], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '1' },
  });
  assert.equal(comboWithLabel.status, 0, comboWithLabel.stderr);

  for (const [start, name, file, label] of [
    [headPure, 'archive', 'docs/plans/archive/2026-11/FO-Plan-Old-1.plan.md', '0'],
    [headCombo, 'trivial', 'README.md', '1'],
  ]) {
    ci.git('switch', '-c', `test/invariants-${name}`, start);
    const path = join(ci.root, file);
    const cleanText = readFileSync(path, 'utf8');
    writeFileSync(path, cleanText + '\nforbidden-fixture-marker\n');
    ci.git('add', file);
    ci.git('commit', '-m', `add ${name} invariant fixture`);
    writeFileSync(path, cleanText);
    const rejected = ci.run('ci-check', ['--base', base, '--head', 'HEAD'], [], {
      omitPlan: true, envOverrides: { NO_PLAN: label },
    });
    assert.match(rejected.stderr, /noSecretsPatterns: potential secret/);
    ci.git('restore', '--', file);
  }

  ci.git('checkout', '-b', 'chore/bad-archive', base);
  mkdirSync(join(ci.root, 'docs/plans/archive/2026-11'), { recursive: true });
  writeFileSync(
    join(ci.root, 'docs/plans/archive/2026-11/FO-Plan-Unclosed.plan.md'),
    '---\ntitle: Plan - Feature: Unclosed\nticket: local://FO:Unclosed\nstatus: draft\n---\n# Unclosed\n\n## Acceptance criteria\n- [ ] Still open\n',
  );
  ci.git('add', '.');
  ci.git('commit', '-m', 'add unclosed archive plan');
  const headBad = ci.git('rev-parse', 'HEAD');

  const badRes = ci.run('ci-check', ['--base', base, '--head', headBad], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '1' },
  });
  assert.notEqual(badRes.status, 0);
  assert.match(badRes.stderr, /archived plan is not closed out/);
});

test('ci-check requires a plan for a legitimate workflow sync', (t) => {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');
  const baseSha = f.git('rev-parse', 'HEAD');

  f.git('checkout', '-b', 'chore/verified-sync', baseSha);
  copyFileSync(join(process.cwd(), 'scripts/sync.mjs'), join(f.root, 'scripts/sync.mjs'));
  execFileSync(
    process.execPath,
    [join(f.root, 'scripts/sync.mjs'), f.root, '--remote'],
    { env: { ...process.env, ADW_TEST_SYNC_SOURCE: process.cwd() }, encoding: 'utf8' },
  );
  f.git('add', '.');
  f.git('commit', '-m', 'chore: verified workflow sync');
  const syncHead = f.git('rev-parse', 'HEAD');

  const rejected = f.run('ci-check', ['--base', baseSha, '--head', syncHead], [], {
    omitPlan: true,
    envOverrides: { NO_PLAN: '1' },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /no workflow policy changes/);
});

test('T1.1: requireReview enforces independent subagent or second-model review and gates --self-review behind allowSelfReview', (t) => {
  const f = fixture(t, 'agent: Gemini\n', [], {
    tracker: 'local',
    requireReview: true,
  });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');
  f.git('checkout', '-b', 'feat/self-review');
  const createRes = f.run('create', ['--agent', 'Gemini']);
  assert.equal(createRes.status, 0, createRes.stderr);
  f.git('add', '.');
  f.git('commit', '-m', 'ticketed');

  // Same agent without --reviewer-id is blocked
  const selfBlocked = f.run('review', [
    '--agent',
    'Gemini',
    '--verdict',
    'pass',
    '--summary',
    'self check',
  ]);
  assert.notEqual(selfBlocked.status, 0);
  assert.match(selfBlocked.stderr, /self-review blocked/);

  // Same agent with --self-review is also blocked when allowSelfReview is false/unset
  const selfReasonBlocked = f.run('review', [
    '--agent',
    'Gemini',
    '--verdict',
    'pass',
    '--summary',
    'solo attempt',
    '--self-review',
    'no second model available',
  ]);
  assert.notEqual(selfReasonBlocked.status, 0);
  assert.match(selfReasonBlocked.stderr, /--self-review is disabled/);

  // Short --subagent / --reviewer-id (<4 chars) is rejected
  const shortSubagentBlocked = f.run('review', [
    '--agent',
    'Gemini',
    '--subagent',
    'abc',
    '--verdict',
    'pass',
    '--summary',
    'short id',
  ]);
  assert.notEqual(shortSubagentBlocked.status, 0);
  assert.match(shortSubagentBlocked.stderr, /at least 4 characters/);

  // Same agent with independent subagent --reviewer-id succeeds and passes check
  const subagentRes = f.run('review', [
    '--agent',
    'Gemini',
    '--reviewer-id',
    'subagent-61f13605',
    '--verdict',
    'pass',
    '--summary',
    'independent subagent pass',
  ]);
  assert.equal(subagentRes.status, 0, subagentRes.stderr);
  assert.match(readFileSync(f.plan, 'utf8'), /reviewSession: subagent-61f13605/);
  assert.match(readFileSync(f.plan, 'utf8'), /\[reviewer: subagent-61f13605\]/);
  const checkSub = f.run('check');
  assert.equal(checkSub.status, 0, checkSub.stderr);

  // Tampering reviewSession out of frontmatter causes check to fail
  const planPath = f.plan;
  writeFileSync(
    planPath,
    readFileSync(planPath, 'utf8').replace(/^reviewSession:.*\r?\n/m, ''),
  );
  const checkSubTampered = f.run('check');
  assert.notEqual(checkSubTampered.status, 0);
  assert.match(checkSubTampered.stderr, /self-review blocked/);

  // Enabling allowSelfReview allows --self-review override and detects tampering
  const cfgPath = join(f.root, 'scripts/ticket.config.json');
  const prevCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...prevCfg, allowSelfReview: true }, null, 2));

  const selfAllowed = f.run('review', [
    '--agent',
    'Gemini',
    '--verdict',
    'pass',
    '--summary',
    'solo session',
    '--self-review',
    'no second model available',
  ]);
  assert.equal(selfAllowed.status, 0, selfAllowed.stderr);
  assert.match(readFileSync(f.plan, 'utf8'), /reviewSelfReason: no second model available/);

  const checkSelf = f.run('check');
  assert.equal(checkSelf.status, 0, checkSelf.stderr);

  writeFileSync(
    planPath,
    readFileSync(planPath, 'utf8').replace(/^reviewSelfReason:.*\r?\n/m, ''),
  );
  const checkTampered = f.run('check');
  assert.notEqual(checkTampered.status, 0);
  assert.match(checkTampered.stderr, /self-review blocked/);

  // Different AI client clears reviewSelfReason and passes check without --reviewer-id
  const indepRes = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'independent pass',
  ]);
  assert.equal(indepRes.status, 0, indepRes.stderr);
  assert.doesNotMatch(readFileSync(f.plan, 'utf8'), /reviewSelfReason:/);
  const checkIndep = f.run('check');
  assert.equal(checkIndep.status, 0, checkIndep.stderr);
});

test('T1.2: pack and review detect deleted tests and added skips unless --allow-test-drop is given', (t) => {
  const f = fixture(t, `ticket: local://FO:FO-Plan-Test\nagent: Gemini\n`, [], {
    tracker: 'local',
    requireReview: true,
  });
  writeFileSync(
    join(f.root, 'sample.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => { assert.equal(1, 1); });\ntest('b', () => { assert.equal(2, 2); });\n",
  );
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');
  f.git('checkout', '-b', 'feat/test-integrity');

  // Clean pack reports Test Integrity OK
  const packClean = f.run('pack');
  assert.equal(packClean.status, 0, packClean.stderr);
  assert.match(packClean.stdout, /## Test Integrity[\s\S]*OK/);

  // Drop one test and skip the other
  writeFileSync(
    join(f.root, 'sample.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest.skip('a', () => { assert.equal(1, 1); });\n",
  );
  f.git('add', 'sample.test.mjs');

  const packWarn = f.run('pack');
  assert.equal(packWarn.status, 0, packWarn.stderr);
  assert.match(packWarn.stdout, /Net drop in test cases/);
  assert.match(packWarn.stdout, /Added test skip\/only\/todo marker/);

  const reviewBlocked = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'looks ok',
  ]);
  assert.notEqual(reviewBlocked.status, 0);
  assert.match(reviewBlocked.stderr, /test integrity check flagged/);

  const reviewAllowed = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'intentional removal',
    '--allow-test-drop',
    'obsolete test removed after refactor',
  ]);
  assert.equal(reviewAllowed.status, 0, reviewAllowed.stderr);
  assert.match(readFileSync(f.plan, 'utf8'), /reviewTestDropReason: obsolete test removed after refactor/);
});

test('T1.3: tick --verify-cmd runs command, stamps typed evidence, and check --strict rejects manual-only criteria', (t) => {
  const f = fixture(t, `ticket: local://FO:FO-Plan-Test\n`, [], {
    tracker: 'local',
    requireReview: false,
    verifyCommand: 'node -e "process.exit(0)"',
  });
  const planPath = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    planPath,
    [
      '---',
      'title: Plan - Feature: Evidence',
      'ticket: local://FO:FO-Plan-Test',
      'status: in-progress',
      '---',
      '# Evidence',
      '',
      '## Summary',
      'Test typed and executable evidence.',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: Manual check',
      '- [ ] AC2: Automated check',
      '',
      '## Steps',
      '- [x] Done',
      '',
    ].join('\n'),
  );
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // Manual tick works for non-strict check, fails --strict when all criteria are manual
  const tickManual = f.run('tick', [
    '1',
    '--evidence-type',
    'manual',
    '--verified',
    'inspected output',
  ]);
  assert.equal(tickManual.status, 0, tickManual.stderr);
  assert.match(readFileSync(planPath, 'utf8'), /verified\(manual\): inspected output/);

  // Failing --verify-cmd must not tick AC2
  const failCmd = f.run('tick', [
    '1',
    '--verify-cmd',
    'node -e "process.exit(1)"',
  ]);
  assert.notEqual(failCmd.status, 0);
  assert.match(readFileSync(planPath, 'utf8'), /- \[ \] AC2: Automated check/);

  // Tick AC2 manually first to test check --strict rejection when all criteria are manual
  const tickManual2 = f.run('tick', [
    '1',
    '--evidence-type',
    'manual',
    '--verified',
    'manual check 2',
  ]);
  assert.equal(tickManual2.status, 0, tickManual2.stderr);
  const strictFail = f.run('check', ['--strict']);
  assert.notEqual(strictFail.status, 0);
  assert.match(strictFail.stderr, /--strict requires at least one automated verification proof/);

  // Re-open AC2 and tick with --verify-cmd (exit 0) -> check --strict passes
  writeFileSync(
    planPath,
    readFileSync(planPath, 'utf8').replace(
      /- \[x\] AC2: Automated check.*$/m,
      '- [ ] AC2: Automated check',
    ),
  );
  const passCmd = f.run('tick', [
    '1',
    '--verify-cmd',
    'node -e "process.exit(0)"',
  ]);
  assert.equal(passCmd.status, 0, passCmd.stderr);
  assert.match(readFileSync(planPath, 'utf8'), /verified\(cmd\): `node -e "process\.exit\(0\)"` exit 0 @[0-9a-f]+/);

  const strictPass = f.run('check', ['--strict']);
  assert.equal(strictPass.status, 0, strictPass.stderr);
});

test('T1.4: template v5 scaffolding, prime open-question count, start --strict, and v4 compatibility', (t) => {
  const f = fixture(t, '', [], { tracker: 'local', requireReview: false });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // v4 plan without Context/Open questions/appetite still passes check
  const v4Path = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    v4Path,
    '---\ntitle: Plan - Process: Legacy\nticket: local://FO:FO-Plan-Test\nstatus: in-progress\n---\n# Legacy\n\n## Summary\nOld plan.\n\n## Acceptance criteria\n- [x] Works verified: ok\n\n## Steps\n- [x] Done\n',
  );
  const v4Check = f.run('check');
  assert.equal(v4Check.status, 0, v4Check.stderr);

  // Scaffold v5 plan with --appetite and --context
  const newRes = f.run(
    'new',
    ['V5 Feature', '--appetite', 'M', '--context', 'scripts/ticket.mjs:10'],
    [],
    { omitPlan: true },
  );
  assert.equal(newRes.status, 0, newRes.stderr);
  const createdFile = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('V5-Feature'),
  );
  assert.ok(createdFile, 'expected v5 plan file');
  const createdRel = `docs/plans/${createdFile}`;
  const createdText = readFileSync(join(f.root, createdRel), 'utf8');
  assert.match(createdText, /appetite: M/);
  assert.match(createdText, /## Context[\s\S]*scripts\/ticket\.mjs:10/);
  assert.match(createdText, /## Open questions/);
  assert.match(createdText, /AC1: <Observable outcome>/);

  // Fill required sections so create lint passes, then add open question to test prime + start --strict
  const readyText = createdText
    .replace(/<2-3 sentences:[^>]*>/, 'Verify v5 scaffolding and start --strict.')
    .replace(/<Unresolved assumptions[^>]*>/, 'None')
    .replace(/AC1: <Observable outcome>/, 'AC1: Cache returns stored value')
    .replace(/<Step>/, 'Add cache')
    .replace(/<Pre-mortem:[^>]*>/, 'None noted.')
    .replace(/<What this plan deliberately[^>]*>/, 'None noted.');
  writeFileSync(join(f.root, createdRel), readyText);
  f.git('checkout', '-b', 'feat/v5-test');
  const createTicket = f.run('create', [createdRel, '--agent', 'Gemini'], [], {
    omitPlan: true,
  });
  assert.equal(createTicket.status, 0, createTicket.stderr);

  const ticketedText = readFileSync(join(f.root, createdRel), 'utf8');
  writeFileSync(
    join(f.root, createdRel),
    ticketedText.replace(
      /## Open questions\n\nNone/,
      '## Open questions\n\n- [ ] Should cache expire after 5m?',
    ),
  );

  const primeRes = f.run('prime', [createdRel], [], { omitPlan: true });
  assert.equal(primeRes.status, 0, primeRes.stderr);
  assert.match(primeRes.stdout, /Appetite: M/);
  assert.match(primeRes.stdout, /Open questions: 1/);

  const startStrict = f.run('start', [createdRel, '--strict'], [], {
    omitPlan: true,
  });
  assert.notEqual(startStrict.status, 0);
  assert.match(startStrict.stderr, /unresolved item\(s\) under "## Open questions"/);
});

test('T2.6: appetite diff-size budget warns/fails when exceeded and excludes plansDir', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\nappetite: S\n', [], {
    tracker: 'local',
    requireReview: false,
    appetite: { S: { maxLines: 5, maxFiles: 1 } },
  });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');
  f.git('checkout', '-b', 'feat/appetite-test');

  // Adding lines inside docs/plans/ does not trip S budget
  writeFileSync(
    join(f.root, 'docs/plans/extra-notes.md'),
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'plan docs only');
  const checkDocsOnly = f.run('check', ['--strict']);
  assert.equal(checkDocsOnly.status, 0, checkDocsOnly.stderr);

  // Adding 10 code lines exceeds S maxLines=5
  writeFileSync(
    join(f.root, 'app.js'),
    Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join('\n'),
  );
  f.git('add', 'app.js');
  f.git('commit', '-m', 'exceed appetite');

  const packRes = f.run('pack');
  assert.equal(packRes.status, 0, packRes.stderr);
  assert.match(packRes.stdout, /Appetite: S \(10\/5 lines, 1\/1 files — EXCEEDED\)/);

  const checkStrict = f.run('check', ['--strict']);
  assert.notEqual(checkStrict.status, 0);
  assert.match(checkStrict.stderr, /Appetite S exceeded.*split/);
});

test('T1.5: runInvariants enforces mirrorDirs, readmeCliSync, zeroDependencies, noSecretsPatterns, and customChecks', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
    invariants: {
      mirrorDirs: [['.agents/skills', '.claude/skills']],
      readmeCliSync: true,
      zeroDependencies: true,
      noSecretsPatterns: ['\\bntn_test_[A-Za-z0-9]{6,}'],
      customChecks: [{ name: 'ok-check', cmd: 'node -e "process.exit(0)"' }],
    },
  });
  mkdirSync(join(f.root, '.agents/skills/demo'), { recursive: true });
  mkdirSync(join(f.root, '.claude/skills/demo'), { recursive: true });
  writeFileSync(join(f.root, '.agents/skills/demo/SKILL.md'), 'same\n');
  writeFileSync(join(f.root, '.claude/skills/demo/SKILL.md'), 'same\n');
  writeFileSync(
    join(f.root, 'README.md'),
    [
      'new', 'prime', 'tick', 'defer', 'step', 'checkpoint', 'run', 'create', 'start',
      'log', 'handoff', 'resume', 'pack', 'review', 'check', 'lint', 'ship', 'pr', 'merge', 'done',
      'overview', 'hook', 'adr', 'exec', 'wt', 'recall', 'archive', 'doctor', 'verify',
      'hygiene', 'switch', 'split', 'fleet', 'wave', 'lesson', 'stats', 'release', 'blueprint',
      'ready', 'map',
    ].join(' '),
  );
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }));
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // All invariants pass initially
  const passCheck = f.run('check');
  assert.equal(passCheck.status, 0, passCheck.stderr);

  const docRes = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(docRes.status, 0, docRes.stderr);
  assert.match(docRes.stdout, /Invariants: 5\/5 passed/);

  // Break mirrorDirs
  writeFileSync(join(f.root, '.claude/skills/demo/SKILL.md'), 'drifted\n');
  const failMirror = f.run('check');
  assert.notEqual(failMirror.status, 0);
  assert.match(failMirror.stderr, /mirrorDirs mismatch|content differs/);
  writeFileSync(join(f.root, '.claude/skills/demo/SKILL.md'), 'same\n');

  // Break zeroDependencies
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
  const failDeps = f.run('check');
  assert.notEqual(failDeps.status, 0);
  assert.match(failDeps.stderr, /zeroDependencies/);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ dependencies: {} }));

  // Break noSecretsPatterns
  writeFileSync(join(f.root, 'leak.txt'), 'token=ntn_test_12345678\n');
  f.git('add', 'leak.txt');
  const failSecret = f.run('check');
  assert.notEqual(failSecret.status, 0);
  assert.match(failSecret.stderr, /noSecretsPatterns/);
});

test('T2.1: lint catches placeholders, open questions, task verbs, vague words, and uncovered AC# IDs', (t) => {
  const f = fixture(t, '', [], { tracker: 'local', requireReview: false });
  const planPath = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    planPath,
    [
      '---',
      'title: Plan - Feature: Lint Target',
      'status: draft',
      '---',
      '# Lint Target',
      '',
      '## Summary',
      'Test lint diagnostics.',
      '',
      '## Open questions',
      '- [ ] Unresolved assumption?',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: Implement parser cleanly',
      '- [ ] AC2: Output is valid JSON',
      '',
      '## Steps',
      '- [ ] Build parser (AC1)',
      '',
      '## Risks',
      '<Pre-mortem: placeholder>',
      '',
      '## Out of scope',
      'Nothing else.',
      '',
    ].join('\n'),
  );

  // lint --json reports errors + warnings + uncoveredAc
  const lintJson = f.run('lint', ['--json']);
  assert.notEqual(lintJson.status, 0);
  const parsed = JSON.parse(lintJson.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => /Open questions/i.test(e)));
  assert.ok(parsed.errors.some((e) => /Risks.*placeholder/i.test(e)));
  assert.ok(parsed.warnings.some((w) => /task verb/i.test(w)));
  assert.ok(parsed.warnings.some((w) => /vague/i.test(w)));
  assert.deepEqual(parsed.uncoveredAc, ['AC2']);

  // create aborts when lint has errors
  const createFail = f.run('create', ['--agent', 'Gemini']);
  assert.notEqual(createFail.status, 0);
  assert.match(createFail.stderr, /plan lint failed/);

  // Fix errors & warnings -> lint --strict passes
  writeFileSync(
    planPath,
    [
      '---',
      'title: Plan - Feature: Lint Target',
      'status: draft',
      '---',
      '# Lint Target',
      '',
      '## Summary',
      'Test lint diagnostics.',
      '',
      '## Open questions',
      'None',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: WHEN input is valid THE SYSTEM SHALL parse fields',
      '- [ ] AC2: Output is valid JSON',
      '',
      '## Steps',
      '- [ ] Build parser (AC1, AC2)',
      '',
      '## Risks',
      'Malformed input returns exit 1.',
      '',
      '## Out of scope',
      'Nothing else.',
      '',
    ].join('\n'),
  );
  const lintStrict = f.run('lint', ['--strict']);
  assert.equal(lintStrict.status, 0, lintStrict.stderr);
  assert.match(lintStrict.stdout, /Plan lint clean/);
});

test('T2.2: stats aggregates active/archive plans, cycle time median/p90, review/deferral/retry metrics, and 14d escaped defects', (t) => {
  const f = fixture(t, '', [], { tracker: 'local', requireReview: false });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');

  const dayIso = (daysAgo) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  // Clean out default FO-Plan-Test so counts match fixture plans cleanly
  rmSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'));
  mkdirSync(join(f.root, 'docs/plans/archive/2026-11'), { recursive: true });
  mkdirSync(join(f.root, 'src'), { recursive: true });

  // Feature plan #1 (archived, 2d cycle time, block + pass review, 1 deferral)
  writeFileSync(join(f.root, 'src/parser.js'), 'export const parse = () => 1;\n');
  writeFileSync(
    join(f.root, 'docs/plans/archive/2026-11/FO-Plan-Feat1.plan.md'),
    [
      '---',
      'title: Plan - Feature: Parser V1',
      'ticket: local://FO:FO-Plan-Feat1',
      'status: done',
      `startedAt: ${dayIso(10)}`,
      `completedAt: ${dayIso(8)}`,
      'retryCount: 2',
      '---',
      '# Parser V1',
      '',
      '## Summary',
      'Initial parser.',
      '',
      '## Acceptance criteria',
      '- [x] Parses numbers verified: test passes',
      '- [ ] Handles streaming deferred: phase 2',
      '',
      '## Steps',
      '- [x] Add parser',
      '',
      '## Progress log',
      '- 2026-11-01 10:00 UTC, Codex (review: block): missing edge case',
      '- 2026-11-01 11:00 UTC, Claude (review: pass): fixed [self-review: solo]',
      '',
    ].join('\n'),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'feat: Parser V1', '--date', `${dayIso(8)}T12:00:00Z`);

  // Bug plan within 14d touching src/parser.js -> potential escaped defect!
  writeFileSync(join(f.root, 'src/parser.js'), 'export const parse = () => 2;\n');
  writeFileSync(
    join(f.root, 'docs/plans/FO-Plan-FixParser.plan.md'),
    [
      '---',
      'title: Debug - Bug: Fix Parser Crash',
      'ticket: local://FO:FO-Plan-FixParser',
      'status: in-progress',
      `startedAt: ${dayIso(4)}`,
      '---',
      '# Fix Parser Crash',
      '',
      '## Summary',
      'Fixes crash in parser.',
      '',
      '## Acceptance criteria',
      '- [x] No crash verified: test',
      '',
      '## Steps',
      '- [x] Fix bug',
      '',
      '## Progress log',
      '- 2026-11-05 09:00 UTC, Gemini (review: warn): check callers',
      '',
    ].join('\n'),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'fix: Fix Parser Crash', '--date', `${dayIso(4)}T12:00:00Z`);

  // Feature plan #2 + immediate Revert commit on src/cache.js -> escaped defect #2
  writeFileSync(join(f.root, 'src/cache.js'), 'export const cache = true;\n');
  writeFileSync(
    join(f.root, 'docs/plans/FO-Plan-Feat2.plan.md'),
    [
      '---',
      'title: Plan - Feature: Cache Layer',
      'ticket: local://FO:FO-Plan-Feat2',
      'status: done',
      `startedAt: ${dayIso(12)}`,
      `completedAt: ${dayIso(6)}`,
      '---',
      '# Cache Layer',
      '',
      '## Summary',
      'Add cache.',
      '',
      '## Acceptance criteria',
      '- [x] Cached verified: test',
      '',
      '## Steps',
      '- [x] Write cache',
      '',
    ].join('\n'),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'feat: Cache Layer', '--date', `${dayIso(6)}T12:00:00Z`);

  // Revert touching src/cache.js within 14d of Feat2
  writeFileSync(join(f.root, 'src/cache.js'), 'export const cache = false;\n');
  f.git('add', 'src/cache.js');
  f.git('commit', '-m', 'Revert "feat: Cache Layer"', '--date', `${dayIso(2)}T12:00:00Z`);

  const statsJson = f.run('stats', ['--json'], [], { omitPlan: true });
  assert.equal(statsJson.status, 0, statsJson.stderr);
  const s = JSON.parse(statsJson.stdout);

  assert.equal(s.totalPlans, 3);
  assert.equal(s.byStatus.done, 2);
  assert.equal(s.byStatus['in-progress'], 1);
  assert.equal(s.byType.Feature, 2);
  assert.equal(s.byType.Bug, 1);
  assert.equal(s.cycleTimeDays.sampleSize, 2);
  assert.equal(s.cycleTimeDays.median, 4); // median of [2, 6]
  assert.equal(s.cycleTimeDays.p90, 6);
  assert.equal(s.reviews.total, 3);
  assert.equal(s.reviews.pass, 1);
  assert.equal(s.reviews.warn, 1);
  assert.equal(s.reviews.block, 1);
  assert.equal(s.reviews.selfReviews, 1);
  assert.equal(s.checkboxes.deferred, 1);
  assert.equal(s.retries.totalRetries, 2);
  assert.ok(
    s.escapedDefects.some((d) => d.kind === 'bug-plan' && d.sourcePlan.includes('Feat1')),
    `Expected bug-plan escaped defect for Feat1, got: ${JSON.stringify(s.escapedDefects)}`,
  );
  assert.ok(
    s.escapedDefects.some((d) => d.kind === 'revert' && d.sourcePlan.includes('Feat2')),
    `Expected revert escaped defect for Feat2, got: ${JSON.stringify(s.escapedDefects)}`,
  );

  const statsText = f.run('stats', [], [], { omitPlan: true });
  assert.equal(statsText.status, 0, statsText.stderr);
  assert.match(statsText.stdout, /Escaped defects: 2 potential within 14d/);
});

test('T2.7: lesson capture, ship --retro, recall --lessons, review --prompt, and step reviewer lessons', (t) => {
  const f = fixture(
    t,
    'ticket: local://FO:FO-Plan-Test\nreviewVerdict: pass\nreviewedBy: Other\n',
    [],
    { tracker: 'local', requireReview: false, verifyCommand: 'node -e "process.exit(0)"' },
  );
  // Close out plan so ship passes
  const planPath = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    planPath,
    readFileSync(planPath, 'utf8')
      .replace('## Summary', '## Summary\nGuard cache timeout.\n')
      .replace('- [ ] First criterion', '- [x] First criterion verified: test')
      .replace('- [ ] First step', '- [x] First step'),
  );

  // 1. Capture standalone lesson
  const l1 = f.run(
    'lesson',
    ['Always escape PowerShell && in scripts', '--tags', 'windows,cli', '--plan', 'docs/plans/FO-Plan-Test.plan.md'],
    [],
    { omitPlan: true },
  );
  assert.equal(l1.status, 0, l1.stderr);
  const lessonsContent = readFileSync(join(f.root, 'docs/lessons.md'), 'utf8');
  assert.match(lessonsContent, /windows, cli · docs\/plans\/FO-Plan-Test\.plan\.md \| Always escape PowerShell && in scripts/);

  // 2. ship --retro records the takeaway in the plan without changing the shared lessons file.
  const shipRes = f.run('ship', [
    '--pr',
    'https://github.com/example/repo/pull/99',
    '--retro',
    'Cache timeout tests need fake timers to avoid flake',
  ]);
  assert.equal(shipRes.status, 0, shipRes.stderr);
  assert.match(shipRes.plan, /Retrospective \(retro\): Cache timeout tests need fake timers/);
  assert.equal(readFileSync(join(f.root, 'docs/lessons.md'), 'utf8'), lessonsContent);
  assert.equal(f.run('lesson', ['Cache timeout tests need fake timers to avoid flake']).status, 0);

  // 3. recall searches docs/lessons.md and recall --lessons filters strictly
  const recallAll = f.run('recall', ['Cache'], [], { omitPlan: true });
  assert.equal(recallAll.status, 0, recallAll.stderr);
  assert.match(recallAll.stdout, /\[Lesson\] docs\/lessons\.md/);

  const recallLessonsOnly = f.run('recall', ['--lessons'], [], { omitPlan: true });
  assert.equal(recallLessonsOnly.status, 0, recallLessonsOnly.stderr);
  assert.match(recallLessonsOnly.stdout, /\[Lesson\] docs\/lessons\.md/);
  assert.doesNotMatch(recallLessonsOnly.stdout, /\[Plan\]/);

  // 4. review --prompt and step --role reviewer surface relevant lessons
  const promptRes = f.run('review', ['--prompt']);
  assert.equal(promptRes.status, 0, promptRes.stderr);
  assert.match(promptRes.stdout, /## Recent & Relevant Lessons/);
  assert.match(promptRes.stdout, /Cache timeout tests need fake timers/);

  const stepReviewer = f.run('step', ['--role', 'reviewer']);
  assert.equal(stepReviewer.status, 0, stepReviewer.stderr);
  assert.match(stepReviewer.stdout, /## Recent & Relevant Lessons/);
  assert.match(stepReviewer.stdout, /Cache timeout tests need fake timers/);
});

test('T2.4: prime --verify and resume --verify report baseline PASS/FAIL without aborting', (t) => {
  const fPass = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
    bootVerifyTier: 'fast',
    verify: { fast: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  });
  const primePass = fPass.run('prime', ['--verify']);
  assert.equal(primePass.status, 0, primePass.stderr);
  assert.match(primePass.stdout, /Baseline: PASS/);

  const resumePass = fPass.run('resume', ['--verify']);
  assert.equal(resumePass.status, 0, resumePass.stderr);
  assert.match(resumePass.stdout, /Baseline: PASS/);

  const fFail = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
    bootVerifyTier: 'fast',
    verify: { fast: 'node -e "console.error(\'broken test\'); process.exit(1)"' },
  });
  const primeFail = fFail.run('prime', ['--verify']);
  assert.equal(primeFail.status, 0, primeFail.stderr);
  assert.match(primeFail.stdout, /Baseline: FAIL .*fix baseline before starting next step/);

  const resumeFail = fFail.run('resume', ['--verify']);
  assert.equal(resumeFail.status, 0, resumeFail.stderr);
  assert.match(resumeFail.stdout, /Baseline: FAIL .*fix baseline before starting next step/);
});

test('T2.5: tick --red records failing reproduction unchecked, rejects exit 0, and new --type Refactor seeds characterization step', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
  });
  writeFileSync(
    f.plan,
    readFileSync(f.plan, 'utf8').replace('- [x] Works verified: fixture', '- [ ] First criterion'),
  );

  // 1. tick --red with exit 0 fails
  const redZero = f.run('tick', ['1', '--red', 'node -e "process.exit(0)"']);
  assert.notEqual(redZero.status, 0);
  assert.match(redZero.stderr, /expected failing reproduction/);

  // 2. tick --red with non-zero exit stamps red: ... without checking [x]
  const redFail = f.run('tick', ['1', '--red', 'node -e "process.exit(2)"']);
  assert.equal(redFail.status, 0, redFail.stderr);
  assert.match(redFail.stdout, /Red reproduction recorded on \[1\]: - \[ \]/);
  const updatedPlan = readFileSync(f.plan, 'utf8');
  assert.match(updatedPlan, /- \[ \] First criterion red: `node -e "process\.exit\(2\)"` exit 2 @/);

  // 3. new --type Refactor without --steps seeds characterization-test step
  const refactorNew = f.run('new', ['Clean Module', '--type', 'Refactor'], [], { omitPlan: true });
  assert.equal(refactorNew.status, 0, refactorNew.stderr);
  const createdFile = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('Clean-Module'),
  );
  assert.ok(createdFile, 'expected refactor plan file');
  const refactorBody = readFileSync(join(f.root, 'docs/plans', createdFile), 'utf8');
  assert.match(refactorBody, /Lock existing behaviour with characterization tests before structural changes/);
});

test('T2.3: hook --agent-hooks lifecycle and adw-hook.mjs pre-tool, post-tool, and stop enforcement', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\nstatus: draft\n', [], {
    tracker: 'local',
    requireReview: false,
    protectedBranches: ['main'],
    verify: { fast: 'node -e "console.error(\'post fail\'); process.exit(1)"' },
    hooks: { postToolVerify: true },
  });
  const hookSrc = readFileSync(join(scripts, 'hooks', 'adw-hook.mjs'), 'utf8');
  mkdirSync(join(f.root, 'scripts', 'hooks'), { recursive: true });
  const hookDest = join(f.root, 'scripts', 'hooks', 'adw-hook.mjs');
  writeFileSync(hookDest, hookSrc, 'utf8');

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // Preserve pre-existing settings & user hooks when installing --agent-hooks
  mkdirSync(join(f.root, '.claude'), { recursive: true });
  writeFileSync(
    join(f.root, '.claude/settings.json'),
    JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [{ matcher: 'Custom', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    }),
  );

  const installRes = f.run('hook', ['install', '--agent-hooks'], [], { omitPlan: true });
  assert.equal(installRes.status, 0, installRes.stderr);
  const installedSettings = JSON.parse(readFileSync(join(f.root, '.claude/settings.json'), 'utf8'));
  assert.equal(installedSettings.theme, 'dark');
  assert.equal(installedSettings.hooks.PreToolUse.length, 2);
  assert.ok(installedSettings.hooks.PostToolUse.some((e) => JSON.stringify(e).includes('adw-hook.mjs post-tool')));
  assert.ok(installedSettings.hooks.Stop.some((e) => JSON.stringify(e).includes('adw-hook.mjs stop')));

  const statusRes = f.run('hook', ['status', '--agent-hooks'], [], { omitPlan: true });
  assert.equal(statusRes.status, 0, statusRes.stderr);
  assert.match(statusRes.stdout, /installed \(3\/3 events\)/);

  const runHook = (mode, stdinObjOrRaw, extraArgs = []) => {
    const input =
      typeof stdinObjOrRaw === 'string'
        ? stdinObjOrRaw
        : JSON.stringify(stdinObjOrRaw);
    return spawnSync(process.execPath, [hookDest, mode, ...extraArgs], {
      cwd: f.root,
      input,
      encoding: 'utf8',
    });
  };

  // Malformed JSON: fail open by default, block under --strict
  assert.equal(runHook('pre-tool', '{bad json').status, 0);
  assert.equal(runHook('pre-tool', '{bad json', ['--strict']).status, 2);

  // pre-tool: block direct checkbox edit on .plan.md
  const blockCheckbox = runHook('pre-tool', {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'docs/plans/FO-Plan-Test.plan.md',
      old_string: '- [ ] First criterion',
      new_string: '- [x] First criterion',
    },
  });
  assert.equal(blockCheckbox.status, 2);
  assert.match(blockCheckbox.stderr, /Direct edits to plan checkboxes/);

  // pre-tool: allow prose edit in Notes on .plan.md
  const allowProse = runHook('pre-tool', {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'docs/plans/FO-Plan-Test.plan.md',
      old_string: '## Notes',
      new_string: '## Notes\nUpdated prose',
    },
  });
  assert.equal(allowProse.status, 0, allowProse.stderr);

  // pre-tool: block workflow file edit when no in-progress plan exists
  const blockWorkflowNoPlan = runHook('pre-tool', {
    tool_name: 'Edit',
    tool_input: { file_path: 'scripts/ticket.mjs', old_string: 'a', new_string: 'b' },
  });
  assert.equal(blockWorkflowNoPlan.status, 2);
  assert.match(blockWorkflowNoPlan.stderr, /requires an active `in-progress` plan/);

  // pre-tool: block git push (including `git -C <dir> push`) to protected branch main
  const blockPush = runHook('pre-tool', {
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  });
  assert.equal(blockPush.status, 2);
  assert.match(blockPush.stderr, /protected branch "main"/);

  const blockPushWithC = runHook('pre-tool', {
    tool_name: 'Bash',
    tool_input: { command: 'git -C . push origin main' },
  });
  assert.equal(blockPushWithC.status, 2);
  assert.match(blockPushWithC.stderr, /protected branch "main"/);

  // post-tool: reports verify failure output boundedly
  const postRes = runHook('post-tool', {
    tool_name: 'Edit',
    tool_input: { file_path: 'src/app.js' },
  });
  assert.equal(postRes.status, 0);
  assert.match(postRes.stderr, /post-tool verify failed/);

  // Switch to feature branch with active in-progress plan and open item, then test stop hook
  f.git('checkout', '-b', 'feat/hook-test');
  writeFileSync(
    f.plan,
    readFileSync(f.plan, 'utf8')
      .replace('status: draft', 'status: in-progress')
      .replace('- [x] Implement', '- [ ] Implement'),
  );
  writeFileSync(join(f.root, 'dirty.txt'), 'unlogged change\n');

  const stopBlocked = runHook('stop', {});
  assert.equal(stopBlocked.status, 2);
  assert.match(stopBlocked.stderr, /handoff/);

  // Record handoff -> stop allows clean pause (exit 0)
  const handoffRes = f.run('handoff', ['--agent', 'Gemini', '--done', 'WIP', '--next', 'Finish']);
  assert.equal(handoffRes.status, 0, handoffRes.stderr);
  const stopAllowed = runHook('stop', {});
  assert.equal(stopAllowed.status, 0, stopAllowed.stderr);

  // Uninstall removes only ADW entries and preserves user hook
  const uninstallRes = f.run('hook', ['uninstall', '--agent-hooks'], [], { omitPlan: true });
  assert.equal(uninstallRes.status, 0, uninstallRes.stderr);
  const afterUninstall = JSON.parse(readFileSync(join(f.root, '.claude/settings.json'), 'utf8'));
  assert.equal(afterUninstall.theme, 'dark');
  assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
  assert.equal(afterUninstall.hooks.PreToolUse[0].matcher, 'Custom');
  assert.equal(afterUninstall.hooks.PostToolUse, undefined);
});

test('T3.1: versioning new --version --impact, activeTrain default, split preservation, and requireVersionOnPlans lint/check', (t) => {
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
    versioning: {
      enabled: true,
      currentVersion: '1.1.0',
      activeTrain: '1.2.0',
      roadmapPath: 'docs/ROADMAP.md',
      changelogPath: 'CHANGELOG.md',
      tagPrefix: 'v',
      requireVersionOnPlans: true,
    },
  });
  copyFileSync(
    join(scripts, '..', 'docs/plans/_template.plan.md'),
    join(f.root, 'docs/plans/_template.plan.md'),
  );

  // 1. Existing fixture plan without version/impact fails check & lint when requireVersionOnPlans: true
  const failCheck = f.run('check');
  assert.notEqual(failCheck.status, 0);
  assert.match(failCheck.stderr, /version is required in frontmatter/);
  assert.match(failCheck.stderr, /impact is required in frontmatter/);

  const failLint = f.run('lint', ['--json']);
  assert.notEqual(failLint.status, 0);
  const lintJson = JSON.parse(failLint.stdout);
  assert.ok(lintJson.errors.some((e) => /"version" is required/.test(e)));
  assert.ok(lintJson.errors.some((e) => /"impact" is required/.test(e)));

  // 2. Invalid impact is rejected by new and check
  const badNew = f.run('new', ['Bad Impact', '--impact', 'breaking'], [], { omitPlan: true });
  assert.notEqual(badNew.status, 0);
  assert.match(badNew.stderr, /--impact must be one of none, patch, minor, major/);

  // 3. new without --version inherits activeTrain (1.2.0) and infers minor for Feature, patch for Bug
  const featNew = f.run(
    'new',
    ['Overlay Search', '--type', 'Feature', '--appetite', 'M', '--criteria', 'AC1: Search works|AC2: Fast', '--steps', 'Step 1 (AC1)|Step 2 (AC2)'],
    [],
    { omitPlan: true },
  );
  assert.equal(featNew.status, 0, featNew.stderr);
  const featFile = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('Overlay-Search'),
  );
  assert.ok(featFile);
  const featRel = `docs/plans/${featFile}`;
  const featContent = readFileSync(join(f.root, featRel), 'utf8');
  assert.match(featContent, /^version: 1\.2\.0$/m);
  assert.match(featContent, /^impact: minor$/m);
  assert.match(featContent, /^appetite: M$/m);

  // 4. split preserves appetite, version, and impact in Part 2
  const splitRes = f.run('split', [featRel, '--after', '1'], [], { omitPlan: true });
  assert.equal(splitRes.status, 0, splitRes.stderr);
  const part2File = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('Overlay-Search-Part-2'),
  );
  assert.ok(part2File);
  const part2Content = readFileSync(join(f.root, 'docs/plans', part2File), 'utf8');
  assert.match(part2Content, /^appetite: M$/m);
  assert.match(part2Content, /^version: 1\.2\.0$/m);
  assert.match(part2Content, /^impact: minor$/m);
});

test('T3.2: create stamps Target Version on Notion Tasks and retries gracefully if Target Version is unsupported', (t) => {
  // 1. Stamps Target Version when version is set (e.g. 1.2.0)
  const f1 = fixture(t, 'version: 1.2.0\nimpact: minor\n', [empty, created]);
  const r1 = f1.run('create', ['--agent', 'Gemini']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(
    r1.calls[1].body.properties['Target Version'].rich_text[0].text.content,
    '1.2.0',
  );

  // 2. Does not stamp Target Version when version is "none"
  const f2 = fixture(t, 'version: none\nimpact: none\n', [empty, created]);
  const r2 = f2.run('create', ['--agent', 'Gemini']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.calls[1].body.properties['Target Version'], undefined);

  // 3. Soft fallback retries without Target Version if Notion returns validation_error on Target Version
  const f3 = fixture(t, 'version: 1.2.0\nimpact: minor\n', [
    empty,
    {
      status: 400,
      body: {
        code: 'validation_error',
        message: 'Target Version is not a property that exists.',
      },
    },
    created,
  ]);
  const r3 = f3.run('create', ['--agent', 'Gemini']);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(r3.calls.length, 3);
  assert.ok(r3.calls[1].body.properties['Target Version']);
  assert.equal(r3.calls[2].body.properties['Target Version'], undefined);
});

test('T3.3: release init, status, notes (--write), closeout, and prime/resume/pack/doctor/stats version surfacing', (t) => {
  const f = fixture(
    t,
    'ticket: local://FO:FO-Plan-Test\nstatus: done\nversion: 1.2.0\nimpact: minor\npr: https://github.com/owner/repo/pull/42\n',
    [],
    {
      tracker: 'local',
      requireReview: false,
      versioning: {
        enabled: true,
        currentVersion: '1.1.0',
        activeTrain: '1.2.0',
        roadmapPath: 'docs/ROADMAP.md',
        changelogPath: 'CHANGELOG.md',
        tagPrefix: 'v',
        requireVersionOnPlans: false,
      },
    },
  );
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');

  // Add a second Bug plan targeting 1.2.0 in archive
  mkdirSync(join(f.root, 'docs/plans/archive/2026-11'), { recursive: true });
  writeFileSync(
    join(f.root, 'docs/plans/archive/2026-11/FO-Plan-Fix-Crash-2026-11.plan.md'),
    [
      '---',
      'title: Plan - Bug: Fix Overlay Crash',
      'ticket: local://FO:FO-Plan-Fix-Crash-2026-11',
      'status: done',
      'version: 1.2.0',
      'impact: patch',
      'pr: https://github.com/owner/repo/pull/43',
      '---',
      '# Fix Overlay Crash',
      '',
      '## Summary',
      'Prevent null-pointer crash when closing overlay.',
      '',
      '## Acceptance criteria',
      '- [x] AC1: No crash verified: test',
      '',
      '## Steps',
      '- [x] Fix guard (AC1)',
      '',
    ].join('\n'),
  );

  // Update main fixture plan to Feature for release notes categorization
  writeFileSync(
    f.plan,
    readFileSync(f.plan, 'utf8').replace(
      'title: Plan - Process: Test',
      'title: Plan - Feature: Command Palette',
    ),
  );

  f.git('add', '.');
  f.git('commit', '-m', 'init plans');

  // 1. release init creates docs/ROADMAP.md
  const initRes = f.run('release', ['init'], [], { omitPlan: true });
  assert.equal(initRes.status, 0, initRes.stderr);
  assert.ok(existsSync(join(f.root, 'docs/ROADMAP.md')));
  const rmContent = readFileSync(join(f.root, 'docs/ROADMAP.md'), 'utf8');
  assert.match(rmContent, /### 1\.1\.0/);
  assert.match(rmContent, /### 1\.2\.0/);

  // 2. release status --json aggregates active + archived plans and detects ROADMAP.md entry
  const statusRes = f.run('release', ['status', '1.2.0', '--json'], [], { omitPlan: true });
  assert.equal(statusRes.status, 0, statusRes.stderr);
  const statusJson = JSON.parse(statusRes.stdout);
  assert.equal(statusJson.versioningEnabled, true);
  assert.equal(statusJson.roadmapExists, true);
  assert.equal(statusJson.trains.length, 1);
  assert.equal(statusJson.trains[0].version, '1.2.0');
  assert.equal(statusJson.trains[0].inRoadmap, true);
  assert.equal(statusJson.trains[0].highestImpact, 'minor');
  assert.equal(statusJson.trains[0].totalPlans, 2);
  assert.equal(statusJson.trains[0].counts.ready, 2);

  // 3. release notes --write generates Keep-a-Changelog sections in CHANGELOG.md
  const notesRes = f.run('release', ['notes', '1.2.0', '--write'], [], { omitPlan: true });
  assert.equal(notesRes.status, 0, notesRes.stderr);
  const clContent = readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8');
  assert.match(clContent, /## \[1\.2\.0\] - \d{4}-\d{2}-\d{2}/);
  assert.match(clContent, /### Added\n- \*\*Command Palette\*\*: Test fixture \(\[#42\]/);
  assert.match(clContent, /### Fixed\n- \*\*Fix Overlay Crash\*\*: Prevent null-pointer crash when closing overlay\. \(\[#43\]/);

  // 4. release closeout scaffolds a valid V5 closeout plan that passes lint
  const closeoutRes = f.run('release', ['closeout', '1.2.0'], [], { omitPlan: true });
  assert.equal(closeoutRes.status, 0, closeoutRes.stderr);
  const closeoutFile = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('Release-Closeout-1-2-0'),
  );
  assert.ok(closeoutFile);
  const lintCloseout = f.run('lint', [`docs/plans/${closeoutFile}`], [], { omitPlan: true });
  assert.equal(lintCloseout.status, 0, lintCloseout.stderr);

  // 4b. release status and release notes exclude closeout plans and skip draft/open plans by default
  writeFileSync(
    join(f.root, 'docs/plans/FO-Plan-Draft-Future-Work-2026-11.plan.md'),
    [
      '---',
      'title: Plan - Feature: Unfinished Draft Feature',
      'ticket:',
      'status: draft',
      'version: 1.2.0',
      'impact: minor',
      '---',
      '# Unfinished Draft Feature',
      '',
      '## Summary',
      'Should not appear in CHANGELOG until closed out.',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: Pending',
      '',
      '## Steps',
      '- [ ] Pending step (AC1)',
      '',
    ].join('\n'),
  );
  const postCloseoutStatus = f.run('release', ['status', '1.2.0', '--json'], [], { omitPlan: true });
  assert.equal(postCloseoutStatus.status, 0, postCloseoutStatus.stderr);
  const postCloseoutJson = JSON.parse(postCloseoutStatus.stdout);
  assert.equal(postCloseoutJson.trains[0].totalPlans, 3); // 2 done + 1 draft; closeout excluded
  assert.equal(postCloseoutJson.trains[0].counts.ready, 2);
  assert.equal(postCloseoutJson.trains[0].counts.planned, 1);

  const notesDefault = f.run('release', ['notes', '1.2.0'], [], { omitPlan: true });
  assert.equal(notesDefault.status, 0, notesDefault.stderr);
  assert.doesNotMatch(notesDefault.stdout, /Release Closeout/);
  assert.doesNotMatch(notesDefault.stdout, /Unfinished Draft Feature/);
  assert.match(notesDefault.stderr, /skipping 1 unclosed plan/);

  const notesAll = f.run('release', ['notes', '1.2.0', '--all'], [], { omitPlan: true });
  assert.equal(notesAll.status, 0, notesAll.stderr);
  assert.doesNotMatch(notesAll.stdout, /Release Closeout/);
  assert.match(notesAll.stdout, /Unfinished Draft Feature/);

  // 4c. release notes --write creates nested changelogPath parent directories automatically
  const cfgPath = join(f.root, 'scripts/ticket.config.json');
  const prevCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(
    cfgPath,
    JSON.stringify({ ...prevCfg, versioning: { ...prevCfg.versioning, changelogPath: 'docs/releases/CHANGELOG.md' } }, null, 2),
  );
  const nestedWrite = f.run('release', ['notes', '1.2.0', '--write'], [], { omitPlan: true });
  assert.equal(nestedWrite.status, 0, nestedWrite.stderr);
  assert.ok(existsSync(join(f.root, 'docs/releases/CHANGELOG.md')));
  // Restore changelogPath & remove extra draft plan before single-plan prime/resume/pack checks
  writeFileSync(cfgPath, JSON.stringify(prevCfg, null, 2));
  rmSync(join(f.root, 'docs/plans/FO-Plan-Draft-Future-Work-2026-11.plan.md'), { force: true });

  // 5. prime, resume, pack, doctor, and stats surface version metadata
  const primeRes = f.run('prime');
  assert.equal(primeRes.status, 0, primeRes.stderr);
  assert.match(primeRes.stdout, /Version: 1\.2\.0 \(minor\)/);

  const resumeRes = f.run('resume');
  assert.equal(resumeRes.status, 0, resumeRes.stderr);
  assert.match(resumeRes.stdout, /Version:\s+1\.2\.0 \(minor\)/);

  const packRes = f.run('pack');
  assert.equal(packRes.status, 0, packRes.stderr);
  assert.match(packRes.stdout, /Version: 1\.2\.0 \(minor\)/);

  const docRes = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(docRes.status, 0, docRes.stderr);
  assert.match(docRes.stdout, /Version:\s+current=1\.1\.0, train=1\.2\.0 \(roadmap: present, changelog: present\)/);

  const statsRes = f.run('stats', ['--json'], [], { omitPlan: true });
  assert.equal(statsRes.status, 0, statsRes.stderr);
  const statsJson = JSON.parse(statsRes.stdout);
  assert.equal(statsJson.byVersion['1.2.0'], 3);
});

test('T3.4: omitted requireReview defaults to true, enforces independent review, and doctor reports status', (t) => {
  const f = fixture(t, 'agent: Gemini\n', [], { tracker: 'local' });
  const cfgPath = join(f.root, 'scripts/ticket.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  delete cfg.requireReview;
  delete cfg.allowSelfReview;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');
  f.git('checkout', '-b', 'feat/default-review');

  const createRes = f.run('create', ['--agent', 'Gemini']);
  assert.equal(createRes.status, 0, createRes.stderr);
  f.git('add', '.');
  f.git('commit', '-m', 'ticketed');

  // Check fails without review even though requireReview was omitted from config
  const unreviewedCheck = f.run('check');
  assert.notEqual(unreviewedCheck.status, 0);
  assert.match(unreviewedCheck.stderr, /no passing review recorded/);

  // Doctor explicitly reports mandatory independent review
  const docRes = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(docRes.status, 0, docRes.stderr);
  assert.match(docRes.stdout, /Review:\s+required \(independent sub-agent \/ second model; self-review blocked\)/);

  // Independent subagent review with --reviewer-id unblocks check and ci-check
  const revRes = f.run('review', [
    '--agent',
    'Gemini',
    '--reviewer-id',
    'subagent-9999',
    '--verdict',
    'pass',
    '--summary',
    'independent subagent check passed',
  ]);
  assert.equal(revRes.status, 0, revRes.stderr);
  assert.equal(f.run('check').status, 0);
});

test('T3.5: verify --pre-push, prePushVerify hook/doctor, merge local Notion closeout, and sync ci.ticketDoneWorkflow', async (t) => {
  // 1. verify --pre-push and hook install / doctor surfacing
  const f = fixture(t, '', [], {
    verify: {
      test: 'node -e "console.log(\'prepush-test-ok\')"',
      full: 'node -e "console.log(\'prepush-full-ok\')"',
    },
  });
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // prePushVerify omitted -> --pre-push exits 0 without running verify command
  const skipOff = f.run('verify', ['--pre-push'], [], { omitPlan: true });
  assert.equal(skipOff.status, 0, skipOff.stderr);
  assert.doesNotMatch(skipOff.stdout, /prepush-test-ok/);

  // Enable prePushVerify: true
  const cfgPath = join(f.root, 'scripts/ticket.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.prePushVerify = true;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const runOn = f.run('verify', ['--pre-push'], [], {
    omitPlan: true,
    envOverrides: {
      GIT_DIR: join(f.root, '.bogus-git-dir'),
      GIT_WORK_TREE: join(f.root, '.bogus-wt'),
    },
  });
  assert.equal(runOn.status, 0, runOn.stderr);
  assert.match(runOn.stdout, /prepush-test-ok/);

  // verify strips GIT_DIR/GIT_WORK_TREE from child test commands (prevents linked-worktree hook hijacking)
  cfg.verify.full = 'node -e "const cp=require(\'child_process\'); if(process.env.GIT_DIR||process.env.GIT_WORK_TREE) process.exit(2); cp.execFileSync(\'git\',[\'rev-parse\',\'--is-inside-work-tree\'],{stdio:\'inherit\'}); console.log(\'git-env-clean\')"';
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const cleanGitEnv = f.run('verify', ['--pre-push', '--tier', 'full'], [], {
    omitPlan: true,
    envOverrides: {
      GIT_DIR: join(f.root, '.bogus-git-dir'),
      GIT_WORK_TREE: join(f.root, '.bogus-wt'),
    },
  });
  assert.equal(cleanGitEnv.status, 0, cleanGitEnv.stderr);
  assert.match(cleanGitEnv.stdout, /git-env-clean/);

  // GIT_SKIP_PREPUSH_VERIFY=1 skips execution
  const skipEnv = f.run('verify', ['--pre-push'], [], {
    omitPlan: true,
    envOverrides: { GIT_SKIP_PREPUSH_VERIFY: '1' },
  });
  assert.equal(skipEnv.status, 0, skipEnv.stderr);
  assert.match(skipEnv.stdout, /Pre-push verify skipped/);

  // hook install forwards the pushed SHA and doctor prints prePushVerify
  const hookRes = f.run('hook', ['install'], [], { omitPlan: true });
  assert.equal(hookRes.status, 0, hookRes.stderr);
  const hookScript = readFileSync(join(f.root, '.git/hooks/pre-push'), 'utf8');
  assert.match(hookScript, /verify --pre-push --pushed-head "\$pushed_head"/);
  const dr = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(dr.status, 0, dr.stderr);
  assert.match(dr.stdout, /Pre-push:\s+installed \(prePushVerify: test\)/);

  const older = f.git('rev-parse', 'HEAD');
  f.git('add', 'scripts/ticket.config.json');
  f.git('commit', '-m', 'enable pre-push verification');
  const head = f.git('rev-parse', 'HEAD');
  const invokeVerify = (sha) => f.run('verify', ['--pre-push', '--pushed-head', sha], [], { omitPlan: true });
  const exact = invokeVerify(head);
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /prepush-test-ok/);
  assert.match(invokeVerify(older).stderr, /must run from the commit being pushed/);
  assert.match(invokeVerify('multiple').stderr, /requires a single pushed commit/);
  const dirtyFile = join(f.root, 'untracked.txt');
  writeFileSync(dirtyFile, 'dirty');
  const unclean = invokeVerify(head);
  assert.match(unclean.stderr, /pre-push verification requires a clean committed snapshot/);
  assert.doesNotMatch(unclean.stdout, /prepush-test-ok/);
  rmSync(dirtyFile);

  const pushRemote = mkdtempSync(join(tmpdir(), 'adw-prepush-remote-'));
  t.after(() => rmSync(pushRemote, { recursive: true, force: true }));
  f.git('init', '--bare', pushRemote);
  f.git('remote', 'add', 'fixture', pushRemote);
  f.git('push', 'fixture', `${head}:refs/heads/verified-fixture`);
  assert.throws(() => f.git('push', 'fixture', `${older}:refs/heads/stale-fixture`),
    (error) => error.stderr.includes('commit being pushed'));
  assert.throws(() => f.git('push', 'fixture',
    `${head}:refs/heads/current-fixture`, `${older}:refs/heads/stale-fixture`),
  (error) => error.stderr.includes('Push different revisions separately'));
  f.git('push', 'fixture', ':refs/heads/verified-fixture');

  // 2. merge command merges open PR via gh and closes Notion ticket locally
  const prUrl = 'https://github.com/example/repo/pull/99';
  const taskId = '11111111111141118111111111111111';

  const fMerge = fixture(
    t,
    [
      'status: shipped',
      `ticket: https://www.notion.so/${taskId}`,
      'agent: Gemini',
      'reviewedBy: Gemini',
      'reviewVerdict: pass',
      'reviewSession: subagent-8888',
      `pr: ${prUrl}`,
    ].join('\n') + '\n',
    [],
    { requireReview: true },
  );
  fMerge.git('init', '-b', 'main');
  writeFileSync(join(fMerge.root, '.git/info/exclude'), '\ngh-requests.jsonl\nrequests.jsonl\n', { flag: 'a' });
  fMerge.git('config', 'user.name', 'Test');
  fMerge.git('config', 'user.email', 'test@example.invalid');
  fMerge.git('add', '.');
  fMerge.git('commit', '-m', 'init');
  const base = fMerge.git('rev-parse', 'HEAD');
  fMerge.git('switch', '-c', 'feature');
  const planBody = readFileSync(fMerge.plan, 'utf8')
    .replace('- [ ] AC1\n', '- [x] AC1 verified: ok\n')
    .replace('- [ ] Step\n', '- [x] Step\n');
  writeFileSync(fMerge.plan, planBody);
  const revMergeRes = fMerge.run('review', [
    '--agent', 'Gemini',
    '--reviewer-id', 'subagent-8888',
    '--verdict', 'pass',
    '--summary', 'ok',
  ]);
  assert.equal(revMergeRes.status, 0, revMergeRes.stderr);
  fMerge.git('add', '.');
  fMerge.git('commit', '-m', 'reviewed');
  const reviewedHead = fMerge.git('rev-parse', 'HEAD');
  const prFiles = [[{ ...changedPlan, status: 'modified' }]];
  const merged = mergedPull(99, reviewedHead, {
    head: { sha: reviewedHead, ref: 'feature' },
    base: { ref: 'main', repo: { full_name: 'example/repo' }, sha: base },
  });
  const open = { ...merged, merged: false, state: 'open' };

  const queued = fMerge.run('merge', [], [], {
    github: [repository, open, prFiles, '', open],
  });
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /has not merged .* yet/);
  assert.equal(queued.calls.length, 0);

  const stale = fMerge.run('merge', [], [], {
    github: [repository, { ...open, head: { sha: base, ref: 'feature' } }, prFiles],
  });
  assert.match(stale.stderr, /head differs from the locally reviewed commit/);
  assert.equal(stale.calls.length, 0);

  const unrelated = fMerge.run('merge', [], [], {
    github: [repository, open, [[{ filename: 'README.md', status: 'modified' }]]],
  });
  assert.match(unrelated.stderr, /pull request does not change this plan/);
  assert.equal(unrelated.calls.length, 0);

  const mergeRes = fMerge.run(
    'merge',
    ['--squash'],
    [
      completionState('Doing', null, taskId),
      { body: { id: taskId } },
    ],
    {
      omitPlan: true,
      github: [repository, open, prFiles, '', merged],
    },
  );
  assert.equal(mergeRes.status, 0, mergeRes.stderr);
  assert.match(mergeRes.stdout, /Merged pull request:/);
  assert.match(mergeRes.stdout, /Ticket set to Done:/);
  assert.deepEqual(mergeRes.ghCalls.find((args) => args[1] === 'merge'),
    ['pr', 'merge', prUrl, '--squash', '--delete-branch', '--match-head-commit', reviewedHead]);
  const donePatch = mergeRes.calls.find(
    (r) => r.method === 'PATCH' && r.url.includes(taskId) && r.body?.properties?.Status?.status?.name === 'Done',
  );
  assert.ok(donePatch, 'Expected Notion Status=Done patch during merge');

  // 3. sync.mjs supports ci.ticketDoneWorkflow: false
  const target = mkdtempSync(join(tmpdir(), 'adw-sync-nodone-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const runSync = (args = []) =>
    spawnSync(process.execPath, [join(scripts, 'sync.mjs'), target, ...args], {
      encoding: 'utf8',
    });
  assert.equal(runSync(['--init-prefix', 'OPT']).status, 0);
  const targetDonePath = join(target, '.github/workflows/ticket-done.yml');
  const hadPullRequest = /pull_request(?:_target)?:/.test(readFileSync(targetDonePath, 'utf8'));
  const targetCfgPath = join(target, 'scripts/ticket.config.json');
  const targetCfg = JSON.parse(readFileSync(targetCfgPath, 'utf8'));
  targetCfg.ci = { ticketDoneWorkflow: false };
  writeFileSync(targetCfgPath, JSON.stringify(targetCfg, null, 2));

  if (hadPullRequest) {
    const driftCheck = runSync(['--check']);
    assert.equal(driftCheck.status, 1, driftCheck.stderr);
    assert.match(driftCheck.stdout, /\[DRIFT\].*ticket-done\.yml/);

    const updatedSync = runSync();
    assert.equal(updatedSync.status, 0, updatedSync.stderr);
    assert.match(updatedSync.stdout, /\[UPDATED\].*ticket-done\.yml/);
  } else {
    assert.equal(runSync().status, 0);
  }
  const doneWorkflow = readFileSync(targetDonePath, 'utf8');
  assert.match(doneWorkflow, /workflow_dispatch:/);
  assert.match(doneWorkflow, /inputs:\s+pr:\s+description: Number of the merged pull request/);
  assert.match(doneWorkflow, /github.event_name == 'workflow_dispatch'/);
  assert.match(doneWorkflow, /ci-done --pr-number/);
  assert.doesNotMatch(doneWorkflow, /pull_request(?:_target)?:/);
  assert.equal(runSync(['--check']).status, 0);
  const selfDoctorBundleCheck = spawnSync(
    process.execPath,
    [join(target, 'scripts/sync.mjs'), target, '--check', '--bundle-only'],
    { encoding: 'utf8' },
  );
  assert.equal(selfDoctorBundleCheck.status, 0, selfDoctorBundleCheck.stderr);
});

test('role-to-model routing: config defaults, step/prime/review --prompt/run --dry-run, ADW_MODEL, and review --model', (t) => {
  const repoRoot = dirname(scripts);
  const expectedModels = {
    planner: 'gemini-4-neon-medium',
    builder: 'gemini-4-hydrogen-medium',
    fixer: 'gemini-4-hydrogen-medium',
    reviewer: 'gemini-4-neon-low',
  };
  for (const relCfg of ['scripts/ticket.config.json', 'ticket.config.example.json']) {
    const fullCfg = join(repoRoot, relCfg);
    if (!existsSync(fullCfg)) continue;
    const cfg = JSON.parse(readFileSync(fullCfg, 'utf8'));
    assert.deepEqual(cfg.agentic?.models, expectedModels, `${relCfg} agentic.models`);
  }
  const manifest = JSON.parse(readFileSync(join(scripts, 'workflow-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.starterConfig?.agentic?.models, expectedModels, 'starterConfig agentic.models');

  // 1. Configured agentic.models surfaces across step, step --json, prime, review --prompt, run --dry-run
  const f = fixture(
    t,
    'ticket: local://FO:FO-Plan-Test\nagent: Gemini\n',
    [],
    {
      tracker: 'local',
      verify: { test: 'node -e "process.exit(0)"' },
      agentic: { maxRetries: 2, verifyTier: 'test', models: expectedModels },
    },
  );
  writeFileSync(
    join(f.root, 'docs/plans/FO-Plan-Test.plan.md'),
    [
      '---',
      'title: Plan - Feature: Role Routing',
      'ticket: local://FO:FO-Plan-Test',
      'status: in-progress',
      'agent: Gemini',
      '---',
      '# Role Routing',
      '',
      '## Summary',
      'Test role model routing.',
      '',
      '## Context',
      '- scripts/ticket.mjs',
      '',
      '## Open questions',
      'None',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: Works',
      '',
      '## Steps',
      '- [ ] Step 1 (AC1)',
      '',
      '## Progress log',
    ].join('\n'),
  );
  f.git('init', '-b', 'feat/role-test');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  for (const [role, model] of Object.entries(expectedModels)) {
    const res = f.run('step', ['--role', role]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`Model:\\s+${model}`));
    const jsonRes = f.run('step', ['--role', role, '--json']);
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.role, role);
    assert.equal(parsed.model, model);
  }
  const plannerRes = f.run('step', ['--role', 'planner']);
  assert.match(plannerRes.stdout, /# Planner Brief:/);
  assert.match(plannerRes.stdout, /## Planning Protocol/);

  const primeRes = f.run('prime');
  assert.equal(primeRes.status, 0, primeRes.stderr);
  assert.match(
    primeRes.stdout,
    /Models:\s+planner=gemini-4-neon-medium \| builder=gemini-4-hydrogen-medium \| reviewer=gemini-4-neon-low \| fixer=gemini-4-hydrogen-medium/,
  );

  const reviewPromptRes = f.run('review', ['--prompt']);
  assert.equal(reviewPromptRes.status, 0, reviewPromptRes.stderr);
  assert.match(reviewPromptRes.stdout, /Model:\s+gemini-4-neon-low/);

  const dryRunRes = f.run('run', ['--cmd', 'node -e ""', '--dry-run']);
  assert.equal(dryRunRes.status, 0, dryRunRes.stderr);
  assert.match(dryRunRes.stdout, /Models:\s+planner=gemini-4-neon-medium/);
  assert.match(dryRunRes.stdout, /Model:\s+gemini-4-hydrogen-medium/);

  // 2. ADW_MODEL propagation in run for builder and reviewer
  const envLogDir = mkdtempSync(join(tmpdir(), 'adw-env-'));
  t.after(() => rmSync(envLogDir, { recursive: true, force: true }));
  const envLog = join(envLogDir, 'adw-env.jsonl');
  const runnerScript = join(f.root, 'runner.mjs');
  writeFileSync(
    runnerScript,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ role: process.env.ADW_ROLE, model: process.env.ADW_MODEL }) + '\\n');
const planPath = process.env.ADW_PLAN;
if (process.env.ADW_ROLE === 'reviewer') {
  execFileSync(process.execPath, ['scripts/ticket.mjs', 'review', planPath, '--agent', 'Codex', '--model', process.env.ADW_MODEL || '', '--verdict', 'pass', '--summary', 'Runner verified']);
}
`,
  );
  // Ensure clean tree for review fingerprint
  f.git('add', 'runner.mjs');
  f.git('commit', '-m', 'add runner');
  const runRes = f.run('run', ['--cmd', `node ${JSON.stringify(runnerScript)}`]);
  assert.equal(runRes.status, 0, `${runRes.stdout}\n${runRes.stderr}`);
  const envEntries = readFileSync(envLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    envEntries.filter((e) => e.role === 'builder').map((e) => e.model),
    ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen-medium'],
  );
  assert.deepEqual(
    envEntries.filter((e) => e.role === 'reviewer').map((e) => e.model),
    ['gemini-4-neon-low'],
  );

  // 3. review --model records reviewModel and progress log tag, and omitting --model stays backward-compatible
  const planAfterRun = readFileSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'), 'utf8');
  assert.match(planAfterRun, /reviewModel: gemini-4-neon-low/);
  assert.match(planAfterRun, /\(review: pass\): Runner verified \(model: gemini-4-neon-low\)/);

  const plainRev = f.run('review', [
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'No model flag',
  ]);
  assert.equal(plainRev.status, 0, plainRev.stderr);
  assert.doesNotMatch(plainRev.plan, /reviewModel:/);
  assert.match(plainRev.plan, /\(review: pass\): No model flag$/m);

  // 4. Omitting agentic.models omits Model/Models lines cleanly
  const fNoModels = fixture(
    t,
    'ticket: local://FO:FO-Plan-Test\nagent: Gemini\n',
    [],
    { tracker: 'local', verify: { test: 'node -e "process.exit(0)"' } },
  );
  fNoModels.git('init', '-b', 'feat/no-models');
  fNoModels.git('config', 'user.name', 'Test');
  fNoModels.git('config', 'user.email', 'test@example.invalid');
  fNoModels.git('add', '.');
  fNoModels.git('commit', '-m', 'init');

  for (const role of ['planner', 'builder', 'reviewer', 'fixer']) {
    const res = fNoModels.run('step', ['--role', role]);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /^Model:/m);
    const jRes = fNoModels.run('step', ['--role', role, '--json']);
    assert.equal(jRes.status, 0, jRes.stderr);
    assert.equal('model' in JSON.parse(jRes.stdout), false);
  }
  const primeNoModels = fNoModels.run('prime');
  assert.equal(primeNoModels.status, 0, primeNoModels.stderr);
  assert.doesNotMatch(primeNoModels.stdout, /^Models:/m);
  const revPromptNoModels = fNoModels.run('review', ['--prompt']);
  assert.equal(revPromptNoModels.status, 0, revPromptNoModels.stderr);
  assert.doesNotMatch(revPromptNoModels.stdout, /^Model:/m);
  const dryRunNoModels = fNoModels.run('run', ['--cmd', 'node -e ""', '--dry-run']);
  assert.equal(dryRunNoModels.status, 0, dryRunNoModels.stderr);
  assert.doesNotMatch(dryRunNoModels.stdout, /^Models:/m);
  assert.doesNotMatch(dryRunNoModels.stdout, /^Model:/m);
});

test('architecture blueprints: scaffold, list, new --blueprint, prime/step/pack surfacing, lint validation, and recall indexing', (t) => {
  const f = fixture(
    t,
    'ticket: local://FO:FO-Plan-Test\nagent: Gemini\n',
    [],
    {
      tracker: 'local',
      agentic: { models: { planner: 'gemini-4-neon-medium', builder: 'gemini-4-hydrogen-medium', reviewer: 'gemini-4-neon-low', fixer: 'gemini-4-hydrogen-medium' } },
      verify: { test: 'node -e "process.exit(0)"' },
    },
  );
  f.git('init', '-b', 'feat/blueprint-test');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'init');

  // 1. Empty blueprint list prints helpful message
  const emptyList = f.run('blueprint', [], [], { omitPlan: true });
  assert.equal(emptyList.status, 0, emptyList.stderr);
  assert.match(emptyList.stdout, /No architecture blueprints found/);

  // 2. Scaffold blueprint with --version and plannerModel
  const createBp = f.run('blueprint', ['Auth Architecture', '--version', '1.2.0'], [], { omitPlan: true });
  assert.equal(createBp.status, 0, createBp.stderr);
  const bpRel = 'docs/architecture/FO-Blueprint-Auth-Architecture.md';
  const bpFull = join(f.root, bpRel);
  assert.ok(existsSync(bpFull), 'blueprint file should exist');
  const bpText = readFileSync(bpFull, 'utf8');
  assert.match(bpText, /^title: Blueprint: Auth Architecture$/m);
  assert.match(bpText, /^status: active$/m);
  assert.match(bpText, /^version: 1\.2\.0$/m);
  assert.match(bpText, /^plannerModel: gemini-4-neon-medium$/m);
  assert.match(bpText, /^created: \d{4}-\d{2}-\d{2}$/m);
  for (const heading of [
    '## Goal & Non-Goals',
    '## Architecture & Boundaries',
    '## Contracts & Invariants',
    '## PR Slice Breakdown',
    '## Living Updates & ADRs',
  ]) {
    assert.ok(bpText.includes(heading), `missing section ${heading}`);
  }

  // 3. Duplicate guard and --force overwrite
  const dupBp = f.run('blueprint', ['Auth Architecture'], [], { omitPlan: true });
  assert.notEqual(dupBp.status, 0);
  assert.match(dupBp.stderr, /already exists/);

  const forceBp = f.run('blueprint', ['Auth Architecture', '--version', '1.3.0', '--force'], [], { omitPlan: true });
  assert.equal(forceBp.status, 0, forceBp.stderr);
  assert.match(readFileSync(bpFull, 'utf8'), /^version: 1\.3\.0$/m);

  // 4. List blueprints (no args and explicit 'list', ignoring _ files)
  writeFileSync(join(f.root, 'docs/architecture/_template.md'), '# Ignore\n');
  for (const args of [[], ['list']]) {
    const listRes = f.run('blueprint', args, [], { omitPlan: true });
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.match(listRes.stdout, /FO-Blueprint-Auth-Architecture\.md/);
    assert.match(listRes.stdout, /status: active/);
    assert.match(listRes.stdout, /version: 1\.3\.0/);
    assert.match(listRes.stdout, /Blueprint: Auth Architecture/);
    assert.doesNotMatch(listRes.stdout, /_template\.md/);
  }

  // 5. new --blueprint (valid, custom --context, missing error, standalone unchanged)
  const badNew = f.run('new', ['Bad Slice', '--blueprint', 'docs/architecture/missing.md'], [], { omitPlan: true });
  assert.notEqual(badNew.status, 0);
  assert.match(badNew.stderr, /blueprint not found/);

  const childRes = f.run('new', ['Auth Slice', '--blueprint', bpRel], [], { omitPlan: true });
  assert.equal(childRes.status, 0, childRes.stderr);
  const childPlanFile = readdirSync(join(f.root, 'docs/plans')).find((n) => n.includes('Auth-Slice'));
  assert.ok(childPlanFile, 'child plan should be created');
  const childRel = `docs/plans/${childPlanFile}`;
  const childText = readFileSync(join(f.root, childRel), 'utf8');
  assert.match(childText, new RegExp(`^blueprint: ${bpRel}$`, 'm'));
  assert.match(childText, new RegExp(`See architecture blueprint: \`${bpRel}\``));

  const standaloneRes = f.run('new', ['Standalone Slice'], [], { omitPlan: true });
  assert.equal(standaloneRes.status, 0, standaloneRes.stderr);
  const standaloneFile = readdirSync(join(f.root, 'docs/plans')).find((n) => n.includes('Standalone-Slice'));
  const standaloneText = readFileSync(join(f.root, 'docs/plans', standaloneFile), 'utf8');
  assert.doesNotMatch(standaloneText, /^blueprint:/m);

  // Remove extra plans so onePlan() resolves cleanly to a blueprint-linked plan
  rmSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'));
  rmSync(join(f.root, 'docs/plans', standaloneFile));
  // Fill required sections in child plan so lint passes
  const filledChild = childText
    .replace(/<2-3 sentences:[^>]*>/, 'Implement auth slice 1.')
    .replace(/<Unresolved assumptions[^>]*>/, 'None')
    .replace(/<Pre-mortem:[^>]*>/, 'None noted.')
    .replace(/<What this plan deliberately[^>]*>/, 'None noted.')
    .replace(/- \[ \] AC1: <Observable outcome>/, '- [ ] AC1: WHEN auth runs THE SYSTEM SHALL succeed')
    .replace(/- \[ \] <Step> \(AC1\)/, '- [ ] Add auth handler (AC1)');
  writeFileSync(join(f.root, childRel), filledChild);

  // 6. prime, step (all roles + --json), and pack surface Blueprint:
  const primeRes = f.run('prime', [], [], { omitPlan: true });
  assert.equal(primeRes.status, 0, primeRes.stderr);
  assert.match(primeRes.stdout, new RegExp(`^Blueprint: ${bpRel}$`, 'm'));

  for (const role of ['planner', 'builder', 'fixer', 'reviewer']) {
    const stepRes = f.run('step', ['--role', role], [], { omitPlan: true });
    assert.equal(stepRes.status, 0, stepRes.stderr);
    assert.match(stepRes.stdout, new RegExp(`^Blueprint: ${bpRel}$`, 'm'));
    if (['builder', 'fixer', 'reviewer'].includes(role)) {
      assert.match(stepRes.stdout, /contracts and invariants/i);
    }
  }
  const stepJsonRes = f.run('step', ['--role', 'builder', '--json'], [], { omitPlan: true });
  assert.equal(stepJsonRes.status, 0, stepJsonRes.stderr);
  assert.equal(JSON.parse(stepJsonRes.stdout).blueprint, bpRel);

  const packRes = f.run('pack', [], [], { omitPlan: true });
  assert.equal(packRes.status, 0, packRes.stderr);
  assert.match(packRes.stdout, new RegExp(`^Blueprint: ${bpRel}$`, 'm'));

  // 7. lint passes with valid blueprint and fails on missing blueprint
  const lintOk = f.run('lint', [childRel], [], { omitPlan: true });
  assert.equal(lintOk.status, 0, lintOk.stderr);

  writeFileSync(join(f.root, childRel), filledChild.replace(bpRel, 'docs/architecture/missing.md'));
  const lintMissing = f.run('lint', [childRel], [], { omitPlan: true });
  assert.notEqual(lintMissing.status, 0);
  assert.match(lintMissing.stdout + lintMissing.stderr, /missing\.md/);

  // 8. recall indexes docs/architecture/*.md as [Blueprint]
  writeFileSync(bpFull, bpText + '\nUniqueBlueprintTokenForRecall\n');
  const recallRes = f.run('recall', ['UniqueBlueprintTokenForRecall'], [], { omitPlan: true });
  assert.equal(recallRes.status, 0, recallRes.stderr);
  assert.match(recallRes.stdout, /\[Blueprint\] docs\/architecture\/FO-Blueprint-Auth-Architecture\.md/);
});

test('F1: cached git fixture, verify.fast, archive --merged [--fleet] [--dry-run], sync --ensure-invariants, and doctor dirty protected branch warning', (t) => {
  const f = fixture(t, '', [], {
    tracker: 'local',
    requireReview: false,
    verify: {
      fast: 'node --check scripts/ticket.mjs',
      test: 'node -e "process.exit(0)"',
    },
  });

  // 1. Cached git fixture preserves pre-existing files on init -b and short-circuits default config calls
  writeFileSync(join(f.root, 'pre-init.txt'), 'kept\n');
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  assert.equal(readFileSync(join(f.root, 'pre-init.txt'), 'utf8'), 'kept\n');
  assert.equal(f.git('config', '--get', 'user.name'), 'Test');
  assert.equal(f.git('config', '--get', 'user.email'), 'test@example.invalid');

  // 2. verify --tier fast works and repo config + manifest have fast / invariants configured
  const repoCfg = JSON.parse(readFileSync(join(scripts, 'ticket.config.json'), 'utf8'));
  if (repoCfg.prefix === 'ADW') {
    assert.equal(repoCfg.verify?.fast, 'node --check scripts/ticket.mjs');
  }
  const fixtureCfg = JSON.parse(readFileSync(join(f.root, 'scripts', 'ticket.config.json'), 'utf8'));
  assert.equal(fixtureCfg.verify?.fast, 'node --check scripts/ticket.mjs');
  const manifest = JSON.parse(readFileSync(join(scripts, 'workflow-manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.starterConfig?.invariants?.noSecretsPatterns));
  assert.ok(Array.isArray(manifest.starterConfig?.invariants?.excludePaths));

  const fastVerify = f.run('verify', ['--tier', 'fast'], [], { omitPlan: true });
  assert.equal(fastVerify.status, 0, fastVerify.stderr);

  // 3. archive --merged [--dry-run] [--fleet]
  const shippedClosed = join(f.root, 'docs/plans/FO-Plan-Shipped-Closed.plan.md');
  const inProgressOpen = join(f.root, 'docs/plans/FO-Plan-Open.plan.md');
  const mergedLocal = join(f.root, 'docs/plans/FO-Plan-Test.plan.md');
  writeFileSync(
    shippedClosed,
    [
      '---',
      'title: Plan - Feature: Shipped Closed',
      'ticket: https://www.notion.so/40a0b9c6786f817fab0ff2059ad410e3',
      'status: shipped',
      'completedAt: 2026-11-15',
      '---',
      '# Shipped Closed',
      '',
      '## Summary',
      'Shipped and merged.',
      '',
      '## Acceptance criteria',
      '- [x] AC1: Done verified: ok',
      '',
      '## Steps',
      '- [x] Step 1',
      '',
    ].join('\n'),
  );
  writeFileSync(
    inProgressOpen,
    [
      '---',
      'title: Plan - Feature: Open Work',
      'ticket: local://FO:FO-Plan-Open',
      'status: in-progress',
      '---',
      '# Open Work',
      '',
      '## Summary',
      'Still working.',
      '',
      '## Acceptance criteria',
      '- [ ] AC1: Pending',
      '',
      '## Steps',
      '- [ ] Step 1',
      '',
    ].join('\n'),
  );
  writeFileSync(
    mergedLocal,
    [
      '---',
      'title: Plan - Feature: Local Merged',
      'ticket: local://FO:FO-Plan-Test',
      'status: in-progress',
      'completedAt: 2026-11-10',
      '---',
      '# Local Merged',
      '',
      '## Summary',
      'Merged to main.',
      '',
      '## Acceptance criteria',
      '- [x] AC1: Works verified: ok',
      '',
      '## Steps',
      '- [x] Step 1',
      '',
    ].join('\n'),
  );

  f.git('add', '.');
  f.git('commit', '-m', 'commit plans on main');

  // Dry-run previews without moving
  const dryArchive = f.run('archive', ['--merged', '--dry-run'], [], { omitPlan: true });
  assert.equal(dryArchive.status, 0, dryArchive.stderr);
  assert.match(dryArchive.stdout, /\[dry-run\] Would archive: docs\/plans\/FO-Plan-Shipped-Closed\.plan\.md/);
  assert.match(dryArchive.stdout, /\[dry-run\] Would archive: docs\/plans\/FO-Plan-Test\.plan\.md/);
  assert.doesNotMatch(dryArchive.stdout, /FO-Plan-Open\.plan\.md/);
  assert.ok(existsSync(shippedClosed));
  assert.ok(existsSync(mergedLocal));

  // Real archive --merged moves closed/merged plans and leaves open plan untouched
  const realArchive = f.run('archive', ['--merged'], [], { omitPlan: true });
  assert.equal(realArchive.status, 0, realArchive.stderr);
  assert.ok(!existsSync(shippedClosed));
  assert.ok(!existsSync(mergedLocal));
  assert.ok(existsSync(join(f.root, 'docs/plans/archive/2026-11/FO-Plan-Shipped-Closed.plan.md')));
  assert.ok(existsSync(join(f.root, 'docs/plans/archive/2026-11/FO-Plan-Test.plan.md')));
  assert.ok(existsSync(inProgressOpen));

  // 4. doctor warns when on a dirty protected branch (main has uncommitted changes)
  const docDirty = f.run('doctor', [], [], { omitPlan: true });
  assert.equal(docDirty.status, 0, docDirty.stderr);
  assert.match(docDirty.stdout, /Warning:\s+Protected branch "main" has \d+ uncommitted file\(s\)/);

  // 5. sync.mjs --ensure-invariants backfills starterConfig.invariants without causing --check --bundle-only drift
  const targetRepo = mkdtempSync(join(tmpdir(), 'ticket-sync-inv-'));
  t.after(() => rmSync(targetRepo, { recursive: true, force: true }));
  const initSync = spawnSync(
    process.execPath,
    [join(scripts, 'sync.mjs'), targetRepo, '--init-prefix', 'TST'],
    { encoding: 'utf8' },
  );
  assert.equal(initSync.status, 0, initSync.stderr);

  // Strip invariants from targetRepo's ticket.config.json to simulate an older downstream config
  const targetCfgPath = join(targetRepo, 'scripts/ticket.config.json');
  const strippedCfg = JSON.parse(readFileSync(targetCfgPath, 'utf8'));
  delete strippedCfg.invariants;
  writeFileSync(targetCfgPath, JSON.stringify(strippedCfg, null, 2) + '\n');

  // --check --bundle-only must NOT report drift when invariants is missing
  const bundleCheck = spawnSync(
    process.execPath,
    [join(scripts, 'sync.mjs'), targetRepo, '--check', '--bundle-only'],
    { encoding: 'utf8' },
  );
  assert.equal(bundleCheck.status, 0, bundleCheck.stdout + bundleCheck.stderr);

  // --ensure-invariants backfills starterConfig.invariants
  const backfillSync = spawnSync(
    process.execPath,
    [join(scripts, 'sync.mjs'), targetRepo, '--ensure-invariants'],
    { encoding: 'utf8' },
  );
  assert.equal(backfillSync.status, 0, backfillSync.stderr);
  const backfilledCfg = JSON.parse(readFileSync(targetCfgPath, 'utf8'));
  assert.deepEqual(backfilledCfg.invariants, manifest.starterConfig.invariants);
});

test('G1: hunk/most-recent escaped-defect precision, deduplicated auto-lessons on block->pass and Bug close-out, and recall across blueprints/docs', (t) => {
  const f = fixture(t, '', [], {
    tracker: 'local',
    requireReview: false,
    verifyCommand: 'node -e "process.exit(0)"',
  });

  const dayIso = (daysAgo) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  rmSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'));
  mkdirSync(join(f.root, 'src'), { recursive: true });
  mkdirSync(join(f.root, 'docs/dev-workflow'), { recursive: true });
  mkdirSync(join(f.root, 'docs/architecture'), { recursive: true });

  // Create a 20-line shared file touched by >2 feature plans at distinct line ranges
  const baseLines = Array.from({ length: 20 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
  writeFileSync(join(f.root, 'src/god.js'), baseLines.join('\n') + '\n');
  writeFileSync(join(f.root, 'README.md'), '# Doc v0\n');
  writeFileSync(join(f.root, 'Strings.resw'), '<root>v0</root>\n');

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', '.');
  f.git('commit', '-m', 'chore: base', '--date', `${dayIso(12)}T10:00:00Z`);

  const writeClosedPlan = (relPath, title, startedDaysAgo, completedDaysAgo) => {
    const full = join(f.root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      [
        '---',
        `title: ${title}`,
        `ticket: local://FO:${basename(relPath, '.plan.md')}`,
        'status: done',
        `startedAt: ${dayIso(startedDaysAgo)}`,
        `completedAt: ${dayIso(completedDaysAgo)}`,
        '---',
        `# ${title}`,
        '',
        '## Summary',
        `Summary for ${title}.`,
        '',
        '## Acceptance criteria',
        '- [x] AC1: Works verified: test',
        '',
        '## Steps',
        '- [x] Step 1',
        '',
      ].join('\n'),
    );
  };

  // Feat1 touches line 2 of src/god.js + noise files
  const lines1 = [...baseLines];
  lines1[1] = 'export const line2 = 200;';
  writeFileSync(join(f.root, 'src/god.js'), lines1.join('\n') + '\n');
  writeFileSync(join(f.root, 'README.md'), '# Doc v1\n');
  writeClosedPlan('docs/plans/FO-Plan-Feat1.plan.md', 'Plan - Feature: Feat 1', 11, 10);
  f.git('add', '.');
  f.git('commit', '-m', 'feat: Feat 1', '--date', `${dayIso(10)}T12:00:00Z`);

  // Feat2 touches line 10 of src/god.js
  const lines2 = [...lines1];
  lines2[9] = 'export const line10 = 1000;';
  writeFileSync(join(f.root, 'src/god.js'), lines2.join('\n') + '\n');
  writeClosedPlan('docs/plans/FO-Plan-Feat2.plan.md', 'Plan - Feature: Feat 2', 9, 8);
  f.git('add', '.');
  f.git('commit', '-m', 'feat: Feat 2', '--date', `${dayIso(8)}T12:00:00Z`);

  // Feat3 touches line 19 of src/god.js (unrelated hunk to line 10!)
  const lines3 = [...lines2];
  lines3[18] = 'export const line19 = 1900;';
  writeFileSync(join(f.root, 'src/god.js'), lines3.join('\n') + '\n');
  writeClosedPlan('docs/plans/FO-Plan-Feat3.plan.md', 'Plan - Feature: Feat 3', 7, 6);
  f.git('add', '.');
  f.git('commit', '-m', 'feat: Feat 3', '--date', `${dayIso(6)}T12:00:00Z`);

  // Bug1 fixes line 10 of src/god.js (should attribute to Feat2 by hunk overlap, NOT Feat3 or Feat1!)
  const linesBug = [...lines3];
  linesBug[9] = 'export const line10 = 1001;';
  writeFileSync(join(f.root, 'src/god.js'), linesBug.join('\n') + '\n');
  writeFileSync(join(f.root, 'README.md'), '# Doc v2\n');
  writeFileSync(join(f.root, 'Strings.resw'), '<root>v2</root>\n');
  const bugPlanRel = 'docs/plans/FO-Plan-Bug1.plan.md';
  writeFileSync(
    join(f.root, bugPlanRel),
    [
      '---',
      'title: Debug - Bug: Fix Line 10 Overflow',
      'ticket: local://FO:FO-Plan-Bug1',
      'status: in-progress',
      `startedAt: ${dayIso(3)}`,
      '---',
      '# Fix Line 10 Overflow',
      '',
      '## Summary',
      'Guard line 10 against integer overflow in shared module.',
      '',
      '## Acceptance criteria',
      '- [x] AC1: No overflow verified: test',
      '',
      '## Steps',
      '- [x] Fix line 10',
      '',
    ].join('\n'),
  );
  f.git('add', '.');
  f.git('commit', '-m', 'fix: Fix Line 10 Overflow', '--date', `${dayIso(3)}T12:00:00Z`);

  // 1. Verify stats attributes Bug1 ONLY to Feat2 (hunk match on line 10, noise files README.md/Strings.resw ignored)
  const statsRes = f.run('stats', ['--json'], [], { omitPlan: true });
  assert.equal(statsRes.status, 0, statsRes.stderr);
  const statsData = JSON.parse(statsRes.stdout);
  assert.equal(statsData.escapedDefects.length, 1);
  assert.equal(statsData.escapedDefects[0].sourcePlan, 'docs/plans/FO-Plan-Feat2.plan.md');
  assert.equal(statsData.escapedDefects[0].defectRef, bugPlanRel);
  assert.deepEqual(statsData.escapedDefects[0].overlappingFiles, ['src/god.js']);

  // 2. Auto-lesson on review block -> pass + deduplication
  const blockRes = f.run('review', [
    bugPlanRel,
    '--agent',
    'Codex',
    '--verdict',
    'block',
    '--summary',
    'Missing negative boundary check',
  ], [], { omitPlan: true });
  assert.equal(blockRes.status, 0, blockRes.stderr);

  const passRes = f.run('review', [
    bugPlanRel,
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'Added negative boundary check and unit test',
  ], [], { omitPlan: true });
  assert.equal(passRes.status, 0, passRes.stderr);

  const lessonsPath = join(f.root, 'docs/lessons.md');
  assert.ok(existsSync(lessonsPath), 'docs/lessons.md should be auto-created on block->pass');
  const afterReviewLessons = readFileSync(lessonsPath, 'utf8');
  assert.match(afterReviewLessons, /review-blocker · docs\/plans\/FO-Plan-Bug1\.plan\.md \| Resolved review blocker \(Missing negative boundary check\): Added negative boundary check and unit test/);

  // Re-stamping the same pass review does not duplicate the lesson
  const passDup = f.run('review', [
    bugPlanRel,
    '--agent',
    'Codex',
    '--verdict',
    'pass',
    '--summary',
    'Added negative boundary check and unit test',
  ], [], { omitPlan: true });
  assert.equal(passDup.status, 0, passDup.stderr);
  assert.equal(readFileSync(lessonsPath, 'utf8'), afterReviewLessons);

  // 3. Auto-lesson on Bug plan close-out (done / ship) + deduplication
  const doneRes = f.run('done', [bugPlanRel], [], { omitPlan: true });
  assert.equal(doneRes.status, 0, doneRes.stderr);
  const afterDoneLessons = readFileSync(lessonsPath, 'utf8');
  assert.match(afterDoneLessons, /bug-fix · docs\/plans\/FO-Plan-Bug1\.plan\.md \| Guard line 10 against integer overflow in shared module\./);

  // Re-running done does not duplicate the bug-fix lesson
  const doneDup = f.run('done', [bugPlanRel], [], { omitPlan: true });
  assert.equal(doneDup.status, 0, doneDup.stderr);
  assert.equal(readFileSync(lessonsPath, 'utf8'), afterDoneLessons);

  // 4. recall searches docs/dev-workflow/ ([Doc]) and docs/architecture/ ([Blueprint])
  writeFileSync(
    join(f.root, 'docs/dev-workflow/setup-guide.md'),
    '# Setup Guide\n\nUse UniqueWorkflowDocToken for multi-repo sync.\n',
  );
  writeFileSync(
    join(f.root, 'docs/architecture/FO-Blueprint-Core.md'),
    '# Core Blueprint\n\nUse UniqueArchBlueprintToken for system boundaries.\n',
  );

  const recallDoc = f.run('recall', ['UniqueWorkflowDocToken'], [], { omitPlan: true });
  assert.equal(recallDoc.status, 0, recallDoc.stderr);
  assert.match(recallDoc.stdout, /\[Doc\] docs\/dev-workflow\/setup-guide\.md/);

  const recallBp = f.run('recall', ['UniqueArchBlueprintToken'], [], { omitPlan: true });
  assert.equal(recallBp.status, 0, recallBp.stderr);
  assert.match(recallBp.stdout, /\[Blueprint\] docs\/architecture\/FO-Blueprint-Core\.md/);
});

test('H1: dependsOn lint/resolution, ready --claim/--release, blueprint status, wave dependency gating, and map symbol outline', (t) => {
  const f = fixture(t, '', [], {
    tracker: 'local',
    requireReview: false,
  });

  rmSync(join(f.root, 'docs/plans/FO-Plan-Test.plan.md'));
  mkdirSync(join(f.root, 'src'), { recursive: true });
  writeFileSync(
    join(f.root, 'src/service.js'),
    [
      'export class AuthService {',
      '  login() {}',
      '}',
      'export async function verifyToken(token) {',
      '  return Boolean(token);',
      '}',
      'export const DEFAULT_TTL = 3600;',
    ].join('\n') + '\n',
  );

  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'Test');
  f.git('config', 'user.email', 'test@example.invalid');

  // 1. Scaffold blueprint and 2 dependent plans (Plan B depends on Plan A)
  const bpCreate = f.run('blueprint', ['Next Gen Auth'], [], { omitPlan: true });
  assert.equal(bpCreate.status, 0, bpCreate.stderr);
  const bpRel = 'docs/architecture/FO-Blueprint-Next-Gen-Auth.md';

  const newA = f.run(
    'new',
    [
      'Slice A Base',
      '--blueprint',
      bpRel,
      '--priority',
      'high',
      '--summary',
      'Base auth slice.',
      '--criteria',
      'AC1: Base works',
      '--steps',
      'Build base (AC1)',
      '--create',
      '--agent',
      'Gemini',
    ],
    [],
    { omitPlan: true },
  );
  assert.equal(newA.status, 0, newA.stderr);
  const planAFile = readdirSync(join(f.root, 'docs/plans')).find((n) => n.includes('Slice-A-Base'));
  const planARel = `docs/plans/${planAFile}`;

  const newB = f.run(
    'new',
    [
      'Slice B Dependent',
      '--blueprint',
      bpRel,
      '--depends-on',
      planAFile,
      '--summary',
      'Dependent auth slice.',
      '--criteria',
      'AC1: Dependent works',
      '--steps',
      'Build dependent (AC1)',
      '--create',
      '--agent',
      'Gemini',
    ],
    [],
    { omitPlan: true },
  );
  assert.equal(newB.status, 0, newB.stderr);
  const planBFile = readdirSync(join(f.root, 'docs/plans')).find((n) => n.includes('Slice-B-Dependent'));
  const planBRel = `docs/plans/${planBFile}`;

  f.git('add', '.');
  f.git('commit', '-m', 'chore: add blueprint and plans A & B');

  // 2. lint flags missing and circular dependencies
  const planBFull = join(f.root, planBRel);
  const planBOrig = readFileSync(planBFull, 'utf8');
  writeFileSync(
    planBFull,
    planBOrig.replace(`dependsOn: ${planAFile}`, 'dependsOn: FO-Plan-DoesNotExist.plan.md'),
  );
  const lintMissing = f.run('lint', [planBRel], [], { omitPlan: true });
  assert.notEqual(lintMissing.status, 0);
  assert.match(lintMissing.stdout + lintMissing.stderr, /dependsOn references missing plan/);

  // Create circular dependency A <-> B
  const planAFull = join(f.root, planARel);
  const planAOrig = readFileSync(planAFull, 'utf8');
  writeFileSync(planBFull, planBOrig);
  writeFileSync(
    planAFull,
    planAOrig.replace(/\n---\n/, `\ndependsOn: ${planBFile}\n---\n`),
  );
  const lintCycle = f.run('lint', [planARel], [], { omitPlan: true });
  assert.notEqual(lintCycle.status, 0);
  assert.match(lintCycle.stdout + lintCycle.stderr, /circular dependency/i);
  writeFileSync(planAFull, planAOrig);

  // 3. ready queue lists Plan A as ready and Plan B as blocked
  const ready1 = f.run('ready', ['--blueprint', bpRel, '--json'], [], { omitPlan: true });
  assert.equal(ready1.status, 0, ready1.stderr);
  const q1 = JSON.parse(ready1.stdout);
  assert.equal(q1.ready.length, 1);
  assert.equal(q1.ready[0].plan, planARel);
  assert.equal(q1.blocked.length, 1);
  assert.equal(q1.blocked[0].plan, planBRel);

  // 4. ready --claim stamps claimedBy/claimedAt on Plan A; another agent sees it as claimed
  const claimRes = f.run('ready', ['--claim', '--agent', 'Gemini', '--json'], [], { omitPlan: true });
  assert.equal(claimRes.status, 0, claimRes.stderr);
  const claimData = JSON.parse(claimRes.stdout);
  assert.equal(claimData.claimed, planARel);
  assert.equal(claimData.claimedBy, 'Gemini');

  const readyOther = f.run('ready', ['--agent', 'Codex', '--json'], [], { omitPlan: true });
  assert.equal(readyOther.status, 0, readyOther.stderr);
  const qOther = JSON.parse(readyOther.stdout);
  assert.equal(qOther.ready.length, 0);
  assert.equal(qOther.claimed.length, 1);
  assert.equal(qOther.claimed[0].claimedBy, 'Gemini');

  // Release claim on Plan A
  const releaseRes = f.run('ready', ['--release', planARel], [], { omitPlan: true });
  assert.equal(releaseRes.status, 0, releaseRes.stderr);
  assert.doesNotMatch(readFileSync(planAFull, 'utf8'), /^claimedBy:/m);

  // 5. wave --spawn --dry-run skips blocked Plan B and only targets Plan A
  const waveDry = f.run('wave', ['--spawn', '--dry-run'], [], { omitPlan: true });
  assert.equal(waveDry.status, 0, waveDry.stderr);
  assert.match(waveDry.stdout, /Skipping docs\/plans\/FO-Plan-Slice-B-Dependent.*\[blocked by:/);
  assert.match(waveDry.stdout, /\[dry-run\] 1 worktree target\(s\)/);

  // 6. blueprint status reports 0 done, 1 ready, 1 blocked
  const bpStatus1 = f.run('blueprint', ['status', bpRel, '--json'], [], { omitPlan: true });
  assert.equal(bpStatus1.status, 0, bpStatus1.stderr);
  const bps1 = JSON.parse(bpStatus1.stdout);
  assert.equal(bps1.counts.total, 2);
  assert.equal(bps1.counts.ready, 1);
  assert.equal(bps1.counts.blocked, 1);
  assert.equal(bps1.counts.done, 0);

  // Complete Plan A -> Plan B becomes ready!
  assert.equal(
    f.run('tick', [planARel, '1', '--verified', 'unit test'], [], { omitPlan: true }).status,
    0,
  );
  assert.equal(
    f.run('tick', [planARel, '1', '--verified', 'done'], [], { omitPlan: true }).status,
    0,
  );
  assert.equal(f.run('done', [planARel], [], { omitPlan: true }).status, 0);

  const ready2 = f.run('ready', ['--json'], [], { omitPlan: true });
  assert.equal(ready2.status, 0, ready2.stderr);
  const q2 = JSON.parse(ready2.stdout);
  assert.equal(q2.ready.length, 1);
  assert.equal(q2.ready[0].plan, planBRel);
  assert.equal(q2.blocked.length, 0);

  const bpStatus2 = f.run('blueprint', ['status', bpRel], [], { omitPlan: true });
  assert.equal(bpStatus2.status, 0, bpStatus2.stderr);
  assert.match(bpStatus2.stdout, /Slices: 2 total \(done: 1, in-progress: 0, ready: 1, blocked: 0\)/);
  assert.match(bpStatus2.stdout, /\[deps satisfied:/);

  // 7. map extracts symbols from src/service.js and scripts/ticket.mjs
  const mapJson = f.run('map', ['src/service.js', '--json'], [], { omitPlan: true });
  assert.equal(mapJson.status, 0, mapJson.stderr);
  const mapData = JSON.parse(mapJson.stdout);
  assert.equal(mapData.shownFiles, 1);
  assert.equal(mapData.files[0].file, 'src/service.js');
  const symNames = mapData.files[0].symbols.map((s) => s.name);
  assert.ok(symNames.includes('AuthService'));
  assert.ok(symNames.includes('verifyToken'));
  assert.ok(symNames.includes('DEFAULT_TTL'));

  const mapText = f.run('map', ['ticket.mjs', '--max', '1'], [], { omitPlan: true });
  assert.equal(mapText.status, 0, mapText.stderr);
  assert.match(mapText.stdout, /scripts\/ticket\.mjs/);
  assert.match(mapText.stdout, /\[command\] commands\.ready/);
  assert.match(mapText.stdout, /\[command\] commands\.map/);
});

test('I1: characterization of scripts/lib/* ESM modules, command surface parity, and sync --check --bundle-only', async (t) => {
  const mdLib = await import('./lib/markdown-plan.mjs');
  const invLib = await import('./lib/invariants-lint.mjs');
  const statsLib = await import('./lib/stats-lessons.mjs');
  const symLib = await import('./lib/symbols-map.mjs');

  // 1. markdown-plan.mjs exports & behavior
  const sampleDoc = '---\ntitle: Plan - Feature: Lib\n---\n# Lib\n\n## Summary\nHello lib.\n\n## Open questions\n- [ ] Question 1?\n\n## Acceptance criteria\n- [ ] AC1: First\n- [x] AC2: Second verified: ok\n';
  const body = mdLib.bodyOf(sampleDoc);
  assert.equal(mdLib.section(body, 'Summary'), 'Hello lib.');
  assert.equal(mdLib.countOpenQuestions(body), 1);
  const appended = mdLib.appendToSection(body, 'Summary', 'More text.');
  assert.match(mdLib.section(appended, 'Summary'), /Hello lib\.[\s\S]*More text\./);
  const cbs = mdLib.findCheckboxes(body);
  assert.equal(cbs.items.length, 3);
  assert.equal(mdLib.missingCheckboxes(body, body).length, 0);

  // 2. invariants-lint.mjs exports & behavior
  assert.equal(invLib.isTestFile('scripts/ticket.test.mjs'), true);
  assert.equal(invLib.isTestFile('scripts/ticket.mjs'), false);
  assert.equal(invLib.isIgnoredDiffPath('pnpm-lock.yaml', ['pnpm-lock.yaml', '*.min.js']), true);
  assert.equal(invLib.isIgnoredDiffPath('bundle.min.js', ['pnpm-lock.yaml', '*.min.js']), true);
  assert.equal(invLib.tailLines('a\nb\nc\n', 2), 'b\nc');
  assert.equal(invLib.percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(invLib.round1(1.26), 1.3);

  // 3. stats-lessons.mjs exports & behavior
  assert.equal(statsLib.parsePlanTypeFromMeta({ title: 'Plan - Refactor: Clean' }), 'Refactor');
  assert.equal(statsLib.parsePlanTypeFromMeta({ title: 'Debug - Bug: Crash' }), 'Bug');
  assert.ok(Number.isFinite(statsLib.parseIsoDayOrMs('2026-11-23')));
  assert.equal(statsLib.isNoiseFileForDefects('README.md'), true);
  assert.equal(statsLib.isNoiseFileForDefects('Strings.resw'), true);
  assert.equal(statsLib.isNoiseFileForDefects('src/core.js'), false);
  assert.equal(statsLib.rangesOverlap([[10, 20]], [[15, 25]]), true);
  assert.equal(statsLib.rangesOverlap([[10, 12]], [[20, 25]]), false);

  // 4. symbols-map.mjs exports & behavior
  assert.deepEqual(
    symLib.parseDependsOn({ meta: { dependsOn: 'PlanA.plan.md, PlanB.plan.md | ADW:KeyC' } }),
    ['PlanA.plan.md', 'PlanB.plan.md', 'ADW:KeyC'],
  );
  const libMap = symLib.collectRepoSymbolMap(dirname(scripts), { filter: 'scripts/lib/' });
  assert.equal(libMap.shownFiles, 4);

  // 5. workflow-manifest.json and sync.mjs --check --bundle-only .
  const manifest = JSON.parse(readFileSync(join(scripts, 'workflow-manifest.json'), 'utf8'));
  for (const modPath of [
    'scripts/lib/markdown-plan.mjs',
    'scripts/lib/invariants-lint.mjs',
    'scripts/lib/stats-lessons.mjs',
    'scripts/lib/symbols-map.mjs',
  ]) {
    assert.ok(manifest.copy.includes(modPath), `manifest.copy missing ${modPath}`);
  }

  const syncRes = spawnSync(
    process.execPath,
    [join(scripts, 'sync.mjs'), dirname(scripts), '--check', '--bundle-only'],
    { encoding: 'utf8' },
  );
  assert.equal(syncRes.status, 0, syncRes.stdout + syncRes.stderr);
});

test('J1: Spike plan type scaffolding, timebox/appetite defaults, Hypothesis lint, and stats classification', (t) => {
  const f = fixture(t, '', [], { tracker: 'local', requireReview: false });
  rmSync(f.plan);

  // 1. new --type Spike --timebox 4h defaults appetite to S and adds Hypothesis + Findings sections
  const spikeNew = f.run(
    'new',
    ['Eval Cache', '--type', 'Spike', '--timebox', '4h'],
    [],
    { omitPlan: true },
  );
  assert.equal(spikeNew.status, 0, spikeNew.stderr);
  const createdFile = readdirSync(join(f.root, 'docs/plans')).find((n) =>
    n.includes('Eval-Cache'),
  );
  assert.ok(createdFile, 'expected Spike plan file');
  const relPath = `docs/plans/${createdFile}`;
  const fullPath = join(f.root, relPath);
  const spikeText = readFileSync(fullPath, 'utf8');
  assert.match(spikeText, /^title: Plan - Spike: Eval Cache$/m);
  assert.match(spikeText, /^appetite: S$/m);
  assert.match(spikeText, /^timebox: 4h$/m);
  assert.match(spikeText, /^## Hypothesis$/m);
  assert.match(spikeText, /^## Findings & Recommendation$/m);
  assert.match(spikeText, /within 4h budget/);
  assert.match(spikeText, /Documented answer and go\/no-go recommendation/);

  // 2. lint rejects placeholder Hypothesis and warns when appetite is L
  const lintFail = f.run('lint', [relPath], [], { omitPlan: true });
  assert.notEqual(lintFail.status, 0);
  assert.match(lintFail.stderr + lintFail.stdout, /Hypothesis.*placeholder/);

  const populated = spikeText
    .replace('appetite: S', 'appetite: L')
    .replace(/<2-3 sentences:[^>]*>/, 'Evaluate cache latency vs memory.')
    .replace(/<Compacted research:[^>]*>/, 'Benchmarked local LRU.')
    .replace(/<Unresolved assumptions[^>]*>/, 'None')
    .replace(/<Hypothesis:[^>]*>/, 'LRU cache reduces repeat reads below 5ms.')
    .replace(/<Pre-mortem:[^>]*>/, 'Prototype discarded if p95 exceeds 10ms.')
    .replace(/<What this plan deliberately[^>]*>/, 'Production rollout.');
  writeFileSync(fullPath, populated);

  const lintWarn = f.run('lint', [relPath, '--json'], [], { omitPlan: true });
  assert.equal(lintWarn.status, 0, lintWarn.stderr);
  const warnParsed = JSON.parse(lintWarn.stdout);
  assert.ok(
    warnParsed.warnings.some((w) => /Spike plans should be time-boxed with appetite S or M/.test(w)),
    `Expected Spike appetite warning, got: ${JSON.stringify(warnParsed.warnings)}`,
  );

  // Fixing appetite -> lint --strict passes cleanly
  writeFileSync(fullPath, populated.replace('appetite: L', 'appetite: S'));
  const lintClean = f.run('lint', [relPath, '--strict'], [], { omitPlan: true });
  assert.equal(lintClean.status, 0, lintClean.stderr);

  // 3. stats classifies Spike under byType.Spike
  const statsRes = f.run('stats', ['--json'], [], { omitPlan: true });
  assert.equal(statsRes.status, 0, statsRes.stderr);
  const stats = JSON.parse(statsRes.stdout);
  assert.equal(stats.byType.Spike, 1);
  assert.equal(stats.escapedDefects.length, 0);
});

test('listFilesRel traverses directory junctions/symlinks without EISDIR', async (t) => {
  const { listFilesRel } = await import('./lib/invariants-lint.mjs');
  const f = fixture(t, 'ticket: local://FO:FO-Plan-Test\n', [], {
    tracker: 'local',
    requireReview: false,
    invariants: {
      mirrorDirs: [['.agents/skills', '.claude/skills']],
    },
  });

  const targetSkill = join(f.root, '.agents/skills/ext-skill');
  mkdirSync(targetSkill, { recursive: true });
  writeFileSync(join(targetSkill, 'SKILL.md'), 'same content\n');
  mkdirSync(join(f.root, '.claude/skills'), { recursive: true });
  symlinkSync(
    targetSkill,
    join(f.root, '.claude/skills/ext-skill'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  assert.deepEqual(listFilesRel(join(f.root, '.claude/skills')), ['ext-skill/SKILL.md']);

  const checkRes = f.run('check');
  assert.equal(checkRes.status, 0, checkRes.stderr);
});

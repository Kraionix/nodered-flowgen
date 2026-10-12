/**
 * Milestone-1 acceptance (`recon/V1-SPEC-flowgen.md` §3), end to end through the CLI — and the
 * second example that followed it (`examples/dashboard/`).
 *
 * The projects are the committed examples, not fixtures written by the test: nothing about them
 * is authored here except the target URL, which comes from the environment, so the run proves the
 * example a user would copy actually works. `examples/acceptance/` is the milestone-1 flow set
 * (subflow parameters, a shared config node, a three-output switch, a group, a dashboard page);
 * `examples/dashboard/` is the dashboard-heavy, two-target project, including one target that can
 * never be reached.
 *
 * The lifecycle is the acceptance script itself:
 *
 * 1. `palette pull` — the instance's palette becomes a committed snapshot (`palettes/local.json`,
 *    plus generated types, both ignored by git in the example);
 * 2. `types gen` — the augmentations the config is type-checked against;
 * 3. `validate` — offline, no instance involved;
 * 4. `plan` then `apply` — the deploy, with a receipt;
 * 5. runtime probe `GET /flowgen/scale?x=7` → `21`: 7 × the `factor` override of 3. A flow that
 *    parsed but lost the override, or wired the wrong ports, cannot answer this;
 * 6. `palette check` — the snapshot still describes the instance;
 * 7. `rollback` — the instance is empty again.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../src/cli/index.ts';
import { startNodeRed, waitFor, type NodeRedInstance } from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTANCE = path.join(REPO_ROOT, 'examples', 'acceptance');
const DASHBOARD = path.join(REPO_ROOT, 'examples', 'dashboard');

let instance: NodeRedInstance;
let env: Record<string, string>;
let artifacts: readonly string[];

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in one of the example projects, against the disposable instance. */
async function cliIn(project: string, ...argv: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv: [...argv, '--cwd', project, '--url', instance.url],
    cwd: project,
    env,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

/** One admin API read, for the assertions that need the instance's own view of itself. */
async function readJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`${instance.url}${pathname}`, {
    headers: { 'node-red-api-version': 'v2', authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}` },
  });
  assert.ok(response.ok, `${pathname} answered ${response.status}`);
  return (await response.json()) as T;
}

/** The acceptance example is the one most tests use. */
function cli(...argv: string[]): Promise<CliRun> {
  return cliIn(ACCEPTANCE, ...argv);
}

/**
 * Like `cliIn`, but without `--url`.
 *
 * `--all-targets` and `--url` are alternatives by design (the flag already names every configured
 * target), so a fan-out has to reach the instance through the project's own config — which is what
 * `FLOWGEN_TARGET_URL` is for, exactly as a user would do it.
 */
async function cliConfigured(project: string, ...argv: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv: [...argv, '--cwd', project],
    cwd: project,
    env,
    stdout: (chunk: string) => {
      stdout += chunk;
    },
    stderr: (chunk: string) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

/**
 * Empties the instance.
 *
 * The examples are two projects sharing one disposable instance, and the acceptance run leaves
 * `orders`/`scale` deployed. The dashboard example creates a `ui_base` of its own, so it has to
 * start from an instance that is actually empty — otherwise it is comparing itself with the other
 * project's dashboard, and its plan refuses an id it does not own (correctly).
 */
async function resetInstance(): Promise<void> {
  const state = await readJson<{ rev: string }>('/flows');
  const response = await fetch(`${instance.url}/flows`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'node-red-api-version': 'v2',
      'node-red-deployment-type': 'full',
      authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}`,
    },
    body: JSON.stringify({ flows: [], rev: state.rev }),
  });
  assert.ok(response.ok, `could not empty the instance: ${response.status}`);
}

before(async () => {
  instance = await startNodeRed({
    auth: 'password',
    users: [{ username: 'flowgen', password: 's3cret', permissions: '*' }],
    // Dashboard widgets are in the flow set, so the palette has to come from an instance that
    // actually has the module installed - which is the point of pulling rather than assuming.
    userModules: ['node-red-dashboard'],
  });
  // The examples read `FLOWGEN_TARGET_URL` at module scope, the way a user's config does, and a
  // config file sees the real process environment — not the `env` map the CLI resolves *tokens*
  // through. So the URL is exported here, exactly as the example's README tells a user to.
  process.env['FLOWGEN_TARGET_URL'] = instance.url;
  env = { FLOWGEN_TARGET_TOKEN: await instance.token() };

  // The example is a project, not a fixture: it keeps its lockfile, snapshot, generated types
  // and receipts between runs. Start every acceptance run from the source-only state.
  artifacts = [ACCEPTANCE, DASHBOARD].flatMap((project) => [
    path.join(project, 'palettes'),
    path.join(project, '.flowgen'),
    path.join(project, '.flowgen.lock.json'),
  ]);
  await Promise.all(artifacts.map((entry) => rm(entry, { recursive: true, force: true })));
  await mkdir(ACCEPTANCE, { recursive: true });
  await mkdir(DASHBOARD, { recursive: true });
});

after(async () => {
  await instance?.stop();
  delete process.env['FLOWGEN_TARGET_URL'];
  await Promise.all(artifacts.map((entry) => rm(entry, { recursive: true, force: true })));
});

test('the acceptance run: pull, type, validate, plan, apply, probe, check, roll back', async () => {
  const pulled = await cli('palette', 'pull');
  assert.equal(pulled.code, 0, pulled.stderr);
  const snapshot = JSON.parse(await readFile(path.join(ACCEPTANCE, 'palettes', 'local.json'), 'utf8')) as {
    contentHash: string;
    types: Record<string, unknown>;
  };
  assert.ok(snapshot.types['ui_gauge'], 'the pulled palette covers the user-installed module');
  assert.ok(snapshot.types['subflow:scale'] === undefined, 'an inline subflow is not a palette type');

  const generated = await cli('types', 'gen');
  assert.equal(generated.code, 0, generated.stderr);
  assert.match(generated.stdout, /written/);

  const validated = await cli('validate');
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);
  assert.doesNotMatch(validated.stdout, /error /);

  const planned = await cli('plan');
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /create-container orders/);
  assert.match(planned.stdout, /create-container scale/);
  assert.match(planned.stdout, /palette: the instance matches the pinned snapshot/);

  const applied = await cli('apply');
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /receipt: \.flowgen\/receipts\/local-/);

  const answered = await waitFor(async () => {
    const response = await fetch(`${instance.url}/flowgen/scale?x=7`);
    return response.status === 200 && (await response.text()) === '21';
  });
  assert.equal(answered, true, 'the deployed subflow instance multiplies by its overridden factor');
  assert.doesNotMatch(instance.log(), /Waiting for missing types/);

  const checked = await cli('palette', 'check');
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);

  const rolled = await cli('rollback', '--last');
  assert.equal(rolled.code, 0, rolled.stdout + rolled.stderr);

  const state = (await fetch(`${instance.url}/flows`, {
    headers: { 'node-red-api-version': 'v2', authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}` },
  }).then((response) => response.json())) as { flows: unknown[] };
  assert.deepEqual(state.flows, [], 'the acceptance run left the instance as it found it');
});

test('the same sources deploy a second time without touching the unowned instance state', async () => {
  // Somebody else's work, deployed between the two runs.
  const foreign = [{ id: 'foreign_tab', type: 'tab', label: 'Someone else', disabled: false, info: '' }];
  const before_ = (await fetch(`${instance.url}/flows`, {
    headers: { 'node-red-api-version': 'v2', authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}` },
  }).then((response) => response.json())) as { rev: string };
  await fetch(`${instance.url}/flows`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'node-red-api-version': 'v2',
      'node-red-deployment-type': 'full',
      authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}`,
    },
    body: JSON.stringify({ flows: foreign, rev: before_.rev }),
  });

  const applied = await cli('apply');
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /leave {2}foreign_tab/);

  const state = (await fetch(`${instance.url}/flows`, {
    headers: { 'node-red-api-version': 'v2', authorization: `Bearer ${env['FLOWGEN_TARGET_TOKEN']}` },
  }).then((response) => response.json())) as { flows: { id: string }[] };
  const ids = state.flows.map((entry) => entry.id);
  assert.ok(ids.includes('foreign_tab'), 'a container we do not own survives');
  assert.ok(ids.includes('orders') && ids.includes('scale'));

  // The lockfile is how the next run knows what is ours.
  const lockfile = JSON.parse(await readFile(path.join(ACCEPTANCE, '.flowgen.lock.json'), 'utf8')) as {
    owned: Record<string, { containers: string[] }>;
  };
  assert.deepEqual(lockfile.owned['local']?.containers, ['orders', 'scale']);
});

test('regenerating the artifacts changes nothing: the committed snapshot is a fixed point', async () => {
  const beforeRun = await readFile(path.join(ACCEPTANCE, 'palettes', 'local.json'), 'utf8');
  const pulled = await cli('palette', 'pull');
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.match(pulled.stdout, /snapshot unchanged/);
  assert.equal(await readFile(path.join(ACCEPTANCE, 'palettes', 'local.json'), 'utf8'), beforeRun);

  const generated = await cli('types', 'gen', '--check');
  assert.equal(generated.code, 0, generated.stderr);
  assert.match(generated.stdout, /generated types are current/);
});

/**
 * The dashboard example, run the way a user would.
 *
 * Two things here are not covered by the acceptance run above: a dashboard-shaped flow set (two
 * pages, a template body, theme and site, an `order` on every level) and a *fan-out* over more
 * than one target, one of which cannot be reached.
 */
test('the dashboard example: two pages, a template body, and a probe that renders rows', async () => {
  await resetInstance();

  const pulled = await cliIn(DASHBOARD, 'palette', 'pull');
  assert.equal(pulled.code, 0, pulled.stderr);
  const generated = await cliIn(DASHBOARD, 'types', 'gen');
  assert.equal(generated.code, 0, generated.stderr);
  const validated = await cliIn(DASHBOARD, 'validate');
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);

  const planned = await cliIn(DASHBOARD, 'plan', '--target', 'local');
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /create-container report_api/);
  assert.match(planned.stdout, /create-container ops_ui/);

  const applied = await cliIn(DASHBOARD, 'apply', '--target', 'local');
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);

  const answered = await waitFor(async () => {
    const response = await fetch(`${instance.url}/flowgen/report`);
    return response.status === 200 && (await response.text()).includes('<td>cpu</td>');
  });
  assert.equal(answered, true, 'the deployed function renders the rows the example promises');

  // The dashboard tree, as the instance holds it: two pages in order, a group per page, and a
  // template whose body is the multi-line string the source declared — quotes, newlines and all.
  const state = (await readJson<{ flows: Record<string, unknown>[] }>('/flows')).flows;
  const byId = new Map(state.map((entry) => [String(entry['id']), entry]));
  assert.deepEqual(
    state.filter((entry) => entry['type'] === 'ui_tab').map((entry) => [entry['name'], entry['order']]),
    [['Overview', 1], ['Detail', 2]],
  );
  assert.equal(byId.get('summary')?.['tab'], 'overview');
  assert.equal(byId.get('report')?.['tab'], 'detail');
  assert.equal(byId.get('base')?.['theme'], 'dark');
  const base = byId.get('base') ?? {};
  assert.equal((base['site'] as { name?: string } | undefined)?.name, 'Ops console');
  // The dashboard client keeps its grid geometry only when `site.sizes` is there and then reads it
  // while applying the theme, so a site without it renders a blank page.
  assert.equal((base['site'] as { sizes?: { sy?: number } } | undefined)?.sizes?.sy, 48);
  assert.equal(byId.get('report_table')?.['group'], 'report');

  const template = String(byId.get('report_table')?.['format'] ?? '');
  assert.match(template, /^<table class="report">\n/);
  assert.match(template, /ng-repeat="row in msg\.payload"/);
  assert.match(template, /\n<\/table>$/);

  // What is deployed is a fixed point of our own reader: exported, read back and compared, the
  // two sides are identical. That is the property `diff` exists to state.
  await writeFile(path.join(DASHBOARD, '.tmp-remote.json'), JSON.stringify(state), 'utf8');
  const same = await cliIn(DASHBOARD, 'diff', '--from', '.tmp-remote.json', '--to', '@target:local', '--check');
  assert.equal(same.code, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /no differences/);

  const rolled = await cliIn(DASHBOARD, 'rollback', '--last');
  assert.equal(rolled.code, 0, rolled.stdout + rolled.stderr);
});

test('--all-targets reports the unreachable staging host and still plans the local one', async () => {
  const fanOut = await cliConfigured(DASHBOARD, 'plan', '--all-targets', '--no-palette-check');
  assert.equal(fanOut.code, 4, 'the exit code is the highest of the targets, so failures are not hidden');
  assert.match(fanOut.stdout, /2 target\(s\): 1 failed \(staging\)/);
  assert.match(fanOut.stdout, /-- target "staging"/);
  assert.match(fanOut.stdout, /-- target "local"/);
  assert.match(fanOut.stdout, /create-container ops_ui/, 'the reachable target is still planned in full');

  // And the single-target form is unaffected: one instance, one plan, exit 0.
  const single = await cliConfigured(DASHBOARD, 'plan', '--target', 'local');
  assert.equal(single.code, 0, single.stdout + single.stderr);
});

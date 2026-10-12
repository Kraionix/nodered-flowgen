/**
 * Milestone-1 acceptance (`recon/V1-SPEC-flowgen.md` §3), end to end through the CLI.
 *
 * The project is the committed example in `examples/acceptance/` — a subflow with typed
 * parameters and an instance override, a shared config node, a three-output switch, a group and
 * a dashboard page. Nothing about it is written by the test except the target URL, which comes
 * from the environment, so the run proves the example a user would copy actually works.
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
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../src/cli/index.ts';
import { startNodeRed, waitFor, type NodeRedInstance } from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = path.join(REPO_ROOT, 'examples', 'acceptance');

let instance: NodeRedInstance;
let env: Record<string, string>;
let artifacts: readonly string[];

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in the example project, against the disposable instance. */
async function cli(...argv: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv: [...argv, '--cwd', EXAMPLE, '--url', instance.url],
    cwd: EXAMPLE,
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

before(async () => {
  instance = await startNodeRed({
    auth: 'password',
    users: [{ username: 'flowgen', password: 's3cret', permissions: '*' }],
    // Dashboard widgets are in the flow set, so the palette has to come from an instance that
    // actually has the module installed - which is the point of pulling rather than assuming.
    userModules: ['node-red-dashboard'],
  });
  env = { FLOWGEN_TARGET_TOKEN: await instance.token() };

  // The example is a project, not a fixture: it keeps its lockfile, snapshot, generated types
  // and receipts between runs. Start every acceptance run from the source-only state.
  artifacts = [
    path.join(EXAMPLE, 'palettes'),
    path.join(EXAMPLE, '.flowgen'),
    path.join(EXAMPLE, '.flowgen.lock.json'),
  ];
  await Promise.all(artifacts.map((entry) => rm(entry, { recursive: true, force: true })));
  await mkdir(EXAMPLE, { recursive: true });
});

after(async () => {
  await instance?.stop();
  await Promise.all(artifacts.map((entry) => rm(entry, { recursive: true, force: true })));
});

test('the acceptance run: pull, type, validate, plan, apply, probe, check, roll back', async () => {
  const pulled = await cli('palette', 'pull');
  assert.equal(pulled.code, 0, pulled.stderr);
  const snapshot = JSON.parse(await readFile(path.join(EXAMPLE, 'palettes', 'local.json'), 'utf8')) as {
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
  const lockfile = JSON.parse(await readFile(path.join(EXAMPLE, '.flowgen.lock.json'), 'utf8')) as {
    owned: Record<string, { containers: string[] }>;
  };
  assert.deepEqual(lockfile.owned['local']?.containers, ['orders', 'scale']);
});

test('regenerating the artifacts changes nothing: the committed snapshot is a fixed point', async () => {
  const beforeRun = await readFile(path.join(EXAMPLE, 'palettes', 'local.json'), 'utf8');
  const pulled = await cli('palette', 'pull');
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.match(pulled.stdout, /snapshot unchanged/);
  assert.equal(await readFile(path.join(EXAMPLE, 'palettes', 'local.json'), 'utf8'), beforeRun);

  const generated = await cli('types', 'gen', '--check');
  assert.equal(generated.code, 0, generated.stderr);
  assert.match(generated.stdout, /generated types are current/);
});

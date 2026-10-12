/**
 * The CLI, end to end, against a real instance.
 *
 * Everything here goes through `runCli` — the same entry point the `flowgen` binary uses — so the
 * test asserts the contract a user gets: exit codes, captured output, and the files the commands
 * leave behind. The lifecycle is exercised in the order a project would meet it:
 *
 * `palette pull` → `types gen` → `validate` → `plan` → `apply` → probe → `apply` (no-op) →
 * `palette check` → `rollback`.
 *
 * The runtime probe is what makes this more than an HTTP smoke test: the flow that was written
 * by `apply` is asked for an answer, and only a deployed, wired, parsed flow set can give one.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCli } from '../../src/cli/index.ts';
import { startNodeRed, waitFor, type NodeRedInstance } from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_ENTRY = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href;

let instance: NodeRedInstance;
let project: string;
let env: Record<string, string>;

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(...argv: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
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

before(async () => {
  instance = await startNodeRed({
    auth: 'password',
    users: [{ username: 'flowgen', password: 's3cret', permissions: '*' }],
  });
  env = { NR_TOKEN: await instance.token() };
  project = await mkdtemp(path.join(os.tmpdir(), 'flowgen-cli-it-'));

  // The profile carries the instance, so `palette pull` and `palette check` need no flags, while
  // `validate` and `types gen` stay offline against the committed snapshot.
  await writeFile(
    path.join(project, 'flowgen.config.ts'),
    `import { defineConfig, defineFlowSet } from ${JSON.stringify(PACKAGE_ENTRY)};

export default defineConfig({
  flowSet: defineFlowSet((f) => {
    const tab = f.flow('main', { label: 'Main', info: 'Written by the CLI integration test.' });
    const ping = tab.node('http in', { key: 'ping', url: '/flowgen/ping', method: 'get', name: 'GET /flowgen/ping' });
    const answer = tab.node('function', {
      key: 'answer',
      name: 'answer',
      func: 'msg.payload = "flowgen ok";\\nreturn msg;',
      outputs: 1,
    });
    const reply = tab.node('http response', { key: 'reply', statusCode: '', headers: {} });
    tab.chain(ping, answer, reply);
  }),
  palette: {
    default: 'local',
    profiles: { local: { url: ${JSON.stringify(instance.url)}, tokenEnv: 'NR_TOKEN' } },
  },
  targets: { local: { url: ${JSON.stringify(instance.url)}, tokenEnv: 'NR_TOKEN' } },
});
`,
    'utf8',
  );
});

after(async () => {
  await instance?.stop();
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

/** The lockfile as it stands on disk; several tests assert on what import did and did not record. */
async function readLockfile(): Promise<{ ids: Record<string, string>; owned: Record<string, { containers: string[] }> }> {
  return JSON.parse(await readFile(path.join(project, '.flowgen.lock.json'), 'utf8')) as {
    ids: Record<string, string>;
    owned: Record<string, { containers: string[] }>;
  };
}

test('palette pull writes a snapshot and a second pull is a no-op', async () => {
  const first = await cli('palette', 'pull');
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /pulled \d+ types from \d+ node sets \(live /);
  assert.match(first.stdout, /snapshot written: palettes\/local\.json/);

  const snapshot = JSON.parse(await readFile(path.join(project, 'palettes', 'local.json'), 'utf8')) as { contentHash: string };
  assert.match(snapshot.contentHash, /^sha256:/);

  const second = await cli('palette', 'pull');
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /snapshot unchanged/);
});

test('types gen commits the augmentations and --check agrees', async () => {
  const generated = await cli('types', 'gen');
  assert.equal(generated.code, 0, generated.stderr);

  const index = await readFile(path.join(project, 'palettes', 'local.d', 'index.d.ts'), 'utf8');
  assert.match(index, /reference path=/);

  const checked = await cli('types', 'gen', '--check');
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /generated types are current/);
});

test('validate, plan and apply report the same plan the deploy executes', async () => {
  const validated = await cli('validate');
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);

  const planned = await cli('plan', '--json');
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout) as {
    exitCode: number;
    plan: { operations: { kind: string; id: string }[] };
    palette: { contentHash: string; liveHash: string };
  };
  assert.equal(plan.exitCode, 0);
  assert.deepEqual(
    plan.plan.operations.map((operation) => `${operation.kind}:${operation.id}`),
    ['create-container:main'],
  );
  assert.equal(plan.palette.liveHash, plan.palette.contentHash, 'the instance matches the pinned palette');

  const applied = await cli('apply', '--receipt', '.flowgen/receipts/deploy.json');
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /create-container main/);
  assert.match(applied.stdout, /receipt: \.flowgen\/receipts\/deploy\.json/);

  const lockfile = JSON.parse(await readFile(path.join(project, '.flowgen.lock.json'), 'utf8')) as {
    owned: Record<string, { containers: string[] }>;
    ids: Record<string, string>;
  };
  assert.deepEqual(lockfile.owned['local']?.containers, ['main']);
  assert.equal(lockfile.ids['tab:main'], 'main');

  const answered = await waitFor(async () => {
    const response = await fetch(`${instance.url}/flowgen/ping`);
    return response.status === 200 && (await response.text()) === 'flowgen ok';
  });
  assert.equal(answered, true, 'the flow the CLI deployed answers at runtime');
});

test('a second apply changes nothing and --expect-rev refuses a moved revision', async () => {
  // `--no-receipt` on purpose: a no-op deploy must not overwrite the receipt that can undo the
  // real one, and this is the case where that would matter.
  const again = await cli('apply', '--no-receipt');
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /the instance already matched the sources/);

  const conflict = await cli('apply', '--expect-rev', 'not-the-revision');
  assert.equal(conflict.code, 3, conflict.stdout + conflict.stderr);
  assert.match(conflict.stdout, /deploy\/version-mismatch/);
  assert.match(conflict.stdout, /refusing to deploy to "local": revision moved/);
});

test('palette check passes against the instance it was pulled from', async () => {
  const checked = await cli('palette', 'check');
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /palette matches/);
});

test('rollback puts the instance back exactly as the receipt recorded it', async () => {
  const receipts = await readdir(path.join(project, '.flowgen', 'receipts'));
  assert.deepEqual(receipts, ['deploy.json'], 'only the deploy that wrote one has a receipt');

  const rolled = await cli('rollback', '--last');
  assert.equal(rolled.code, 0, rolled.stdout + rolled.stderr);
  assert.match(rolled.stdout, /rolled back target "local"/);
  assert.match(rolled.stdout, /restored 0 entries/);

  const state = await fetch(`${instance.url}/flows`, {
    headers: { 'node-red-api-version': 'v2', authorization: `Bearer ${env['NR_TOKEN']}` },
  }).then((response) => response.json() as Promise<{ flows: unknown[] }>);
  assert.deepEqual(state.flows, [], 'the instance is empty again, as it was before the deploy');

  const gone = await fetch(`${instance.url}/flowgen/ping`);
  assert.notEqual(gone.status, 200, 'the endpoint the rollback removed no longer answers');
});

/**
 * `import`: the other direction. It runs here rather than in its own spec because the palette it
 * needs is the one this project already pulled, and because `--url` needs something deployed to
 * read back — the flow set `apply` wrote a moment ago.
 */
test('import turns an existing flow file into sources and records the ids it had', async () => {
  const fixture = path.join(REPO_ROOT, 'test', 'fixtures', 'flows-recon-demo.json');
  const imported = await cli('import', '--from', fixture, '--out', 'src/imported.ts', '--json');
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);

  const envelope = JSON.parse(imported.stdout) as {
    exitCode: number;
    report: { printed: number; untyped: number; comments: number; dropped: number };
    ids: { written: boolean; count: number; conflicts: string[] };
    sources: { path: string; status: string }[];
  };
  assert.equal(envelope.exitCode, 0);
  assert.equal(envelope.report.untyped, 0, 'the instance the palette came from knows every type here');
  assert.equal(envelope.report.dropped, 0);
  assert.deepEqual(envelope.sources, [{ path: 'src/imported.ts', status: 'written' }]);
  assert.equal(envelope.ids.written, true);

  const source = await readFile(path.join(project, 'src', 'imported.ts'), 'utf8');
  assert.match(source, /export default defineFlowSet\(\(f\) => \{/);
  assert.match(source, /const scale_x_factor = f\.subflow\(/);
  assert.match(source, /\.instance\(scale_x_factor, \{/);
  assert.match(source, /broker: unused_autoconnect_off/, 'a reference is a handle, not an id');

  const lockfile = await readLockfile();
  assert.equal(lockfile.ids['tab:recon_generated'], 'tab_1', 'the id the file had is the id it keeps');
  assert.equal(lockfile.ids['subflow:scale_x_factor'], 'scale_sf_1');
  assert.deepEqual(lockfile.owned['local']?.containers, ['main'], 'importing claims no ownership');

  const again = await cli('import', '--from', fixture, '--out', 'src/imported.ts');
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /1 file\(s\) unchanged/);
  assert.match(again.stdout, /ids already recorded/);
});

test('import leaves a lockfile key that already means something else alone', async () => {
  const lockfilePath = path.join(project, '.flowgen.lock.json');
  const before = JSON.parse(await readFile(lockfilePath, 'utf8')) as { ids: Record<string, string> };
  before.ids['tab:recon_generated'] = 'somebody_elses_tab';
  await writeFile(lockfilePath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const fixture = path.join(REPO_ROOT, 'test', 'fixtures', 'flows-recon-demo.json');
  const imported = await cli('import', '--from', fixture, '--out', 'src/imported.ts', '--json');
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  const envelope = JSON.parse(imported.stdout) as { ids: { conflicts: string[] } };
  assert.deepEqual(envelope.ids.conflicts, ['tab:recon_generated']);

  const after = await readLockfile();
  assert.equal(after.ids['tab:recon_generated'], 'somebody_elses_tab', 'the existing meaning is preserved');
});

test('import --ids writes the id record where it is asked to', async () => {
  const fixture = path.join(REPO_ROOT, 'test', 'fixtures', 'flows-recon-demo.json');
  const imported = await cli('import', '--from', fixture, '--ids', 'src/imported.ids.json');
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  assert.match(imported.stdout, /ids written to src\/imported\.ids\.json/);
  assert.match(imported.stdout, /const scale_x_factor = f\.subflow\(/, 'the sources go to stdout by default');

  const fragment = JSON.parse(await readFile(path.join(project, 'src', 'imported.ids.json'), 'utf8')) as {
    lockVersion: number;
    ids: Record<string, string>;
  };
  assert.equal(fragment.lockVersion, 1);
  assert.equal(fragment.ids['tab:recon_generated'], 'tab_1');
});

test('import --url reads back what the instance is running', async () => {
  // Nothing is deployed at this point in the lifecycle: the rollback above emptied the instance,
  // so deploy the project again and import it back.
  const applied = await cli('apply', '--no-receipt');
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);

  const imported = await cli('import', '--url', instance.url, '--token-env', 'NR_TOKEN', '--out', 'src/deployed.ts', '--json');
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  const envelope = JSON.parse(imported.stdout) as { materialised: { filled: number }; ids: { conflicts: string[] } };
  assert.deepEqual(envelope.ids.conflicts, [], 'the ids of the deployed tab are already ours');

  const source = await readFile(path.join(project, 'src', 'deployed.ts'), 'utf8');
  assert.match(source, /const main = f\.flow\("main", \{ label: "Main"/);
  assert.match(source, /http_in|get_flowgen_ping/, 'the deployed nodes are in the sources');
});

test('import refuses what it cannot import, and says why', async () => {
  const missing = await cli('import');
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /nothing to import/);

  await writeFile(path.join(project, 'not-a-flow.json'), '{"flow": true}', 'utf8');
  const notAFlow = await cli('import', '--from', 'not-a-flow.json');
  assert.equal(notAFlow.code, 2, notAFlow.stdout + notAFlow.stderr);
  assert.match(notAFlow.stderr, /is not a flow file/);

  const both = await cli('import', '--from', 'not-a-flow.json', '--url', instance.url);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--from and --url are alternatives/);
});

test('validate reports what it could not check, and checks the target when it has one', async () => {
  const offline = await cli('validate', '--json');
  assert.equal(offline.code, 0, offline.stdout + offline.stderr);
  const cached = JSON.parse(offline.stdout) as {
    report: { skipped: { name: string; missing: string[] }[]; ran: string[] };
  };
  assert.deepEqual(
    cached.report.skipped,
    [{ name: 'target', missing: ['liveInstance'] }],
    'a validator that needs the instance says so instead of quietly checking less',
  );
  assert.ok(cached.report.ran.includes('credentials'), 'the offline checks still run');

  const live = await cli('validate', '--live', '--url', instance.url, '--token-env', 'NR_TOKEN', '--json');
  assert.equal(live.code, 0, live.stdout + live.stderr);
  const checked = JSON.parse(live.stdout) as {
    exitCode: number;
    report: { skipped: { name: string }[]; ran: string[] };
  };
  assert.deepEqual(checked.report.skipped, [], 'nothing is skipped once the instance is reachable');
  assert.ok(checked.report.ran.includes('target'), 'so the target check actually runs');
  assert.equal(checked.exitCode, 0, 'this instance has every type the project uses');
});

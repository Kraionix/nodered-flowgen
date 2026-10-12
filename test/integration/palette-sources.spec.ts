/**
 * The claim under test: for one installation, every palette source produces the *same*
 * content — a live instance, the same instance scanned from disk, and a snapshot file written
 * from either. This is what makes `palette pull` a cache rather than a fork in the data.
 *
 * The instance is disposable (own user directory, own flows file, ephemeral port) and is never
 * the developer's, because the filesystem source has to see the very same installation the
 * live source is serving.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describePalette } from '../../src/palette/snapshot.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import { liveHttpSource } from '../../src/palette/sources/liveHttp.ts';
import { fileSnapshotSource, writeSnapshotFile } from '../../src/palette/sources/snapshot.ts';
import { PaletteSourceError } from '../../src/palette/sources/source.ts';
import { startNodeRed, type NodeRedInstance } from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_NODES_DIR = path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes');

let instance: NodeRedInstance;

before(async () => {
  instance = await startNodeRed({
    auth: 'password',
    users: [
      { username: 'flowgen', password: 's3cret', permissions: '*' },
      { username: 'reader', password: 'readonly', permissions: 'read' },
    ],
    userModules: ['node-red-dashboard'],
  });
});

after(async () => {
  await instance?.stop();
});

test('the live source reads the whole palette with an admin token', async () => {
  const snapshot = await liveHttpSource({ url: instance.url, token: await instance.token() }).load();
  const summary = describePalette(snapshot);

  assert.equal(summary.typeCount, 71, '50 core types plus 21 dashboard types');
  assert.equal(summary.nodeSetCount, 58);
  assert.deepEqual(summary.modules, [
    { module: 'node-red', version: snapshot.nodeRedVersion ?? '', typeCount: 50 },
    { module: 'node-red-dashboard', version: '3.6.6', typeCount: 21 },
  ]);

  const junction = snapshot.types['junction'];
  assert.equal(junction?.synthetic, true, 'junction has no editor registration and is synthesised');
  assert.equal(junction?.nodeSet, 'node-red/junction');
  assert.equal(snapshot.types['ui_gauge']?.refs['group']?.targets[0], 'ui_group');
});

test('a read-scope token is enough to read a palette', async () => {
  const snapshot = await liveHttpSource({ url: instance.url, token: await instance.token('reader') }).load();
  assert.equal(describePalette(snapshot).typeCount, 71);
});

test('without a token an authenticated instance refuses the palette', async () => {
  await assert.rejects(
    () => liveHttpSource({ url: instance.url }).load(),
    (error: unknown) => error instanceof PaletteSourceError && error.code === 'unauthorized',
  );
});

test('the filesystem source reproduces the live palette byte for byte', async () => {
  const live = await liveHttpSource({ url: instance.url, token: await instance.token() }).load();
  const disk = await filesystemSource({ coreNodesDir: CORE_NODES_DIR, userDir: instance.userDir }).load();

  assert.equal(disk.contentHash, live.contentHash);
  assert.deepEqual(disk.nodeSets, live.nodeSets);
});

test('a snapshot file written from the live palette reloads to the same content', async () => {
  const live = await liveHttpSource({ url: instance.url, token: await instance.token() }).load();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowgen-palettes-'));
  const file = path.join(dir, 'local.json');

  assert.equal((await writeSnapshotFile(file, live)).status, 'written');
  assert.equal((await writeSnapshotFile(file, live)).status, 'unchanged');

  const reloaded = await fileSnapshotSource(file, { id: 'local' }).load();
  assert.equal(reloaded.contentHash, live.contentHash);
  assert.equal(reloaded.provenance.kind, 'live', 'provenance records where the palette came from');
});

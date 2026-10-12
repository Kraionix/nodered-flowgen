/**
 * Committed palette fixtures: the raw `GET /nodes` pair, re-assembled offline.
 *
 * The fixtures exist because the HTML extractor is the most fragile part of the palette layer.
 * A fixture that stored only the *resulting snapshot* could not catch a parsing regression — it
 * would be compared with itself. These store the bytes the instance actually sent, so the tests
 * below run the real assembly path (`snapshotFromNodeList`, the same function `liveHttpSource`
 * calls) with no instance present, and compare the resulting content hash with the manifest.
 *
 * Regeneration is `node test/fixtures/palettes/capture.ts` (see its header). Capturing the same
 * instance again must produce identical bytes; if it does not, the fixture directory is stale and
 * the capture is what changed it, deliberately.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { emitTypes } from '../../src/palette/codegen/emitTypes.ts';
import type { PaletteType } from '../../src/palette/model.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import { snapshotFromNodeList } from '../../src/palette/sources/liveHttp.ts';
import { serializePaletteSnapshot, type PaletteSnapshot } from '../../src/palette/snapshot.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'palettes');
const CORE_NODES = path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes');

interface ManifestEntry {
  readonly name: string;
  readonly nodeRedVersion: string | null;
  readonly contentHash: string;
  readonly typeCount: number;
  readonly nodeSetCount: number;
  readonly coreOnly: boolean;
  readonly capturedFrom: string;
  readonly note: string;
}

let fixtures: readonly ManifestEntry[];
const assembled = new Map<string, PaletteSnapshot>();

async function assemble(entry: ManifestEntry): Promise<PaletteSnapshot> {
  const cached = assembled.get(entry.name);
  if (cached !== undefined) return cached;

  const json = await readFile(path.join(FIXTURES, `${entry.name}.nodes.json`), 'utf8');
  const html = await readFile(path.join(FIXTURES, `${entry.name}.nodes.html`), 'utf8');
  const snapshot = snapshotFromNodeList(json, html, {
    kind: 'snapshot',
    url: null,
    userDir: null,
    nodeModulesDirs: null,
  });
  assembled.set(entry.name, snapshot);
  return snapshot;
}

before(async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: ManifestEntry[] };
  fixtures = manifest.fixtures;
  assert.ok(fixtures.length >= 2, 'at least the 5.0.7 and 5.0.8 core fixtures are committed');
});

test('every fixture assembles to the palette its manifest records', async () => {
  for (const entry of fixtures) {
    const snapshot = await assemble(entry);
    assert.equal(snapshot.contentHash, entry.contentHash, `${entry.name} no longer assembles to its recorded hash`);
    assert.equal(Object.keys(snapshot.types).length, entry.typeCount, `${entry.name} type count`);
    assert.equal(snapshot.nodeSets.length, entry.nodeSetCount, `${entry.name} node set count`);
    assert.equal(snapshot.nodeRedVersion, entry.nodeRedVersion, `${entry.name} Node-RED version`);
    assert.equal(snapshot.provenance.kind, 'snapshot');
  }
});

test('assembly is deterministic: the same bytes give the same snapshot, twice', async () => {
  for (const entry of fixtures) {
    const json = await readFile(path.join(FIXTURES, `${entry.name}.nodes.json`), 'utf8');
    const html = await readFile(path.join(FIXTURES, `${entry.name}.nodes.html`), 'utf8');
    const first = snapshotFromNodeList(json, html, { kind: 'snapshot', url: null, userDir: null, nodeModulesDirs: null });
    const second = snapshotFromNodeList(json, html, { kind: 'snapshot', url: null, userDir: null, nodeModulesDirs: null });
    assert.equal(serializePaletteSnapshot(first), serializePaletteSnapshot(second));
  }
});

test('a fixture is a usable palette: it types, validates and generates', async () => {
  const snapshot = await assemble(fixtures.find((entry) => entry.name === 'core-5.0.8') as ManifestEntry);
  assert.ok(snapshot.types['inject'], 'inject is extracted from the editor bundle');
  assert.ok(snapshot.types['junction'], 'junction has no editor registration and is synthesised');
  assert.equal(snapshot.types['junction']?.synthetic, true);
  assert.equal(snapshot.types['mqtt-broker']?.category, 'config');

  const files = emitTypes(snapshot, { directory: 'generated' });
  assert.ok(files.length > 1, 'one file per module plus an index');
  const moduleFiles = files.map((file) => file.path).filter((file) => !file.endsWith('index.d.ts'));
  // The file name carries the module version, which reads `5.0.8-git` inside a checkout and
  // `5.0.8` from a tarball — the fixture records whichever it was captured with.
  assert.equal(moduleFiles.length, 1, 'core types land in a single module file');
  assert.match(moduleFiles[0] as string, /^generated\/node-red@5\.0\.8(-git)?\.d\.ts$/);
});

test('the two core fixtures agree on the core node types across 5.0.7 and 5.0.8', async () => {
  const [older, newer] = await Promise.all([
    assemble(fixtures.find((entry) => entry.name === 'core-5.0.7') as ManifestEntry),
    assemble(fixtures.find((entry) => entry.name === 'core-5.0.8') as ManifestEntry),
  ]);

  assert.deepEqual(Object.keys(older.types), Object.keys(newer.types), 'the same core node types are registered');
  assert.notEqual(older.contentHash, newer.contentHash, 'but the definitions carry different versions');
  assert.equal(older.types['inject']?.version, '5.0.7');
  assert.equal(newer.types['inject']?.version, '5.0.8-git');
});

test('the installed installation still matches the fixture captured from it', async (t) => {
  if (!existsSync(CORE_NODES)) {
    t.skip('node_modules/@node-red/nodes is not installed');
    return;
  }

  // Only the core module is compared: the fixture is core-only on purpose, while the
  // installation also carries whatever user modules the checkout happens to have.
  const installed = await filesystemSource({ coreNodesDir: CORE_NODES }).load();
  const entry = fixtures.find((candidate) => installed.nodeRedVersion?.startsWith((candidate.nodeRedVersion ?? '').replace(/-git$/, '')));
  if (entry === undefined) {
    t.skip(`no fixture was captured from Node-RED ${installed.nodeRedVersion ?? 'unknown'}`);
    return;
  }

  // This is the "regeneration is a no-op" guard: reading the same installation through a
  // different source must produce the same declarations. Versions are excluded from the
  // comparison because the installation reports `5.0.8-git` inside a checkout and `5.0.8` from a
  // tarball, and the fixture records whichever it was captured with.
  const fixture = await assemble(entry);
  const coreIds = Object.keys(fixture.types).sort();
  const installedCore = Object.fromEntries(
    Object.entries(installed.types).filter(([, type]) => type.module === 'node-red'),
  );
  assert.deepEqual(coreIds, Object.keys(installedCore).sort(), 'the fixture covers every core type');

  const differing = coreIds.filter((id) => shapeOf(fixture.types[id] as PaletteType) !== shapeOf(installedCore[id] as PaletteType));
  assert.deepEqual(differing, [], 'the extractor reads the same declarations out of both sources');
});

/** Everything about a type except its version, which depends on how Node-RED was installed. */
function shapeOf(type: PaletteType): string {
  const { version, ...rest } = type;
  void version;
  return JSON.stringify(rest);
}

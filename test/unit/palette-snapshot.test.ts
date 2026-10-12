import assert from 'node:assert/strict';
import test from 'node:test';

import { paletteProperty, paletteType, type PaletteModule, type PaletteProvenance } from '../../src/palette/model.ts';
import {
  createPaletteSnapshot,
  describePalette,
  diffPalette,
  hashPaletteContent,
  parsePaletteSnapshot,
  recomputeContentHash,
  samePaletteContent,
  serializePaletteSnapshot,
  type PaletteSnapshotInput,
} from '../../src/palette/snapshot.ts';
import { unwrapOrThrow } from '../../src/result.ts';

/** Parsed JSON of a snapshot document, for asserting on the wire format itself. */
function documentOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function typesOf(document: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return document['types'] as Record<string, Record<string, unknown>>;
}

const LIVE: PaletteProvenance = { kind: 'live', url: 'http://127.0.0.1:1890', userDir: null, nodeModulesDirs: null };

function sampleInput(overrides: Partial<PaletteSnapshotInput> = {}): PaletteSnapshotInput {
  return {
    nodeRedVersion: '5.0.8',
    provenance: LIVE,
    modules: [
      { id: 'node-red', name: 'node-red', version: '5.0.8', types: ['inject', 'mqtt-broker'] },
      { id: 'node-red-dashboard', name: 'node-red-dashboard', version: '3.6.6', types: ['ui_gauge'] },
    ] satisfies PaletteModule[],
    types: [
      paletteType('ui_gauge', {
        module: 'node-red-dashboard',
        setVersion: '3.6.6',
        category: 'dashboard',
        paletteLabel: 'gauge',
        color: 'rgb(119, 198, 204)',
        icon: 'ui_gauge.png',
        align: 'right',
        inputs: 1,
        outputs: 0,
        defaults: {
          name: paletteProperty({ value: '' }),
          group: paletteProperty({ type: 'ui_group', required: true }),
          min: paletteProperty({ value: 0, required: true, dynamic: true }),
        },
        dynamics: { inputs: false, outputs: false, paletteLabel: false, category: false, defaults: ['min'] },
      }),
      paletteType('inject', {
        module: 'node-red',
        setVersion: '5.0.8',
        category: 'common',
        paletteLabel: 'inject',
        color: '#a6bbcf',
        icon: 'inject.svg',
        align: 'right',
        inputs: 0,
        outputs: 1,
        defaults: {
          name: paletteProperty({ value: '' }),
          topic: paletteProperty({ value: '' }),
          once: paletteProperty({ value: false }),
          onceDelay: paletteProperty({ value: 0.1 }),
        },
      }),
      paletteType('mqtt-broker', {
        module: 'node-red',
        setVersion: '5.0.8',
        category: 'config',
        paletteLabel: 'mqtt-broker',
        color: '#3FADB5',
        icon: 'bridge.svg',
        defaults: {
          name: paletteProperty({ value: '' }),
          broker: paletteProperty({ value: 'localhost' }),
          port: paletteProperty({ value: 1883, required: true }),
        },
        credentials: { user: paletteProperty({ value: '' }), password: paletteProperty({ value: '' }) },
      }),
    ],
    ...overrides,
  };
}

test('creation sorts modules and types so extraction order cannot leak into the hash', () => {
  const forward = createPaletteSnapshot(sampleInput());
  const reversed = createPaletteSnapshot({
    ...sampleInput(),
    modules: [...sampleInput().modules].reverse(),
    types: [...sampleInput().types].reverse(),
  });

  assert.equal(forward.contentHash, reversed.contentHash);
  assert.deepEqual(Object.keys(forward.types), ['inject', 'mqtt-broker', 'ui_gauge']);
  assert.deepEqual(forward.modules.map((module) => module.id), ['node-red', 'node-red-dashboard']);
  assert.deepEqual(forward.modules[0]?.types, ['inject', 'mqtt-broker']);
});

test('the hash is stable across runs and recomputable from the parsed snapshot', () => {
  const first = createPaletteSnapshot(sampleInput());
  const second = createPaletteSnapshot(sampleInput());

  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(recomputeContentHash(first), first.contentHash);
  assert.deepEqual(first.contentHash, hashPaletteContent(second));
  assert.equal(samePaletteContent(first, second), true);
});

test('declaration order of defaults is part of the content', () => {
  const base = sampleInput();
  const inject = base.types.find((type) => type.id === 'inject') as ReturnType<typeof paletteType>;
  const reordered = createPaletteSnapshot({
    ...base,
    types: [
      ...base.types.filter((type) => type.id !== 'inject'),
      paletteType('inject', {
        ...inject,
        defaults: {
          name: inject.defaults['name'] as never,
          once: inject.defaults['once'] as never,
          topic: inject.defaults['topic'] as never,
          onceDelay: inject.defaults['onceDelay'] as never,
        },
      }),
    ],
  });

  assert.notEqual(createPaletteSnapshot(base).contentHash, reordered.contentHash);
});

test('snapshot serialisation round-trips byte for byte', () => {
  const snapshot = createPaletteSnapshot(sampleInput());
  const text = serializePaletteSnapshot(snapshot);
  const parsed = unwrapOrThrow(parsePaletteSnapshot(text));

  assert.equal(serializePaletteSnapshot(parsed), text);
  assert.deepEqual(parsed, snapshot);
  assert.equal(parsed.contentHash, snapshot.contentHash);
  assert.ok(text.endsWith('}\n'), 'the file ends with a newline');
});

test('optional fields are omitted, not written as nulls, and survive the round trip', () => {
  const text = serializePaletteSnapshot(createPaletteSnapshot(sampleInput()));
  const document = documentOf(text);

  const inject = typesOf(document)['inject'] as Record<string, unknown>;
  assert.equal(Object.hasOwn(inject, 'isConfig'), false);
  assert.equal(Object.hasOwn(inject, 'credentials'), false);
  assert.equal(Object.hasOwn(inject, 'refs'), false);
  assert.equal(Object.hasOwn(inject, 'align'), true);

  const gauge = typesOf(document)['ui_gauge'] as Record<string, unknown>;
  const refs = gauge['refs'] as Record<string, { kind: string; targets: unknown }>;
  assert.deepEqual(refs['group'], { kind: 'one', targets: ['ui_group'] });
});

test('snapshots are frozen: cross-layer sharing cannot mutate the hash contract', () => {
  const snapshot = createPaletteSnapshot(sampleInput());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.types), true);
  assert.equal(Object.isFrozen(snapshot.types['inject']), true);
  assert.throws(() => {
    (snapshot.types['inject'] as { id: string }).id = 'tampered';
  }, TypeError);
});

test('provenance differences do not change the content hash', () => {
  const live = createPaletteSnapshot(sampleInput());
  const fromDisk = createPaletteSnapshot({
    ...sampleInput(),
    provenance: { kind: 'filesystem', url: null, userDir: '/tmp/nrcheck', nodeModulesDirs: ['/tmp/extra'] },
  });

  assert.equal(live.contentHash, fromDisk.contentHash);
  assert.notEqual(serializePaletteSnapshot(live), serializePaletteSnapshot(fromDisk));
  const parsed = unwrapOrThrow(parsePaletteSnapshot(serializePaletteSnapshot(fromDisk)));
  assert.equal(parsed.provenance.kind, 'filesystem');
  assert.deepEqual(parsed.provenance.nodeModulesDirs, ['/tmp/extra']);
});

test('parse reports every structural problem with a path and a code', () => {
  const broken = parsePaletteSnapshot('{"schemaVersion": 1, "modules": [], "types": {"inject": 42}}');
  assert.equal(broken.ok, false);
  if (broken.ok) return;

  assert.deepEqual(
    broken.errors.map((issue) => issue.code),
    ['invalid-field'],
  );
  assert.equal(broken.errors[0]?.path, 'types.inject');
});

test('parse rejects unparsable input, unknown schema versions and missing hashes', () => {
  const notJson = parsePaletteSnapshot('nonsense');
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.errors[0]?.code, 'invalid-json');

  const future = parsePaletteSnapshot('{"schemaVersion": 99}');
  assert.equal(future.ok, false);
  if (!future.ok) {
    assert.ok(future.errors.some((issue) => issue.code === 'unsupported-schema'));
  }

  const noHash = createPaletteSnapshot(sampleInput());
  const document = JSON.parse(serializePaletteSnapshot(noHash)) as Record<string, unknown>;
  delete document['contentHash'];
  const result = parsePaletteSnapshot(JSON.stringify(document));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((issue) => issue.code === 'missing-field' && issue.path === 'contentHash'));
  }
});

test('a hand-edited snapshot is detected unless verification is explicitly disabled', () => {
  const snapshot = createPaletteSnapshot(sampleInput());
  const document = documentOf(serializePaletteSnapshot(snapshot));
  const types = typesOf(document);
  types['inject'] = { ...(types['inject'] as Record<string, unknown>), outputs: 3 };
  const text = JSON.stringify(document, null, 2);

  const strict = parsePaletteSnapshot(text);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.deepEqual(
      strict.errors.map((issue) => issue.code),
      ['content-hash-mismatch'],
    );
  }

  const lenient = parsePaletteSnapshot(text, { verifyContentHash: false });
  assert.equal(lenient.ok, true);
  if (lenient.ok) assert.equal(lenient.value.types['inject']?.outputs, 3);
});

test('module/type attribution mismatches are reported', () => {
  const snapshot = createPaletteSnapshot(sampleInput());
  const document = documentOf(serializePaletteSnapshot(snapshot));
  const types = typesOf(document);
  types['inject'] = { ...(types['inject'] as Record<string, unknown>), module: 'node-red-dashboard' };
  const text = JSON.stringify(document, null, 2);

  const result = parsePaletteSnapshot(text, { verifyContentHash: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.every((issue) => issue.code === 'module-membership-mismatch'));
    assert.equal(result.errors.length, 2, 'both directions of the inconsistency are reported');
  }
});

test('a type whose key and id disagree is rejected', () => {
  const snapshot = createPaletteSnapshot(sampleInput());
  const document = documentOf(serializePaletteSnapshot(snapshot));
  const types = typesOf(document);
  types['inject'] = { ...(types['inject'] as Record<string, unknown>), id: 'injectt' };

  const result = parsePaletteSnapshot(JSON.stringify(document), { verifyContentHash: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0]?.path, 'types.inject.id');
});

test('diffPalette classifies additions, removals, changes and module versions', () => {
  const before = createPaletteSnapshot(sampleInput());
  const after = createPaletteSnapshot({
    ...sampleInput(),
    nodeRedVersion: '5.1.0',
    modules: [
      { id: 'node-red', name: 'node-red', version: '5.1.0', types: ['inject', 'function'] },
      { id: 'node-red-dashboard', name: 'node-red-dashboard', version: '3.6.6', types: ['ui_gauge'] },
      { id: 'node-red-node-sqlite', name: 'node-red-node-sqlite', version: '1.0.4', types: ['sqlite'] },
    ],
    types: [
      ...sampleInput().types.filter((type) => type.id !== 'mqtt-broker'),
      paletteType('sqlite', { module: 'node-red-node-sqlite', setVersion: '1.0.4', category: 'storage' }),
    ],
  });

  const diff = diffPalette(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added, ['sqlite']);
  assert.deepEqual(diff.removed, ['mqtt-broker']);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.modules, [
    { id: 'node-red', kind: 'version', from: '5.0.8', to: '5.1.0' },
    { id: 'node-red-node-sqlite', kind: 'added', from: null, to: '1.0.4' },
  ]);

  assert.equal(diffPalette(before, before).identical, true);
});

test('diffPalette explains what changed inside a type', () => {
  const before = createPaletteSnapshot(sampleInput());
  const inject = before.types['inject'] as ReturnType<typeof paletteType>;
  const after = createPaletteSnapshot({
    ...sampleInput(),
    types: [
      ...sampleInput().types.filter((type) => type.id !== 'inject'),
      paletteType('inject', {
        ...inject,
        setVersion: '5.1.0',
        outputs: 2,
        defaults: {
          ...inject.defaults,
          repeat: paletteProperty({ value: '' }),
        },
      }),
    ],
  });

  const diff = diffPalette(before, after);
  assert.deepEqual(diff.changed.map((change) => change.id), ['inject']);
  const reasons = diff.changed[0]?.reasons.join(' | ') ?? '';
  assert.match(reasons, /setVersion 5\.0\.8 → 5\.1\.0/);
  assert.match(reasons, /outputs 1 → 2/);
  assert.match(reasons, /defaults: added repeat/);
});

test('describePalette summarises counts per module', () => {
  const summary = describePalette(createPaletteSnapshot(sampleInput()));
  assert.equal(summary.typeCount, 3);
  assert.equal(summary.moduleCount, 2);
  assert.equal(summary.nodeRedVersion, '5.0.8');
  assert.deepEqual(summary.modules, [
    { id: 'node-red', version: '5.0.8', typeCount: 2 },
    { id: 'node-red-dashboard', version: '3.6.6', typeCount: 1 },
  ]);
});

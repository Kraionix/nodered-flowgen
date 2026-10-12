import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paletteProperty,
  paletteType,
  type PaletteNodeSet,
  type PaletteProvenance,
} from '../../src/palette/model.ts';
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

function nodeSet(id: string, name: string, module: string, version: string, types: string[]): PaletteNodeSet {
  return { id, name, module, version, enabled: true, local: false, user: false, types };
}

function sampleInput(overrides: Partial<PaletteSnapshotInput> = {}): PaletteSnapshotInput {
  return {
    nodeRedVersion: '5.0.8',
    provenance: LIVE,
    nodeSets: [
      nodeSet('node-red/inject', 'inject', 'node-red', '5.0.8', ['inject']),
      nodeSet('node-red/mqtt', 'mqtt', 'node-red', '5.0.8', ['mqtt-broker']),
      nodeSet('node-red-dashboard/ui_gauge', 'ui_gauge', 'node-red-dashboard', '3.6.6', ['ui_gauge']),
      // `junction` is registered by the runtime without an editor palette entry: the node
      // set exists, the type definition does not.
      nodeSet('node-red/junction', 'junction', 'node-red', '5.0.8', ['junction']),
    ],
    types: [
      paletteType('ui_gauge', {
        module: 'node-red-dashboard',
        nodeSet: 'node-red-dashboard/ui_gauge',
        version: '3.6.6',
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
        nodeSet: 'node-red/inject',
        version: '5.0.8',
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
        nodeSet: 'node-red/mqtt',
        version: '5.0.8',
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
      paletteType('junction', {
        module: 'node-red',
        nodeSet: 'node-red/junction',
        version: '5.0.8',
        synthetic: true,
      }),
    ],
    ...overrides,
  };
}

test('creation sorts node sets and types so extraction order cannot leak into the hash', () => {
  const base = sampleInput();
  const forward = createPaletteSnapshot(base);
  const reversed = createPaletteSnapshot({
    ...base,
    nodeSets: [...base.nodeSets].reverse(),
    types: [...base.types].reverse(),
  });

  assert.equal(forward.contentHash, reversed.contentHash);
  assert.deepEqual(Object.keys(forward.types), ['inject', 'junction', 'mqtt-broker', 'ui_gauge']);
  assert.deepEqual(
    forward.nodeSets.map((entry) => entry.id),
    ['node-red-dashboard/ui_gauge', 'node-red/inject', 'node-red/junction', 'node-red/mqtt'],
  );
  assert.deepEqual(forward.nodeSets[1]?.types, ['inject']);
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
  const types = typesOf(document);

  const inject = types['inject'] as Record<string, unknown>;
  assert.equal(Object.hasOwn(inject, 'isConfig'), false);
  assert.equal(Object.hasOwn(inject, 'credentials'), false);
  assert.equal(Object.hasOwn(inject, 'refs'), false);
  assert.equal(Object.hasOwn(inject, 'synthetic'), false);
  assert.equal(Object.hasOwn(inject, 'align'), true);
  assert.equal(inject['nodeSet'], 'node-red/inject');

  const gauge = types['ui_gauge'] as Record<string, unknown>;
  assert.deepEqual(gauge['refs'], { group: { kind: 'one', targets: ['ui_group'] } });

  const junction = types['junction'] as Record<string, unknown>;
  assert.equal(junction['synthetic'], true);
  assert.equal(Object.hasOwn(junction, 'defaults'), false);

  const nodeSets = document['nodeSets'] as Record<string, unknown>[];
  assert.equal(Object.hasOwn(nodeSets[0] as object, 'local'), false, 'flags that are false stay out of the file');
});

test('a type whose node set id repeats its module name omits the redundant field', () => {
  const snapshot = createPaletteSnapshot({
    ...sampleInput(),
    nodeSets: [...sampleInput().nodeSets, nodeSet('flowgen:inline', 'inline', 'flowgen:inline', '0.0.0', ['helper'])],
    types: [...sampleInput().types, paletteType('helper', { module: 'flowgen:inline', version: '1.0.0' })],
  });
  const text = serializePaletteSnapshot(snapshot);
  assert.equal(Object.hasOwn(typesOf(documentOf(text))['helper'] as object, 'nodeSet'), false);
  assert.equal(unwrapOrThrow(parsePaletteSnapshot(text)).types['helper']?.nodeSet, 'flowgen:inline');
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
  const broken = parsePaletteSnapshot('{"schemaVersion": 1, "nodeSets": [], "types": {"inject": 42}}');
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

  const document = documentOf(serializePaletteSnapshot(createPaletteSnapshot(sampleInput())));
  delete document['contentHash'];
  const result = parsePaletteSnapshot(JSON.stringify(document));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((issue) => issue.code === 'missing-field' && issue.path === 'contentHash'));
  }
});

test('a hand-edited snapshot is detected unless verification is explicitly disabled', () => {
  const document = documentOf(serializePaletteSnapshot(createPaletteSnapshot(sampleInput())));
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
  const document = documentOf(serializePaletteSnapshot(createPaletteSnapshot(sampleInput())));
  const types = typesOf(document);
  types['inject'] = { ...(types['inject'] as Record<string, unknown>), module: 'node-red-dashboard' };

  const result = parsePaletteSnapshot(JSON.stringify(document), { verifyContentHash: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.every((issue) => issue.code === 'module-membership-mismatch'));
    assert.deepEqual(
      result.errors.map((issue) => issue.path),
      ['types.inject.module'],
    );
  }
});

test('a type attributed to a node set that does not list it is reported', () => {
  const document = documentOf(serializePaletteSnapshot(createPaletteSnapshot(sampleInput())));
  const nodeSets = document['nodeSets'] as Record<string, unknown>[];
  const injectSet = nodeSets.find((entry) => entry['id'] === 'node-red/inject') as Record<string, unknown>;
  injectSet['types'] = [];

  const result = parsePaletteSnapshot(JSON.stringify(document), { verifyContentHash: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.errors.map((issue) => issue.path),
      ['nodeSets.node-red/inject.types'],
    );
  }
});

test('a type whose key and id disagree is rejected', () => {
  const document = documentOf(serializePaletteSnapshot(createPaletteSnapshot(sampleInput())));
  const types = typesOf(document);
  types['inject'] = { ...(types['inject'] as Record<string, unknown>), id: 'injectt' };

  const result = parsePaletteSnapshot(JSON.stringify(document), { verifyContentHash: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0]?.path, 'types.inject.id');
});

test('diffPalette classifies additions, removals, changes and node set versions', () => {
  const before = createPaletteSnapshot(sampleInput());
  const base = sampleInput();
  const after = createPaletteSnapshot({
    ...base,
    nodeRedVersion: '5.1.0',
    nodeSets: [
      nodeSet('node-red/inject', 'inject', 'node-red', '5.1.0', ['inject']),
      nodeSet('node-red-node-sqlite/sqlite', 'sqlite', 'node-red-node-sqlite', '1.0.4', ['sqlite']),
      nodeSet('node-red-dashboard/ui_gauge', 'ui_gauge', 'node-red-dashboard', '3.6.6', ['ui_gauge']),
      nodeSet('node-red/junction', 'junction', 'node-red', '5.1.0', ['junction']),
    ],
    types: [
      ...base.types.filter((type) => type.id !== 'mqtt-broker' && type.id !== 'inject'),
      paletteType('inject', {
        ...(base.types.find((type) => type.id === 'inject') as ReturnType<typeof paletteType>),
        version: '5.1.0',
      }),
      paletteType('sqlite', {
        module: 'node-red-node-sqlite',
        nodeSet: 'node-red-node-sqlite/sqlite',
        version: '1.0.4',
        category: 'storage',
      }),
    ],
  });

  const diff = diffPalette(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added, ['sqlite']);
  assert.deepEqual(diff.removed, ['mqtt-broker']);
  // Only `inject` changes at the type level: a node set version bump alone does not alter
  // the type record, so it is reported through `diff.nodeSets` instead.
  assert.deepEqual(diff.changed.map((change) => change.id), ['inject']);
  assert.deepEqual(diff.nodeSets, [
    { id: 'node-red/inject', kind: 'version', from: '5.0.8', to: '5.1.0' },
    { id: 'node-red/junction', kind: 'version', from: '5.0.8', to: '5.1.0' },
    { id: 'node-red/mqtt', kind: 'removed', from: '5.0.8', to: null },
    { id: 'node-red-node-sqlite/sqlite', kind: 'added', from: null, to: '1.0.4' },
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
        version: '5.1.0',
        outputs: 2,
        defaults: { ...inject.defaults, repeat: paletteProperty({ value: '' }) },
      }),
    ],
  });

  const diff = diffPalette(before, after);
  assert.deepEqual(diff.changed.map((change) => change.id), ['inject']);
  const reasons = diff.changed[0]?.reasons.join(' | ') ?? '';
  assert.match(reasons, /version 5\.0\.8 → 5\.1\.0/);
  assert.match(reasons, /outputs 1 → 2/);
  assert.match(reasons, /defaults: added repeat/);
});

test('describePalette summarises counts per npm module', () => {
  const summary = describePalette(createPaletteSnapshot(sampleInput()));
  assert.equal(summary.typeCount, 4);
  assert.equal(summary.nodeSetCount, 4);
  assert.equal(summary.nodeRedVersion, '5.0.8');
  assert.deepEqual(summary.modules, [
    { module: 'node-red', version: '5.0.8', typeCount: 3 },
    { module: 'node-red-dashboard', version: '3.6.6', typeCount: 1 },
  ]);
});

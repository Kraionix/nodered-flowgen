import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';

import { emitEntries, emitFlowSet, emitNode } from '../../src/emit/flowJson.ts';
import { parseFlowSetText } from '../../src/import/fromFlowJson.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
import type { FlowSet, Node } from '../../src/model/entities.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    icon: 'inject.svg',
    inputs: 0,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      topic: paletteProperty({ value: '' }),
      payload: paletteProperty({ value: '' }),
      payloadType: paletteProperty({ value: 'str' }),
    },
  }),
  'switch': paletteType('switch', {
    module: 'node-red',
    nodeSet: 'node-red/switch',
    inputs: 1,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), property: paletteProperty({ value: 'payload' }) },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883 }) },
  }),
  debug: paletteType('debug', {
    module: 'node-red',
    nodeSet: 'node-red/debug',
    icon: 'debug.svg',
    inputs: 1,
    outputs: 0,
    showLabel: false,
    defaults: { name: paletteProperty({ value: '' }), active: paletteProperty({ value: true }) },
  }),
};

function emptyFlowSet(): FlowSet {
  return { subflows: [], configs: [], flows: [], loose: [], modules: {} };
}

test('a node is written in the editor\'s key order', () => {
  const node: Node = {
    id: 'inject_1',
    type: 'inject',
    z: 'tab_1',
    g: 'group_1',
    disabled: true,
    props: { known: { name: 'Start', payload: 'go' }, extras: { vendorField: 7 } },
    geometry: { x: 120, y: 80 },
    wires: [['fn_1']],
    info: 'note',
  };

  const entry = emitNode(node, { palette: PALETTE });
  assert.deepEqual(Object.keys(entry), [
    'id',
    'type',
    'z',
    'd',
    'g',
    'name',
    'payload',
    'vendorField',
    'x',
    'y',
    'wires',
    'info',
  ]);
  assert.deepEqual(entry['wires'], [['fn_1']]);
  assert.equal(entry['d'], true);
});

test('declared defaults keep palette order, undeclared properties keep theirs', () => {
  const entry = emitNode(
    {
      id: 'inject_1',
      type: 'inject',
      props: { known: { payloadType: 'num', payload: 1, name: 'n' }, extras: { zz: 1, aa: 2 } },
      geometry: { x: 0, y: 0 },
      wires: [[]],
    },
    { palette: PALETTE },
  );
  assert.deepEqual(Object.keys(entry), ['id', 'type', 'name', 'payload', 'payloadType', 'zz', 'aa', 'x', 'y', 'wires']);
});

test('config nodes carry neither coordinates nor wires', () => {
  const flowSet: FlowSet = {
    ...emptyFlowSet(),
    configs: [
      {
        id: 'broker_1',
        type: 'mqtt-broker',
        props: { known: { name: 'local', port: 1883 }, extras: {} },
      },
    ],
  };
  const [entry] = emitEntries(normalizeFlowSet(flowSet, { palette: PALETTE }), { palette: PALETTE });
  assert.deepEqual(entry, { id: 'broker_1', type: 'mqtt-broker', name: 'local', port: 1883 });
});

test('`l` is written only when it differs from the node default', () => {
  const base: Node = { id: 'd1', type: 'debug', props: { known: {}, extras: {} }, geometry: { x: 0, y: 0 }, wires: [] };
  assert.equal(emitNode({ ...base, showLabel: false }, { palette: PALETTE })['l'], undefined);
  assert.equal(emitNode({ ...base, showLabel: true }, { palette: PALETTE })['l'], true);
  assert.equal(
    emitNode({ ...base, icon: 'custom.svg' }, { palette: PALETTE })['icon'],
    'custom.svg',
    'an icon different from the palette default is written',
  );
  assert.equal(
    emitNode({ ...base, icon: 'node-red/debug.svg' }, { palette: PALETTE })['icon'],
    undefined,
    'the palette default icon is not written back',
  );
  assert.equal(emitNode({ ...base, icon: 'custom.svg' }, { palette: PALETTE })['icon'], 'custom.svg');
});

test('dimensions are written only when requested', () => {
  const node: Node = {
    id: 'n1',
    type: 'inject',
    props: { known: {}, extras: {} },
    geometry: { x: 10, y: 20, w: 96, h: 30 },
    wires: [[]],
  };
  assert.equal(emitNode(node, { palette: PALETTE })['w'], undefined);
  assert.equal(emitNode(node, { palette: PALETTE, dimensions: true })['w'], 96);
});

test('a tab, its group and its nodes are emitted in a stable order', () => {
  const flowSet: FlowSet = {
    subflows: [],
    configs: [],
    modules: { 'node-red-dashboard': '3.6.6' },
    loose: [],
    flows: [
      {
        id: 'tab_1',
        label: 'Orders',
        info: '',
        groups: [
          { id: 'group_1', name: 'KPI', z: 'tab_1', geometry: { x: 0, y: 0, w: 200, h: 100 } },
        ],
        nodes: [
          {
            id: 'inject_1',
            type: 'inject',
            z: 'tab_1',
            g: 'group_1',
            props: { known: { name: '' }, extras: {} },
            geometry: { x: 100, y: 100 },
            wires: [['debug_1']],
          },
          {
            id: 'debug_1',
            type: 'debug',
            z: 'tab_1',
            g: 'group_1',
            props: { known: { name: '' }, extras: {} },
            geometry: { x: 300, y: 100 },
            wires: [],
          },
        ],
        configs: [],
      },
    ],
  };

  const entries = emitEntries(normalizeFlowSet(flowSet, { palette: PALETTE }), { palette: PALETTE });
  assert.deepEqual(
    entries.map((entry) => entry['type']),
    ['global-config', 'tab', 'group', 'inject', 'debug'],
  );
  assert.deepEqual(entries[2]?.['nodes'], ['inject_1', 'debug_1'], 'membership is derived from the nodes');
  assert.deepEqual(entries[0]?.['modules'], { 'node-red-dashboard': '3.6.6' });
  assert.deepEqual(Object.keys(entries[2] as object), ['id', 'type', 'z', 'name', 'style', 'nodes', 'x', 'y', 'w', 'h']);
});

test('a subflow definition is written with its ports, parameters and meta', () => {
  const flowSet: FlowSet = {
    ...emptyFlowSet(),
    subflows: [
      {
        id: 'scale',
        name: 'scale × factor',
        info: '',
        category: '',
        color: '#DDAA99',
        env: [{ name: 'factor', type: 'num', value: '2' }],
        meta: {},
        ports: {
          in: [[{ node: 'fn_1' }]],
          out: [[{ node: 'fn_1', port: 0 }]],
          status: [],
        },
        nodes: [
          {
            id: 'fn_1',
            type: 'inject',
            z: 'scale',
            props: { known: {}, extras: {} },
            geometry: { x: 100, y: 100 },
            wires: [[]],
          },
        ],
        groups: [],
        configs: [],
      },
    ],
  };

  const entries = emitEntries(normalizeFlowSet(flowSet, { palette: PALETTE }), { palette: PALETTE });
  const subflow = entries[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(subflow), [
    'id',
    'type',
    'name',
    'info',
    'category',
    'in',
    'out',
    'env',
    'meta',
    'color',
  ]);
  assert.deepEqual(subflow['in'], [{ x: 100, y: 100, wires: [{ id: 'fn_1' }] }]);
  assert.deepEqual(subflow['out'], [{ x: 500, y: 100, wires: [{ id: 'fn_1', port: 0 }] }]);
  assert.deepEqual(subflow['env'], [{ name: 'factor', type: 'num', value: '2' }]);
});

// --------------------------------------------------------------------------------------
// The round-trip oracle: emit → parse → emit must be a fixed point. The input is the flow
// file produced by the reconnaissance prototype, which the editor rendered and the runtime
// executed — and whose key order is *not* canonical, so this also proves normalisation.
// --------------------------------------------------------------------------------------

let palette: Record<string, PaletteType>;
let source: string;

before(async () => {
  const snapshot = await filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
    userDir: REPO_ROOT,
  }).load();
  palette = { ...snapshot.types };
  source = await readFile(path.join(REPO_ROOT, 'test', 'fixtures', 'flows-recon-demo.json'), 'utf8');
});

test('import → emit is a fixed point on a real flow file', () => {
  const imported = parseFlowSetText(source, { palette });
  const normalized = normalizeFlowSet(imported, { palette });
  const first = emitFlowSet(normalized, { palette, includeManifest: false });

  const reparsed = normalizeFlowSet(parseFlowSetText(first, { palette }), { palette });
  const second = emitFlowSet(reparsed, { palette, includeManifest: false });

  assert.equal(second, first, 'a second pass must not change a single byte');
});

test('the round trip preserves every entry and every property', () => {
  const imported = parseFlowSetText(source, { palette });
  const emitted = emitEntries(normalizeFlowSet(imported, { palette }), { palette, includeManifest: false });
  const original = JSON.parse(source) as Record<string, unknown>[];

  assert.equal(emitted.length, original.length);
  // Array order is our own documented convention — a subflow definition and its contents come
  // first, then the shared config nodes, then each tab with its groups and nodes — so the
  // comparison is by identity, not by position.
  assert.deepEqual(
    [...emitted.map((entry) => entry['id'])].sort(),
    [...original.map((entry) => entry['id'])].sort(),
  );
  assert.equal(emitted[0]?.['type'], 'subflow');
  assert.deepEqual(
    emitted.slice(1, 3).map((entry) => entry['id']),
    ['x_factor_1', 'unused_autoconnect_off_1'],
    'a subflow definition is followed by its own nodes and config nodes',
  );

  let droppedEmptyEnv = 0;
  for (const entry of original) {
    const roundTripped = emitted.find((candidate) => candidate['id'] === entry['id']) as Record<string, unknown>;
    const expectedKeys = Object.keys(entry).filter((key) => {
      // The one documented canonicalisation this input needs: an empty `env` array is not part
      // of a canonical flow file (the editor deletes it on export).
      const value = entry[key];
      if (key === 'env' && Array.isArray(value) && value.length === 0) {
        droppedEmptyEnv += 1;
        return false;
      }
      return true;
    });
    assert.deepEqual(Object.keys(roundTripped).sort(), [...expectedKeys].sort(), String(entry['id']));
    for (const key of expectedKeys) {
      assert.deepEqual(roundTripped[key], entry[key], `${String(entry['id'])}.${key}`);
    }
  }
  assert.equal(droppedEmptyEnv, 1, 'exactly one empty env array existed in the fixture');
});

test('the emitter output is stable across runs and independent of input order', () => {
  const imported = parseFlowSetText(source, { palette });
  const forward = emitFlowSet(normalizeFlowSet(imported, { palette }), { palette });
  const again = emitFlowSet(normalizeFlowSet(parseFlowSetText(source, { palette }), { palette }), { palette });
  assert.equal(again, forward);
});

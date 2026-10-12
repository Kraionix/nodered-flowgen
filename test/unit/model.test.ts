import assert from 'node:assert/strict';
import test from 'node:test';

import { allIds, type FlowSet, type Node } from '../../src/model/entities.ts';
import { createIdAllocator, slugify } from '../../src/model/ids.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', { inputs: 0, outputs: 1 }),
  switch: paletteType('switch', { inputs: 1, outputs: 1, defaults: { rules: paletteProperty({ value: [] }) } }),
  dynamic: paletteType('dynamic', {
    inputs: 1,
    outputs: 2,
    dynamics: { inputs: false, outputs: true, paletteLabel: false, category: false, defaults: [] },
  }),
  'mqtt-broker': paletteType('mqtt-broker', { category: 'config' }),
};

function flowSetWith(nodes: readonly Node[]): FlowSet {
  return {
    subflows: [],
    configs: [],
    flows: [
      {
        id: 'tab_1',
        label: 'Main',
        env: [],
        disabled: false,
        locked: false,
        groups: [],
        nodes,
        configs: [],
      },
    ],
    loose: [],
    modules: { 'node-red': '5.0.8', 'node-red-dashboard': '3.6.6', '': 'ignored' },
  };
}

function node(partial: Partial<Node> & { id: string; type: string }): Node {
  return {
    props: { known: {}, extras: {} },
    wires: [],
    ...partial,
  };
}

test('slugify produces stable, readable, ASCII ids', () => {
  assert.equal(slugify('Orders API'), 'orders_api');
  assert.equal(slugify('start'), 'start');
  assert.equal(slugify('  spaced  out '), 'spaced_out');
  assert.equal(slugify('Привет мир'), 'node_1', 'a non-ASCII key still yields a usable id');
  assert.equal(slugify('a'.repeat(80)).length, 48);
});

test('ids are deterministic, unique and follow the lockfile when there is one', () => {
  const allocator = createIdAllocator();
  assert.equal(allocator.allocate('start'), 'start');
  assert.equal(allocator.allocate('start'), 'start', 'the same key yields the same id');
  assert.equal(allocator.allocate('Start'), 'start_2', 'a colliding slug is disambiguated');
  assert.equal(allocator.allocate('other'), 'other');

  const reserved = createIdAllocator({ existing: ['start'] });
  assert.equal(reserved.allocate('start'), 'start_2');

  const locked = createIdAllocator({ locked: new Map([['start', 'inject_legacy']]) });
  assert.equal(locked.allocate('start'), 'inject_legacy', 'the lockfile wins over the derived id');
  assert.equal(locked.allocate('start'), 'inject_legacy');
});

test('a locked id that is already taken is not reused', () => {
  const allocator = createIdAllocator({ existing: ['inject_legacy'], locked: new Map([['start', 'inject_legacy']]) });
  assert.notEqual(allocator.allocate('start'), 'inject_legacy');
});

test('normalisation pads and trims wires to the declared output count', () => {
  const flowSet = normalizeFlowSet(
    flowSetWith([
      node({ id: 'a', type: 'inject', wires: [['b'], ['c']] }),
      node({ id: 'b', type: 'switch', wires: [] }),
      node({ id: 'c', type: 'dynamic', wires: [['d']] }),
      node({ id: 'd', type: 'unknown-type', wires: [['a'], ['b'], ['c']] }),
    ]),
    { palette: PALETTE },
  );

  const nodes = flowSet.flows[0]?.nodes ?? [];
  assert.deepEqual(nodes[0]?.wires, [['b']], 'a node with one output cannot have two wire arrays');
  assert.deepEqual(nodes[1]?.wires, [[]], 'a missing wire array is filled in');
  assert.deepEqual(nodes[2]?.wires, [['d']], 'computed outputs are left alone');
  assert.deepEqual(nodes[3]?.wires, [['a'], ['b'], ['c']], 'unknown types keep what they have');
});

test('normalisation drops what the editor never writes', () => {
  const flowSet = normalizeFlowSet(
    flowSetWith([
      node({
        id: 'a',
        type: 'inject',
        disabled: false,
        icon: '',
        inputLabels: [' ', ''],
        outputLabels: ['value'],
        wires: [[]],
      }),
      node({ id: 'b', type: 'inject', disabled: true, icon: 'custom.svg', wires: [[]] }),
    ]),
    { palette: PALETTE },
  );

  const [a, b] = flowSet.flows[0]?.nodes ?? [];
  assert.equal(a?.disabled, undefined, '`d` is written only when true');
  assert.equal(a?.icon, undefined);
  assert.equal(a?.inputLabels, undefined, 'blank labels are not written');
  assert.deepEqual(a?.outputLabels, ['value']);
  assert.equal(b?.disabled, true);
  assert.equal(b?.icon, 'custom.svg');
});

test('empty env arrays disappear, the module manifest loses the core module', () => {
  const flowSet = normalizeFlowSet(flowSetWith([]), { palette: PALETTE });
  assert.equal(flowSet.flows[0]?.env, undefined);
  assert.deepEqual(flowSet.modules, { 'node-red-dashboard': '3.6.6' });
});

test('a node that declares its own port count overrides the palette', () => {
  // `switch` has one output in the palette but the node carries `outputs: 3`, and the editor
  // serialises wires against the node's own property.
  const flowSet = normalizeFlowSet(
    flowSetWith([
      node({
        id: 'sw',
        type: 'switch',
        props: { known: { outputs: 3 }, extras: {} },
        wires: [['a'], ['b'], ['c']],
      }),
    ]),
    { palette: PALETTE },
  );

  assert.deepEqual(flowSet.flows[0]?.nodes[0]?.wires, [['a'], ['b'], ['c']]);
});

test('normalisation is idempotent', () => {
  const once = normalizeFlowSet(flowSetWith([node({ id: 'a', type: 'switch', wires: [] })]), { palette: PALETTE });
  const twice = normalizeFlowSet(once, { palette: PALETTE });
  assert.deepEqual(twice, once);
});

test('allIds enumerates every entity exactly once', () => {
  const flowSet = flowSetWith([node({ id: 'a', type: 'inject', wires: [] })]);
  assert.deepEqual(allIds(flowSet), ['tab_1', 'a']);
});

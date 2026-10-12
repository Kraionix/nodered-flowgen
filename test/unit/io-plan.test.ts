import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyLockfile,
  knownIds,
  lockfileIdMap,
  ownedContainers,
  parseLockfile,
  serializeLockfile,
  updateLockfile,
} from '../../src/io/lockfile.ts';
import { isNoop, mergeFlowSets, planDeployment, summarizePlan } from '../../src/io/plan.ts';
import { createReceipt, parseReceipt, serializeReceipt } from '../../src/io/receipt.ts';
import type { FlowSet, Node } from '../../src/model/entities.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';
import { unwrapOrThrow } from '../../src/result.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), topic: paletteProperty({ value: '' }) },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883 }) },
  }),
};

function node(id: string, type: string, init: Partial<Node> = {}): Node {
  return { id, type, props: { known: { name: '' }, extras: {} }, wires: [], ...init };
}

function flowSetWith(init: Partial<FlowSet> = {}): FlowSet {
  return normalizeFlowSet(
    { subflows: [], configs: [], flows: [], loose: [], modules: {}, ...init },
    { palette: PALETTE },
  );
}

function flow(id: string, label: string, nodes: readonly Node[], z = id): FlowSet['flows'][number] {
  return { id, label, groups: [], nodes: nodes.map((entry) => ({ ...entry, z })), configs: [] };
}

test('lockfile round-trips and keeps its ids', () => {
  const lockfile = updateLockfile(emptyLockfile(), {
    target: 'local',
    url: 'http://127.0.0.1:1880',
    paletteProfile: 'local-5.0.8',
    paletteHash: 'sha256:abc',
    keys: new Map([
      ['tab:orders', 'orders'],
      ['node:orders/start', 'start'],
    ]),
    containers: ['orders'],
  });

  const text = serializeLockfile(lockfile);
  const parsed = unwrapOrThrow(parseLockfile(text));
  assert.deepEqual(parsed, lockfile);
  assert.equal(serializeLockfile(parsed), text, 'serialisation is stable');
  assert.deepEqual([...lockfileIdMap(parsed)].sort(), [
    ['node:orders/start', 'start'],
    ['tab:orders', 'orders'],
  ]);
  assert.deepEqual([...ownedContainers(parsed, 'local')], ['orders']);
  assert.deepEqual([...knownIds(parsed)].sort(), ['orders', 'start']);
});

test('ownership is per target and never shrinks implicitly', () => {
  const base = updateLockfile(emptyLockfile(), {
    target: 'local',
    url: 'http://127.0.0.1:1880',
    keys: new Map([['tab:orders', 'orders']]),
    containers: ['orders'],
  });
  const other = updateLockfile(base, {
    target: 'staging',
    url: 'http://staging:1880',
    keys: new Map(),
    containers: ['staging_tab'],
  });

  assert.deepEqual([...ownedContainers(other, 'local')], ['orders']);
  assert.deepEqual([...ownedContainers(other, 'staging')], ['staging_tab']);

  const again = updateLockfile(other, {
    target: 'local',
    url: 'http://127.0.0.1:1880',
    keys: new Map([['tab:orders', 'orders'], ['tab:extra', 'extra']]),
    containers: ['extra'],
  });
  assert.deepEqual([...ownedContainers(again, 'local')].sort(), ['extra', 'orders']);
});

test('a lockfile from a newer version is refused', () => {
  const result = parseLockfile('{"lockVersion": 99}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0]?.code, 'unsupported-version');
});

test('the plan distinguishes our containers from everyone else\'s', () => {
  const current = flowSetWith({
    flows: [flow('alien', 'Someone else', [node('a1', 'inject', { wires: [[]] })]), flow('orders', 'Orders', [node('o1', 'inject')])],
  });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { props: { known: { name: '', topic: 'x' }, extras: {} } })])] });

  const plan = planDeployment({
    target: 'local',
    rev: 'rev-1',
    current,
    desired,
    palette: PALETTE,
    owned: new Set(['orders']),
  });

  assert.deepEqual(plan.unowned, ['alien']);
  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ['leave-alien', 'update-container'],
  );
  assert.equal(isNoop(plan), false);
  assert.equal(plan.operations[1]?.changes[0]?.entity, 'o1');
  assert.deepEqual(plan.operations[1]?.changes[0]?.added, ['topic'], 'the diff is over written properties');
  assert.deepEqual(plan.operations[1]?.changes[0]?.changed, []);
});

test('a container of ours that disappears is only deleted when pruning', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const desired = flowSetWith({});

  const keep = planDeployment({ target: 'local', rev: 'r', current, desired, palette: PALETTE, owned: new Set(['orders']) });
  assert.deepEqual(keep.deletions, []);
  assert.deepEqual(keep.operations, []);

  const prune = planDeployment({
    target: 'local',
    rev: 'r',
    current,
    desired,
    palette: PALETTE,
    owned: new Set(['orders']),
    prune: true,
  });
  assert.deepEqual(prune.deletions, ['orders']);
  assert.deepEqual(prune.operations.map((operation) => operation.kind), ['delete-owned']);
});

test('geometry differences are ignored unless asked for', () => {
  const before = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { geometry: { x: 100, y: 100 } })])] });
  const after = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { geometry: { x: 400, y: 250 } })])] });

  const insensitive = planDeployment({ target: 'local', rev: 'r', current: before, desired: after, palette: PALETTE, owned: new Set(['orders']) });
  assert.equal(isNoop(insensitive), true, 'moving a node on the canvas is not a change to deploy');

  const sensitive = planDeployment({
    target: 'local',
    rev: 'r',
    current: before,
    desired: after,
    palette: PALETTE,
    owned: new Set(['orders']),
    diffGeometry: true,
  });
  assert.equal(isNoop(sensitive), false);
  assert.deepEqual(sensitive.operations[0]?.changes[0]?.changed, ['x', 'y']);
});

test('the merge copies foreign containers through untouched and takes ours from the source', () => {
  const current = flowSetWith({
    flows: [flow('alien', 'Alien', [node('a1', 'inject')]), flow('orders', 'Old', [node('o1', 'inject')])],
    configs: [{ id: 'foreign-broker', type: 'mqtt-broker', props: { known: {}, extras: {} } }],
  });
  const desired = flowSetWith({
    flows: [flow('orders', 'New', [node('o1', 'inject')])],
    configs: [{ id: 'our-broker', type: 'mqtt-broker', props: { known: {}, extras: {} } }],
  });

  const merged = mergeFlowSets(current, desired, {
    owned: new Set(['orders']),
    ownedEntities: new Set(['o1', 'our-broker']),
    prune: false,
  });

  assert.deepEqual(merged.flowSet.flows.map((entry) => [entry.id, entry.label]), [
    ['alien', 'Alien'],
    ['orders', 'New'],
  ]);
  assert.deepEqual(merged.flowSet.configs.map((config) => config.id), ['foreign-broker', 'our-broker']);
});

test('a config node we do not own is never rewritten', () => {
  const current = flowSetWith({ configs: [{ id: 'shared-broker', type: 'mqtt-broker', props: { known: { port: 1883 }, extras: {} } }] });
  const desired = flowSetWith({ configs: [{ id: 'shared-broker', type: 'mqtt-broker', props: { known: { port: 9999 }, extras: {} } }] });

  const merged = mergeFlowSets(current, desired, { owned: new Set(), ownedEntities: new Set(), prune: false });
  assert.equal(merged.flowSet.configs[0]?.props.known['port'], 1883, 'an unowned config node keeps its values');

  const plan = planDeployment({ target: 'local', rev: 'r', current, desired, palette: PALETTE, owned: new Set() });
  assert.deepEqual(plan.operations.map((operation) => operation.kind), ['update-config']);
});

test('summaries count only operations that change something', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const same = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const plan = planDeployment({ target: 'local', rev: 'r', current, desired: same, palette: PALETTE, owned: new Set(['orders']) });

  assert.equal(isNoop(plan), true);
  assert.deepEqual(summarizePlan(plan), {
    'create-container': 0,
    'update-container': 0,
    'leave-alien': 0,
    'delete-owned': 0,
    'create-config': 0,
    'update-config': 0,
    'update-entities': 0,
  });
});

test('receipts round-trip and refuse to lose the previous flow set', () => {
  const receipt = createReceipt({
    target: 'local',
    url: 'http://127.0.0.1:1880',
    previousRev: 'rev-1',
    previousFlows: [{ id: 'tab_1', type: 'tab' }],
    deployedRev: 'rev-2',
    deployedAt: '2026-10-12T00:00:00.000Z',
    summary: ['create-container: 1'],
  });

  const text = serializeReceipt(receipt);
  assert.deepEqual(unwrapOrThrow(parseReceipt(text)), receipt);

  const broken = parseReceipt('{"receiptVersion":1}');
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.errors[0]?.path, 'previousFlows');
});

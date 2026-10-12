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
import {
  containerEntityIds,
  isNoop,
  MUTATION_KINDS,
  planMerge,
  summarizePlan,
  writtenContainers,
  type DeploymentPlan,
  type MergeRequest,
} from '../../src/io/plan.ts';
import { emitEntries } from '../../src/emit/flowJson.ts';
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
  'mqtt in': paletteType('mqtt in', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), broker: paletteProperty({ type: 'mqtt-broker' }) },
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

/** Ids of the emitted entities, with geometry dropped: the diff is geometry-insensitive. */
function entriesOf(flowSet: FlowSet): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of emitEntries(flowSet, { palette: PALETTE, includeManifest: false })) {
    const stripped = Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== 'x' && key !== 'y' && key !== 'w' && key !== 'h'),
    );
    map.set(String(entry['id']), JSON.stringify(stripped));
  }
  return map;
}

/** Every entity id whose emitted form differs between the instance and the payload. */
function differingIds(current: FlowSet, payload: FlowSet): readonly string[] {
  const before = entriesOf(current);
  const after = entriesOf(payload);
  const differing: string[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) !== after.get(id)) differing.push(id);
  }
  return differing.sort();
}

/**
 * Every entity id the plan reports as changing.
 *
 * An operation that creates or deletes an entity names it directly — and a container names
 * everything that came or went with it. An *update* names itself only through its property
 * changes, because that is where the difference is recorded: a container whose nodes changed is
 * reported by those nodes, not by the tab entry they hang off.
 *
 * Decisions (`leave-alien`, `keep-config`) are excluded on purpose: they say "nothing happens
 * here", which is the other half of the agreement property.
 */
function reportedIds(plan: DeploymentPlan, current: FlowSet): readonly string[] {
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    if (!MUTATION_KINDS.includes(operation.kind)) continue;
    for (const change of operation.changes) ids.add(change.entity);
    if (operation.kind === 'create-container') {
      ids.add(operation.id);
      for (const id of containerEntityIds(plan.payload, operation.id)) ids.add(id);
    }
    if (operation.kind === 'delete-container') {
      ids.add(operation.id);
      for (const id of containerEntityIds(current, operation.id)) ids.add(id);
    }
    if (operation.kind === 'delete-config' || operation.kind === 'delete-node') ids.add(operation.id);
  }
  return [...ids].sort();
}

function planOf(current: FlowSet, desired: FlowSet, options: Partial<MergeRequest> = {}): DeploymentPlan {
  return planMerge({
    target: 'local',
    rev: 'rev-1',
    current,
    desired,
    palette: PALETTE,
    owned: options.owned ?? new Set<string>(),
    ownedEntities: options.ownedEntities ?? new Set<string>(),
    ...(options.prune === undefined ? {} : { prune: options.prune }),
    ...(options.reassign === undefined ? {} : { reassign: options.reassign }),
    ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
    ...(options.diffGeometry === undefined ? {} : { diffGeometry: options.diffGeometry }),
  });
}

function config(id: string, known: Record<string, unknown> = {}, z?: string): FlowSet['configs'][number] {
  return { id, type: 'mqtt-broker', props: { known, extras: {} }, ...(z === undefined ? {} : { z }) };
}

test("the plan distinguishes our containers from everyone else's", () => {
  const current = flowSetWith({
    flows: [flow('alien', 'Someone else', [node('a1', 'inject', { wires: [[]] })]), flow('orders', 'Orders', [node('o1', 'inject')])],
  });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { props: { known: { name: '', topic: 'x' }, extras: {} } })])] });

  const plan = planOf(current, desired, { owned: new Set(['orders']) });

  assert.deepEqual(plan.unowned, ['alien']);
  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ['leave-alien', 'update-container'],
  );
  assert.equal(isNoop(plan), false);
  assert.equal(plan.operations[1]?.changes[0]?.entity, 'o1');
  assert.deepEqual(plan.operations[1]?.changes[0]?.added, ['topic'], 'the diff is over written properties');
  assert.deepEqual(plan.operations[1]?.changes[0]?.changed, []);
  assert.deepEqual(
    plan.operations[0]?.reason,
    'not ours: copied through untouched',
    'a decision carries its reason',
  );
});

test('a container of ours that disappears is only deleted when pruning', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const desired = flowSetWith({});

  const keep = planOf(current, desired, { owned: new Set(['orders']) });
  assert.deepEqual(keep.deletions, []);
  assert.deepEqual(keep.operations, []);
  assert.deepEqual(keep.payload.flows.map((entry) => entry.id), ['orders'], 'the container is copied through');

  const prune = planOf(current, desired, { owned: new Set(['orders']), prune: true });
  assert.deepEqual(prune.deletions, ['orders']);
  assert.deepEqual(prune.operations.map((operation) => operation.kind), ['delete-container']);
  assert.deepEqual(prune.payload.flows, []);
});

test('geometry differences are ignored unless asked for', () => {
  const before = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { geometry: { x: 100, y: 100 } })])] });
  const after = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { geometry: { x: 400, y: 250 } })])] });

  const insensitive = planOf(before, after, { owned: new Set(['orders']) });
  assert.equal(isNoop(insensitive), true, 'moving a node on the canvas is not a change to deploy');

  const sensitive = planOf(before, after, { owned: new Set(['orders']), diffGeometry: true });
  assert.equal(isNoop(sensitive), false);
  assert.deepEqual(sensitive.operations[0]?.changes[0]?.changed, ['x', 'y']);
});

test('the payload copies foreign containers through untouched and takes ours from the source', () => {
  const current = flowSetWith({
    flows: [flow('alien', 'Alien', [node('a1', 'inject')]), flow('orders', 'Old', [node('o1', 'inject')])],
    configs: [config('foreign-broker')],
  });
  const desired = flowSetWith({
    flows: [flow('orders', 'New', [node('o1', 'inject')])],
    configs: [config('our-broker')],
  });

  const plan = planOf(current, desired, { owned: new Set(['orders']), ownedEntities: new Set(['o1', 'our-broker']) });

  assert.deepEqual(plan.payload.flows.map((entry) => [entry.id, entry.label]), [
    ['alien', 'Alien'],
    ['orders', 'New'],
  ]);
  assert.deepEqual(plan.payload.configs.map((entry) => entry.id), ['foreign-broker', 'our-broker']);
  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ['leave-alien', 'update-container', 'create-config'],
    'containers first, then the config nodes they need',
  );
});

test('declaring a config node whose id belongs to somebody else is refused, not silently dropped', () => {
  const current = flowSetWith({ configs: [config('shared-broker', { port: 1883 })] });
  const desired = flowSetWith({ configs: [config('shared-broker', { port: 9999 })] });

  const plan = planOf(current, desired);
  assert.deepEqual(
    plan.operations.filter((operation) => MUTATION_KINDS.includes(operation.kind)),
    [],
    'nothing is written for that id',
  );
  assert.equal(plan.payload.configs[0]?.props.known['port'], 1883, 'the instance keeps its values');
  const decision = plan.operations.find((operation) => operation.kind === 'keep-config');
  assert.match(decision?.reason ?? '', /sources declare a different definition/);
  assert.deepEqual(
    plan.problems.map((problem) => [problem.code, problem.severity, problem.entity]),
    [['plan/id-collision', 'error', 'shared-broker']],
  );
  assert.match(plan.problems[0]?.hint ?? '', /change its key/);
});

test('a colliding container is refused, and --reassign deploys it under a fresh id', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Theirs', [node('alien_1', 'inject')])] });
  const desired = flowSetWith({ flows: [flow('orders', 'Ours', [node('o1', 'inject')])] });

  const refused = planOf(current, desired);
  assert.deepEqual(refused.problems.map((problem) => problem.code), ['plan/unowned-target']);
  assert.match(refused.problems[0]?.hint ?? '', /--adopt orders/);
  assert.deepEqual(refused.payload.flows.map((entry) => entry.label), ['Theirs'], 'their container is untouched');
  assert.deepEqual(refused.unowned, ['orders']);
  assert.deepEqual(refused.adopted, []);

  const reassigned = planOf(current, desired, { reassign: true });
  assert.deepEqual(reassigned.problems, []);
  assert.deepEqual(reassigned.notes.map((note) => note.code), ['reassigned']);
  assert.match(reassigned.notes[0]?.message ?? '', /orders → orders_2/);
  assert.deepEqual(reassigned.payload.flows.map((entry) => [entry.id, entry.label]), [
    ['orders', 'Theirs'],
    ['orders_2', 'Ours'],
  ]);
  assert.deepEqual(
    reassigned.operations.map((operation) => operation.kind),
    ['leave-alien', 'create-container'],
    'the alien stays where it was: a reassignment must not delete it',
  );
});

test('an owned config node that is no longer declared is kept, deleted, or kept for a reason', () => {
  // `broker` is a declared reference of `mqtt in`, so the alien tab really does point at cfg1.
  const alienNode = node('a1', 'mqtt in', { props: { known: { name: '', broker: 'cfg1' }, extras: {} } });

  const undeclared = flowSetWith({ configs: [config('cfg1')] });
  const keptNoPrune = planOf(undeclared, flowSetWith({}), { ownedEntities: new Set(['cfg1']) });
  assert.deepEqual(keptNoPrune.operations.map((operation) => operation.kind), ['keep-config']);
  assert.match(keptNoPrune.operations[0]?.reason ?? '', /--prune was not given/);
  assert.deepEqual(keptNoPrune.payload.configs.map((entry) => entry.id), ['cfg1']);

  const pruned = planOf(undeclared, flowSetWith({}), { ownedEntities: new Set(['cfg1']), prune: true });
  assert.deepEqual(pruned.operations.map((operation) => operation.kind), ['delete-config']);
  assert.deepEqual(pruned.payload.configs, []);

  // The alien tab holds `broker: "cfg1"`: deleting it would break a flow we never touched.
  const referenced = flowSetWith({ flows: [flow('alien', 'Alien', [alienNode])], configs: [config('cfg1')] });
  const keptForReference = planOf(referenced, flowSetWith({}), {
    owned: new Set<string>(),
    ownedEntities: new Set(['cfg1']),
    prune: true,
  });
  const decision = keptForReference.operations.find((operation) => operation.kind === 'keep-config');
  assert.ok(decision, `expected a keep-config decision, got ${keptForReference.operations.map((entry) => entry.kind).join(', ')}`);
  assert.match(decision.reason ?? '', /still referenced by a1 \(props\.broker\)/);
  assert.deepEqual(keptForReference.payload.configs.map((entry) => entry.id), ['cfg1']);
});

test('a config node scoped to our own tab survives the tab being rewritten — or is deleted on purpose', () => {
  const current = flowSetWith({
    flows: [
      {
        id: 'orders',
        label: 'Orders',
        groups: [],
        nodes: [node('o1', 'inject', { z: 'orders' })],
        configs: [config('tab-scoped', { port: 1883 }, 'orders')],
      },
    ],
  });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });

  // Kept: the container is rewritten around it rather than replacing it wholesale (P1-5).
  const kept = planOf(current, desired, { owned: new Set(['orders']), ownedEntities: new Set(['o1', 'tab-scoped']) });
  assert.deepEqual(kept.payload.flows[0]?.configs.map((entry) => entry.id), ['tab-scoped']);
  assert.deepEqual(
    kept.operations.filter((operation) => operation.kind === 'keep-config').map((operation) => operation.id),
    ['tab-scoped'],
  );

  // Deleted: --prune, nothing outside our containers references it, and the payload must really
  // lose it — the container is written from the sources, so "deleted" has to mean "removed here".
  const pruned = planOf(current, desired, {
    owned: new Set(['orders']),
    ownedEntities: new Set(['o1', 'tab-scoped']),
    prune: true,
  });
  assert.deepEqual(pruned.payload.flows[0]?.configs, []);
  assert.deepEqual(
    pruned.operations.filter((operation) => operation.kind === 'delete-config').map((operation) => operation.id),
    ['tab-scoped'],
  );
});

test('containerless nodes follow the same ownership rule as config nodes', () => {
  const current = flowSetWith({ loose: [node('orphan', 'inject')] });
  const desired = flowSetWith({ loose: [node('orphan', 'inject')] });

  const own = planOf(current, desired, { ownedEntities: new Set(['orphan']) });
  assert.equal(isNoop(own), true, 'an unchanged loose node is not an operation');
  assert.deepEqual(own.payload.loose.map((entry) => entry.id), ['orphan']);

  const gone = planOf(current, flowSetWith({}), { ownedEntities: new Set(['orphan']) });
  assert.deepEqual(gone.operations.map((operation) => operation.kind), []);
  assert.deepEqual(gone.payload.loose.map((entry) => entry.id), ['orphan'], 'kept without --prune');

  const pruned = planOf(current, flowSetWith({}), { ownedEntities: new Set(['orphan']), prune: true });
  assert.deepEqual(pruned.operations.map((operation) => operation.kind), ['delete-node']);
  assert.deepEqual(pruned.payload.loose, []);
});

test('only the containers we write are recorded as ours', () => {
  // The payload holds every container that will exist on the instance, ours and everybody else's.
  // Recording all of them as owned would claim somebody's tab — and a later `apply --prune` would
  // then delete it. The acceptance run caught exactly that.
  const current = flowSetWith({
    flows: [flow('alien', 'Alien', [node('a1', 'inject')]), flow('orders', 'Orders', [node('o1', 'inject')])],
  });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const plan = planOf(current, desired, { owned: new Set(['orders']), ownedEntities: new Set(['o1']) });

  assert.deepEqual(plan.payload.flows.map((entry) => entry.id), ['alien', 'orders']);
  assert.deepEqual(writtenContainers(plan), ['orders']);

  const colliding = flowSetWith({ flows: [flow('orders', 'Theirs', [node('alien_1', 'inject')])] });
  const reassigned = planOf(colliding, desired, { reassign: true, ownedEntities: new Set(['o1']) });
  assert.deepEqual(writtenContainers(reassigned), ['orders_2'], 'the id we deployed under is the one we own');
});

test('summaries count only operations that change something', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const same = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const plan = planOf(current, same, { owned: new Set(['orders']) });

  assert.equal(isNoop(plan), true);
  assert.deepEqual(summarizePlan(plan), {
    'create-container': 0,
    'update-container': 0,
    'delete-container': 0,
    'leave-alien': 0,
    'create-config': 0,
    'update-config': 0,
    'delete-config': 0,
    'keep-config': 0,
    'create-node': 0,
    'update-node': 0,
    'delete-node': 0,
  });
});

/**
 * The plan ⟷ payload agreement, over the situations that used to make them disagree.
 *
 * This is the property the two-implementation version could not hold: the operations were diffed
 * from `desired` while the payload was merged from `current`. Every case below has to satisfy both
 * directions — every mutation corresponds to a real difference between what the instance holds and
 * what will be written, and every difference is reported by some operation.
 */
const AGREEMENT_CASES: readonly { readonly name: string; readonly scenario: () => { current: FlowSet; desired: FlowSet; options: Partial<MergeRequest> } }[] = [
  {
    name: 'a first deploy',
    scenario: () => ({
      current: flowSetWith({}),
      desired: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { wires: [[]] })])], configs: [config('cfg1')] }),
      options: { ownedEntities: new Set(['o1', 'cfg1']) },
    }),
  },
  {
    name: 'an idempotent re-deploy',
    scenario: () => {
      const set = () =>
        flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { wires: [[]] })])], configs: [config('cfg1')] });
      return { current: set(), desired: set(), options: { owned: new Set(['orders']), ownedEntities: new Set(['o1', 'cfg1']) } };
    },
  },
  {
    name: 'an alien container beside ours, with ours edited',
    scenario: () => ({
      current: flowSetWith({
        flows: [flow('alien', 'Alien', [node('a1', 'inject')]), flow('orders', 'Orders', [node('o1', 'inject', { wires: [[]] })])],
      }),
      desired: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { props: { known: { name: '', topic: 'x' }, extras: {} }, wires: [[]] })])] }),
      options: { owned: new Set(['orders']), ownedEntities: new Set(['o1']) },
    }),
  },
  {
    name: 'a node added and another removed inside our container',
    scenario: () => ({
      current: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { wires: [[]] }), node('o2', 'inject', { wires: [[]] })])] }),
      desired: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject', { wires: [[]] }), node('o3', 'inject', { wires: [[]] })])] }),
      options: { owned: new Set(['orders']), ownedEntities: new Set(['o1', 'o2', 'o3']) },
    }),
  },
  {
    name: 'our container disappears, pruning off',
    scenario: () => ({
      current: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] }),
      desired: flowSetWith({}),
      options: { owned: new Set(['orders']), ownedEntities: new Set(['o1']) },
    }),
  },
  {
    name: 'our container disappears, pruning on',
    scenario: () => ({
      current: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] }),
      desired: flowSetWith({}),
      options: { owned: new Set(['orders']), ownedEntities: new Set(['o1']), prune: true },
    }),
  },
  {
    name: 'our config disappears, pruning off',
    scenario: () => ({
      current: flowSetWith({ configs: [config('cfg1')] }),
      desired: flowSetWith({}),
      options: { ownedEntities: new Set(['cfg1']) },
    }),
  },
  {
    name: 'our config disappears, unreferenced and pruned',
    scenario: () => ({
      current: flowSetWith({ configs: [config('cfg1')] }),
      desired: flowSetWith({}),
      options: { ownedEntities: new Set(['cfg1']), prune: true },
    }),
  },
  {
    name: 'our config disappears but an alien node holds it, so it is kept',
    scenario: () => ({
      current: flowSetWith({
        flows: [flow('alien', 'Alien', [node('a1', 'mqtt in', { props: { known: { name: '', broker: 'cfg1' }, extras: {} } })])],
        configs: [config('cfg1')],
      }),
      desired: flowSetWith({}),
      options: { ownedEntities: new Set(['cfg1']), prune: true },
    }),
  },
  {
    name: 'an alien config beside ours, with ours edited',
    scenario: () => ({
      current: flowSetWith({ configs: [config('alien-cfg', { port: 1883 }), config('cfg1', { port: 1883 })] }),
      desired: flowSetWith({ configs: [config('cfg1', { port: 9999 })] }),
      options: { ownedEntities: new Set(['cfg1']) },
    }),
  },
  {
    name: 'a config scoped to our tab, deleted by pruning',
    scenario: () => ({
      current: flowSetWith({
        flows: [
          { id: 'orders', label: 'Orders', groups: [], nodes: [node('o1', 'inject', { z: 'orders' })], configs: [config('cfg1', {}, 'orders')] },
        ],
      }),
      desired: flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] }),
      options: { owned: new Set(['orders']), ownedEntities: new Set(['o1', 'cfg1']), prune: true },
    }),
  },
  {
    name: 'a colliding container with --reassign',
    scenario: () => ({
      current: flowSetWith({ flows: [flow('orders', 'Theirs', [node('alien_1', 'inject')])] }),
      desired: flowSetWith({ flows: [flow('orders', 'Ours', [node('o1', 'inject', { wires: [[]] })])] }),
      options: { reassign: true, ownedEntities: new Set(['o1']) },
    }),
  },
  {
    name: 'a subflow definition and its instance',
    scenario: () => ({
      current: flowSetWith({}),
      desired: flowSetWith({
        subflows: [
          {
            id: 'scale',
            name: 'scale',
            env: [],
            meta: {},
            ports: { in: [], out: [], status: [] },
            nodes: [node('work', 'inject', { z: 'scale', wires: [[]] })],
            groups: [],
            configs: [],
          },
        ],
      }),
      options: { ownedEntities: new Set(['work']) },
    }),
  },
];

for (const entry of AGREEMENT_CASES) {
  test(`the plan agrees with the payload it will write: ${entry.name}`, () => {
    const { current, desired, options } = entry.scenario();
    const plan = planOf(current, desired, options);

    assert.deepEqual(
      reportedIds(plan, current),
      differingIds(current, plan.payload),
      'the operations must describe exactly the difference between the instance and the payload',
    );
  });
}

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

test('a container on the target is refused until --adopt names it, and then it is ours', () => {
  const current = flowSetWith({
    flows: [flow('orders', 'Orders', [node('o1', 'inject'), node('o2', 'debug')])],
    configs: [config('broker', { port: 1883 }, 'orders')],
  });
  const desired = flowSetWith({
    // The same container as the sources would have it after `flowgen import`: one node renamed.
    flows: [flow('orders', 'Orders', [node('o1', 'inject'), { ...node('o2', 'debug'), props: { known: { name: 'sink' }, extras: {} } }])],
    configs: [config('broker', { port: 1883 }, 'orders')],
  });

  const refused = planOf(current, desired);
  assert.deepEqual(
    refused.problems.map((problem) => [problem.code, problem.severity]),
    [['plan/unowned-target', 'error']],
  );
  assert.deepEqual(refused.payload.flows.map((entry) => entry.label), ['Orders'], 'their container is copied through');

  const adopted = planOf(current, desired, { adopt: ['orders'] });
  assert.deepEqual(adopted.problems, [], 'adoption is the answer to the refusal, not another error');
  assert.deepEqual(adopted.adopted, ['orders']);
  assert.deepEqual(adopted.unowned, [], 'the container is no longer somebody else\'s');
  assert.deepEqual(adopted.notes.map((note) => note.code), ['adopted']);
  assert.match(adopted.notes[0]?.message ?? '', /orders: adopted/);
  // Adoption plans the container like one of ours: the one edited node becomes an update, and the
  // config node inside it is ours as well (it used to count as a foreign reference).
  assert.deepEqual(
    adopted.operations.filter((operation) => MUTATION_KINDS.includes(operation.kind)).map((operation) => `${operation.kind}:${operation.id}`),
    ['update-container:orders'],
  );
});

test('adopting what the sources already match is an operation with no changes', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });

  const plan = planOf(current, desired, { adopt: ['orders'] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.adopted, ['orders']);
  assert.equal(isNoop(plan), true, 'the takeover itself writes nothing to the instance');
  assert.deepEqual(writtenContainers(plan), ['orders'], '...but the container is ours to record');
});

test('--adopt naming something the target does not have warns instead of pretending', () => {
  const current = flowSetWith({ flows: [flow('orders', 'Orders', [])] });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', []), flow('reports', 'Reports', [])] });

  const plan = planOf(current, desired, { adopt: ['reports', 'orders'] });
  assert.deepEqual(
    plan.problems.map((problem) => [problem.code, problem.severity, problem.entity]),
    [['plan/adopt-unused', 'warn', 'reports']],
  );
  assert.deepEqual(plan.adopted, ['orders'], 'only the container that exists is recorded as adopted');
});

test('adoption does not claim the right to delete: --prune still only removes our own', () => {
  const current = flowSetWith({
    flows: [flow('orders', 'Orders', [node('o1', 'inject')]), flow('legacy', 'Legacy', [node('l1', 'inject')])],
  });
  const desired = flowSetWith({ flows: [flow('orders', 'Orders', [node('o1', 'inject')])] });

  // `legacy` is on the target, is not in the sources and is not adopted: it stays, adopted or not.
  const plan = planOf(current, desired, { adopt: ['orders'], prune: true });
  assert.deepEqual(plan.deletions, []);
  assert.deepEqual(plan.unowned, ['legacy']);
  assert.ok(plan.operations.some((operation) => operation.kind === 'leave-alien' && operation.id === 'legacy'));
});

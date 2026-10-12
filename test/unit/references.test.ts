/**
 * The reference analysis, and the two validator checks that were wrong without it.
 *
 * Both defects here were silent, which is the whole reason the analysis exists as one function:
 *
 * * a config node's references were never checked. In node-red-dashboard 3.x every interesting
 *   reference *is* a config node — `ui_base`, `ui_tab`, `ui_group`, `ui_link` — so
 *   `ui_group.tab → ui_tab` dangled unremarked when somebody deleted a page (P2-10);
 * * `link out` declares `outputs: 0` and carries its edge in a `links` reference, so a wire-only
 *   connectivity check reported both halves of every link pair as isolated (P2-11).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFlowSet } from '../../src/model/normalize.ts';
import { inboundReferences, outgoingTargets, referenceTargets } from '../../src/model/references.ts';
import type { FlowSet, Node, NodeProps } from '../../src/model/entities.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';
import { defaultValidators } from '../../src/validate/index.ts';
import { runValidators } from '../../src/validate/report.ts';

/** The shapes that matter, copied from the palette of a live Node-RED 5.0.7 + dashboard 3.6.6. */
const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.7',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }) },
  }),
  debug: paletteType('debug', {
    module: 'node-red',
    nodeSet: 'node-red/debug',
    version: '5.0.7',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }) },
  }),
  'link out': paletteType('link out', {
    module: 'node-red',
    nodeSet: 'node-red/link',
    version: '5.0.7',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }), links: paletteProperty({ type: 'link in[]' }) },
  }),
  'link in': paletteType('link in', {
    module: 'node-red',
    nodeSet: 'node-red/link',
    version: '5.0.7',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), links: paletteProperty({ type: 'link out[]' }) },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.7',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }) },
  }),
  'mqtt in': paletteType('mqtt in', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.7',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), broker: paletteProperty({ type: 'mqtt-broker' }) },
  }),
  ui_tab: paletteType('ui_tab', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_tab',
    version: '3.6.6',
    category: 'config',
    isConfig: true,
    defaults: { name: paletteProperty({ value: '' }) },
  }),
  ui_group: paletteType('ui_group', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_group',
    version: '3.6.6',
    category: 'config',
    isConfig: true,
    defaults: { name: paletteProperty({ value: '' }), tab: paletteProperty({ type: 'ui_tab', required: true }) },
  }),
};

function node(id: string, type: string, known: Record<string, unknown> = {}, init: Partial<Node> = {}): Node {
  const props: NodeProps = { known, extras: {} };
  return { id, type, props, wires: [], ...init };
}

function flowSetOf(nodes: readonly Node[], extra: Partial<FlowSet> = {}): FlowSet {
  return normalizeFlowSet(
    {
      subflows: [],
      configs: [],
      loose: [],
      modules: {},
      flows: [{ id: 'tab_1', label: 'Main', groups: [], nodes, configs: [] }],
      ...extra,
    },
    { palette: PALETTE },
  );
}

function codes(flowSet: FlowSet): readonly string[] {
  const report = runValidators(defaultValidators(), { flowSet, palette: PALETTE }, { mode: 'collect' });
  return report.problems.filter((problem) => problem.severity !== 'info').map((problem) => problem.code);
}

function infos(flowSet: FlowSet): readonly string[] {
  const report = runValidators(defaultValidators(), { flowSet, palette: PALETTE }, { mode: 'collect' });
  return report.problems.filter((problem) => problem.severity === 'info').map((problem) => `${problem.code} ${problem.entity}`);
}

// ---------------------------------------------------------------------------------------
// The analysis itself
// ---------------------------------------------------------------------------------------

test('referenceTargets reads every declared reference, from nodes and from config nodes', () => {
  const group = node('group_1', 'ui_group', { name: 'KPIs', tab: 'tab_9' });
  assert.deepEqual(referenceTargets(group, PALETTE), [{ property: 'tab', id: 'tab_9' }]);

  const out = node('link_1', 'link out', { links: ['in_1', 'in_2'] });
  assert.deepEqual(referenceTargets(out, PALETTE), [
    { property: 'links', id: 'in_1' },
    { property: 'links', id: 'in_2' },
  ]);
});

test('an empty or blank reference is unset, not dangling', () => {
  // The editor writes `"broker": ""` for every optional config reference the author has not
  // picked, so treating that as a dangling reference would make the validator cry wolf.
  assert.deepEqual(referenceTargets(node('a', 'mqtt in', { broker: '' }), PALETTE), []);
  assert.deepEqual(referenceTargets(node('a', 'link out', { links: [] }), PALETTE), []);
  assert.deepEqual(referenceTargets(node('a', 'link out', { links: ['', 'in_1'] }), PALETTE), [{ property: 'links', id: 'in_1' }]);
});

test('outgoingTargets is wires plus references; inboundReferences is the reverse index', () => {
  const set = flowSetOf([
    node('out_1', 'link out', { links: ['in_1'] }),
    node('in_1', 'link in', { links: ['out_1'] }),
    node('tick', 'inject', {}, { wires: [['in_1']] }),
    node('sink', 'debug'),
  ]);

  assert.deepEqual(outgoingTargets(set.flows[0]?.nodes[0] as Node, PALETTE), ['in_1']);
  assert.deepEqual(outgoingTargets(set.flows[0]?.nodes[2] as Node, PALETTE), ['in_1'], 'wires come first');
  assert.deepEqual(outgoingTargets(set.flows[0]?.nodes[3] as Node, PALETTE), []);

  const inbound = inboundReferences(set, PALETTE);
  assert.deepEqual(
    inbound.get('in_1')?.map((entry) => [entry.from, entry.kind, entry.path]),
    [
      ['out_1', 'reference', 'props.links'],
      ['tick', 'wire', 'wires[0][0]'],
    ],
    'both halves of a link pair point at each other, and the wire is one more entry',
  );
  assert.deepEqual(inbound.get('out_1')?.map((entry) => entry.from), ['in_1']);
  assert.equal(inbound.get('sink'), undefined, 'containment is not a reference');
});

test('inboundReferences includes subflow port links', () => {
  const set = flowSetOf([node('work', 'debug')], {
    subflows: [
      {
        id: 'subflow:scale',
        name: 'scale',
        env: [],
        meta: {},
        ports: { in: [[{ node: 'work' }]], out: [[{ node: 'work', port: 0 }]], status: [{ node: 'work' }] },
        nodes: [node('work', 'debug', {}, { z: 'subflow:scale' })],
        groups: [],
        configs: [],
      },
    ],
  });

  assert.deepEqual(
    inboundReferences(set, PALETTE).get('work')?.map((entry) => [entry.kind, entry.path]),
    [
      ['subflow-port', 'ports.in[0][0]'],
      ['subflow-port', 'ports.out[0][0]'],
      ['subflow-port', 'ports.status[0]'],
    ],
  );
});

// ---------------------------------------------------------------------------------------
// P2-10: a config node's references are checked
// ---------------------------------------------------------------------------------------

test('a dangling reference held by a config node is an error', () => {
  const set = flowSetOf([], {
    configs: [{ id: 'group_1', type: 'ui_group', props: { known: { name: 'KPIs', tab: 'tab_deleted' }, extras: {} } }],
  });

  assert.deepEqual(codes(set), ['palette/ref-missing']);
  const report = runValidators(defaultValidators(), { flowSet: set, palette: PALETTE }, { mode: 'collect' });
  const problem = report.problems.find((entry) => entry.code === 'palette/ref-missing');
  assert.equal(problem?.entity, 'group_1');
  assert.equal(problem?.path, 'props.tab');
  assert.match(problem?.message ?? '', /points at "tab_deleted"/);
});

test('a ui_group whose tab exists is fine, and whose tab is the wrong type is not', () => {
  const withTab = flowSetOf([], {
    configs: [
      { id: 'tab_1_config', type: 'ui_tab', props: { known: { name: 'KPIs' }, extras: {} } },
      { id: 'group_1', type: 'ui_group', props: { known: { name: 'KPIs', tab: 'tab_1_config' }, extras: {} } },
    ],
  });
  assert.deepEqual(codes(withTab), []);

  const wrongType = flowSetOf([], {
    configs: [
      { id: 'broker_1', type: 'mqtt-broker', props: { known: { name: 'broker' }, extras: {} } },
      { id: 'group_1', type: 'ui_group', props: { known: { name: 'KPIs', tab: 'broker_1' }, extras: {} } },
    ],
  });
  assert.deepEqual(codes(wrongType), ['palette/ref-wrong-type']);
});

test('a node reference is still checked, node and config alike', () => {
  const set = flowSetOf([node('sub', 'mqtt in', { broker: 'no_such_broker' })]);
  assert.deepEqual(codes(set), ['palette/ref-missing']);
});

// ---------------------------------------------------------------------------------------
// P2-11: a link pair is connected
// ---------------------------------------------------------------------------------------

test('a link out / link in pair is connected, not two isolated nodes', () => {
  const set = flowSetOf([node('out_1', 'link out', { links: ['in_1'] }), node('in_1', 'link in', { links: ['out_1'] })]);
  assert.deepEqual(infos(set), [], 'neither half of a link pair is a leftover');
});

test('a link out with nothing connected to it is still info-level', () => {
  const set = flowSetOf([node('out_1', 'link out'), node('in_1', 'link in')]);
  assert.deepEqual(infos(set), ['graph/unreachable out_1', 'graph/unreachable in_1']);
  assert.deepEqual(codes(set), [], 'an unwired link node is never an error');
});

test('a wire into a link out makes both halves connected', () => {
  const set = flowSetOf([
    node('tick', 'inject', {}, { wires: [['out_1']] }),
    node('out_1', 'link out', { links: ['in_1'] }),
    node('in_1', 'link in', {}, { wires: [['sink']] }),
    node('sink', 'debug'),
  ]);
  assert.deepEqual(infos(set), []);
});

test('a config reference counts as a connection too', () => {
  // A dashboard widget that hangs off a group is not a leftover, and neither is an mqtt node
  // that points at a broker: both are "wired up" as far as the author is concerned.
  const set = flowSetOf([node('sub', 'mqtt in', { broker: 'broker_1' })], {
    configs: [{ id: 'broker_1', type: 'mqtt-broker', props: { known: { name: 'broker' }, extras: {} } }],
  });
  assert.deepEqual(infos(set), []);
});

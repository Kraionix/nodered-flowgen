/**
 * Layout: termination, determinism, and the scopes it has to cover.
 *
 * The load-bearing test here is the first one. The previous implementation computed longest-path
 * depth with a worklist that re-enqueued a node every time a longer path to it was found, so a
 * single feedback loop — `inject → f1 → f2 → f1`, the second flow anybody writes — made the depth
 * grow without bound and the loop never drain. The failure mode was not a wrong coordinate: it
 * was `flowgen validate`, `plan` and `apply` never returning, printing nothing and exiting with
 * nothing, because the work is synchronous and blocks the event loop. It was measured with
 * `timeout 8 node probe2.mjs` → exit 124.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutFlowSet, layoutFlowSetWithDiagnostics } from '../../src/authoring/layout.ts';
import type { FlowSet, Node, NodeProps, SubflowDef } from '../../src/model/entities.ts';

function props(): NodeProps {
  return { known: {}, extras: {} };
}

function node(id: string, init: Partial<Node> = {}): Node {
  return { id, type: 'function', props: props(), wires: [], ...init };
}

function flowSet(nodes: readonly Node[], extra: Partial<FlowSet> = {}): FlowSet {
  return {
    subflows: [],
    configs: [],
    loose: [],
    modules: {},
    flows: [{ id: 'tab_1', label: 'Main', groups: [], nodes, configs: [] }],
    ...extra,
  };
}

function subflow(id: string, nodes: readonly Node[]): SubflowDef {
  return {
    id,
    name: id.replace(/^subflow:/, ''),
    env: [],
    meta: {},
    ports: { in: [], out: [], status: [] },
    nodes,
    groups: [],
    configs: [],
  };
}

function xOf(flowSetValue: FlowSet, id: string): number | undefined {
  for (const flow of flowSetValue.flows) {
    for (const candidate of flow.nodes) if (candidate.id === id) return candidate.geometry?.x;
  }
  for (const definition of flowSetValue.subflows) {
    for (const candidate of definition.nodes) if (candidate.id === id) return candidate.geometry?.x;
  }
  for (const candidate of flowSetValue.loose) if (candidate.id === id) return candidate.geometry?.x;
  return undefined;
}

function placeNodes(flowSetValue: FlowSet): readonly Node[] {
  return [...flowSetValue.flows.flatMap((flow) => flow.nodes), ...flowSetValue.loose];
}

test('a feedback loop lays out in milliseconds instead of hanging the CLI', () => {
  const cyclic = flowSet([
    node('inject_1', { type: 'inject', wires: [['f1']] }),
    node('f1', { wires: [['f2']] }),
    node('f2', { wires: [['f1']] }),
  ]);

  const started = Date.now();
  const placed = layoutFlowSet(cyclic);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `layout took ${elapsed} ms on a three-node loop; it must be bounded by construction`);

  // The loop is one column, and the root that feeds it is the column before.
  assert.equal(xOf(placed, 'inject_1'), 120);
  assert.equal(xOf(placed, 'f1'), 310, 'both nodes of the loop share the column the loop sits in');
  assert.equal(xOf(placed, 'f2'), 310);
});

test('a loop that nothing feeds still terminates and shares one column', () => {
  const placed = layoutFlowSet(flowSet([node('a', { wires: [['b']] }), node('b', { wires: [['a']] })]));
  assert.equal(xOf(placed, 'a'), 120);
  assert.equal(xOf(placed, 'b'), 120);
});

test('a node wired to itself is a loop of one, not an infinite one', () => {
  const placed = layoutFlowSet(flowSet([node('a', { wires: [['a']] })]));
  assert.equal(xOf(placed, 'a'), 120);
});

test('layout is a fixed point: the second pass changes nothing', () => {
  const cyclic = flowSet([
    node('inject_1', { type: 'inject', wires: [['f1']] }),
    node('f1', { wires: [['f2']] }),
    node('f2', { wires: [['f1']] }),
    node('leaf'),
  ]);

  const once = layoutFlowSet(cyclic);
  const twice = layoutFlowSet(once);
  assert.deepEqual(twice, once);
});

test('depth is the *longest* path, not the first one found', () => {
  const placed = layoutFlowSet(
    flowSet([
      node('a', { wires: [['b', 'c']] }),
      node('b', { wires: [['d']] }),
      node('c'),
      node('d'),
    ]),
  );

  assert.equal(xOf(placed, 'a'), 120);
  assert.equal(xOf(placed, 'b'), 310);
  assert.equal(xOf(placed, 'c'), 310, 'a node with no outgoing wire is not lengthened by one');
  assert.equal(xOf(placed, 'd'), 500, 'the longer of the two paths to d wins');
});

test('a loop is reported as an info diagnostic naming its nodes in flow order', () => {
  const result = layoutFlowSetWithDiagnostics(
    flowSet([node('inject_1', { type: 'inject', wires: [['f1']] }), node('f1', { wires: [['f2']] }), node('f2', { wires: [['f1']] })]),
  );

  assert.deepEqual(result.problems, [
    {
      code: 'layout/cycle',
      severity: 'info',
      entity: 'f1',
      path: 'wires',
      message: 'nodes form a loop: f1 → f2',
      hint: 'geometry is advisory: a loop is placed in one column',
    },
  ]);
});

test('a self-wired node reports itself, and an acyclic flow reports nothing', () => {
  const self = layoutFlowSetWithDiagnostics(flowSet([node('a', { wires: [['a']] })]));
  assert.equal(self.problems.length, 1);
  assert.equal(self.problems[0]?.message, 'node wires to itself: a');

  const acyclic = layoutFlowSetWithDiagnostics(flowSet([node('a', { wires: [['b']] }), node('b')]));
  assert.deepEqual(acyclic.problems, []);
});

test('subflow bodies are laid out, not left piled up at the origin', () => {
  const placed = layoutFlowSet(
    flowSet([], {
      subflows: [subflow('subflow:scale', [node('work', { wires: [['done']] }), node('done')])],
    }),
  );

  const nodes = placed.subflows[0]?.nodes ?? [];
  assert.deepEqual(
    nodes.map((entry) => [entry.id, entry.geometry?.x, entry.geometry?.y]),
    [
      ['work', 120, 80],
      ['done', 310, 80],
    ],
  );
});

test('containerless nodes are laid out too', () => {
  const placed = layoutFlowSet(flowSet([], { loose: [node('orphan', { wires: [['orphan_2']] }), node('orphan_2')] }));

  assert.deepEqual(
    placed.loose.map((entry) => [entry.id, entry.geometry?.x]),
    [
      ['orphan', 120],
      ['orphan_2', 310],
    ],
  );
});

test('a node the author placed keeps its coordinates, and still counts for the group box', () => {
  const placed = layoutFlowSet(
    flowSet([node('a', { geometry: { x: 999, y: 999 }, wires: [['b']] }), node('b')]),
  );

  assert.deepEqual(placed.flows[0]?.nodes[0]?.geometry, { x: 999, y: 999 });
  assert.equal(xOf(placed, 'b'), 310, 'a placed node still contributes its depth to the graph');
});

test('a long chain is laid out without recursing per node', () => {
  const length = 20_000;
  const chain: Node[] = [];
  for (let index = 0; index < length; index += 1) {
    chain.push(node(`n${index}`, index === length - 1 ? {} : { wires: [[`n${index + 1}`]] }));
  }

  const placed = layoutFlowSet(flowSet(chain));
  const nodes = placeNodes(placed);
  assert.equal(nodes.length, length);
  assert.equal(nodes[length - 1]?.geometry?.x, 120 + (length - 1) * 190);
});

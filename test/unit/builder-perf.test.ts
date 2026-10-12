/**
 * The builder's cost curve, held down by a test.
 *
 * Wiring used to be `#nodes.findIndex(...)` per wire plus a copy of the node's whole `wires` array
 * per connection. That is invisible in a fixture and quadratic in a project, and a build that takes
 * a minute is a build nobody runs. `NodeTable` keeps an `id → index` map instead, and this test is
 * what stops the linear scan from coming back.
 *
 * A timing assertion is a blunt instrument, so the workload is sized until the two shapes are far
 * apart rather than merely different — measured on this machine, same flow set: **528 ms** with the
 * index map against **4 693 ms** with a `findIndex` per wire, against a 2 000 ms budget. That is
 * enough headroom for a slow CI machine and still a failing test for the quadratic path.
 *
 * The layout is included on purpose: it is the other pass that touches every node and every edge.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defineFlowSet } from '../../src/authoring/defineFlowSet.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }) },
  }),
  function: paletteType('function', {
    module: 'node-red',
    nodeSet: 'node-red/function',
    version: '5.0.8',
    inputs: 1,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), func: paletteProperty({ value: '' }), outputs: paletteProperty({ value: 1 }) },
  }),
};

const NODES = 20_000;
const WIRES = 40_000;
const BUDGET_MS = 2_000;

test(`${NODES} nodes and ${WIRES} wires build in under ${BUDGET_MS} ms`, () => {
  const definition = defineFlowSet((f) => {
    const tab = f.flow('big');
    const nodes = Array.from({ length: NODES }, (_unused, index) =>
      tab.node(index % 10 === 0 ? 'inject' : 'function', { key: `n${index}`, name: `n${index}`, func: 'return msg;', outputs: 1 }),
    );
    // Two wires per node on average, skipping forward so the graph is a DAG the layout can place.
    for (let index = 0; index < WIRES; index += 1) {
      const from = nodes[index % NODES] as (typeof nodes)[number];
      const to = nodes[(index * 7 + 1) % NODES] as (typeof nodes)[number];
      if (from.id === to.id) continue;
      from.toPort(0, to);
    }
    // Groups and cross-container moves go through the same lookups, so they are in the measurement.
    const group = tab.group('all', { name: 'all' });
    group.add(...nodes.slice(0, 50));
  });

  const started = performance.now();
  const built = definition.build({ palette: PALETTE });
  const elapsed = performance.now() - started;

  assert.equal(built.flowSet.flows[0]?.nodes.length, NODES);
  assert.equal(built.flowSet.flows[0]?.groups[0]?.id, 'all');
  assert.equal(built.flowSet.flows[0]?.nodes[0]?.g, 'all', 'the relocated nodes are in the group');
  assert.ok(elapsed < BUDGET_MS, `build took ${Math.round(elapsed)} ms for ${NODES} nodes (budget ${BUDGET_MS} ms)`);
});

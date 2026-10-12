import assert from 'node:assert/strict';
import test from 'node:test';

import { defineFlowSet } from '../../src/authoring/defineFlowSet.ts';
import { dashboard } from '../../src/authoring/helpers/dashboard.ts';
import { layoutFlowSet } from '../../src/authoring/layout.ts';
import { P } from '../../src/authoring/params.ts';
import { emitEntries } from '../../src/emit/flowJson.ts';
import { eachNode, type FlowSet } from '../../src/model/entities.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    category: 'common',
    inputs: 0,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      topic: paletteProperty({ value: '' }),
      payload: paletteProperty({ value: '' }),
      once: paletteProperty({ value: false }),
      computed: paletteProperty({ dynamic: true }),
    },
  }),
  function: paletteType('function', {
    module: 'node-red',
    nodeSet: 'node-red/function',
    version: '5.0.8',
    inputs: 1,
    outputs: 1,
    defaults: { name: paletteProperty({ value: '' }), func: paletteProperty({ value: '' }), outputs: paletteProperty({ value: 1 }) },
  }),
  'http response': paletteType('http response', {
    module: 'node-red',
    nodeSet: 'node-red/http',
    version: '5.0.8',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }), statusCode: paletteProperty({ value: '' }) },
  }),
  switch: paletteType('switch', {
    module: 'node-red',
    nodeSet: 'node-red/switch',
    version: '5.0.8',
    inputs: 1,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      property: paletteProperty({ value: 'payload' }),
      outputs: paletteProperty({ value: 1 }),
    },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883, required: true }) },
  }),
  'mqtt out': paletteType('mqtt out', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    inputs: 1,
    outputs: 0,
    defaults: {
      name: paletteProperty({ value: '' }),
      topic: paletteProperty({ value: '' }),
      broker: paletteProperty({ type: 'mqtt-broker', required: true }),
    },
  }),
  ui_base: paletteType('ui_base', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_base',
    version: '3.6.6',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), path: paletteProperty({ value: '/ui' }) },
  }),
  ui_tab: paletteType('ui_tab', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_tab',
    version: '3.6.6',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), label: paletteProperty({ value: '' }), icon: paletteProperty({ value: '' }) },
  }),
  ui_group: paletteType('ui_group', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_group',
    version: '3.6.6',
    category: 'config',
    defaults: {
      name: paletteProperty({ value: '' }),
      tab: paletteProperty({ type: 'ui_tab', required: true }),
      width: paletteProperty({ value: 6 }),
    },
  }),
  ui_gauge: paletteType('ui_gauge', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_gauge',
    version: '3.6.6',
    inputs: 1,
    outputs: 0,
    defaults: {
      name: paletteProperty({ value: '' }),
      group: paletteProperty({ type: 'ui_group', required: true }),
      min: paletteProperty({ value: 0 }),
    },
  }),
};

function build(definition: ReturnType<typeof defineFlowSet>): FlowSet {
  return definition.build({ palette: PALETTE }).flowSet;
}

test('flows, nodes and defaults: the author writes only what differs', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('orders', { label: 'Orders API', info: 'generated' });
      tab.node('inject', { key: 'start', topic: 'orders' });
    }),
  );

  const tab = flowSet.flows[0];
  assert.equal(tab?.id, 'orders');
  assert.equal(tab?.label, 'Orders API');
  assert.equal(tab?.info, 'generated');

  const node = tab?.nodes[0];
  assert.equal(node?.id, 'start');
  assert.equal(node?.z, 'orders');
  assert.deepEqual(Object.keys(node?.props.known ?? {}), ['name', 'topic', 'payload', 'once']);
  assert.equal(node?.props.known['topic'], 'orders');
  assert.equal(node?.props.known['name'], '', 'a declared default is materialised');
  assert.equal(Object.hasOwn(node?.props.known ?? {}, 'computed'), false, 'a computed default is never invented');
  assert.deepEqual(node?.props.extras, {}, 'key/x/y/… are not properties');
});

test('wiring happens through handles, not ids', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('orders');
      const start = tab.node('inject', { key: 'start' });
      const fn = tab.node('function', { key: 'work' });
      const back = tab.node('http response', { key: 'reply' });
      tab.chain(start, fn, back);
    }),
  );

  const nodes = flowSet.flows[0]?.nodes ?? [];
  assert.deepEqual(nodes[0]?.wires, [['work']]);
  assert.deepEqual(nodes[1]?.wires, [['reply']]);
  assert.deepEqual(nodes[2]?.wires, [], 'a node with no outputs still has its wire arrays normalised');
});

test('multi-output wiring uses ports', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      const sw = tab.node('switch', { key: 'classify', outputs: 3 });
      const a = tab.node('function', { key: 'eq' });
      const b = tab.node('function', { key: 'gt' });
      sw.toPort(0, a).toPort(1, b);
    }),
  );

  const sw = eachNode(flowSet).find((node) => node.id === 'classify');
  assert.deepEqual(
    sw?.wires,
    [['eq'], ['gt'], []],
    'wire arity follows the node property (3), not the palette default (1)',
  );
});

test('groups own their members, and a declared group reference is filled in', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      const group = tab.group('kpi', { name: 'KPIs' });
      group.node('inject', { key: 'inside' });
      tab.node('inject', { key: 'outside' });
    }),
  );

  const nodes = flowSet.flows[0]?.nodes ?? [];
  assert.equal(nodes[0]?.g, 'kpi');
  assert.equal(nodes[1]?.g, undefined);
  assert.deepEqual(flowSet.flows[0]?.groups.map((group) => [group.id, group.name, group.z]), [['kpi', 'KPIs', 'main']]);
});

test('config nodes are separated from nodes, and a config type created as a node becomes one', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      const broker = tab.config('mqtt-broker', { key: 'broker', port: 1884 });
      tab.node('mqtt out', { key: 'publish', broker });
      tab.node('mqtt-broker', { key: 'second', port: 1885 });
    }),
  );

  assert.deepEqual(
    flowSet.configs.map((config) => config.id),
    ['broker'],
    'a config node created in a tab is global, like the editor does',
  );
  assert.deepEqual(flowSet.flows[0]?.configs.map((config) => config.id), ['second']);
  assert.equal(eachNode(flowSet).length, 1, 'config nodes are not nodes');
  assert.equal(flowSet.flows[0]?.nodes[0]?.props.known['broker'], 'broker', 'a handle is accepted where a reference is');
});

test('subflow parameters are declared once and overridden per instance', () => {
  const definition = defineFlowSet((f) => {
    const scale = f.subflow(
      'scale',
      {
        name: 'scale × factor',
        params: { factor: P.num(2), tag: P.str('default'), verbose: P.bool(true), secret: P.cred() },
        ports: { in: ['value'], out: ['scaled'] },
      },
      (s) => {
        const work = s.node('function', { key: 'work', func: 'msg.payload = msg.payload * env.get("factor"); return msg;' });
        s.in(work);
        s.out(work, 0);
      },
    );

    const tab = f.flow('main', { label: 'Main' });
    const source = tab.node('inject', { key: 'source' });
    const instance = tab.instance(scale, { key: 'scale3', name: 'scale x3', env: { factor: 3, verbose: false } });
    const sink = tab.node('function', { key: 'sink' });
    tab.chain(source, instance, sink);
  });

  const flowSet = build(definition);
  const subflow = flowSet.subflows[0];
  assert.equal(subflow?.id, 'scale');
  assert.deepEqual(
    subflow?.env.map((param) => [param.name, param.type, param.value]),
    [
      ['factor', 'num', '2'],
      ['tag', 'str', 'default'],
      ['verbose', 'bool', 'true'],
      ['secret', 'cred', ''],
    ],
    'declared parameters are stored the way the flow file stores them',
  );
  assert.deepEqual(subflow?.ports.in, [[{ node: 'work' }]]);
  assert.deepEqual(subflow?.ports.out, [[{ node: 'work', port: 0 }]]);
  assert.deepEqual(subflow?.inputLabels, ['value']);

  const instance = flowSet.flows[0]?.nodes.find((node) => node.type === 'subflow:scale');
  assert.equal(instance?.z, 'main');
  assert.deepEqual(
    instance?.env?.map((param) => [param.name, param.type, param.value]),
    [
      ['factor', 'num', '3'],
      ['verbose', 'bool', 'false'],
    ],
    'overrides are converted using the declared parameter types',
  );
  assert.deepEqual(instance?.wires, [['sink']], 'an instance is an ordinary node for wiring');
});

test('a config node created inside a subflow is scoped to it', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      f.subflow('worker', {}, (s) => {
        s.config('mqtt-broker', { key: 'local-broker', port: 1884 });
        s.node('mqtt out', { key: 'publish', broker: 'local-broker' });
      });
    }),
  );

  assert.deepEqual(flowSet.configs, []);
  assert.deepEqual(flowSet.subflows[0]?.configs.map((config) => config.id), ['local-broker']);
});

test('the module manifest is derived from the modules actually used', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      tab.node('inject', { key: 'start' });
      const dash = f.use(dashboard());
      const dashTab = dash.tab('page', { name: 'Page' });
      dash.group('panel', dashTab, { name: 'Panel' });
    }),
  );

  assert.deepEqual(flowSet.modules, { 'node-red-dashboard': '3.6.6' }, 'the core module is never listed');
});

test('the dashboard helper wires the three-level tree and fills in the group reference', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const dash = f.use(dashboard({ baseName: 'Ops' }));
      const tab = f.flow('main');
      const page = dash.tab('page', { name: 'KPIs' });
      const panel = dash.group('panel', page, { name: 'KPIs', width: 6 });
      dash.gauge(panel, { min: 0, max: 100 });
      void tab;
    }),
  );

  const configs = flowSet.configs.map((config) => [config.id, config.type]);
  assert.deepEqual(configs, [
    ['base', 'ui_base'],
    ['page', 'ui_tab'],
    ['panel', 'ui_group'],
  ]);

  const gauge = eachNode(flowSet).find((node) => node.type === 'ui_gauge');
  assert.equal(gauge?.props.known['group'], 'panel', 'the widget points at the group without repeating it');
  assert.equal(gauge?.props.known['min'], 0);
  assert.equal(gauge?.props.known['name'], '', 'palette defaults are materialised');
});

test('untyped() is an escape hatch that keeps the property bag open', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      tab.untyped('inhouse-plc', { key: 'plc', register: 'D100', count: 4 });
    }),
  );

  const node = flowSet.flows[0]?.nodes[0];
  assert.equal(node?.type, 'inhouse-plc');
  assert.deepEqual(node?.props.extras, { register: 'D100', count: 4 });
  assert.deepEqual(node?.props.known, {}, 'nothing is materialised for an unknown type');
});

test('untypedConfig() creates a config node for a type the palette does not cover', () => {
  // The dashboard helper depends on this: whether `ui_tab` is a config node is a palette fact,
  // and library code must produce the right *shape* even before a palette has been generated.
  // `untyped()` is the wrong primitive for it — without the palette it builds a canvas node, with
  // geometry and a place in the tab.
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      tab.untypedConfig('ui_tab', { key: 'page', name: 'KPIs' });
      tab.untyped('ui_gauge', { key: 'load' });
    }),
  );

  assert.deepEqual(
    flowSet.configs.map((config) => [config.id, config.type]),
    [['page', 'ui_tab']],
  );
  assert.deepEqual(
    flowSet.flows[0]?.nodes.map((node) => node.type),
    ['ui_gauge'],
    'a config node is never placed in a container',
  );
  assert.equal(eachNode(flowSet).find((node) => node.type === 'ui_gauge')?.geometry?.x, 120, 'an ordinary node still gets geometry');
});

test('ids are deterministic, unique and honour the lockfile', () => {
  const definition = defineFlowSet((f) => {
    const tab = f.flow('main');
    tab.node('inject', { key: 'start' });
    tab.node('inject', { key: 'start' });
  });

  const first = definition.build({ palette: PALETTE });
  const second = definition.build({ palette: PALETTE });
  assert.deepEqual(first.keys, second.keys, 'the same source yields the same ids');
  assert.deepEqual(
    first.flowSet.flows[0]?.nodes.map((node) => node.id),
    ['start', 'start_2'],
    'a repeated authoring key gets its own id instead of merging two entities',
  );
  assert.deepEqual(first.duplicateKeys, ['node:main/start']);

  const locked = definition.build({ palette: PALETTE, lockfile: new Map([['node:main/start', 'inject_legacy']]) });
  assert.equal(locked.flowSet.flows[0]?.nodes[0]?.id, 'inject_legacy');
});

test('layout places nodes by wire depth and boxes each group around its members', () => {
  const definition = defineFlowSet((f) => {
    const tab = f.flow('main');
    const group = tab.group('kpi', { name: 'KPIs' });
    const start = tab.node('inject', { key: 'start' });
    const work = group.node('function', { key: 'work' });
    const reply = tab.node('http response', { key: 'reply' });
    tab.chain(start, work, reply);
  });

  const placed = layoutFlowSet(definition.build({ palette: PALETTE, layout: false }).flowSet);
  const nodes = placed.flows[0]?.nodes ?? [];
  assert.equal(nodes[0]?.geometry?.x, 120);
  assert.equal(nodes[1]?.geometry?.x, 310, 'the second column is one column width further right');
  assert.equal(nodes[2]?.geometry?.x, 500);

  const group = placed.flows[0]?.groups[0];
  assert.ok((group?.geometry.w ?? 0) > 0 && (group?.geometry.h ?? 0) > 0, 'the group box has been computed');
  assert.ok(
    (group?.geometry.x ?? 0) < (nodes[1]?.geometry?.x ?? 0) && (group?.geometry.y ?? 0) < (nodes[1]?.geometry?.y ?? 0),
    'the box encloses its member',
  );
});

test('the emitted file reflects the authored flow set', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('orders', { label: 'Orders API' });
      const start = tab.node('inject', { key: 'start', topic: 'orders' });
      const reply = tab.node('http response', { key: 'reply' });
      tab.chain(start, reply);
    }),
  );

  const entries = emitEntries(flowSet, { palette: PALETTE });
  const tab = entries.find((entry) => entry['type'] === 'tab');
  assert.deepEqual(Object.keys(tab as object), ['id', 'type', 'label', 'disabled', 'info']);

  const inject = entries.find((entry) => entry['id'] === 'start');
  assert.deepEqual(Object.keys(inject as object).slice(0, 3), ['id', 'type', 'z']);
  assert.equal(inject?.['topic'], 'orders');
  assert.deepEqual(inject?.['wires'], [['reply']]);
});

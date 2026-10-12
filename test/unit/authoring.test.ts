import assert from 'node:assert/strict';
import test from 'node:test';

import { defineFlowSet } from '../../src/authoring/defineFlowSet.ts';
import { defineSubflowLibrary, subflows } from '../../src/authoring/library.ts';
import { DEFAULT_SITE_SIZES, dashboard, dashboardIn } from '../../src/authoring/helpers/dashboard.ts';
import { layoutFlowSet } from '../../src/authoring/layout.ts';
import { P } from '../../src/authoring/params.ts';
import { emitEntries } from '../../src/emit/flowJson.ts';
import { eachConfig, eachNode, type FlowSet } from '../../src/model/entities.ts';
import { emitFlowSet } from '../../src/emit/flowJson.ts';
import { parseFlowFile } from '../../src/import/fromFlowJson.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
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
    defaults: {
      name: paletteProperty({ value: '' }),
      path: paletteProperty({ value: '/ui' }),
      theme: paletteProperty({ value: '' }),
      site: paletteProperty({ value: '' }),
    },
  }),
  ui_tab: paletteType('ui_tab', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_tab',
    version: '3.6.6',
    category: 'config',
    defaults: {
      name: paletteProperty({ value: '' }),
      label: paletteProperty({ value: '' }),
      icon: paletteProperty({ value: '' }),
      order: paletteProperty({ value: 0 }),
    },
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
      order: paletteProperty({ value: 0 }),
    },
  }),
  ui_text: paletteType('ui_text', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_text',
    version: '3.6.6',
    inputs: 1,
    outputs: 0,
    defaults: {
      group: paletteProperty({ type: 'ui_group', required: true }),
      name: paletteProperty({ value: '' }),
      order: paletteProperty({ value: 0 }),
      format: paletteProperty({ value: '' }),
    },
  }),
  ui_template: paletteType('ui_template', {
    module: 'node-red-dashboard',
    nodeSet: 'node-red-dashboard/ui_template',
    version: '3.6.6',
    inputs: 1,
    outputs: 0,
    defaults: {
      group: paletteProperty({ type: 'ui_group', required: true }),
      name: paletteProperty({ value: '' }),
      order: paletteProperty({ value: 0 }),
      width: paletteProperty({ value: 0 }),
      height: paletteProperty({ value: 0 }),
      format: paletteProperty({ value: '' }),
      storeOutMessages: paletteProperty({ value: true }),
      fwdInMessages: paletteProperty({ value: true }),
      resendOnRefresh: paletteProperty({ value: false }),
      templateScope: paletteProperty({ value: 'local' }),
      className: paletteProperty({ value: '' }),
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
      order: paletteProperty({ value: 0 }),
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

/**
 * The dashboard coverage the v1 review asked for: two pages in one flow set, a `ui_template` with
 * a real body, the `ui_base` theme/site pair, and the `order` convention that decides what the
 * reader sees first. All four are emitted *and* read back, because the editor's own ordering rules
 * are the part that a hand-written test tends to skip.
 */
test('two dashboard pages, a template body and order conventions survive a round trip', () => {
  const template = `<div style="padding:4px">\n  <b ng-bind="msg.payload"></b>\n  <span>\\o/ "quoted"</span>\n</div>`;

  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('ops', { label: 'Ops' });
      const dash = dashboardIn(tab, { baseName: 'Ops', site: { name: 'Ops console' }, theme: 'dark' });

      const first = dash.tab('page_one', { name: 'First', order: 1, icon: 'dashboard' });
      const second = dash.tab('page_two', { name: 'Second', order: 2 });

      const panelOne = dash.group('panel_one', first, { name: 'Overview', width: 6, order: 1 });
      const panelTwo = dash.group('panel_two', second, { name: 'Details', width: 12, order: 2 });

      dash.gauge(panelOne, { name: 'load', min: 0, max: 100, order: 2 });
      dash.text(panelOne, { name: 'status', order: 1 });
      dash.template(panelTwo, { key: 'report', name: 'report', format: template, height: 4, order: 1 });
    }),
  );

  const configs = eachConfig(flowSet);
  const base = configs.find((config) => config.type === 'ui_base');
  assert.deepEqual(
    base?.props.known['site'],
    { name: 'Ops console', sizes: DEFAULT_SITE_SIZES },
    'ui_base.site is the object the dashboard reads, with the grid geometry its client requires',
  );
  assert.equal(base?.props.known['theme'], 'dark', 'ui_base.theme is written');
  assert.equal(base?.props.known['path'], '/ui', 'an untouched default is still materialised');

  const tabs = configs.filter((config) => config.type === 'ui_tab');
  assert.deepEqual(tabs.map((config) => config.props.known['name']), ['First', 'Second']);
  assert.deepEqual(tabs.map((config) => config.props.known['order']), [1, 2]);

  const groups = configs.filter((config) => config.type === 'ui_group');
  assert.deepEqual(
    groups.map((group) => [group.props.known['tab'], group.props.known['order'], group.props.known['width']]),
    [['page_one', 1, 6], ['page_two', 2, 12]],
    'each panel points at its own page, and keeps its order and width',
  );

  const widgets = eachNode(flowSet).filter((node) => node.type.startsWith('ui_'));
  assert.deepEqual(
    widgets.map((node) => [node.type, node.props.known['group'], node.props.known['order']]),
    [['ui_gauge', 'panel_one', 2], ['ui_text', 'panel_one', 1], ['ui_template', 'panel_two', 1]],
  );

  // The template body is data: quotes, backslashes, newlines and `$` included. It is stored
  // verbatim, not interpolated and not escaped a second time.
  const report = widgets.find((node) => node.type === 'ui_template');
  assert.equal(report?.props.known['format'], template);
  assert.equal(report?.props.known['height'], 4);

  // Emit, read back, and require the same tree: this is the property the editor depends on when
  // it reloads the page and re-registers every config node.
  const document = emitFlowSet(flowSet, { palette: PALETTE });
  const reparsed = normalizeFlowSet(parseFlowFile(JSON.parse(document), { palette: PALETTE }), { palette: PALETTE });
  assert.equal(emitFlowSet(reparsed, { palette: PALETTE }), document, 'the emitted document is a fixed point');

  const entries = JSON.parse(document) as Record<string, unknown>[];
  const templateEntry = entries.find((entry) => entry['id'] === 'report');
  assert.equal(templateEntry?.['format'], template, 'the template body is byte-identical after emission');
  assert.equal(templateEntry?.['group'], 'panel_two');
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

test('an unwired subflow instance still has one wire array per declared output', () => {
  const definition = defineFlowSet((f) => {
    const pass = f.subflow('pass', { name: 'pass', ports: { in: ['value'], out: ['value', 'error'] } }, (s) => {
      const work = s.node('inject', { key: 'work' });
      s.in(work);
      s.out(work, 0);
    });
    f.flow('main').instance(pass, { key: 'pass_1' });
  });

  // The palette cannot answer for an inline subflow: it is not in `GET /nodes`, and the flow set is
  // normalised before the subflow overlay exists. The definition's own ports are the authority, and
  // the editor writes one array per output whether or not anything is wired to it.
  const instance = definition.build({ palette: PALETTE }).flowSet.flows[0]?.nodes[0];
  assert.deepEqual(instance?.wires, [[], []], 'two declared outputs, two wire arrays');
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

test('a value that only looks like a handle stays data, and a real one becomes an id', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      const broker = f.config('mqtt-broker', { key: 'broker', port: 1883 });
      // A property *value* that happens to have `id` and `type` is data, not a reference: the
      // old conversion turned it into the bare string `"a"`.
      tab.untyped('inject', { key: 'start', payload: { id: 'a', type: 'b' }, broker });
      // A forward reference cannot be a handle at all — the variable does not exist yet — so an
      // imported file's forward reference is written as the id it already has.
      tab.untyped('link out', { key: 'send', links: ['receive'] });
      tab.untyped('link in', { key: 'receive' });
    }),
  );

  const nodes = flowSet.flows[0]?.nodes ?? [];
  assert.deepEqual(nodes[0]?.props.known['payload'], { id: 'a', type: 'b' }, 'a payload keeps its shape');
  assert.equal(nodes[0]?.props.extras['broker'], 'broker', 'a handle still becomes its id');
  assert.deepEqual(nodes[1]?.props.extras['links'], ['receive'], 'a raw id stays a raw id');
});

test('a group keeps the box it was given, and gets one computed when it has none', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      const imported = tab.group('imported', { name: 'imported', x: 95, y: 355, w: 550, h: 422 });
      const computed = tab.group('computed', { name: 'computed' });
      imported.node('inject', { key: 'a', x: 120, y: 400 });
      computed.node('inject', { key: 'b', x: 400, y: 400 });
    }),
  );

  const groups = flowSet.flows[0]?.groups ?? [];
  assert.deepEqual(groups[0]?.geometry, { x: 95, y: 355, w: 550, h: 422 });
  assert.notDeepEqual(groups[1]?.geometry, { x: 0, y: 0, w: 0, h: 0 }, 'an unplaced group is boxed by the layout');
});

test('a subflow body can hold a group, and a subflow carries its meta and port geometry', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const sub = f.subflow(
        'scale',
        {
          name: 'scale',
          meta: { 'node-red-dashboard': '3.6.6' },
          params: { factor: P.num(2) },
          ports: { in: ['value'], out: ['scaled'], inPosition: { x: 140, y: 200 } },
        },
        (s) => {
          const group = s.group('body', { name: 'body', x: 10, y: 20, w: 300, h: 200 });
          const work = group.node('function', { key: 'work', func: 'return msg;' });
          s.in(work);
          s.out(work, 0);
        },
      );
      const tab = f.flow('main');
      tab.instance(sub, { key: 'use', env: { factor: 3 } });
    }),
  );

  const subflow = flowSet.subflows[0];
  assert.deepEqual(subflow?.meta, { 'node-red-dashboard': '3.6.6' });
  assert.deepEqual(subflow?.ports.inPosition, { x: 140, y: 200 });
  assert.deepEqual(subflow?.groups.map((group) => group.id), ['body']);
  assert.equal(subflow?.nodes[0]?.g, 'body', 'the node belongs to the group inside the subflow');

  const instance = flowSet.flows[0]?.nodes[0];
  assert.deepEqual(instance?.env, [{ name: 'factor', type: 'num', value: '3' }]);
});

test('an instance can carry the whole envelope an imported file had', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const sub = f.subflow('scale', { name: 'scale' }, () => {});
      const tab = f.flow('main');
      tab.instance(sub, {
        key: 'use',
        disabled: true,
        x: 300,
        y: 120,
        props: { name: '', info: 'imported instance', l: false },
      });
    }),
  );

  const instance = flowSet.flows[0]?.nodes[0];
  assert.equal(instance?.disabled, true);
  assert.deepEqual(instance?.geometry, { x: 300, y: 120 });
  assert.equal(instance?.props.extras['info'], 'imported instance');
  assert.equal(instance?.props.extras['l'], false);
});

test('a config node can be scoped to the container, the way an imported file scopes it', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      const tab = f.flow('main');
      // The editor's default: a config node dropped on a tab's canvas is global.
      tab.untypedConfig('mqtt-broker', { key: 'shared', port: 1883 });
      // What a hand-written or programmatic flow file may say instead.
      tab.untypedConfig('mqtt-broker', { key: 'scoped', port: 1884 }, { scope: 'container' });
    }),
  );

  assert.deepEqual(flowSet.configs.map((config) => config.id), ['shared']);
  assert.deepEqual(flowSet.flows[0]?.configs.map((config) => config.id), ['scoped']);
});

test('undeclared properties have a home, so a closed property bag is still lossless', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      f.manifest({ env: { hint: P.str('node-red-dashboard') }, modules: { 'node-red-dashboard': '3.6.6', 'node-red': '5.0.8' } });
      const tab = f.flow('main');
      tab.node('inject', { key: 'start', topic: 'orders', extras: { l: false, icon: 'x.svg' } });
      tab.untyped('inject', { key: 'other', env: { p: P.str('v') } });
    }),
  );

  const nodes = flowSet.flows[0]?.nodes ?? [];
  assert.deepEqual(Object.keys(nodes[0]?.props.extras ?? {}), ['l', 'icon'], 'the bag keeps its order');
  assert.deepEqual(Object.keys(nodes[0]?.props.known ?? {}), ['name', 'topic', 'payload', 'once']);
  assert.deepEqual(nodes[1]?.env, [{ name: 'p', type: 'str', value: 'v' }], 'a node-level env survives');

  assert.deepEqual(flowSet.manifest, {
    id: 'global-config',
    env: [{ name: 'hint', type: 'str', value: 'node-red-dashboard' }],
  });
  assert.deepEqual(flowSet.modules, { 'node-red-dashboard': '3.6.6' }, 'a declared list replaces the derivation');
});

test('a library defines subflows once and declares them into any build', () => {
  // The library holds no builder, which is the whole point: the same file can be declared into a
  // config here, a second one there, and a test somewhere else.
  const library = defineSubflowLibrary('math', [
    {
      key: 'scale',
      options: { name: 'scale × factor', params: { factor: P.num(2) }, ports: { in: ['value'], out: ['scaled'] } },
      body: (s) => {
        const work = s.node('function', { key: 'work', func: 'return msg;' });
        s.in(work);
        s.out(work, 0);
      },
    },
    {
      key: 'double',
      options: { name: 'double', ports: { in: ['value'], out: ['doubled'] } },
      body: (s) => {
        const work = s.node('function', { key: 'twice', func: 'msg.payload *= 2; return msg;' });
        s.in(work);
        s.out(work, 0);
      },
    },
  ]);

  const flowSet = build(
    defineFlowSet((f) => {
      const handles = f.subflowFrom(library);
      const tab = f.flow('main');
      tab.instance(handles.get('scale') as never, { key: 'first', env: { factor: 3 } });
      tab.instance(handles.get('double') as never, { key: 'second' });
    }),
  );

  assert.deepEqual(flowSet.subflows.map((subflow) => subflow.id), ['scale', 'double']);
  assert.deepEqual(flowSet.subflows[0]?.ports.in[0], [{ node: 'work' }]);
  assert.deepEqual(
    flowSet.flows[0]?.nodes.map((node) => node.type),
    ['subflow:scale', 'subflow:double'],
  );
  assert.deepEqual(flowSet.flows[0]?.nodes[0]?.env, [{ name: 'factor', type: 'num', value: '3' }]);
});

test('f.use(subflows(library)) is the same declaration, spelled as a helper', () => {
  const library = defineSubflowLibrary('one', [
    { key: 'echo', options: { name: 'echo', ports: { in: ['value'], out: ['same'] } }, body: (s) => s.in(s.node('function', { key: 'pass', func: 'return msg;' }), 0) },
  ]);

  const flowSet = build(
    defineFlowSet((f) => {
      const handles = f.use(subflows(library));
      const tab = f.flow('main');
      tab.instance(handles.get('echo') as never, { key: 'use' });
    }),
  );
  assert.deepEqual(flowSet.subflows.map((subflow) => subflow.id), ['echo']);
  assert.equal(flowSet.flows[0]?.nodes[0]?.type, 'subflow:echo');
});

test('the shapes the v1 review listed as untested', () => {
  const flowSet = build(
    defineFlowSet((f) => {
      // A subflow inside a subflow body, with an instance of the outer one in a tab.
      const inner = f.subflow('inner', { name: 'inner', ports: { in: ['value'], out: ['same'] } }, (s) => {
        const pass = s.node('function', { key: 'pass', func: 'return msg;' });
        s.in(pass);
        s.out(pass, 0);
      });
      f.subflow('outer', { name: 'outer', ports: { in: ['value'], out: ['same'] } }, (s) => {
        const use = s.instance(inner, { key: 'inner_use' });
        s.in(use);
        s.out(use, 0);
      });

      const tab = f.flow('main');
      // Two instances of one definition, in one tab, with different overrides.
      const outer = f.subflow('factor', { name: 'factor', params: { factor: P.num(2) }, ports: { in: ['value'], out: ['scaled'] } }, (s) => {
        const work = s.node('function', { key: 'work', func: 'return msg;' });
        s.in(work);
        s.out(work, 0);
      });
      const three = tab.instance(outer, { key: 'three', env: { factor: 3 } });
      const five = tab.instance(outer, { key: 'five', env: { factor: 5 } });
      assert.notEqual(three.id, five.id);

      // A hand-authored junction and a link call, both of which are ordinary nodes to the IR.
      const junction = tab.node('junction', { key: 'join' });
      const call = tab.node('link call', { key: 'call', name: 'far away', linkType: 'static', links: ['receive_1'] });
      const receive = tab.untyped('link in', { key: 'receive', name: 'receive_1', mode: 'link' });
      tab.chain(receive, junction, call);
    }),
  );

  assert.deepEqual(flowSet.subflows.map((subflow) => subflow.id), ['inner', 'outer', 'factor']);
  const outer = flowSet.subflows[1];
  assert.deepEqual(outer?.nodes.map((node) => node.type), ['subflow:inner']);
  assert.deepEqual(outer?.ports.in[0], [{ node: 'inner_use' }]);

  const tab = flowSet.flows[0];
  assert.deepEqual(
    tab?.nodes.map((node) => node.id),
    ['three', 'five', 'join', 'call', 'receive'],
  );
  assert.deepEqual(tab?.nodes[0]?.env, [{ name: 'factor', type: 'num', value: '3' }]);
  assert.deepEqual(tab?.nodes[1]?.env, [{ name: 'factor', type: 'num', value: '5' }]);
  assert.equal(tab?.nodes[2]?.type, 'junction');
  assert.deepEqual(
    tab?.nodes.find((node) => node.id === 'call')?.props.extras['links'] ?? tab?.nodes.find((node) => node.id === 'call')?.props.known['links'],
    ['receive_1'],
    'a raw id in a reference property stays a raw id',
  );
});

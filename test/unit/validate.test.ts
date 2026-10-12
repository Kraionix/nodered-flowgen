import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowSet, Node, NodeProps } from '../../src/model/entities.ts';
import { normalizeFlowSet, normalizeFlowSetWithFixes } from '../../src/model/normalize.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';
import { defaultValidators, overlayRulesValidator } from '../../src/validate/index.ts';
import { countBySeverity, hasErrors } from '../../src/diagnostics/index.ts';
import { formatProblems, formatSkipped, runValidators, type Validator } from '../../src/validate/report.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      topic: paletteProperty({ value: '' }),
      once: paletteProperty({ value: false }),
      repeat: paletteProperty({ value: '' }),
    },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883, required: true }) },
    credentials: { user: paletteProperty({ value: '' }) },
  }),
  'mqtt in': paletteType('mqtt in', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      broker: paletteProperty({ type: 'mqtt-broker', required: true }),
      qos: paletteProperty({ value: '0' }),
    },
  }),
  debug: paletteType('debug', {
    module: 'node-red',
    nodeSet: 'node-red/debug',
    version: '5.0.8',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }), active: paletteProperty({ value: true }) },
  }),
};

function props(known: Record<string, unknown> = {}, extras: Record<string, unknown> = {}): NodeProps {
  return { known, extras };
}

function node(id: string, type: string, init: Partial<Node> = {}): Node {
  return { id, type, props: props(), wires: [], ...init };
}

/**
 * Fixtures go through normalisation, exactly like the real pipeline does (authoring → normalise
 * → validate): wire arrays are padded to the declared port count, so a fixture never trips the
 * static arity check by accident. That check is exercised separately, on a raw IR.
 */
function flowSet(nodes: readonly Node[], extra: Partial<FlowSet> = {}): FlowSet {
  return normalizeFlowSet({ subflows: [], configs: [], loose: [], modules: {}, flows: [{ id: 'tab_1', label: 'Main', groups: [], nodes, configs: [] }], ...extra }, { palette: PALETTE });
}

/** A flow set normalisation deliberately did *not* repair. */
function rawFlowSet(nodes: readonly Node[], extra: Partial<FlowSet> = {}): FlowSet {
  return { subflows: [], configs: [], loose: [], modules: {}, flows: [{ id: 'tab_1', label: 'Main', groups: [], nodes, configs: [] }], ...extra };
}

type ValidatorOptions = Parameters<typeof defaultValidators>[0];

function validate(flowSetValue: FlowSet, options: ValidatorOptions = {}) {
  return runValidators(defaultValidators(options), { flowSet: flowSetValue, palette: PALETTE }, { mode: 'collect' });
}

/**
 * Codes at error/warn level. Info-level findings (`graph/unreachable`) are normal in these
 * single-node fixtures and would otherwise drown the assertions; tests that care about them
 * inspect the report directly.
 */
function codes(flowSetValue: FlowSet, options: ValidatorOptions = {}) {
  return validate(flowSetValue, options)
    .problems.filter((problem) => problem.severity !== 'info')
    .map((problem) => problem.code);
}

// --------------------------------------------------------------------------------------
// Palette checks
// --------------------------------------------------------------------------------------

test('palette/unknown-type fires for a type the palette does not know', () => {
  assert.deepEqual(codes(flowSet([node('a', 'inhouse-plc')])), ['palette/unknown-type']);
  assert.deepEqual(codes(flowSet([node('a', 'inject')])), []);
});

test('palette/unknown-type also fires for an instance of a subflow the flow set does not define', () => {
  assert.deepEqual(codes(flowSet([node('a', 'subflow:missing')])), ['palette/unknown-type']);
  const withDefinition = flowSet([node('a', 'subflow:scale', { z: 'scale' })], {
    subflows: [
      {
        id: 'scale',
        name: 'scale',
        env: [],
        meta: {},
        ports: { in: [], out: [], status: [] },
        nodes: [],
        groups: [],
        configs: [],
      },
    ],
  });
  assert.deepEqual(codes(withDefinition), []);
});

test('palette/unknown-property warns about properties the node does not declare', () => {
  const problems = runValidators(
    defaultValidators(),
    { flowSet: flowSet([node('a', 'inject', { props: props({ topic: 'x' }, { toppic: 'typo' }) })]), palette: PALETTE },
    { mode: 'collect' },
  ).problems;

  assert.deepEqual(
    problems.filter((problem) => problem.severity !== 'info').map((problem) => [problem.code, problem.severity, problem.path]),
    [['palette/unknown-property', 'warn', 'props.toppic']],
  );
});

test('palette/missing-required fires for a required property with no value anywhere', () => {
  assert.deepEqual(codes(flowSet([node('a', 'mqtt in')])), ['palette/missing-required']);
  assert.deepEqual(
    codes(
      flowSet([
        node('a', 'mqtt in', { props: props({ broker: 'broker_1' }) }),
        node('broker_1', 'mqtt-broker', { props: props({ name: 'b', port: 1883 }) }),
      ]),
    ),
    [],
  );
});

test('palette/type-mismatch fires when a value contradicts the declared default', () => {
  const wrong = flowSet([node('a', 'inject', { props: props({ once: 'yes' }) })]);
  assert.deepEqual(codes(wrong), ['palette/type-mismatch']);

  const right = flowSet([node('a', 'inject', { props: props({ once: true }) })]);
  assert.deepEqual(codes(right), []);
});

test('palette/ref-missing and palette/ref-wrong-type cover dangling and mistyped references', () => {
  const dangling = flowSet([node('a', 'mqtt in', { props: props({ broker: 'nowhere' }) })]);
  assert.deepEqual(codes(dangling), ['palette/ref-missing']);

  const mistyped = flowSet([
    node('a', 'mqtt in', { props: props({ broker: 'b' }) }),
    node('b', 'inject', { z: 'tab_1' }),
  ]);
  assert.deepEqual(codes(mistyped), ['palette/ref-wrong-type']);

  const fine = flowSet([
    node('a', 'mqtt in', { props: props({ broker: 'b' }) }),
    node('b', 'mqtt-broker', { z: 'tab_1' }),
  ]);
  assert.deepEqual(codes(fine), []);
});

test('palette/module-version-drift compares the flow manifest with the palette', () => {
  const missing = flowSet([], { modules: { 'node-red-dashboard': '3.6.6' } });
  assert.deepEqual(codes(missing), ['palette/module-version-drift']);

  // Normalisation removes the core module from the manifest (Node-RED excludes it), so a core
  // version mismatch can only be observed on a raw flow set.
  const mismatched = rawFlowSet([], { modules: { 'node-red': '5.0.7' } });
  assert.deepEqual(codes(mismatched), ['palette/module-version-drift']);
  assert.equal(validate(mismatched).problems[0]?.severity, 'warn', 'the core version is a warning, not a failure');

  const matching = flowSet([], { modules: { 'node-red': '5.0.8' } });
  assert.deepEqual(codes(matching), []);
});

// --------------------------------------------------------------------------------------
// Graph checks
// --------------------------------------------------------------------------------------

test('graph/duplicate-id fires when an id is reused', () => {
  const duplicated = flowSet([node('a', 'inject'), node('a', 'debug', { z: 'tab_1' })]);
  assert.ok(codes(duplicated).includes('graph/duplicate-id'));
});

test('graph/container-missing covers unknown containers and containerless nodes', () => {
  const unknownContainer = flowSet([node('a', 'inject', { z: 'tab_gone' })]);
  assert.deepEqual(codes(unknownContainer), ['graph/container-missing']);

  const loose = flowSet([], { loose: [node('a', 'inject')] });
  const problems = runValidators(
    defaultValidators(),
    { flowSet: loose, palette: PALETTE },
    { mode: 'collect' },
  ).problems.filter((problem) => problem.severity !== 'info');
  assert.deepEqual(problems.map((problem) => [problem.code, problem.severity]), [['graph/container-missing', 'warn']]);
});

test('graph/wire-target-missing fires for a wire into nowhere', () => {
  const dangling = flowSet([node('a', 'inject', { wires: [['ghost']] })]);
  assert.deepEqual(codes(dangling), ['graph/wire-target-missing']);

  const fine = flowSet([node('a', 'inject', { wires: [['b']] }), node('b', 'debug', { z: 'tab_1' })]);
  assert.deepEqual(codes(fine), []);
});

test('graph/wire-arity catches a raw IR whose wire arrays do not match the ports', () => {
  // Normalisation *repairs* this (the editor pads on export too), so the check is only
  // reachable on a flow set that was not normalised — which is exactly what it is for.
  const short = rawFlowSet([node('a', 'inject', { wires: [] })]);
  assert.deepEqual(codes(short), ['graph/wire-arity']);

  const long = rawFlowSet([node('a', 'inject', { wires: [[], [], []] })]);
  assert.deepEqual(codes(long), ['graph/wire-arity']);

  const repaired = normalizeFlowSetWithFixes(short, { palette: PALETTE });
  assert.deepEqual(codes(repaired.flowSet), []);
  assert.deepEqual(repaired.fixes.map((fix) => [fix.code, fix.severity, fix.path]), [
    ['normalize/wire-arity', 'info', 'wires'],
  ]);
  assert.match(repaired.fixes[0]?.message ?? '', /adjusted from 0 to 1 array/);
});

test('graph/group-membership covers missing groups, cross-container membership and empty groups', () => {
  const missing = flowSet([node('a', 'inject', { g: 'group_gone' })]);
  assert.deepEqual(codes(missing), ['graph/group-membership']);

  const crossContainer = normalizeFlowSet(
    rawFlowSet([], {
      flows: [
        {
          id: 'tab_1',
          label: 'Main',
          groups: [],
          nodes: [node('a', 'inject', { z: 'tab_1', g: 'group_1' })],
          configs: [],
        },
        {
          id: 'tab_2',
          label: 'Other',
          groups: [{ id: 'group_1', name: 'G', z: 'tab_2', geometry: { x: 0, y: 0, w: 10, h: 10 } }],
          nodes: [],
          configs: [],
        },
      ],
    }),
    { palette: PALETTE },
  );
  const problems = runValidators(
    defaultValidators(),
    { flowSet: crossContainer, palette: PALETTE },
    { mode: 'collect' },
  ).problems;
  assert.deepEqual(
    problems.filter((problem) => problem.severity !== 'info').map((problem) => problem.code),
    ['graph/group-membership'],
  );
});

test('graph/config-cycle detects a reference loop the runtime refuses to start', () => {
  const twoBrokers: Record<string, PaletteType> = {
    ...PALETTE,
    'tls-config': paletteType('tls-config', {
      category: 'config',
      defaults: { name: paletteProperty({ value: '' }), peer: paletteProperty({ type: 'tls-config' }) },
    }),
  };
  const cyclic = flowSet([], {
    configs: [
      { id: 'c1', type: 'tls-config', props: props({ peer: 'c2' }) },
      { id: 'c2', type: 'tls-config', props: props({ peer: 'c1' }) },
    ],
  });
  const report = runValidators(defaultValidators(), { flowSet: cyclic, palette: twoBrokers }, { mode: 'collect' });
  assert.deepEqual(report.problems.map((problem) => problem.code), ['graph/config-cycle']);
  assert.match(report.problems[0]?.message ?? '', /c1 → c2 → c1|c2 → c1 → c2/);
});

test('graph/subflow-recursion detects a subflow that contains itself', () => {
  const recursive = flowSet([], {
    subflows: [
      {
        id: 'scale',
        name: 'scale',
        env: [],
        meta: {},
        ports: { in: [], out: [], status: [] },
        nodes: [node('inner', 'subflow:scale', { z: 'scale' })],
        groups: [],
        configs: [],
      },
    ],
  });
  const report = runValidators(defaultValidators(), { flowSet: recursive, palette: PALETTE }, { mode: 'collect' });
  assert.deepEqual(
    report.problems.filter((problem) => problem.severity !== 'info').map((problem) => problem.code),
    ['graph/subflow-recursion'],
  );
});

test('graph/unreachable reports isolated nodes as info only', () => {
  const isolated = flowSet([node('a', 'debug', { z: 'tab_1' })]);
  const problems = runValidators(
    defaultValidators(),
    { flowSet: isolated, palette: PALETTE },
    { mode: 'collect' },
  ).problems;
  assert.deepEqual(problems.map((problem) => [problem.code, problem.severity]), [['graph/unreachable', 'info']]);
  assert.equal(hasErrors(problems), false);
});

// --------------------------------------------------------------------------------------
// Project rules, skip reporting, dispatch modes
// --------------------------------------------------------------------------------------

test('overlay rules count nodes per scope and report overlay/<code>', () => {
  const rules = [
    {
      code: 'single-base',
      type: 'ui_base',
      exactly: 1,
      scope: 'flow-set' as const,
      message: 'a dashboard needs exactly one ui_base',
      hint: 'add one ui_base config node',
    },
  ];
  const palette: Record<string, PaletteType> = {
    ui_base: paletteType('ui_base', { category: 'config' }),
    ui_gauge: paletteType('ui_gauge', { inputs: 1, outputs: 0 }),
  };
  const ruleValidators: readonly Validator[] = [overlayRulesValidator(rules)];
  const none = runValidators(ruleValidators, { flowSet: flowSet([]), palette }, { mode: 'collect' });
  assert.deepEqual(
    none.problems.map((problem) => [problem.code, problem.severity]),
    [['overlay/single-base', 'error']],
  );
  assert.match(none.problems[0]?.message ?? '', /found 0, expected exactly 1/);

  const one = runValidators(
    ruleValidators,
    { flowSet: flowSet([], { configs: [{ id: 'base', type: 'ui_base', props: props() }] }), palette },
    { mode: 'collect' },
  );
  assert.deepEqual(one.problems, []);
});

test('validators that need a missing capability are skipped and named', () => {
  const needsInstance: Validator = {
    name: 'runtime-probe',
    requires: ['liveInstance'],
    validate: () => [],
  };
  const report = runValidators(
    [...defaultValidators(), needsInstance],
    { flowSet: flowSet([]), palette: PALETTE },
    { mode: 'collect' },
  );

  assert.deepEqual(report.skipped, [{ name: 'runtime-probe', missing: ['liveInstance'] }]);
  assert.match(formatSkipped(report.skipped), /skipped runtime-probe: needs liveInstance/);
  assert.deepEqual(report.ran, ['palette', 'graph', 'overlay-rules']);
});

test('bail mode stops at the first validator that reports an error', () => {
  const order: string[] = [];
  const first: Validator = {
    name: 'first',
    validate: () => {
      order.push('first');
      return [{ code: 'palette/unknown-type', severity: 'error', entity: 'a', path: 'type', message: 'x' }];
    },
  };
  const second: Validator = {
    name: 'second',
    validate: () => {
      order.push('second');
      return [];
    },
  };

  const validators: readonly Validator[] = [first, second];
  const bailed = runValidators(validators, { flowSet: flowSet([]), palette: PALETTE }, { mode: 'bail' });
  assert.deepEqual(order, ['first']);
  assert.equal(bailed.hasErrors, true);
  assert.deepEqual(bailed.ran, ['first']);

  order.length = 0;
  const collected = runValidators(validators, { flowSet: flowSet([]), palette: PALETTE }, { mode: 'collect' });
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(collected.ran, ['first', 'second']);
});

test('problems format with a location and a hint, and count by severity', () => {
  const problems = runValidators(
    defaultValidators(),
    { flowSet: flowSet([node('a', 'inhouse-plc'), node('b', 'inject', { props: props({}, { toppic: 1 }) })]), palette: PALETTE },
    { mode: 'collect' },
  ).problems;

  assert.deepEqual(countBySeverity(problems), { error: 1, warn: 1, info: 2 }, 'two nodes are isolated too');
  const text = formatProblems(problems);
  assert.match(text, /error palette\/unknown-type a\.type — node type "inhouse-plc" is not in the palette/);
  assert.match(text, /hint: install the module/);
  assert.match(text, /warn palette\/unknown-property b\.props\.toppic/);
  assert.equal(formatProblems(problems, { includeInfo: false, includeHints: false }).includes('hint:'), false);
});

test('the normalised recon flow set validates cleanly apart from the known isolated node', () => {
  const flowSetValue = normalizeFlowSet(flowSet([node('a', 'inject', { wires: [['b']] }), node('b', 'debug', { z: 'tab_1' })]), {
    palette: PALETTE,
  });
  assert.deepEqual(codes(flowSetValue), []);
});

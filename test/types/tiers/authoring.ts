/**
 * Tier 1 of 4 — **authoring**, compiled from a consumer's position.
 *
 * `test/types/tsconfig.json` compiles this file with only one import root: the package entry
 * point. Nothing here reaches into `src/`, so if a tier name moves or stops being exported, this
 * file stops compiling — which is the whole point of a tier fixture. `packaging.spec.ts` compiles
 * the same file against the *installed* tarball, so the published declarations have to carry it.
 *
 * What it covers, in the order a project meets it: a subflow library, a flow set with a subflow,
 * a config node referenced across containers, a group, a dashboard page, the project config, the
 * build and the layout pass. Every intermediate value is annotated with the public type it is
 * supposed to have, so a widened return type is a red test too.
 */

import {
  dashboardIn,
  defineConfig,
  defineFlowSet,
  defineSubflowLibrary,
  layoutFlowSet,
  layoutFlowSetWithDiagnostics,
  P,
  subflows,
  type BuildOptions,
  type BuildResult,
  type ConfigScopeOptions,
  type ContainerHandle,
  type Dashboard,
  type EnvValue,
  type FlowBuilder,
  type FlowHandle,
  type FlowSet,
  type FlowgenConfig,
  type FlowSetDefinition,
  type GroupHandle,
  type InstanceOptions,
  type LayoutOptions,
  type LayoutResult,
  type NodeEnvelope,
  type NodeHandle,
  type PaletteProfile,
  type ParamDeclarations,
  type PropsFor,
  type Ref,
  type SubflowDefinition,
  type SubflowHandle,
  type SubflowOptions,
  type TargetConfig,
  type WidgetProps,
} from '@kraionix/nodered-flowgen';

// --- a subflow library: a definition without a builder ---------------------------------------

const scaleOptions: SubflowOptions = {
  name: 'scale × factor',
  info: 'Multiplies the payload by the `factor` parameter.',
  params: { factor: P.num(2), tag: P.str('default'), secret: P.cred() },
  ports: { in: ['value'], out: ['scaled'] },
};

const scaleDefinition: SubflowDefinition = {
  key: 'scale',
  options: scaleOptions,
  body: (s: SubflowHandle): void => {
    const work = s.node('function', { key: 'work', name: 'x factor', func: 'return msg;', outputs: 1 });
    s.in(work);
    s.out(work, 0);
  },
};

export const opsLibrary = defineSubflowLibrary('ops', [scaleDefinition]);

// --- the flow set ----------------------------------------------------------------------------

/**
 * Handles the fixture type-checks, kept so that "this returned the type I expect" is an assertion
 * the compiler makes rather than a comment. `Object.assign` is doing the work an `expect` would.
 */
export const collected: Record<string, unknown> = {};

export const definition: FlowSetDefinition = defineFlowSet((f: FlowBuilder): void => {
  // The library is *declared into* the builder; the handles come back keyed by library key.
  const scale = f.subflowFrom(opsLibrary).get('scale');
  if (scale === undefined) throw new Error('the library lost its definition');

  // ...and the same thing through `use`, which is how a helper module is mounted.
  const mounted = f.use(subflows(opsLibrary));
  if (!mounted.has('scale')) throw new Error('unreachable');

  f.manifest({ env: { FACTOR: P.num(2) }, modules: { 'node-red-dashboard': '3.6.6' } });

  const tab: FlowHandle = f.flow('orders', { label: 'Orders API', info: 'Generated.', env: { stage: P.str('dev') } });

  const broker = f.config('mqtt-broker', { key: 'broker', name: 'broker', port: 1883, autoConnect: false });
  const scoped: ConfigScopeOptions = { scope: 'flow-set' };
  const second: NodeHandle<'mqtt-broker'> = f.config('mqtt-broker', { key: 'broker2', name: 'second' }, scoped);

  const start: NodeHandle<'inject'> = tab.node('inject', { key: 'tick', name: 'tick', topic: 'tick', once: true });
  const publish = tab.node('mqtt out', { key: 'publish', name: 'publish', topic: 'flowgen/out', broker });
  const publishByString: Ref<'mqtt-broker'> = 'broker_1';
  const declared: PropsFor<'inject'> = { key: 'declared', name: 'declared', repeat: '2' };

  // Chains, ports and instances.
  tab.chain(start, publish);
  const classify = tab.node('switch', { key: 'classify', name: 'classify', property: 'payload', outputs: 2 });
  classify.toPort(1, publish);
  const instanceOptions: InstanceOptions = { key: 'scale_x3', name: 'scale x3', env: { factor: 3 } };
  const instance = tab.instance(scale, instanceOptions);
  tab.chain(classify, instance);

  // A group owns its members; the handle is a `Ref<'group'>` for dashboard properties.
  const group: GroupHandle = tab.group('kpi', { name: 'classifier', style: { fill: '#fff' } });
  group.add(classify);

  // The dashboard helper synthesises the `ui_base` config node it needs.
  const dash: Dashboard = dashboardIn(tab, { baseName: 'Ops' });
  const page = dash.tab('page', { name: 'KPIs', icon: 'dashboard' });
  const panel = dash.group('panel', page, { name: 'KPIs', width: 6 });
  const gauge: WidgetProps<'gauge'> = { name: 'load', min: 0, max: 100, order: 1 };
  dash.gauge(panel, gauge);

  // Escape hatches, and the generic way to reach a container.
  tab.untyped('acme-widget', { key: 'widget', vendor: 'ACME' });
  const container: ContainerHandle<string> = tab;
  container.untypedConfig('acme-gateway', { key: 'gateway' }, { scope: 'container' });

  // A second instance of the same definition in the same tab, with different overrides: the
  // builder has to keep one palette entry per definition and one id per instance.
  tab.instance(scale, { key: 'scale_again', env: { factor: 9, tag: 'x' } });

  Object.assign(collected, {
    tab,
    broker,
    scoped,
    second,
    start,
    publish,
    publishByString,
    declared,
    classify,
    instance,
    instanceOptions,
    group,
    panel,
    page,
    mounted: mounted.size,
    container: container.id,
  });
});

// --- the project around it -------------------------------------------------------------------

const localProfile: PaletteProfile = {
  snapshot: 'palettes/local.json',
  typesDirectory: 'palettes/local.d',
  cheatSheet: 'palettes/local.md',
  url: 'http://127.0.0.1:1880',
  tokenEnv: 'FLOWGEN_TOKEN',
  userDir: '.',
  coreNodesDir: 'node_modules/@node-red/nodes',
  nodeModulesDirs: ['node_modules'],
};

const localTarget: TargetConfig = { url: 'http://127.0.0.1:1880', tokenEnv: 'FLOWGEN_TOKEN', paletteProfile: 'local', prune: false };

export const config: FlowgenConfig = defineConfig({
  flowSet: definition,
  palette: { default: 'local', profiles: { local: localProfile } },
  targets: { local: localTarget },
  lockfile: '.flowgen.lock.json',
  receipts: '.flowgen/receipts',
  layout: { columnWidth: 200 },
});

// --- building and laying out -----------------------------------------------------------------

const buildOptions: BuildOptions = { palette: {}, layout: { originX: 40, originY: 40 } };
export const built: BuildResult = definition.build(buildOptions);

const layoutOptions: LayoutOptions = { columnWidth: 190, rowHeight: 120 };
const laidOut: FlowSet = layoutFlowSet(built.flowSet, layoutOptions);
const withAdvice: LayoutResult = layoutFlowSetWithDiagnostics(laidOut, { palette: buildOptions.palette });

export const keys: ReadonlyMap<string, string> = built.keys;
export const problems: LayoutResult['problems'] = withAdvice.problems;

// --- the typing vocabulary -------------------------------------------------------------------

export const envelope: NodeEnvelope = { key: 'x', x: 10, y: 20, disabled: false, extras: { l: true } };
export const params: ParamDeclarations = { factor: P.num(2), flag: P.bool(true), blob: P.json({ a: 1 }), secret: P.cred() };
export const envValue: EnvValue = 3;

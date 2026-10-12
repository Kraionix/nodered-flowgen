/**
 * IR normalisation: the editor's own fix-ups, applied to data instead of to a canvas.
 *
 * Each rule below is taken from the editor's serializer, because the goal is that a flow set
 * we emit and a flow set the editor exports are the same document:
 *
 * | rule | source |
 * |---|---|
 * | `wires` is exactly `outputs` arrays, empty ones included | `convertNode` |
 * | `d` is written only when true | `convertNode` |
 * | config nodes have no coordinates and no wires | `convertNode` (`_def.category != "config"`) |
 * | `inputLabels`/`outputLabels` only for existing, non-blank labels | `convertNode` |
 * | tab/group `env` is dropped when empty | `convertNode` |
 * | group membership lives in `nodes[]`, members carry `g` | `convertNode` group branch |
 * | subflow definitions carry no coordinates and always have `env`/`meta` | `convertSubflow` |
 *
 * Normalisation is idempotent: normalising an already normalised flow set returns an equal
 * value. That is what makes `emit → parse → emit` a fixed point, which the test suite asserts.
 */

import type { PaletteType } from '../palette/model.ts';

import type { Problem } from '../validate/problem.ts';

import type { ConfigNode, EnvParam, FlowSet, Group, Node, NodeProps } from './entities.ts';

export interface NormalizeContext {
  readonly palette: Readonly<Record<string, PaletteType>>;
}

export function normalizeFlowSet(flowSet: FlowSet, context: NormalizeContext): FlowSet {
  return normalizeFlowSetWithFixes(flowSet, context).flowSet;
}

/**
 * Normalisation that reports what it changed.
 *
 * Wire padding is a *fix*, not a validation failure — the editor does the same on export — but
 * silently repairing a flow file would hide a real authoring bug, so every repair is reported as
 * an info-level problem.
 *
 * The authoring path deliberately does not surface them: the builder pads wires itself, so a
 * node wired through one port of a three-output switch — ordinary authoring — would print an
 * info diagnostic on every validate and teach its reader to ignore the level. These messages
 * belong to foreign data, which is the `import` path.
 */
export function normalizeFlowSetWithFixes(
  flowSet: FlowSet,
  context: NormalizeContext,
): { readonly flowSet: FlowSet; readonly fixes: readonly Problem[] } {
  const fixes: Problem[] = [];
  return { flowSet: normalizeInner(flowSet, context, fixes), fixes };
}

function normalizeInner(flowSet: FlowSet, context: NormalizeContext, fixes: Problem[]): FlowSet {
  return {
    ...flowSet,
    subflows: flowSet.subflows.map((subflow) => ({
      ...subflow,
      env: subflow.env.map(normalizeEnvParam),
      nodes: subflow.nodes.map((node) => normalizeNodeWithFixes(node, context, fixes)),
      groups: subflow.groups.map(normalizeGroup),
      configs: subflow.configs.map(normalizeConfig),
    })),
    configs: flowSet.configs.map(normalizeConfig),
    loose: flowSet.loose.map((node) => normalizeNodeWithFixes(node, context, fixes)),
    flows: flowSet.flows.map((flow) => ({
      ...flow,
      env: emptyToUndefined(flow.env),
      disabled: falseToUndefined(flow.disabled),
      locked: falseToUndefined(flow.locked),
      groups: flow.groups.map(normalizeGroup),
      nodes: flow.nodes.map((node) => normalizeNodeWithFixes(node, context, fixes)),
      configs: flow.configs.map(normalizeConfig),
    })),
    modules: normalizeModules(flowSet.modules),
  };
}

export function normalizeNode(node: Node, context: NormalizeContext): Node {
  return normalizeNodeWithFixes(node, context, []);
}

function normalizeNodeWithFixes(node: Node, context: NormalizeContext, fixes: Problem[]): Node {
  const type = context.palette[node.type] ?? null;
  const wires = normalizeWires(node, type);
  if (wires.length !== node.wires.length) {
    fixes.push({
      code: 'normalize/wire-arity',
      severity: 'info',
      entity: node.id,
      path: 'wires',
      message: `wires adjusted from ${node.wires.length} to ${wires.length} array(s) to match the declared port count`,
      hint: 'the editor always writes exactly one array per output',
    });
  }

  return {
    ...node,
    disabled: falseToUndefined(node.disabled),
    env: emptyToUndefined(node.env?.map(normalizeEnvParam)),
    wires,
    inputLabels: labelsOrUndefined(node.inputLabels, effectiveInputCount(type, node.props), node),
    outputLabels: labelsOrUndefined(node.outputLabels, effectiveOutputCount(type, node.props), node),
    icon: emptyStringToUndefined(node.icon),
    geometry: normalizeGeometry(node.geometry),
  };
}

export function normalizeConfig(config: ConfigNode): ConfigNode {
  return { ...config, z: emptyStringToUndefined(config.z) };
}

export function normalizeGroup(group: Group): Group {
  return { ...group, env: emptyToUndefined(group.env?.map(normalizeEnvParam)) };
}

export function normalizeEnvParam(param: EnvParam): EnvParam {
  return param.type === '' ? { ...param, type: 'str' } : param;
}

/**
 * Pads or trims `wires` to the declared output count.
 *
 * A node whose type the palette does not know, or whose output count is computed from its
 * properties, keeps whatever it has: inventing ports would be worse than a validation warning.
 */
function normalizeWires(node: Node, type: PaletteType | null): readonly (readonly string[])[] {
  const declared = effectiveOutputCount(type, node.props);
  if (declared === null) return node.wires.map((wire) => [...wire]);

  const wires: string[][] = [];
  for (let port = 0; port < declared; port += 1) {
    wires.push([...(node.wires[port] ?? [])]);
  }
  return wires;
}

/**
 * Effective output count for wire arity, or `null` when it is not knowable statically.
 *
 * The node's **own** `outputs` property wins over the palette's `outputs`, because that is
 * what the editor serialises against: `switch` declares `outputs` as a property (the user adds
 * outputs in the editor), so a three-output switch in a flow file has three wire arrays while
 * the palette says one. Trusting the palette here truncates real wires — a defect the
 * round-trip oracle caught.
 */
export function effectiveOutputCount(type: PaletteType | null, props: NodeProps): number | null {
  const declared = numericProperty(props, 'outputs');
  if (declared !== null) return declared;
  if (type === null || type.dynamics.outputs) return null;
  return type.outputs;
}

export function effectiveInputCount(type: PaletteType | null, props: NodeProps): number | null {
  const declared = numericProperty(props, 'inputs');
  if (declared !== null) return declared;
  if (type === null || type.dynamics.inputs) return null;
  return type.inputs;
}

function numericProperty(props: NodeProps, name: string): number | null {
  const value = Object.hasOwn(props.known, name) ? props.known[name] : props.extras[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The editor writes port labels only when the port exists and the joined label is not blank;
 * a blank label array in the file would render as empty labels in the editor.
 */
function labelsOrUndefined(
  labels: readonly string[] | undefined,
  ports: number | null,
  node: Node,
): readonly string[] | undefined {
  if (labels === undefined) return undefined;
  const effectivePorts = ports ?? Math.max(node.wires.length, labels.length);
  if (effectivePorts <= 0) return undefined;
  if (labels.every((label) => label.trim() === '')) return undefined;
  return [...labels];
}

function normalizeGeometry(geometry: Node['geometry']): Node['geometry'] {
  if (geometry === undefined) return undefined;
  const normalized: { x: number; y: number; w?: number; h?: number } = { x: geometry.x, y: geometry.y };
  if (geometry.w !== undefined) normalized.w = geometry.w;
  if (geometry.h !== undefined) normalized.h = geometry.h;
  return normalized;
}

/** The manifest never carries the core module, and its keys are sorted for stable output. */
function normalizeModules(modules: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(modules)
    .filter(([module]) => module !== 'node-red' && module !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries);
}

function emptyToUndefined<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function emptyStringToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function falseToUndefined(value: boolean | undefined): boolean | undefined {
  return value === true ? true : undefined;
}

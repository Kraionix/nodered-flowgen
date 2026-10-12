/**
 * The IR: a lossless, normalised, validated in-memory flow set.
 *
 * Three rules make it worth having a separate representation at all:
 *
 * 1. **Typed edges, open core.** A node's properties are split into `known` (declared by the
 *    palette) and `extras` (everything else, preserved verbatim), so `import → emit` is
 *    lossless even for node types and Node-RED versions this build does not understand.
 * 2. **Structure is references, not strings.** `z`, `g` and `wires` point at entities; the
 *    emitter turns them into ids. That is what removes hand-written ids from the authoring
 *    surface — the author never types an id, and a rename cannot dangle a wire silently.
 * 3. **Geometry is an advisory facet.** Plans compare semantics first; `x`/`y` are node
 *    *centres* and group boxes are recomputed by the editor from DOM dimensions, so geometry
 *    is written but never treated as a contract.
 *
 * Internal editor keys (`_def`, `_config`, `_orig`, `changed`, `dirty`, `selected`, `moved`,
 * `valid`, `validationErrors`, `users`) are dropped on import so they can never be emitted.
 *
 * Optional facets are declared as `?: T | undefined` on purpose: the IR is plain data that
 * normalisation rebuilds field by field, and under `exactOptionalPropertyTypes` an explicit
 * `undefined` is only assignable when the type says so.
 */

/** An entity id, as it appears in a flow file. */
export type EntityId = string;

/** Internal keys the editor attaches to nodes at runtime; never part of the flow file. */
export const INTERNAL_NODE_KEYS: readonly string[] = [
  '_def',
  '_config',
  '_orig',
  'changed',
  'dirty',
  'selected',
  'moved',
  'valid',
  'validationErrors',
  'users',
];

/** Keys the IR models explicitly; they are never part of `known` or `extras`. */
export const STRUCTURAL_NODE_KEYS: readonly string[] = [
  'id',
  'type',
  'z',
  'g',
  'd',
  'x',
  'y',
  'w',
  'h',
  'wires',
  'credentials',
  'env',
  'nodes',
  'in',
  'out',
  'status',
];

/** A subflow parameter (`env` entry) of a tab, group, subflow definition or instance. */
export interface EnvParam {
  readonly name: string;
  /** `str`, `num`, `bool`, `json`, `cred`, `env`, `flow`, `global`. */
  readonly type: string;
  /** Stored as the flow file stores it: numbers and booleans are strings on instances. */
  readonly value: unknown;
  readonly ui?: unknown;
}

export interface Geometry {
  /** Node centre (or group top-left, as the editor computes it). */
  readonly x: number;
  readonly y: number;
  /** Only written when dimensions were explicitly requested. */
  readonly w?: number;
  readonly h?: number;
}

/** Properties of a node, split by whether the palette declares them. */
export interface NodeProps {
  readonly known: Readonly<Record<string, unknown>>;
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface Credentials {
  /** Credential values, never read from or written to version control. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface Node {
  readonly id: EntityId;
  readonly type: string;
  /** Containing tab or subflow definition. */
  readonly z?: EntityId | undefined;
  /** Containing group. */
  readonly g?: EntityId | undefined;
  /** Written as `d: true` (the editor writes `d` only when true). */
  readonly disabled?: boolean | undefined;
  readonly props: NodeProps;
  /** Subflow *instance* parameter overrides; absent for ordinary nodes. */
  readonly env?: readonly EnvParam[] | undefined;
  readonly credentials?: Credentials | undefined;
  readonly geometry?: Geometry | undefined;
  /** One entry per output port, exactly `outputs` long after normalisation. */
  readonly wires: readonly (readonly EntityId[])[];
  readonly inputLabels?: readonly string[] | undefined;
  readonly outputLabels?: readonly string[] | undefined;
  readonly icon?: string | undefined;
  readonly showLabel?: boolean | undefined;
  readonly info?: string | undefined;
}

/** A config node: no coordinates and no wires (junctions are ordinary nodes here). */
export interface ConfigNode {
  readonly id: EntityId;
  readonly type: string;
  /** Config nodes may be scoped to a tab or a subflow definition. */
  readonly z?: EntityId | undefined;
  readonly props: NodeProps;
  readonly credentials?: Credentials | undefined;
}

export interface Group {
  readonly id: EntityId;
  readonly name: string;
  /** Containing tab or subflow definition. */
  readonly z: EntityId;
  readonly style?: Readonly<Record<string, unknown>> | undefined;
  readonly env?: readonly EnvParam[] | undefined;
  readonly geometry: Geometry;
}

export interface Flow {
  readonly id: EntityId;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly locked?: boolean | undefined;
  readonly info?: string | undefined;
  readonly env?: readonly EnvParam[] | undefined;
  /** Membership order of the group's nodes is derived from node order, not stored here. */
  readonly groups: readonly Group[];
  readonly nodes: readonly Node[];
  readonly configs: readonly ConfigNode[];
}

/** One wire out of a subflow port: which internal node it reaches, and on which port. */
export interface SubflowPortLink {
  readonly node: EntityId;
  readonly port?: number;
}

export interface SubflowPorts {
  /** One entry per input port; each links the internal nodes fed by that port. */
  readonly in: readonly (readonly SubflowPortLink[])[];
  /** One entry per output port; `port` selects the internal node's output. */
  readonly out: readonly (readonly SubflowPortLink[])[];
  readonly status: readonly SubflowPortLink[];
  /** Advisory port geometry; the editor repositions ports on import. */
  readonly inPosition?: { readonly x: number; readonly y: number };
  readonly outPosition?: { readonly x: number; readonly y: number };
  readonly statusPosition?: { readonly x: number; readonly y: number };
}

export interface SubflowDef {
  readonly id: EntityId;
  readonly name: string;
  readonly info?: string | undefined;
  readonly category?: string | undefined;
  readonly color?: string | undefined;
  readonly icon?: string | undefined;
  /** Declared parameters, in order; always written, even when empty. */
  readonly env: readonly EnvParam[];
  /** Always written, even when empty. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly ports: SubflowPorts;
  readonly inputLabels?: readonly string[] | undefined;
  readonly outputLabels?: readonly string[] | undefined;
  readonly nodes: readonly Node[];
  readonly groups: readonly Group[];
  readonly configs: readonly ConfigNode[];
}

/**
 * A complete flow set: the unit `plan` and `apply` reason about.
 *
 * `modules` is the manifest written to `global-config` (Node-RED's own "this flow needs
 * node-red-dashboard@3.6.6" mechanism). It is derived from the types actually used, minus the
 * core module.
 */
export interface FlowSet {
  readonly subflows: readonly SubflowDef[];
  /** Config nodes shared by the whole flow set (no `z`). */
  readonly configs: readonly ConfigNode[];
  readonly flows: readonly Flow[];
  /**
   * Nodes with no container. The editor recovers such nodes into a scratch tab on import; the
   * IR keeps them as they were so that `import → emit` cannot silently change a flow file, and
   * validation reports them.
   */
  readonly loose: readonly Node[];
  readonly modules: Readonly<Record<string, string>>;
}

export const EMPTY_FLOW_SET: FlowSet = { subflows: [], configs: [], flows: [], loose: [], modules: {} };

export function emptyNodeProps(): NodeProps {
  return { known: {}, extras: {} };
}

/** Every node of a flow set, in emission order, including subflow contents. */
export function eachNode(flowSet: FlowSet): readonly Node[] {
  return [
    ...flowSet.subflows.flatMap((subflow) => subflow.nodes),
    ...flowSet.flows.flatMap((flow) => flow.nodes),
    ...flowSet.loose,
  ];
}

export function eachConfig(flowSet: FlowSet): readonly ConfigNode[] {
  return [
    ...flowSet.configs,
    ...flowSet.subflows.flatMap((subflow) => subflow.configs),
    ...flowSet.flows.flatMap((flow) => flow.configs),
  ];
}

export function eachGroup(flowSet: FlowSet): readonly Group[] {
  return [
    ...flowSet.subflows.flatMap((subflow) => subflow.groups),
    ...flowSet.flows.flatMap((flow) => flow.groups),
  ];
}

export function eachSubflow(flowSet: FlowSet): readonly SubflowDef[] {
  return flowSet.subflows;
}

/** All ids of the flow set; used by the id allocator and by duplicate detection. */
export function allIds(flowSet: FlowSet): readonly EntityId[] {
  return [
    ...flowSet.subflows.map((subflow) => subflow.id),
    ...eachConfig(flowSet).map((config) => config.id),
    ...eachGroup(flowSet).map((group) => group.id),
    ...flowSet.flows.map((flow) => flow.id),
    ...eachNode(flowSet).map((node) => node.id),
  ];
}

/** Looks a node up by id across the whole flow set. */
export function findNode(flowSet: FlowSet, id: EntityId): Node | null {
  for (const node of eachNode(flowSet)) {
    if (node.id === id) return node;
  }
  return null;
}

export function findConfig(flowSet: FlowSet, id: EntityId): ConfigNode | null {
  for (const config of eachConfig(flowSet)) {
    if (config.id === id) return config;
  }
  return null;
}

/**
 * Total number of output ports declared by the wires of a node (used when the palette cannot
 * say, e.g. for node types this build does not know).
 */
export function wireArity(node: Node): number {
  return node.wires.length;
}

/**
 * The authoring builder: the object an author actually calls.
 *
 * Design rules, in order of importance:
 *
 * 1. **No ids, no JSON.** Wires, group membership, containers and config references are
 *    expressed with handles; ids are derived from authoring keys, deterministically.
 * 2. **Palette defaults are materialised, not remembered.** `node('inject', {topic: 'x'})`
 *    produces every property the editor would have written, because the palette is consulted at
 *    build time. The author writes only what differs from a default. A *computed* default (a
 *    function in the node's palette entry) is never invented.
 * 3. **One authoritative node list.** Containers are views over it, so a node cannot end up in
 *    two places or in none: `z`/`g` are the only membership facts, and every derived list is
 *    filtered from them.
 * 4. **Helpers are plain functions.** `dashboard()` is not a plugin: it takes the builder and
 *    returns typed wrappers. Adding a node family is adding a file.
 */

import { isSubflowType, subflowTypeId, type PaletteType } from '../palette/model.ts';
import { subflowPaletteType } from '../palette/sources/subflow.ts';
import { subflowDefinitionLike } from '../model/subflows.ts';
import type {
  ConfigNode,
  EntityId,
  EnvParam,
  Flow,
  FlowSet,
  Group,
  Node,
  NodeProps,
  SubflowDef,
} from '../model/entities.ts';
import type { KnownType, NodeRef, PropsFor, Ref } from '../typing.ts';
import { createIdAllocator, type IdAllocator } from '../model/ids.ts';

import { toEnvOverrides, toEnvParams, type ParamDeclarations } from './params.ts';

/** Node-RED accepts a raw id wherever a reference is expected; the builder does too. */
function refId(ref: Ref): EntityId {
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Converts authored values into flow-file values: a node handle becomes its id, and handles
 * nested in arrays or objects (a `link out[]` property, a list of targets) are converted too.
 *
 * The conversion is deferred to build time on purpose (see `Builder#resolveProps`): a property
 * value that *looks* like a handle but points at nothing in this flow set is data — an inject
 * payload of `{"id": "a", "type": "b"}`, say — and must be written verbatim rather than
 * silently replaced by `"a"`.
 */
function toFlowValue(value: unknown, ids: ReadonlySet<string>, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((entry) => toFlowValue(entry, ids, depth + 1));
  if (isNodeHandle(value) && ids.has(value.id)) return value.id;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toFlowValue(entry, ids, depth + 1);
  }
  return result;
}

function isNodeHandle(value: object): value is { id: string } {
  const candidate = value as { id?: unknown; type?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.type === 'string';
}

/**
 * A handle to a node: a `NodeRef` (so it is accepted wherever a reference is expected) plus the
 * wiring methods.
 */
export interface NodeHandle<T extends string = string> extends NodeRef<T> {
  readonly id: EntityId;
  readonly type: T;
  /** Wires output `port` (default 0) to the given nodes. Returns `this` for chaining. */
  to(...targets: readonly Ref[]): NodeHandle<T>;
  toPort(port: number, ...targets: readonly Ref[]): NodeHandle<T>;
}

export interface ContainerHandle<T extends string = string> {
  readonly id: EntityId;
  readonly type: T;
  /** Creates a node inside this container. */
  node<K extends KnownType>(type: K, props?: PropsFor<K>): NodeHandle<K>;
  /** Escape hatch: any node type, with an open property bag. */
  untyped(type: string, props?: Readonly<Record<string, unknown>>): NodeHandle;
  /** Creates a config node scoped the way the container scopes them by default. */
  config<K extends KnownType>(type: K, props?: PropsFor<K>, options?: ConfigScopeOptions): NodeHandle<K>;
  /** Escape hatch for a config node whose type the palette may not cover. */
  untypedConfig(type: string, props?: Readonly<Record<string, unknown>>, options?: ConfigScopeOptions): NodeHandle;
  /** Wires each item to the next one, output 0 to input 0. */
  chain(...items: readonly Ref[]): void;
  /** Creates an instance of a subflow inside this container. */
  instance(subflow: SubflowHandle | string, options?: InstanceOptions): NodeHandle;
  /** Moves previously created nodes into this container. */
  add(...items: readonly Ref[]): void;
}

/**
 * Where a config node belongs.
 *
 * A container's default is the editor's: a config node dropped on a tab's canvas is *global*
 * (Node-RED resolves config nodes by dependency, so scoping it to the tab would only hide it
 * from other tabs), while one dropped inside a subflow belongs to that subflow. An imported
 * flow file says explicitly which it meant, so the printer can ask for either.
 */
export interface ConfigScopeOptions {
  readonly scope?: 'flow-set' | 'container';
}

export interface InstanceOptions {
  readonly key?: string;
  readonly name?: string;
  /** Parameter overrides; values are converted using the declared parameter types. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Written as `d: true`. */
  readonly disabled?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  /**
   * Anything else the instance declares, verbatim.
   *
   * A subflow instance only declares `name`, so everything an imported instance carries beyond
   * the envelope (`info`, `l`, `icon`, a property a newer runtime added) has to come through
   * here — dropping it would make `import → build` lossy for exactly the files this is for.
   */
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface FlowOptions {
  readonly key?: string;
  readonly label?: string;
  readonly info?: string;
  readonly disabled?: boolean;
  readonly locked?: boolean;
  readonly env?: ParamDeclarations;
}

export interface GroupOptions {
  readonly key?: string;
  readonly name: string;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly env?: ParamDeclarations;
  /**
   * The group's box, top-left based.
   *
   * Left out, the layout computes the box from the members — the editor's own rule, and what an
   * author almost always wants. Given, it is kept verbatim: an imported group box came from the
   * editor's DOM measurements, and recomputing it would move every group in the file.
   */
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
}

export interface SubflowOptions {
  readonly key?: string;
  readonly name?: string;
  readonly info?: string;
  readonly category?: string;
  readonly color?: string;
  readonly icon?: string;
  readonly params?: ParamDeclarations;
  /** Written verbatim; the editor's own hint list for the palette manager. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Port labels: their count defines how many input/output ports the subflow has. */
  readonly ports?: {
    readonly in?: readonly string[];
    readonly out?: readonly string[];
    /** Advisory port geometry; the editor repositions ports on import anyway. */
    readonly inPosition?: { readonly x: number; readonly y: number };
    readonly outPosition?: { readonly x: number; readonly y: number };
    readonly statusPosition?: { readonly x: number; readonly y: number };
  };
}

export interface SubflowHandle extends ContainerHandle<string> {
  readonly definitionId: EntityId;
  /** Feeds subflow input port `index` (default: the next free one) from `node`. */
  in(node: Ref, index?: number): void;
  /** Feeds subflow output port `index` from `node`'s output `port`. */
  out(node: Ref, port?: number, index?: number): void;
  /** Routes `node`'s status output to the subflow status port. */
  status(node: Ref, port?: number): void;
  /** A group inside the subflow body. A subflow body is a canvas like any other. */
  group(key: string, options: GroupOptions): GroupHandle;
}

export interface FlowHandle extends ContainerHandle<'tab'> {
  group(key: string, options: GroupOptions): GroupHandle;
}

export interface GroupHandle extends ContainerHandle<'group'> {
  /** The group's own reference, for `group`-typed properties of dashboard widgets. */
  readonly ref: Ref<'group'>;
}

export interface FlowBuilder extends ContainerHandle<'unplaced'> {
  flow(key: string, options?: FlowOptions): FlowHandle;
  subflow(key: string, options: SubflowOptions, body: (s: SubflowHandle) => void): SubflowHandle;
  /** Registers a helper module: `const dash = f.use(dashboard())`. */
  use<H>(helper: (builder: FlowBuilder) => H): H;
}

export interface BuilderOptions {
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** Authoring key → id, from the lockfile: ids stay stable across renames and reorderings. */
  readonly lockfile?: ReadonlyMap<string, string>;
}

/** Envelope keys that never become node properties. */
const ENVELOPE_KEYS = new Set(['key', 'x', 'y', 'w', 'h', 'disabled', 'env']);

interface PortLinks {
  in: { node: EntityId; port?: number }[][];
  out: { node: EntityId; port?: number }[][];
  status: { node: EntityId; port?: number }[];
}

export class Builder implements FlowBuilder {
  /** The caller's palette, extended with this flow set's own subflow instance types. */
  readonly #palette: Record<string, PaletteType>;
  readonly #allocator: IdAllocator;
  readonly #keys = new Map<string, string>();
  readonly #nodes: Node[] = [];
  readonly #configs: ConfigNode[] = [];
  readonly #flows: Flow[] = [];
  readonly #groups: Group[] = [];
  readonly #subflows: { definition: SubflowDef; ports: PortLinks }[] = [];
  readonly #params = new Map<EntityId, readonly EnvParam[]>();
  readonly #duplicateKeys: string[] = [];

  readonly id = 'unplaced';
  readonly type = 'unplaced' as const;

  constructor(options: BuilderOptions) {
    this.#palette = { ...options.palette };
    this.#allocator = createIdAllocator({ ...(options.lockfile === undefined ? {} : { locked: options.lockfile }) });
  }

  /** Authoring key → id, for the lockfile. */
  get keys(): ReadonlyMap<string, string> {
    return this.#keys;
  }

  /** Authoring keys that were used more than once; each reuse got its own id. */
  get duplicateKeys(): readonly string[] {
    return this.#duplicateKeys;
  }

  toFlowSet(): FlowSet {
    const modules: Record<string, string> = {};
    for (const type of [...this.#nodes, ...this.#configs].map((entity) => this.#palette[entity.type])) {
      if (type === undefined || type.module === 'node-red' || type.module === '') continue;
      modules[type.module] = type.version;
    }

    // Handles become ids here, once every entity exists: a reference may point *forward* (a
    // `link out` before its `link in`), so the resolution cannot happen at creation time.
    const known = new Set<string>(this.#flows.map((flow) => flow.id));
    for (const { definition } of this.#subflows) known.add(definition.id);
    for (const group of this.#groups) known.add(group.id);
    for (const config of this.#configs) known.add(config.id);
    for (const node of this.#nodes) known.add(node.id);

    const resolveProps = (props: NodeProps): NodeProps => ({
      known: this.#resolveProps(props.known, known),
      extras: this.#resolveProps(props.extras, known),
    });
    const resolveNode = (node: Node): Node => ({ ...node, props: resolveProps(node.props) });

    const nodesOf = (z: string): Node[] =>
      this.#nodes.filter((node) => (node.z ?? '') === z).map(resolveNode);
    const configsOf = (z: string): ConfigNode[] =>
      this.#configs
        .filter((config) => (config.z ?? '') === z)
        .map((config) => ({ ...config, props: resolveProps(config.props) }));
    const groupsOf = (z: string): Group[] => this.#groups.filter((group) => (group.z ?? '') === z);

    return {
      flows: this.#flows.map((flow) => ({
        ...flow,
        nodes: nodesOf(flow.id),
        configs: configsOf(flow.id),
        groups: groupsOf(flow.id),
      })),
      subflows: this.#subflows.map(({ definition }) => ({
        ...definition,
        nodes: nodesOf(definition.id),
        configs: configsOf(definition.id),
        groups: groupsOf(definition.id),
      })),
      configs: configsOf(''),
      loose: nodesOf(''),
      modules,
    };
  }

  #resolveProps(
    props: Readonly<Record<string, unknown>>,
    known: ReadonlySet<string>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props)) resolved[name] = toFlowValue(value, known);
    return resolved;
  }

  // ------------------------------------------------------------------------------------
  // Containers
  // ------------------------------------------------------------------------------------

  flow(key: string, options: FlowOptions = {}): FlowHandle {
    const id = this.#allocate(`tab:${key}`, key);
    const env = options.env === undefined ? undefined : toEnvParams(options.env);
    this.#flows.push({
      id,
      label: options.label ?? key,
      ...(options.info === undefined ? {} : { info: options.info }),
      ...(options.disabled === true ? { disabled: true } : {}),
      ...(options.locked === true ? { locked: true } : {}),
      ...(env === undefined ? {} : { env }),
      groups: [],
      nodes: [],
      configs: [],
    });

    const methods = this.#containerMethods(id, undefined);
    return { id, type: 'tab', ...methods, group: (groupKey, groupOptions) => this.#createGroup(id, groupKey, groupOptions) };
  }

  subflow(key: string, options: SubflowOptions, body: (s: SubflowHandle) => void): SubflowHandle {
    const id = this.#allocate(`subflow:${key}`, key);
    const env = options.params === undefined ? [] : toEnvParams(options.params);
    const ports: PortLinks = {
      in: Array.from({ length: options.ports?.in?.length ?? 0 }, () => []),
      out: Array.from({ length: options.ports?.out?.length ?? 0 }, () => []),
      status: [],
    };

    const definition: SubflowDef = {
      id,
      name: options.name ?? key,
      ...(options.info === undefined ? {} : { info: options.info }),
      ...(options.category === undefined ? {} : { category: options.category }),
      ...(options.color === undefined ? {} : { color: options.color }),
      ...(options.icon === undefined ? {} : { icon: options.icon }),
      env,
      meta: { ...(options.meta ?? {}) },
      ports: {
        ...ports,
        ...(options.ports?.inPosition === undefined ? {} : { inPosition: options.ports.inPosition }),
        ...(options.ports?.outPosition === undefined ? {} : { outPosition: options.ports.outPosition }),
        ...(options.ports?.statusPosition === undefined ? {} : { statusPosition: options.ports.statusPosition }),
      },
      ...(options.ports?.in === undefined ? {} : { inputLabels: [...options.ports.in] }),
      ...(options.ports?.out === undefined ? {} : { outputLabels: [...options.ports.out] }),
      nodes: [],
      groups: [],
      configs: [],
    };
    this.#subflows.push({ definition, ports });
    this.#params.set(id, env);
    // Instance types are not in `GET /nodes` (inline subflows never are), so the builder adds
    // them itself: without this, an instance would be an unknown type whose ports and defaults
    // could not be materialised. `subflowOverlay` does the same for validation and codegen.
    this.#palette[subflowTypeId(id)] = subflowPaletteType(subflowDefinitionLike(definition));

    const handle: SubflowHandle = {
      id,
      type: 'subflow',
      definitionId: id,
      ...this.#containerMethods(id, undefined, true),
      in: (node, index) => {
        const port = index ?? findFree(ports.in);
        ports.in[port] = [...(ports.in[port] ?? []), { node: refId(node) }];
      },
      out: (node, port = 0, index) => {
        const target = index ?? findFree(ports.out);
        ports.out[target] = [...(ports.out[target] ?? []), { node: refId(node), port }];
      },
      status: (node, port = 0) => {
        ports.status.push({ node: refId(node), port });
      },
      group: (groupKey, groupOptions) => this.#createGroup(id, groupKey, groupOptions),
    };

    body(handle);
    return handle;
  }

  #createGroup(z: string, key: string, options: GroupOptions): GroupHandle {
    const id = this.#allocate(z === '' ? `group:${key}` : `group:${z}/${key}`, key);
    const env = options.env === undefined ? undefined : toEnvParams(options.env);
    this.#groups.push({
      id,
      name: options.name,
      z,
      ...(options.style === undefined ? {} : { style: options.style }),
      ...(env === undefined ? {} : { env }),
      // An all-zero box means "not placed yet": the layout computes it from the members.
      geometry: readGeometry(options) ?? { x: 0, y: 0, w: 0, h: 0 },
    });

    return { id, type: 'group', ref: { id, type: 'group' }, ...this.#containerMethods(z, id) };
  }

  /**
   * Container-scoped creation and wiring.
   *
   * `scopeConfig` is the one place where containers differ: a config node created *inside a
   * subflow* belongs to that subflow (Node-RED supports subflow-local config nodes), while one
   * created while editing a tab is global — which is what the editor does when you drop a
   * broker onto the canvas. `ConfigScopeOptions.scope` overrides the default in either
   * direction, because an imported flow file states the scope it meant.
   */
  #containerMethods(
    z: string,
    g: string | undefined,
    scopeConfig = false,
  ): {
    node: <K extends KnownType>(type: K, props?: PropsFor<K>) => NodeHandle<K>;
    untyped: (type: string, props?: Readonly<Record<string, unknown>>) => NodeHandle;
    config: <K extends KnownType>(type: K, props?: PropsFor<K>, options?: ConfigScopeOptions) => NodeHandle<K>;
    untypedConfig: (type: string, props?: Readonly<Record<string, unknown>>, options?: ConfigScopeOptions) => NodeHandle;
    chain: (...items: readonly Ref[]) => void;
    instance: (subflow: SubflowHandle | string, options?: InstanceOptions) => NodeHandle;
    add: (...items: readonly Ref[]) => void;
  } {
    const scopeOf = (options: ConfigScopeOptions | undefined): string =>
      (options?.scope ?? (scopeConfig ? 'container' : 'flow-set')) === 'container' ? z : '';
    return {
      node: <K extends KnownType>(type: K, props?: PropsFor<K>): NodeHandle<K> =>
        this.#createNode(type as string, (props ?? {}) as Readonly<Record<string, unknown>>, z, g) as NodeHandle<K>,
      untyped: (type, props = {}) => this.#createNode(type, props, z, g),
      config: <K extends KnownType>(type: K, props?: PropsFor<K>, options?: ConfigScopeOptions): NodeHandle<K> =>
        this.#createConfig(
          type as string,
          (props ?? {}) as Readonly<Record<string, unknown>>,
          scopeOf(options),
        ) as NodeHandle<K>,
      untypedConfig: (type, props = {}, options) => this.#createConfig(type, props, scopeOf(options)),
      chain: (...items) => this.#chain(items),
      instance: (subflow, options = {}) => this.#createInstance(subflow, options, z, g),
      add: (...items) => {
        for (const item of items) this.#relocate(refId(item), z, g);
      },
    };
  }

  // ------------------------------------------------------------------------------------
  // Nodes
  // ------------------------------------------------------------------------------------

  node<K extends KnownType>(type: K, props?: PropsFor<K>): NodeHandle<K> {
    return this.#createNode(type as string, (props ?? {}) as Readonly<Record<string, unknown>>, '', undefined) as NodeHandle<K>;
  }

  untyped(type: string, props: Readonly<Record<string, unknown>> = {}): NodeHandle {
    return this.#createNode(type, props, '', undefined);
  }

  /**
   * A **config** node whose type the generated augmentations may not cover.
   *
   * `untyped` cannot serve this case: whether a type is a config node is a palette fact, and
   * without that palette `untyped('ui_tab')` would build a canvas node with geometry and wires
   * instead. Library code that ships its own node family — the dashboard helper — needs to say
   * "config, whatever the palette says".
   */
  untypedConfig(type: string, props: Readonly<Record<string, unknown>> = {}, options?: ConfigScopeOptions): NodeHandle {
    // The root builder is not a container, so a config node created here is always shared;
    // `scope: 'container'` has nothing to attach to and is ignored rather than guessed at.
    void options;
    return this.#createConfig(type, props, '');
  }

  config<K extends KnownType>(type: K, props?: PropsFor<K>, options?: ConfigScopeOptions): NodeHandle<K> {
    void options;
    return this.#createConfig(type as string, (props ?? {}) as Readonly<Record<string, unknown>>, '') as NodeHandle<K>;
  }

  chain(...items: readonly Ref[]): void {
    this.#chain(items);
  }

  instance(subflow: SubflowHandle | string, options: InstanceOptions = {}): NodeHandle {
    return this.#createInstance(subflow, options, '', undefined);
  }

  add(...items: readonly Ref[]): void {
    for (const item of items) this.#relocate(refId(item), '', undefined);
  }

  use<H>(helper: (builder: FlowBuilder) => H): H {
    return helper(this);
  }

  #createNode(
    type: string,
    props: Readonly<Record<string, unknown>>,
    z: string,
    g: string | undefined,
  ): NodeHandle {
    const paletteType = this.#palette[type] ?? null;
    if (paletteType?.isConfig === true) return this.#createConfig(type, props, z);

    const key = stringKey(props) ?? defaultKey(type);
    const id = this.#allocate(z === '' ? `node:${key}` : `node:${z}/${key}`, key);
    const { known, extras } = this.#splitProps(props, paletteType);

    // A node created inside a group that declares a `group` *reference* gets it filled in:
    // dashboard widgets are exactly this shape, and asking the author to repeat the group they
    // already passed to `group.node(...)` (or `dash.gauge(group, …)`) would be a wart.
    if (g !== undefined && !Object.hasOwn(known, 'group') && acceptsGroupReference(paletteType)) {
      known['group'] = g;
    }

    const geometry = readGeometry(props);
    const env = readInstanceEnv(type, props, this.#params);

    const node: Node = {
      id,
      type,
      ...(z === '' ? {} : { z }),
      ...(g === undefined ? {} : { g }),
      ...(props['disabled'] === true ? { disabled: true } : {}),
      props: { known, extras },
      ...(env === undefined ? {} : { env }),
      ...(geometry === undefined ? {} : { geometry }),
      wires: [],
    };
    this.#nodes.push(node);
    return this.#handleFor(node);
  }

  #createConfig(type: string, props: Readonly<Record<string, unknown>>, z: string): NodeHandle {
    const paletteType = this.#palette[type] ?? null;
    const key = stringKey(props) ?? defaultKey(type);
    const id = this.#allocate(z === '' ? `config:${key}` : `config:${z}/${key}`, key);
    const { known, extras } = this.#splitProps(props, paletteType);

    this.#configs.push({
      id,
      type,
      ...(z === '' ? {} : { z }),
      props: { known, extras },
    });
    return this.#handleFor({ id, type, props: { known, extras }, wires: [] });
  }

  #createInstance(
    subflow: SubflowHandle | string,
    options: InstanceOptions,
    z: string,
    g: string | undefined,
  ): NodeHandle {
    const definitionId = typeof subflow === 'string' ? subflow : subflow.definitionId;
    const entry = this.#subflows.find((candidate) => candidate.definition.id === definitionId);
    if (entry === undefined) throw new Error(`instance(): no subflow definition with id "${definitionId}"`);

    // The envelope wins over the raw bag, and the bag keeps its own key order: it is what an
    // imported instance carried, and property order is part of the emitted document.
    const props: Record<string, unknown> = { ...(options.props ?? {}) };
    if (options.name !== undefined) props['name'] = options.name;
    else if (!Object.hasOwn(props, 'name')) props['name'] = '';
    if (options.disabled !== undefined) props['disabled'] = options.disabled;
    if (options.env !== undefined) props['env'] = options.env;
    if (options.key !== undefined) props['key'] = options.key;
    for (const axis of ['x', 'y', 'w', 'h'] as const) {
      if (options[axis] !== undefined) props[axis] = options[axis];
    }

    const type = subflowTypeId(definitionId);
    const paletteType = this.#palette[type] ?? null;
    const key = options.key ?? `${entry.definition.name}_instance`;
    const id = this.#allocate(z === '' ? `instance:${key}` : `instance:${z}/${key}`, key);
    const { known, extras } = this.#splitProps(props, paletteType);
    const env = readInstanceEnv(type, props, this.#params);
    const geometry = readGeometry(props);

    const node: Node = {
      id,
      type,
      ...(z === '' ? {} : { z }),
      ...(g === undefined ? {} : { g }),
      ...(props['disabled'] === true ? { disabled: true } : {}),
      props: { known, extras },
      ...(env === undefined ? {} : { env }),
      ...(geometry === undefined ? {} : { geometry }),
      // One array per declared output port, empty where nothing is wired yet — the editor always
      // writes exactly one, and `[]` is not the same document. Normalisation cannot do this for an
      // instance: a subflow defined inline is never in `GET /nodes`, and `defineFlowSet` normalises
      // against the base palette *before* the subflow overlay exists, so an instance with no
      // outgoing wire used to be emitted as `"wires": []` and then failed its own arity check.
      wires: Array.from({ length: entry.definition.ports.out.length }, () => [] as string[]),
    };
    this.#nodes.push(node);
    return this.#handleFor(node);
  }

  #handleFor(node: Node): NodeHandle {
    const builder = this;
    const handle: NodeHandle = {
      id: node.id,
      type: node.type,
      to(...targets: readonly Ref[]): NodeHandle {
        return handle.toPort(0, ...targets);
      },
      toPort(port: number, ...targets: readonly Ref[]): NodeHandle {
        for (const target of targets) builder.#wire(node.id, port, refId(target));
        return handle;
      },
    };
    return handle;
  }

  #chain(items: readonly Ref[]): void {
    for (let index = 0; index + 1 < items.length; index += 1) {
      this.#wire(refId(items[index] as Ref), 0, refId(items[index + 1] as Ref));
    }
  }

  #wire(fromId: EntityId, port: number, toId: EntityId): void {
    const index = this.#nodes.findIndex((candidate) => candidate.id === fromId);
    if (index < 0) {
      throw new Error(`cannot wire from "${fromId}": it is not a node in this flow set (config nodes have no outputs)`);
    }
    const node = this.#nodes[index] as Node;
    const wires: string[][] = node.wires.map((wire) => [...wire]);
    while (wires.length <= port) wires.push([]);
    (wires[port] as string[]).push(toId);
    this.#nodes[index] = { ...node, wires };
  }

  #relocate(id: EntityId, z: string, g: string | undefined): void {
    const index = this.#nodes.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`cannot place unknown node "${id}"`);
    const node = this.#nodes[index] as Node;
    const { z: _previousZ, g: _previousG, ...rest } = node;
    this.#nodes[index] = {
      ...rest,
      ...(z === '' ? {} : { z }),
      ...(g === undefined ? {} : { g }),
    };
  }

  /**
   * Splits authored props into palette-declared properties (the palette's own literal defaults
   * filled in) and everything else, which is preserved verbatim.
   *
   * Values are *not* converted here: a handle becomes an id at build time, once every entity
   * exists, so a property may reference a node that is created later in the same callback.
   */
  #splitProps(
    props: Readonly<Record<string, unknown>>,
    type: PaletteType | null,
  ): { known: Record<string, unknown>; extras: Record<string, unknown> } {
    const known: Record<string, unknown> = {};
    const extras: Record<string, unknown> = {};

    if (type !== null) {
      for (const [name, property] of Object.entries(type.defaults)) {
        if (Object.hasOwn(props, name)) known[name] = props[name];
        else if (property.value !== undefined && !property.dynamic) known[name] = property.value;
      }
    }

    const declared = type === null ? new Set<string>() : new Set(Object.keys(type.defaults));
    for (const [name, value] of Object.entries(props)) {
      if (ENVELOPE_KEYS.has(name) || declared.has(name)) continue;
      extras[name] = value;
    }

    return { known, extras };
  }

  /**
   * Allocates the id for an entity. A repeated authoring key is disambiguated and reported:
   * silently returning the same id would merge two entities, and silently renaming it would
   * make the lockfile unstable.
   */
  #allocate(lockKey: string, localKey: string): EntityId {
    if (!this.#keys.has(lockKey)) {
      const id = this.#allocator.allocate(lockKey, { slug: localKey });
      this.#keys.set(lockKey, id);
      return id;
    }

    this.#duplicateKeys.push(lockKey);
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${lockKey}#${ordinal}`;
      if (this.#keys.has(candidate)) continue;
      const id = this.#allocator.allocate(candidate, { slug: `${localKey}_${ordinal}` });
      this.#keys.set(candidate, id);
      return id;
    }
  }
}

/** True when the type declares a `group` reference that can point at a group node. */
function acceptsGroupReference(type: PaletteType | null): boolean {
  const spec = type?.refs['group'];
  return spec !== undefined && (spec.targets === '*' || spec.targets.includes('group') || spec.targets.includes('ui_group'));
}

function findFree(ports: readonly (readonly unknown[])[]): number {
  const index = ports.findIndex((port) => port.length === 0);
  return index < 0 ? ports.length : index;
}

function stringKey(props: Readonly<Record<string, unknown>>): string | null {
  const key = props['key'];
  return typeof key === 'string' && key !== '' ? key : null;
}

function defaultKey(type: string): string {
  return isSubflowType(type) ? 'instance' : type.replace(/[^A-Za-z0-9]+/g, '_');
}

function readGeometry(props: { readonly x?: unknown; readonly y?: unknown; readonly w?: unknown; readonly h?: unknown }): Node['geometry'] {
  const x = props.x;
  const y = props.y;
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  const w = props.w;
  const h = props.h;
  return { x, y, ...(typeof w === 'number' ? { w } : {}), ...(typeof h === 'number' ? { h } : {}) };
}

/** Subflow instance overrides live in `env`, not in node properties. */
function readInstanceEnv(
  type: string,
  props: Readonly<Record<string, unknown>>,
  params: ReadonlyMap<EntityId, readonly EnvParam[]>,
): readonly EnvParam[] | undefined {
  if (!isSubflowType(type)) return undefined;
  const definitionId = type.slice('subflow:'.length);
  const overrides = props['env'];
  if (overrides === undefined || overrides === null || typeof overrides !== 'object') return undefined;
  const converted = toEnvOverrides(overrides as Record<string, unknown>, params.get(definitionId) ?? []);
  return converted.length === 0 ? undefined : converted;
}

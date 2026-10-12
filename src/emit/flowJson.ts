/**
 * The canonical emitter: IR → flow-file JSON.
 *
 * Every rule here was read out of the editor's own serializer for the pinned Node-RED version
 * (`red.js`: `convertNode`, `convertWorkspace`, `convertSubflow`), because the point of the tool
 * is that a generated flow file is the file the editor *would* have written:
 *
 * * key order — `id, type, z?, d?, g?, <declared defaults in declaration order>, <extras>,
 *   credentials?, x, y, [w, h], wires, [inputLabels], [outputLabels], [icon], [l], info?`;
 * * `z` is dropped when empty, `d` only appears when true, `g` only when set;
 * * only palette-declared properties are written for known types — anything else survives in
 *   `extras` in its original order, which is what keeps `import → emit` lossless;
 * * config nodes (`category == "config"`) get neither coordinates nor wires; `junction` is an
 *   ordinary node here because its category is not `config` — that is the editor's own rule,
 *   not a special case;
 * * groups are `id, type, z?, name, style, nodes[], [env], x, y, w, h` with `nodes[]` derived
 *   from membership;
 * * subflow definitions are `id, type, name, info, category, in[], out[], env, meta,
 *   [credentials], color, [inputLabels], [outputLabels], [icon], [status]`,
 *   with `in[i] = {x,y,wires:[{id}]}`, `out[j] = {x,y,wires:[{id,port}]}` and
 *   `status = {x,y,wires:[{id,port}]}`.
 *
 * Array order is a deliberate, documented convention rather than a copy of the editor's
 * canvas-order export: subflow definitions first (each followed by its own contents), then
 * shared config nodes, then tabs with their groups and nodes. Node-RED resolves config nodes
 * by dependency, not by position, and the round-trip oracle pins this order.
 */

import { effectiveOutputCount } from '../model/normalize.ts';
import type { PaletteType } from '../palette/model.ts';
import type {
  ConfigNode,
  Credentials,
  EnvParam,
  Flow,
  FlowSet,
  Group,
  Node,
  SubflowDef,
  SubflowPortLink,
} from '../model/entities.ts';

export interface EmitOptions {
  /** Palette used for declaration order, port counts, config detection and default icons. */
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** JSON indentation; 0 produces compact output. Defaults to 4 (Node-RED's pretty setting). */
  readonly indent?: number;
  /** Write `w`/`h`. The editor only does this on export-with-dimensions. */
  readonly dimensions?: boolean;
  /** Write the `global-config` module manifest entry. */
  readonly includeManifest?: boolean;
  /** Credential values to inline. Omitted by default: secrets never belong in a flow file. */
  readonly credentials?: Readonly<Record<string, unknown>>;
}

/** Default positions for subflow ports; advisory, the editor repositions them on import. */
const PORT_GEOMETRY = {
  in: { x: 100, y: 100 },
  out: { x: 500, y: 100 },
  status: { x: 100, y: 40 },
  step: 40,
} as const;

export function emitFlowSet(flowSet: FlowSet, options: EmitOptions): string {
  const entries = emitEntries(flowSet, options);
  const indent = options.indent ?? 4;
  return `${JSON.stringify(entries, null, indent)}\n`;
}

/** The flow-file array without serialisation — used by diffing, planning and tests. */
export function emitEntries(flowSet: FlowSet, options: EmitOptions): readonly Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];

  for (const subflow of flowSet.subflows) {
    entries.push(emitSubflow(subflow, options));
    entries.push(...subflow.configs.map((config) => emitConfig(config, options)));
    entries.push(...subflow.groups.map((group) => emitGroup(group, subflow.nodes, options)));
    entries.push(...subflow.nodes.map((node) => emitNode(node, options)));
  }

  entries.push(...flowSet.configs.map((config) => emitConfig(config, options)));

  if (options.includeManifest ?? true) {
    const manifest = emitGlobalConfig(flowSet);
    if (manifest !== null) entries.push(manifest);
  }

  for (const flow of flowSet.flows) {
    entries.push(emitFlow(flow, options));
    entries.push(...flow.configs.map((config) => emitConfig(config, options)));
    entries.push(...flow.groups.map((group) => emitGroup(group, flow.nodes, options)));
    entries.push(...flow.nodes.map((node) => emitNode(node, options)));
  }

  // Nodes without a container are collected at the end: they have no container whose position
  // could define one, and the editor recovers them into a scratch tab on import anyway.
  entries.push(...flowSet.loose.map((node) => emitNode(node, options)));

  return entries;
}

export function emitNode(node: Node, options: EmitOptions): Record<string, unknown> {
  const type = options.palette[node.type] ?? null;
  const entry: Record<string, unknown> = { id: node.id, type: node.type };

  if (node.z !== undefined && node.z !== '') entry['z'] = node.z;
  if (node.disabled === true) entry['d'] = true;
  if (node.g !== undefined && node.g !== '') entry['g'] = node.g;

  writeProperties(entry, node.props, type);

  if (node.env !== undefined && node.env.length > 0) entry['env'] = node.env.map(emitEnvParam);
  const credentials = emitCredentials(node.credentials, options);
  if (credentials !== null) entry['credentials'] = credentials;

  // Config nodes carry no geometry and no wires; everything else does (junctions included).
  if (type === null || !type.isConfig || node.type === 'junction') {
    const geometry = node.geometry ?? { x: 0, y: 0 };
    entry['x'] = geometry.x;
    entry['y'] = geometry.y;
    if (options.dimensions === true) {
      entry['w'] = geometry.w ?? 0;
      entry['h'] = geometry.h ?? 0;
    }
    const wires: string[][] = [];
    const declared = effectiveOutputCount(type, node.props);
    const length = declared ?? node.wires.length;
    for (let port = 0; port < length; port += 1) wires.push([...(node.wires[port] ?? [])]);
    entry['wires'] = wires;

    const ports = declared ?? node.wires.length;
    if (node.inputLabels !== undefined && ports > 0 && !isBlank(node.inputLabels)) {
      entry['inputLabels'] = [...node.inputLabels];
    }
    if (node.outputLabels !== undefined && ports > 0 && !isBlank(node.outputLabels)) {
      entry['outputLabels'] = [...node.outputLabels];
    }
    if (node.icon !== undefined && node.icon !== '' && node.icon !== defaultIcon(type)) {
      entry['icon'] = node.icon;
    }
    if (node.showLabel !== undefined && node.showLabel !== defaultShowLabel(type)) {
      entry['l'] = node.showLabel;
    }
  }

  if (node.info !== undefined && node.info !== '') entry['info'] = node.info;
  return entry;
}

export function emitConfig(config: ConfigNode, options: EmitOptions): Record<string, unknown> {
  const type = options.palette[config.type] ?? null;
  const entry: Record<string, unknown> = { id: config.id, type: config.type };
  if (config.z !== undefined && config.z !== '') entry['z'] = config.z;
  writeProperties(entry, config.props, type);
  const credentials = emitCredentials(config.credentials, options);
  if (credentials !== null) entry['credentials'] = credentials;
  return entry;
}

export function emitFlow(flow: Flow, options: EmitOptions): Record<string, unknown> {
  void options;
  const entry: Record<string, unknown> = { id: flow.id, type: 'tab' };
  entry['label'] = flow.label;
  entry['disabled'] = flow.disabled === true;
  if (flow.locked === true) entry['locked'] = true;
  entry['info'] = flow.info ?? '';
  if (flow.env !== undefined && flow.env.length > 0) entry['env'] = flow.env.map(emitEnvParam);
  return entry;
}

export function emitGroup(group: Group, members: readonly Node[], options: EmitOptions): Record<string, unknown> {
  void options;
  const entry: Record<string, unknown> = { id: group.id, type: 'group' };
  if (group.z !== '') entry['z'] = group.z;
  entry['name'] = group.name;
  entry['style'] = group.style ?? { label: true };
  // Membership is derived from the nodes themselves: one source of truth, no drift.
  entry['nodes'] = members.filter((node) => node.g === group.id).map((node) => node.id);
  if (group.env !== undefined && group.env.length > 0) entry['env'] = group.env.map(emitEnvParam);
  entry['x'] = group.geometry.x;
  entry['y'] = group.geometry.y;
  entry['w'] = group.geometry.w ?? 0;
  entry['h'] = group.geometry.h ?? 0;
  return entry;
}

export function emitSubflow(subflow: SubflowDef, options: EmitOptions): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: subflow.id, type: 'subflow' };
  entry['name'] = subflow.name;
  entry['info'] = subflow.info ?? '';
  entry['category'] = subflow.category ?? '';
  entry['in'] = subflow.ports.in.map((links, index) => ({
    x: subflow.ports.inPosition?.x ?? PORT_GEOMETRY.in.x,
    y: (subflow.ports.inPosition?.y ?? PORT_GEOMETRY.in.y) + index * PORT_GEOMETRY.step,
    wires: links.map((link) => ({ id: link.node })),
  }));
  entry['out'] = subflow.ports.out.map((links, index) => ({
    x: subflow.ports.outPosition?.x ?? PORT_GEOMETRY.out.x,
    y: (subflow.ports.outPosition?.y ?? PORT_GEOMETRY.out.y) + index * PORT_GEOMETRY.step,
    wires: links.map((link) => ({ id: link.node, port: link.port ?? 0 })),
  }));
  entry['env'] = subflow.env.map(emitEnvParam);
  entry['meta'] = { ...subflow.meta };
  const credentials = emitCredentials(undefined, options);
  if (credentials !== null) entry['credentials'] = credentials;
  entry['color'] = subflow.color ?? '#DDAA99';
  if (subflow.inputLabels !== undefined && subflow.ports.in.length > 0 && !isBlank(subflow.inputLabels)) {
    entry['inputLabels'] = [...subflow.inputLabels];
  }
  if (subflow.outputLabels !== undefined && subflow.ports.out.length > 0 && !isBlank(subflow.outputLabels)) {
    entry['outputLabels'] = [...subflow.outputLabels];
  }
  if (subflow.icon !== undefined && subflow.icon !== '' && subflow.icon !== 'node-red/subflow.svg') {
    entry['icon'] = subflow.icon;
  }
  if (subflow.ports.status.length > 0) {
    entry['status'] = {
      x: subflow.ports.statusPosition?.x ?? PORT_GEOMETRY.status.x,
      y: subflow.ports.statusPosition?.y ?? PORT_GEOMETRY.status.y,
      wires: subflow.ports.status.map((link: SubflowPortLink) => ({ id: link.node, port: link.port ?? 0 })),
    };
  }
  return entry;
}

/**
 * The `global-config` node carrying the module manifest. Node-RED writes it on *export*, not
 * on deploy, so owning it here is what makes an exported flow set self-describing.
 */
export function emitGlobalConfig(flowSet: FlowSet): Record<string, unknown> | null {
  const modules = Object.entries(flowSet.modules);
  if (modules.length === 0) return null;
  return {
    id: 'global-config',
    type: 'global-config',
    env: [],
    modules: Object.fromEntries(modules.sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

function writeProperties(
  entry: Record<string, unknown>,
  props: { known: Readonly<Record<string, unknown>>; extras: Readonly<Record<string, unknown>> },
  type: PaletteType | null,
): void {
  const written = new Set<string>();
  for (const name of type === null ? [] : Object.keys(type.defaults)) {
    if (Object.hasOwn(props.known, name)) {
      entry[name] = props.known[name];
      written.add(name);
    }
  }
  // Anything the palette does not declare keeps its original order, which is what makes an
  // imported flow file round-trip unchanged (the editor itself would drop these keys).
  for (const [name, value] of Object.entries(props.extras)) {
    if (written.has(name) || value === undefined) continue;
    entry[name] = value;
    written.add(name);
  }
  // Known properties of an unknown type still have to be written somewhere.
  for (const [name, value] of Object.entries(props.known)) {
    if (written.has(name) || value === undefined) continue;
    entry[name] = value;
  }
}

function emitEnvParam(param: EnvParam): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: param.name, type: param.type, value: param.value };
  if (param.ui !== undefined) entry['ui'] = param.ui;
  return entry;
}

function emitCredentials(
  credentials: Credentials | undefined,
  options: EmitOptions,
): Record<string, unknown> | null {
  if (credentials === undefined || options.credentials === undefined) return null;
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(credentials.values)) {
    // A credential placeholder is only resolved from the out-of-band provider; unresolvable
    // placeholders are dropped rather than written as literal secrets.
    const resolved = Object.hasOwn(options.credentials, name) ? options.credentials[name] : undefined;
    if (resolved !== undefined) values[name] = resolved;
    else if (value !== undefined && value !== '') values[name] = value;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function defaultIcon(type: PaletteType | null): string | null {
  if (type === null || type.icon === null) return null;
  return `${type.module}/${type.icon}`;
}

function defaultShowLabel(type: PaletteType | null): boolean {
  return type?.showLabel ?? true;
}

function isBlank(labels: readonly string[]): boolean {
  return labels.every((label) => label.trim() === '');
}

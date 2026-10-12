/**
 * Importer: flow-file JSON → IR.
 *
 * The importer is deliberately independent of the authoring layer — that is what makes
 * "parse an existing flow, change it, emit it" possible, and what the round-trip oracle
 * (`emit → deploy → read back → parse → emit` must be a fixed point) rests on.
 *
 * Losslessness is the contract: every property of every entry is preserved, either as a
 * palette-declared property (`props.known`) or verbatim (`props.extras`). The only things
 * dropped are the editor's *internal* keys, which the emitter must never write.
 */

import type { PaletteType } from '../palette/model.ts';

import {
  INTERNAL_NODE_KEYS,
  STRUCTURAL_NODE_KEYS,
  emptyNodeProps,
  type ConfigNode,
  type Credentials,
  type EnvParam,
  type Flow,
  type FlowSet,
  type Geometry,
  type Group,
  type Node,
  type NodeProps,
  type SubflowDef,
  type SubflowPortLink,
  type SubflowPorts,
} from '../model/entities.ts';

export interface ImportOptions {
  /** Palette used to decide which properties are declared and which nodes are config nodes. */
  readonly palette: Readonly<Record<string, PaletteType>>;
}

export function parseFlowSetText(text: string, options: ImportOptions): FlowSet {
  const parsed: unknown = JSON.parse(text);
  return parseFlowFile(parsed, options);
}

export function parseFlowFile(json: unknown, options: ImportOptions): FlowSet {
  if (!Array.isArray(json)) {
    throw new Error('a flow file is a JSON array of entries');
  }

  const flowEntries: Record<string, unknown>[] = [];
  const subflowEntries: Record<string, unknown>[] = [];
  const groupEntries: Record<string, unknown>[] = [];
  const nodeEntries: Record<string, unknown>[] = [];
  const configEntries: Record<string, unknown>[] = [];
  let modules: Record<string, string> = {};

  for (const entry of json as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? record['type'] : '';
    switch (type) {
      case 'tab':
        flowEntries.push(record);
        break;
      case 'subflow':
        subflowEntries.push(record);
        break;
      case 'group':
        groupEntries.push(record);
        break;
      case 'global-config': {
        const declared = record['modules'];
        if (declared !== null && typeof declared === 'object') {
          modules = Object.fromEntries(
            Object.entries(declared as Record<string, unknown>).filter(
              (entryPair): entryPair is [string, string] => typeof entryPair[1] === 'string',
            ),
          );
        }
        configEntries.push(record);
        break;
      }
      default:
        if (options.palette[type]?.isConfig === true) configEntries.push(record);
        else nodeEntries.push(record);
    }
  }

  const nodes = nodeEntries.map((entry) => parseNode(entry, options));
  const configs = configEntries.map((entry) => parseConfig(entry, options));
  const groups = groupEntries.map(parseGroup);
  const subflows = subflowEntries.map((entry) => parseSubflow(entry, options));

  const nodesByContainer = groupBy(nodes, (node) => node.z ?? '');
  const configsByContainer = groupBy(configs, (config) => config.z ?? '');

  const flows: Flow[] = flowEntries.map((entry) => {
    const id = stringOf(entry['id']);
    return {
      id,
      label: stringOf(entry['label']),
      disabled: entry['disabled'] === true ? true : undefined,
      locked: entry['locked'] === true ? true : undefined,
      info: stringOf(entry['info']),
      env: parseEnv(entry['env']),
      groups: groups.filter((group) => group.z === id),
      nodes: nodesByContainer.get(id) ?? [],
      configs: configsByContainer.get(id) ?? [],
    };
  });

  const subflowDefs: SubflowDef[] = subflows.map((subflow) => ({
    ...subflow,
    groups: groups.filter((group) => group.z === subflow.id),
    nodes: nodesByContainer.get(subflow.id) ?? [],
    configs: configsByContainer.get(subflow.id) ?? [],
  }));

  return {
    subflows: subflowDefs,
    configs: configsByContainer.get('') ?? [],
    flows,
    loose: nodesByContainer.get('') ?? [],
    modules,
  };
}

function parseNode(entry: Record<string, unknown>, options: ImportOptions): Node {
  const type = stringOf(entry['type']);
  const geometry = parseGeometry(entry['x'], entry['y'], entry['w'], entry['h']);

  return {
    id: stringOf(entry['id']),
    type,
    z: optionalString(entry['z']),
    g: optionalString(entry['g']),
    disabled: entry['d'] === true ? true : undefined,
    props: splitProps(entry, options.palette[type] ?? null),
    env: parseEnv(entry['env']),
    credentials: parseCredentials(entry['credentials']),
    geometry,
    wires: parseWires(entry['wires']),
    inputLabels: parseLabels(entry['inputLabels']),
    outputLabels: parseLabels(entry['outputLabels']),
    icon: optionalString(entry['icon']),
    showLabel: typeof entry['l'] === 'boolean' ? entry['l'] : undefined,
    info: optionalString(entry['info']),
  };
}

function parseConfig(entry: Record<string, unknown>, options: ImportOptions): ConfigNode {
  const type = stringOf(entry['type']);
  return {
    id: stringOf(entry['id']),
    type,
    z: optionalString(entry['z']),
    props: splitProps(entry, options.palette[type] ?? null),
    credentials: parseCredentials(entry['credentials']),
  };
}

function parseGroup(entry: Record<string, unknown>): Group {
  const style = entry['style'];
  return {
    id: stringOf(entry['id']),
    name: stringOf(entry['name']),
    z: stringOf(entry['z']),
    style: style !== null && typeof style === 'object' && !Array.isArray(style) ? { ...(style as Record<string, unknown>) } : undefined,
    env: parseEnv(entry['env']),
    geometry: parseGeometry(entry['x'], entry['y'], entry['w'], entry['h']) ?? { x: 0, y: 0 },
  };
}

function parseSubflow(entry: Record<string, unknown>, options: ImportOptions): Omit<SubflowDef, 'nodes' | 'groups' | 'configs'> {
  void options;
  const meta = entry['meta'];
  return {
    id: stringOf(entry['id']),
    name: stringOf(entry['name']),
    info: optionalString(entry['info']),
    category: optionalString(entry['category']),
    color: optionalString(entry['color']),
    icon: optionalString(entry['icon']),
    env: parseEnv(entry['env']) ?? [],
    meta: meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {},
    ports: parsePorts(entry),
    inputLabels: parseLabels(entry['inputLabels']),
    outputLabels: parseLabels(entry['outputLabels']),
  };
}

function parsePorts(entry: Record<string, unknown>): SubflowPorts {
  const readLinks = (raw: unknown, withPort: boolean): readonly SubflowPortLink[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((link): link is Record<string, unknown> => link !== null && typeof link === 'object')
      .map((link) => {
        const node = stringOf(link['id']);
        const port = typeof link['port'] === 'number' ? link['port'] : undefined;
        return withPort && port !== undefined ? { node, port } : { node };
      });
  };

  const ports = (raw: unknown, withPort: boolean): readonly (readonly SubflowPortLink[])[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((portEntry) => {
      const wires =
        portEntry !== null && typeof portEntry === 'object' ? (portEntry as Record<string, unknown>)['wires'] : undefined;
      return readLinks(wires, withPort);
    });
  };

  const status = entry['status'];
  const statusWires =
    status !== null && typeof status === 'object' ? (status as Record<string, unknown>)['wires'] : undefined;
  const statusPosition = readPosition(status);

  return {
    in: ports(entry['in'], false),
    out: ports(entry['out'], true),
    status: readLinks(statusWires, true),
    ...(statusPosition === undefined ? {} : { statusPosition }),
  };
}

function readPosition(raw: unknown): { x: number; y: number } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const x = record['x'];
  const y = record['y'];
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  return { x, y };
}

/**
 * Splits entry properties into palette-declared ones and everything else, dropping the keys
 * the IR models structurally and the editor's internal bookkeeping.
 */
function splitProps(entry: Record<string, unknown>, type: PaletteType | null): NodeProps {
  const known: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (STRUCTURAL_NODE_KEYS.includes(key) || INTERNAL_NODE_KEYS.includes(key)) continue;
    if (value === undefined) continue;
    if (type !== null && Object.hasOwn(type.defaults, key)) known[key] = value;
    else extras[key] = value;
  }

  return Object.keys(known).length === 0 && Object.keys(extras).length === 0 ? emptyNodeProps() : { known, extras };
}

function parseWires(raw: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((wire) =>
    Array.isArray(wire) ? wire.filter((target): target is string => typeof target === 'string') : [],
  );
}

function parseEnv(raw: unknown): readonly EnvParam[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => {
      const param: EnvParam = {
        name: stringOf(entry['name']),
        type: stringOf(entry['type']) === '' ? 'str' : stringOf(entry['type']),
        value: entry['value'],
      };
      return entry['ui'] === undefined ? param : { ...param, ui: entry['ui'] };
    });
}

function parseCredentials(raw: unknown): Credentials | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return { values: { ...(raw as Record<string, unknown>) } };
}

function parseLabels(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((label) => (typeof label === 'string' ? label : ''));
}

function parseGeometry(x: unknown, y: unknown, w: unknown, h: unknown): Geometry | undefined {
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  return {
    x,
    y,
    ...(typeof w === 'number' ? { w } : {}),
    ...(typeof h === 'number' ? { h } : {}),
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const bucket = map.get(key(item));
    if (bucket === undefined) map.set(key(item), [item]);
    else bucket.push(item);
  }
  return map;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

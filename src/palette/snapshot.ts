/**
 * Snapshot envelope: creation, canonical serialisation, content hashing, parsing and
 * comparison. Pure — the file/HTTP adapters live in `palette/sources/`.
 *
 * Two invariants drive the design:
 *
 * 1. **Byte-stable output.** `serialize(parse(text)) === text` for any file this module
 *    wrote. Field order is fixed (not alphabetical) so the file stays readable, while
 *    `defaults` entries keep their *declaration* order because the emitter writes node
 *    properties in exactly that order.
 * 2. **Source-independent identity.** The content hash covers only `{schemaVersion,
 *    nodeRedVersion, nodeSets, types}` — never provenance or generator version — so a live
 *    instance and the same installation scanned from disk produce the same hash, and
 *    regeneration is a no-op when nothing changed.
 */

import { createHash } from 'node:crypto';

import { err, ok, type Result } from '../result.ts';

import {
  EMPTY_DYNAMICS,
  PALETTE_SCHEMA_VERSION,
  type PaletteNodeSet,
  type PaletteParameter,
  type PaletteProperty,
  type PaletteProvenance,
  type PaletteType,
  type RefSpec,
  type RefTargets,
  type TypeDynamics,
} from './model.ts';

/** Generator stamp recorded in the file; excluded from the hash on purpose. */
export const DEFAULT_GENERATOR = 'flowgen';

export interface PaletteSnapshot {
  readonly schemaVersion: number;
  readonly generator: string;
  /** Version of the Node-RED instance the snapshot was taken from; `null` if unknown. */
  readonly nodeRedVersion: string | null;
  readonly contentHash: string;
  readonly provenance: PaletteProvenance;
  /** Node sets as reported by the instance, sorted by id; each set's `types` is sorted too. */
  readonly nodeSets: readonly PaletteNodeSet[];
  /** Keyed by type id, insertion order sorted by id. */
  readonly types: Readonly<Record<string, PaletteType>>;
}

/** The part of a snapshot that identity is computed over. */
export type PaletteContent = Pick<PaletteSnapshot, 'schemaVersion' | 'nodeRedVersion' | 'nodeSets' | 'types'>;

export interface PaletteSnapshotInput {
  readonly nodeRedVersion: string | null;
  readonly nodeSets: readonly PaletteNodeSet[];
  readonly types: readonly PaletteType[];
  readonly provenance: PaletteProvenance;
  readonly generator?: string;
}

export class PaletteSnapshotError extends Error {
  readonly issues: readonly PaletteSnapshotIssue[];

  constructor(issues: readonly PaletteSnapshotIssue[]) {
    super(`invalid palette snapshot: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'PaletteSnapshotError';
    this.issues = issues;
  }
}

// --------------------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------------------

/**
 * Normalises a raw extraction result into a snapshot: node sets and types are sorted by id
 * (extraction order is an implementation detail and must not leak into the hash), the
 * content hash is computed and the whole structure is frozen.
 *
 * Throws on duplicate type ids — that is a broken extractor, not a user-facing condition.
 */
export function createPaletteSnapshot(input: PaletteSnapshotInput): PaletteSnapshot {
  const byId = new Map<string, PaletteType>();
  for (const type of input.types) {
    if (byId.has(type.id)) {
      throw new Error(`duplicate palette type id: ${type.id}`);
    }
    byId.set(type.id, type);
  }

  const types: Record<string, PaletteType> = {};
  for (const id of [...byId.keys()].sort()) {
    types[id] = byId.get(id) as PaletteType;
  }

  const nodeSets: PaletteNodeSet[] = input.nodeSets
    .map((nodeSet) => ({ ...nodeSet, types: [...nodeSet.types].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const content: PaletteContent = {
    schemaVersion: PALETTE_SCHEMA_VERSION,
    nodeRedVersion: input.nodeRedVersion,
    nodeSets,
    types,
  };

  const snapshot: PaletteSnapshot = {
    ...content,
    generator: input.generator ?? DEFAULT_GENERATOR,
    contentHash: hashPaletteContent(content),
    provenance: input.provenance,
  };
  return deepFreeze(snapshot);
}

export function snapshotContent(snapshot: PaletteSnapshot): PaletteContent {
  return {
    schemaVersion: snapshot.schemaVersion,
    nodeRedVersion: snapshot.nodeRedVersion,
    nodeSets: snapshot.nodeSets,
    types: snapshot.types,
  };
}

// --------------------------------------------------------------------------------------
// Canonical serialisation
// --------------------------------------------------------------------------------------

export interface SerializeOptions {
  /** 0 (default 2) produces compact output. */
  readonly indent?: number;
}

/** Serialises the whole envelope, provenance included. */
export function serializePaletteSnapshot(snapshot: PaletteSnapshot, options: SerializeOptions = {}): string {
  const indent = options.indent ?? 2;
  const wire: Record<string, unknown> = {
    schemaVersion: snapshot.schemaVersion,
    generator: snapshot.generator,
    nodeRedVersion: snapshot.nodeRedVersion,
    contentHash: snapshot.contentHash,
    provenance: wireProvenance(snapshot.provenance),
    nodeSets: snapshot.nodeSets.map(wireNodeSet),
    types: wireTypes(snapshot.types),
  };
  return `${JSON.stringify(wire, null, indent)}\n`;
}

export function serializePaletteContent(content: PaletteContent, options: SerializeOptions = {}): string {
  const indent = options.indent ?? 2;
  const wire: Record<string, unknown> = {
    schemaVersion: content.schemaVersion,
    nodeRedVersion: content.nodeRedVersion,
    nodeSets: content.nodeSets.map(wireNodeSet),
    types: wireTypes(content.types),
  };
  return JSON.stringify(wire, null, indent);
}

export function hashPaletteContent(content: PaletteContent): string {
  const digest = createHash('sha256').update(serializePaletteContent(content, { indent: 0 }), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/** Recomputes the hash from the snapshot's own content (used to detect hand edits). */
export function recomputeContentHash(snapshot: PaletteSnapshot): string {
  return hashPaletteContent(snapshotContent(snapshot));
}

/** True when two snapshots describe the same palette, regardless of provenance. */
export function samePaletteContent(a: PaletteSnapshot, b: PaletteSnapshot): boolean {
  return a.contentHash === b.contentHash;
}

function wireProvenance(provenance: PaletteProvenance): Record<string, unknown> {
  const wire: Record<string, unknown> = { kind: provenance.kind };
  if (provenance.url !== null) wire['url'] = provenance.url;
  if (provenance.userDir !== null) wire['userDir'] = provenance.userDir;
  if (provenance.nodeModulesDirs !== null) wire['nodeModulesDirs'] = [...provenance.nodeModulesDirs];
  return wire;
}

function wireNodeSet(nodeSet: PaletteNodeSet): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: nodeSet.id,
    name: nodeSet.name,
    module: nodeSet.module,
    version: nodeSet.version,
  };
  if (!nodeSet.enabled) wire['enabled'] = false;
  if (nodeSet.local) wire['local'] = true;
  if (nodeSet.user) wire['user'] = true;
  wire['types'] = [...nodeSet.types];
  return wire;
}

function wireTypes(types: Readonly<Record<string, PaletteType>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const id of Object.keys(types)) {
    wire[id] = wireType(types[id] as PaletteType);
  }
  return wire;
}

function wireType(type: PaletteType): Record<string, unknown> {
  const wire: Record<string, unknown> = { id: type.id, module: type.module };
  // The node set id repeats the module name in hand-written entries; only write it when it
  // carries information.
  if (type.nodeSet !== type.module) wire['nodeSet'] = type.nodeSet;
  wire['version'] = type.version;
  if (type.category !== null) wire['category'] = type.category;
  if (type.paletteLabel !== null) wire['paletteLabel'] = type.paletteLabel;
  if (type.color !== null) wire['color'] = type.color;
  if (type.icon !== null) wire['icon'] = type.icon;
  if (type.align !== null) wire['align'] = type.align;
  if (type.inputs !== null) wire['inputs'] = type.inputs;
  if (type.outputs !== null) wire['outputs'] = type.outputs;
  if (type.isConfig) wire['isConfig'] = true;
  if (type.synthetic) wire['synthetic'] = true;
  if (Object.keys(type.refs).length > 0) wire['refs'] = wireRefs(type.refs);
  if (hasDynamics(type.dynamics)) wire['dynamics'] = wireDynamics(type.dynamics);
  if (Object.keys(type.defaults).length > 0) wire['defaults'] = wireProperties(type.defaults);
  if (Object.keys(type.credentials).length > 0) wire['credentials'] = wireProperties(type.credentials);
  if (type.params.length > 0) wire['params'] = type.params.map(wireParameter);
  return wire;
}

function wireParameter(parameter: PaletteParameter): Record<string, unknown> {
  const wire: Record<string, unknown> = { name: parameter.name, type: parameter.type };
  if (parameter.value !== undefined) wire['value'] = parameter.value;
  if (parameter.ui !== undefined) wire['ui'] = parameter.ui;
  return wire;
}

function wireRefs(refs: Readonly<Record<string, RefSpec>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(refs)) {
    wire[name] = { kind: spec.kind, targets: spec.targets === '*' ? '*' : [...spec.targets] };
  }
  return wire;
}

function wireDynamics(dynamics: TypeDynamics): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (dynamics.inputs) wire['inputs'] = true;
  if (dynamics.outputs) wire['outputs'] = true;
  if (dynamics.paletteLabel) wire['paletteLabel'] = true;
  if (dynamics.category) wire['category'] = true;
  if (dynamics.defaults.length > 0) wire['defaults'] = [...dynamics.defaults];
  return wire;
}

/** Property order mirrors Node-RED's own declarations; only meaningful fields are written. */
function wireProperties(properties: Readonly<Record<string, PaletteProperty>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const entry: Record<string, unknown> = {};
    if (property.value !== undefined) entry['value'] = property.value;
    if (property.type !== null) entry['type'] = property.type;
    if (property.required) entry['required'] = true;
    if (property.label !== null) entry['label'] = property.label;
    if (property.ui !== undefined) entry['ui'] = property.ui;
    if (property.dynamic) entry['dynamic'] = true;
    wire[name] = entry;
  }
  return wire;
}

function hasDynamics(dynamics: TypeDynamics): boolean {
  return (
    dynamics.inputs || dynamics.outputs || dynamics.paletteLabel || dynamics.category || dynamics.defaults.length > 0
  );
}

// --------------------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------------------

export type PaletteSnapshotIssueCode =
  | 'invalid-json'
  | 'not-an-object'
  | 'unsupported-schema'
  | 'missing-field'
  | 'invalid-field'
  | 'duplicate-type'
  | 'content-hash-mismatch'
  | 'module-membership-mismatch';

export interface PaletteSnapshotIssue {
  readonly code: PaletteSnapshotIssueCode;
  /** Dotted path into the JSON document, e.g. `types.inject.defaults.repeat.value`. */
  readonly path: string;
  readonly message: string;
}

export interface ParsePaletteOptions {
  /** Set to false to accept a hand-edited file whose `contentHash` no longer matches. */
  readonly verifyContentHash?: boolean;
  /** Set to false to accept a snapshot whose module/type attribution is inconsistent. */
  readonly verifyMembership?: boolean;
}

/**
 * Parses and structurally validates a snapshot document. Every problem is collected —
 * the caller gets the full list, which is what a CLI needs to explain a broken file.
 */
export function parsePaletteSnapshot(
  text: string,
  options: ParsePaletteOptions = {},
): Result<PaletteSnapshot, readonly PaletteSnapshotIssue[]> {
  const issues: PaletteSnapshotIssue[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err([
      { code: 'invalid-json', path: '', message: cause instanceof Error ? cause.message : 'unparsable JSON' },
    ]);
  }

  const root = readObject(raw, '', issues);
  if (root === null) return err(issues);

  const schemaVersion = readNumber(root['schemaVersion'], 'schemaVersion', issues);
  if (schemaVersion !== null && schemaVersion !== PALETTE_SCHEMA_VERSION) {
    issues.push({
      code: 'unsupported-schema',
      path: 'schemaVersion',
      message: `expected ${PALETTE_SCHEMA_VERSION}, found ${schemaVersion} (written by a different flowgen version?)`,
    });
  }

  const generator = optionalString(root['generator'], 'generator', issues) ?? DEFAULT_GENERATOR;
  const nodeRedVersion = optionalString(root['nodeRedVersion'], 'nodeRedVersion', issues);
  const contentHash = optionalString(root['contentHash'], 'contentHash', issues) ?? '';
  const provenance = decodeProvenance(root['provenance'], issues);
  const nodeSets = decodeNodeSets(root['nodeSets'], issues);
  const types = decodeTypes(root['types'], issues);

  if (issues.length > 0) return err(issues);

  const content: PaletteContent = {
    schemaVersion: schemaVersion as number,
    nodeRedVersion,
    nodeSets: nodeSets as readonly PaletteNodeSet[],
    types: types as Readonly<Record<string, PaletteType>>,
  };
  const snapshot: PaletteSnapshot = { ...content, generator, contentHash, provenance };

  if (options.verifyContentHash !== false) {
    const recomputed = hashPaletteContent(content);
    if (contentHash === '') {
      issues.push({ code: 'missing-field', path: 'contentHash', message: 'content hash is required' });
    } else if (recomputed !== contentHash) {
      issues.push({
        code: 'content-hash-mismatch',
        path: 'contentHash',
        message: `document hashes to ${recomputed}; the file was edited or written by another tool`,
      });
    }
  }

  if (options.verifyMembership !== false) {
    issues.push(...checkMembership(snapshot));
  }

  return issues.length > 0 ? err(issues) : ok(deepFreeze(snapshot));
}

function checkMembership(snapshot: PaletteSnapshot): readonly PaletteSnapshotIssue[] {
  const issues: PaletteSnapshotIssue[] = [];
  const known = new Set(snapshot.nodeSets.map((nodeSet) => nodeSet.id));

  for (const nodeSet of snapshot.nodeSets) {
    for (const typeId of nodeSet.types) {
      const type = snapshot.types[typeId];
      if (type === undefined) {
        issues.push({
          code: 'module-membership-mismatch',
          path: `nodeSets.${nodeSet.id}.types`,
          message: `node set lists type "${typeId}" which is not defined`,
        });
      } else if (type.nodeSet !== nodeSet.id) {
        issues.push({
          code: 'module-membership-mismatch',
          path: `types.${typeId}.nodeSet`,
          message: `type is attributed to node set "${type.nodeSet}" but listed under "${nodeSet.id}"`,
        });
      } else if (type.module !== nodeSet.module) {
        issues.push({
          code: 'module-membership-mismatch',
          path: `types.${typeId}.module`,
          message: `type names module "${type.module}" but node set "${nodeSet.id}" belongs to "${nodeSet.module}"`,
        });
      }
    }
  }

  for (const [typeId, type] of Object.entries(snapshot.types)) {
    if (!known.has(type.nodeSet)) {
      issues.push({
        code: 'module-membership-mismatch',
        path: `types.${typeId}.nodeSet`,
        message: `unknown node set "${type.nodeSet}"`,
      });
      continue;
    }
    const nodeSet = snapshot.nodeSets.find((candidate) => candidate.id === type.nodeSet) as PaletteNodeSet;
    if (!nodeSet.types.includes(typeId)) {
      issues.push({
        code: 'module-membership-mismatch',
        path: `nodeSets.${nodeSet.id}.types`,
        message: `node set does not list its own type "${typeId}"`,
      });
    }
  }

  return issues;
}

function decodeProvenance(raw: unknown, issues: PaletteSnapshotIssue[]): PaletteProvenance {
  if (raw === undefined || raw === null) {
    return { kind: 'snapshot', url: null, userDir: null, nodeModulesDirs: null };
  }
  const record = readObject(raw, 'provenance', issues) ?? {};
  const kind = optionalString(record['kind'], 'provenance.kind', issues) ?? 'snapshot';
  if (!['live', 'filesystem', 'snapshot', 'subflow', 'overlay', 'composite'].includes(kind)) {
    issues.push({
      code: 'invalid-field',
      path: 'provenance.kind',
      message: `unknown source kind "${kind}"`,
    });
  }
  return {
    kind: kind as PaletteProvenance['kind'],
    url: optionalString(record['url'], 'provenance.url', issues),
    userDir: optionalString(record['userDir'], 'provenance.userDir', issues),
    nodeModulesDirs: optionalStringArray(record['nodeModulesDirs'], 'provenance.nodeModulesDirs', issues),
  };
}

function decodeNodeSets(raw: unknown, issues: PaletteSnapshotIssue[]): readonly PaletteNodeSet[] | null {
  const list = readArray(raw, 'nodeSets', issues);
  if (list === null) return null;
  const nodeSets: PaletteNodeSet[] = [];
  list.forEach((entry, index) => {
    const path = `nodeSets[${index}]`;
    const record = readObject(entry, path, issues);
    if (record === null) return;
    const id = requireString(record['id'], `${path}.id`, issues);
    const name = optionalString(record['name'], `${path}.name`, issues) ?? id ?? '';
    const module = optionalString(record['module'], `${path}.module`, issues) ?? name;
    const version = optionalString(record['version'], `${path}.version`, issues) ?? '';
    const types = optionalStringArray(record['types'], `${path}.types`, issues) ?? [];
    if (id !== null) {
      nodeSets.push({
        id,
        name,
        module,
        version,
        enabled: record['enabled'] !== false,
        local: record['local'] === true,
        user: record['user'] === true,
        types,
      });
    }
  });
  return nodeSets;
}

function decodeTypes(
  raw: unknown,
  issues: PaletteSnapshotIssue[],
): Readonly<Record<string, PaletteType>> | null {
  const record = readObject(raw, 'types', issues);
  if (record === null) return null;
  const types: Record<string, PaletteType> = {};
  for (const [id, entry] of Object.entries(record)) {
    const type = decodeType(id, entry, `types.${id}`, issues);
    if (type !== null) types[id] = type;
  }
  return types;
}

function decodeType(id: string, raw: unknown, path: string, issues: PaletteSnapshotIssue[]): PaletteType | null {
  const record = readObject(raw, path, issues);
  if (record === null) return null;

  const declaredId = optionalString(record['id'], `${path}.id`, issues);
  if (declaredId !== null && declaredId !== id) {
    issues.push({
      code: 'invalid-field',
      path: `${path}.id`,
      message: `type id "${declaredId}" does not match its key "${id}"`,
    });
  }

  const defaults = decodeProperties(record['defaults'], `${path}.defaults`, issues) ?? {};
  const credentials = decodeProperties(record['credentials'], `${path}.credentials`, issues) ?? {};
  const category = optionalString(record['category'], `${path}.category`, issues);
  const dynamics = decodeDynamics(record['dynamics'], `${path}.dynamics`, issues);
  const module = optionalString(record['module'], `${path}.module`, issues) ?? '';

  return {
    id,
    module,
    nodeSet: optionalString(record['nodeSet'], `${path}.nodeSet`, issues) ?? module,
    version: optionalString(record['version'], `${path}.version`, issues) ?? '',
    category,
    paletteLabel: optionalString(record['paletteLabel'], `${path}.paletteLabel`, issues),
    color: optionalString(record['color'], `${path}.color`, issues),
    icon: optionalString(record['icon'], `${path}.icon`, issues),
    align: optionalString(record['align'], `${path}.align`, issues),
    inputs: optionalNumber(record['inputs'], `${path}.inputs`, issues),
    outputs: optionalNumber(record['outputs'], `${path}.outputs`, issues),
    isConfig: category === 'config' || record['isConfig'] === true,
    synthetic: record['synthetic'] === true,
    refs: decodeRefs(record['refs'], `${path}.refs`, issues) ?? {},
    defaults,
    credentials,
    params: decodeParams(record['params'], `${path}.params`, issues),
    dynamics,
  };
}

function decodeParams(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): readonly PaletteParameter[] {
  if (raw === undefined || raw === null) return [];
  const list = readArray(raw, path, issues);
  if (list === null) return [];
  const params: PaletteParameter[] = [];
  list.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = readObject(entry, entryPath, issues);
    if (record === null) return;
    const name = requireString(record['name'], `${entryPath}.name`, issues);
    if (name === null) return;
    params.push({
      name,
      type: optionalString(record['type'], `${entryPath}.type`, issues) ?? 'str',
      value: record['value'],
      ui: record['ui'],
    });
  });
  return params;
}

function decodeDynamics(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): TypeDynamics {
  if (raw === undefined || raw === null) return EMPTY_DYNAMICS;
  const record = readObject(raw, path, issues);
  if (record === null) return EMPTY_DYNAMICS;
  return {
    inputs: record['inputs'] === true,
    outputs: record['outputs'] === true,
    paletteLabel: record['paletteLabel'] === true,
    category: record['category'] === true,
    defaults: optionalStringArray(record['defaults'], `${path}.defaults`, issues) ?? [],
  };
}

function decodeRefs(
  raw: unknown,
  path: string,
  issues: PaletteSnapshotIssue[],
): Readonly<Record<string, RefSpec>> | null {
  if (raw === undefined) return null;
  const record = readObject(raw, path, issues);
  if (record === null) return null;
  const refs: Record<string, RefSpec> = {};
  for (const [name, entry] of Object.entries(record)) {
    const entryPath = `${path}.${name}`;
    const spec = readObject(entry, entryPath, issues);
    if (spec === null) continue;
    const kind = optionalString(spec['kind'], `${entryPath}.kind`, issues);
    if (kind !== 'one' && kind !== 'many') {
      issues.push({ code: 'invalid-field', path: `${entryPath}.kind`, message: `expected "one" or "many"` });
      continue;
    }
    refs[name] = { kind, targets: decodeTargets(spec['targets'], `${entryPath}.targets`, issues) };
  }
  return refs;
}

function decodeTargets(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): RefTargets {
  if (raw === '*') return '*';
  if (Array.isArray(raw)) {
    const targets: string[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        issues.push({ code: 'invalid-field', path: `${path}[${index}]`, message: 'expected a type id' });
        return;
      }
      targets.push(entry);
    });
    return targets;
  }
  issues.push({ code: 'invalid-field', path, message: `expected "*" or an array of type ids` });
  return '*';
}

function decodeProperties(
  raw: unknown,
  path: string,
  issues: PaletteSnapshotIssue[],
): Readonly<Record<string, PaletteProperty>> | null {
  if (raw === undefined) return null;
  const record = readObject(raw, path, issues);
  if (record === null) return null;
  const properties: Record<string, PaletteProperty> = {};
  for (const [name, entry] of Object.entries(record)) {
    const entryPath = `${path}.${name}`;
    const property = readObject(entry, entryPath, issues);
    if (property === null) continue;
    properties[name] = {
      value: property['value'],
      type: optionalString(property['type'], `${entryPath}.type`, issues),
      required: property['required'] === true,
      label: optionalString(property['label'], `${entryPath}.label`, issues),
      ui: property['ui'],
      dynamic: property['dynamic'] === true,
    };
  }
  return properties;
}

// --------------------------------------------------------------------------------------
// Structural readers — each reports at most one issue per offending value
// --------------------------------------------------------------------------------------

function readObject(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({
      code: path === '' ? 'not-an-object' : 'invalid-field',
      path,
      message: 'expected an object',
    });
    return null;
  }
  return raw as Record<string, unknown>;
}

function readArray(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): readonly unknown[] | null {
  if (!Array.isArray(raw)) {
    issues.push({ code: 'invalid-field', path, message: 'expected an array' });
    return null;
  }
  return raw;
}

/** A required string field. */
function requireString(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): string | null {
  if (typeof raw === 'string') return raw;
  issues.push({ code: raw === undefined ? 'missing-field' : 'invalid-field', path, message: 'expected a string' });
  return null;
}

/** An optional string field: absent or `null` becomes `null`, anything else is an issue. */
function optionalString(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  issues.push({ code: 'invalid-field', path, message: 'expected a string' });
  return null;
}

function optionalNumber(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  issues.push({ code: 'invalid-field', path, message: 'expected a finite number' });
  return null;
}

function readNumber(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  issues.push({ code: raw === undefined ? 'missing-field' : 'invalid-field', path, message: 'expected a number' });
  return null;
}

function optionalStringArray(raw: unknown, path: string, issues: PaletteSnapshotIssue[]): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    issues.push({ code: 'invalid-field', path, message: 'expected an array of strings' });
    return null;
  }
  const values: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      issues.push({ code: 'invalid-field', path: `${path}[${index}]`, message: 'expected a string' });
      return;
    }
    values.push(entry);
  });
  return values;
}

// --------------------------------------------------------------------------------------
// Comparison and reporting
// --------------------------------------------------------------------------------------

export interface PaletteTypeChange {
  readonly id: string;
  /** Short, human-readable reasons, e.g. `defaults: added crontab`, `version 3.6.6 → 3.6.2`. */
  readonly reasons: readonly string[];
}

export interface PaletteNodeSetChange {
  readonly id: string;
  readonly kind: 'added' | 'removed' | 'version' | 'metadata';
  readonly from: string | null;
  readonly to: string | null;
  /** Field-level detail for `metadata` changes. */
  readonly reasons?: readonly string[];
}

export interface PaletteDiff {
  readonly identical: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly PaletteTypeChange[];
  readonly nodeSets: readonly PaletteNodeSetChange[];
}

/** Compares two snapshots by content (provenance and generator are ignored). */
export function diffPalette(before: PaletteSnapshot, after: PaletteSnapshot): PaletteDiff {
  const beforeIds = new Set(Object.keys(before.types));
  const afterIds = new Set(Object.keys(after.types));

  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const changed: PaletteTypeChange[] = [];

  for (const id of [...beforeIds].filter((candidate) => afterIds.has(candidate)).sort()) {
    const from = before.types[id] as PaletteType;
    const to = after.types[id] as PaletteType;
    if (wireJson(from) === wireJson(to)) continue;
    changed.push({ id, reasons: describeTypeChange(from, to) });
  }

  const nodeSets: PaletteNodeSetChange[] = [];
  const beforeSets = new Map(before.nodeSets.map((nodeSet) => [nodeSet.id, nodeSet]));
  const afterSets = new Map(after.nodeSets.map((nodeSet) => [nodeSet.id, nodeSet]));
  for (const [id, nodeSet] of beforeSets) {
    const next = afterSets.get(id);
    if (next === undefined) {
      nodeSets.push({ id, kind: 'removed', from: nodeSet.version, to: null });
    } else if (next.version !== nodeSet.version) {
      nodeSets.push({ id, kind: 'version', from: nodeSet.version, to: next.version });
    } else {
      const reasons = describeNodeSetChange(nodeSet, next);
      if (reasons.length > 0) nodeSets.push({ id, kind: 'metadata', from: null, to: null, reasons });
    }
  }
  for (const [id, nodeSet] of afterSets) {
    if (!beforeSets.has(id)) nodeSets.push({ id, kind: 'added', from: null, to: nodeSet.version });
  }

  return {
    identical: added.length === 0 && removed.length === 0 && changed.length === 0 && nodeSets.length === 0,
    added,
    removed,
    changed,
    nodeSets,
  };
}

function describeNodeSetChange(from: PaletteNodeSet, to: PaletteNodeSet): readonly string[] {
  const reasons: string[] = [];
  for (const field of ['name', 'module'] as const) {
    if (from[field] !== to[field]) reasons.push(`${field} ${String(from[field])} → ${String(to[field])}`);
  }
  for (const field of ['enabled', 'local', 'user'] as const) {
    if (from[field] !== to[field]) reasons.push(`${field} ${String(from[field])} → ${String(to[field])}`);
  }
  if (wireJson([...from.types].sort()) !== wireJson([...to.types].sort())) reasons.push('type membership changed');
  return reasons;
}

function describeTypeChange(from: PaletteType, to: PaletteType): readonly string[] {
  const reasons: string[] = [];
  if (from.version !== to.version) reasons.push(`version ${from.version} → ${to.version}`);
  if (from.nodeSet !== to.nodeSet) reasons.push(`nodeSet ${from.nodeSet} → ${to.nodeSet}`);
  for (const field of ['category', 'paletteLabel', 'color', 'icon', 'align', 'inputs', 'outputs'] as const) {
    if (from[field] !== to[field]) reasons.push(`${field} ${String(from[field])} → ${String(to[field])}`);
  }
  if (from.isConfig !== to.isConfig) reasons.push(`isConfig ${String(from.isConfig)} → ${String(to.isConfig)}`);
  if (from.synthetic !== to.synthetic) reasons.push(`synthetic ${String(from.synthetic)} → ${String(to.synthetic)}`);

  const defaults = describePropertyChange(from.defaults, to.defaults, 'defaults');
  reasons.push(...defaults);
  const credentials = describePropertyChange(from.credentials, to.credentials, 'credentials');
  reasons.push(...credentials);

  if (wireJson(from.refs) !== wireJson(to.refs)) reasons.push('references changed');
  if (wireJson(from.params) !== wireJson(to.params)) reasons.push('subflow parameters changed');
  if (wireJson(from.dynamics) !== wireJson(to.dynamics)) reasons.push('dynamic declarations changed');
  return reasons.length > 0 ? reasons : ['declaration changed'];
}

function describePropertyChange(
  from: Readonly<Record<string, PaletteProperty>>,
  to: Readonly<Record<string, PaletteProperty>>,
  label: string,
): readonly string[] {
  const reasons: string[] = [];
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  const added = [...names].filter((name) => !(name in from));
  const removed = [...names].filter((name) => !(name in to));
  const modified = [...names]
    .filter((name) => name in from && name in to)
    .filter((name) => wireJson(from[name]) !== wireJson(to[name]));
  if (added.length > 0) reasons.push(`${label}: added ${added.join(', ')}`);
  if (removed.length > 0) reasons.push(`${label}: removed ${removed.join(', ')}`);
  if (modified.length > 0) reasons.push(`${label}: changed ${modified.join(', ')}`);
  return reasons;
}

export interface PaletteSummary {
  readonly schemaVersion: number;
  readonly nodeRedVersion: string | null;
  readonly typeCount: number;
  readonly nodeSetCount: number;
  /** Distinct npm modules that provide at least one type, with their versions. */
  readonly modules: readonly { readonly module: string; readonly version: string; readonly typeCount: number }[];
}

/** Compact description for CLI output and test assertions. */
export function describePalette(snapshot: PaletteSnapshot): PaletteSummary {
  const modules = new Map<string, { module: string; version: string; typeCount: number }>();
  for (const type of Object.values(snapshot.types)) {
    const entry = modules.get(type.module);
    if (entry === undefined) {
      modules.set(type.module, { module: type.module, version: type.version, typeCount: 1 });
    } else {
      entry.typeCount += 1;
    }
  }

  return {
    schemaVersion: snapshot.schemaVersion,
    nodeRedVersion: snapshot.nodeRedVersion,
    typeCount: Object.keys(snapshot.types).length,
    nodeSetCount: snapshot.nodeSets.length,
    modules: [...modules.values()].sort((a, b) => (a.module < b.module ? -1 : 1)),
  };
}

function wireJson(value: unknown): string {
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

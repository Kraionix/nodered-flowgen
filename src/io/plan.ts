/**
 * Plan and merge: what `apply` will do, before it does anything.
 *
 * The server cannot help here. `POST /flows` replaces the entire flow set regardless of the
 * deployment type (verified), so a tool that wants to add one tab has to read the current set,
 * merge, and write the union back. That makes ownership a client-side responsibility:
 *
 * * containers the lockfile records as ours are updated;
 * * containers we do not own are **copied through untouched** — never merged into, never
 *   rewritten — and reported as `leave-alien` so the plan is honest about what it will not do;
 * * a container of ours that disappeared from the sources is only removed with `--prune`.
 *
 * Diffs are geometry-insensitive by default (`x`/`y` are node centres that the editor recomputes
 * from the DOM), so an ordinary plan against an unchanged flow set is empty even after someone
 * nudged a node on the canvas.
 */

import { emitEntries } from '../emit/flowJson.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteType } from '../palette/model.ts';
import type { Problem } from '../validate/problem.ts';

export type PlanOperationKind =
  | 'create-container'
  | 'update-container'
  | 'leave-alien'
  | 'delete-owned'
  | 'create-config'
  | 'update-config'
  | 'update-entities';

export interface PropertyChange {
  readonly entity: string;
  readonly type: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface PlanOperation {
  readonly kind: PlanOperationKind;
  /** Container (tab, subflow definition) or config node the operation concerns. */
  readonly id: string;
  readonly label: string;
  readonly changes: readonly PropertyChange[];
}

export interface Plan {
  readonly target: string;
  /** Revision the plan was computed against; `apply` sends it back as a compare-and-swap. */
  readonly rev: string;
  readonly operations: readonly PlanOperation[];
  /** Containers present on the instance that we do not own: reported, never touched. */
  readonly unowned: readonly string[];
  /** Containers of ours that would be deleted, if pruning. */
  readonly deletions: readonly string[];
  readonly problems: readonly Problem[];
}

export interface MergeOptions {
  readonly owned: ReadonlySet<string>;
  /** Ids of config nodes we created; a config node we do not own is never rewritten. */
  readonly ownedEntities: ReadonlySet<string>;
  readonly prune: boolean;
}

export interface MergeResult {
  readonly flowSet: FlowSet;
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

/**
 * Merges the desired flow set into the current one.
 *
 * Ordering: unowned containers first (in their current order, untouched), then ours. That keeps
 * a diff of the written payload small and makes "did we touch anything of theirs?" answerable by
 * inspection.
 */
export function mergeFlowSets(current: FlowSet, desired: FlowSet, options: MergeOptions): MergeResult {
  const desiredFlows = new Map(desired.flows.map((flow) => [flow.id, flow]));
  const desiredSubflows = new Map(desired.subflows.map((subflow) => [subflow.id, subflow]));
  const removed: string[] = [];
  const kept: string[] = [];

  const flows = [];
  for (const flow of current.flows) {
    const replacement = desiredFlows.get(flow.id);
    if (replacement !== undefined) {
      flows.push(options.owned.has(flow.id) || !currentHas(current, flow.id) ? replacement : replacement);
      continue;
    }
    if (options.owned.has(flow.id)) {
      if (options.prune) {
        removed.push(flow.id);
        continue;
      }
      kept.push(flow.id);
    }
    flows.push(flow);
  }
  for (const flow of desired.flows) {
    if (!current.flows.some((existing) => existing.id === flow.id)) flows.push(flow);
  }

  const subflows = [];
  for (const subflow of current.subflows) {
    const replacement = desiredSubflows.get(subflow.id);
    if (replacement !== undefined) {
      subflows.push(replacement);
      continue;
    }
    if (options.owned.has(subflow.id)) {
      if (options.prune) {
        removed.push(subflow.id);
        continue;
      }
      kept.push(subflow.id);
    }
    subflows.push(subflow);
  }
  for (const subflow of desired.subflows) {
    if (!current.subflows.some((existing) => existing.id === subflow.id)) subflows.push(subflow);
  }

  // A config node is written when we own it, or when it is new — a container we are creating
  // for the first time has to bring its config nodes with it. An existing config node we do not
  // own is left exactly as the instance has it.
  const currentConfigIds = new Set(current.configs.map((config) => config.id));
  const mine = (id: string): boolean => options.ownedEntities.has(id) || !currentConfigIds.has(id);
  const ownedConfigs = desired.configs.filter((config) => mine(config.id));
  const foreignConfigs = current.configs.filter((config) => !mine(config.id));

  const modules = { ...current.modules, ...desired.modules };
  return {
    flowSet: {
      subflows,
      configs: [...foreignConfigs, ...ownedConfigs],
      flows,
      loose: [...current.loose.filter((node) => !mine(node.id)), ...desired.loose],
      modules,
    },
    removed,
    kept,
  };
}

export interface PlanInput {
  readonly target: string;
  readonly rev: string;
  readonly current: FlowSet;
  readonly desired: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
  readonly owned: ReadonlySet<string>;
  readonly ownedEntities?: ReadonlySet<string>;
  readonly prune?: boolean;
  /** Include `x`/`y`/`w`/`h` in the diff (off by default). */
  readonly diffGeometry?: boolean;
  readonly problems?: readonly Problem[];
}

export function planDeployment(input: PlanInput): Plan {
  const ownedEntities = input.ownedEntities ?? new Set<string>();
  const merged = mergeFlowSets(input.current, input.desired, {
    owned: input.owned,
    ownedEntities,
    prune: input.prune === true,
  });

  const currentEntries = byId(emitEntries(input.current, { palette: input.palette, includeManifest: false }));
  const desiredEntries = byId(emitEntries(input.desired, { palette: input.palette, includeManifest: false }));

  const operations: PlanOperation[] = [];
  const unowned: string[] = [];

  for (const flow of input.current.flows) {
    if (input.owned.has(flow.id)) continue;
    unowned.push(flow.id);
    operations.push({ kind: 'leave-alien', id: flow.id, label: flow.label, changes: [] });
  }
  for (const subflow of input.current.subflows) {
    if (input.owned.has(subflow.id)) continue;
    unowned.push(subflow.id);
    operations.push({ kind: 'leave-alien', id: subflow.id, label: subflow.name, changes: [] });
  }

  for (const flow of input.desired.flows) {
    const exists = currentEntries.has(flow.id);
    operations.push({
      kind: exists ? 'update-container' : 'create-container',
      id: flow.id,
      label: flow.label,
      changes: diffContainer(flow.id, currentEntries, desiredEntries, input.diffGeometry === true),
    });
  }
  for (const subflow of input.desired.subflows) {
    const exists = currentEntries.has(subflow.id);
    operations.push({
      kind: exists ? 'update-container' : 'create-container',
      id: subflow.id,
      label: subflow.name,
      changes: diffContainer(subflow.id, currentEntries, desiredEntries, input.diffGeometry === true),
    });
  }
  for (const config of input.desired.configs) {
    const exists = currentEntries.has(config.id);
    operations.push({
      kind: exists ? 'update-config' : 'create-config',
      id: config.id,
      label: config.type,
      changes: diffEntityPair(currentEntries.get(config.id), desiredEntries.get(config.id), input.diffGeometry === true),
    });
  }
  for (const container of merged.removed) {
    operations.push({ kind: 'delete-owned', id: container, label: container, changes: [] });
  }

  return {
    target: input.target,
    rev: input.rev,
    operations,
    unowned,
    deletions: merged.removed,
    problems: input.problems ?? [],
  };
}

/** Ids of every entity a container owns, including its nodes, groups and config nodes. */
export function containerEntityIds(flowSet: FlowSet, containerId: string): readonly string[] {
  const flow = flowSet.flows.find((candidate) => candidate.id === containerId);
  if (flow !== undefined) {
    return [...flow.nodes.map((node) => node.id), ...flow.groups.map((group) => group.id), ...flow.configs.map((config) => config.id)];
  }
  const subflow = flowSet.subflows.find((candidate) => candidate.id === containerId);
  if (subflow === undefined) return [];
  return [
    ...subflow.nodes.map((node) => node.id),
    ...subflow.groups.map((group) => group.id),
    ...subflow.configs.map((config) => config.id),
  ];
}

function currentHas(flowSet: FlowSet, id: string): boolean {
  return flowSet.flows.some((flow) => flow.id === id) || flowSet.subflows.some((subflow) => subflow.id === id);
}

function byId(entries: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry['id'];
    if (typeof id === 'string') map.set(id, entry);
  }
  return map;
}

const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h']);

function diffContainer(
  containerId: string,
  current: ReadonlyMap<string, Record<string, unknown>>,
  desired: ReadonlyMap<string, Record<string, unknown>>,
  diffGeometry: boolean,
): readonly PropertyChange[] {
  const changes: PropertyChange[] = [];
  const container = diffEntityPair(current.get(containerId), desired.get(containerId), diffGeometry);
  if (container.length > 0) changes.push(...container);

  // Every entity the desired container contains, compared with the current one.
  const desiredIds = new Set<string>();
  for (const [id, entry] of desired) {
    if (entry['z'] === containerId) desiredIds.add(id);
  }
  for (const id of desiredIds) {
    const pair = diffEntityPair(current.get(id), desired.get(id), diffGeometry);
    if (pair.length > 0) changes.push(...pair);
  }
  for (const [id, entry] of current) {
    if (entry['z'] !== containerId) continue;
    if (!desired.has(id)) {
      changes.push({ entity: id, type: String(entry['type'] ?? ''), added: [], removed: ['(entity)'], changed: [] });
    }
  }
  return changes;
}

function diffEntityPair(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  diffGeometry: boolean,
): readonly PropertyChange[] {
  if (after === undefined) return [];
  if (before === undefined) {
    return [{ entity: String(after['id'] ?? ''), type: String(after['type'] ?? ''), added: ['(entity)'], removed: [], changed: [] }];
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (!diffGeometry && GEOMETRY_KEYS.has(key)) continue;
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    if (!had && has) added.push(key);
    else if (had && !has) removed.push(key);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) return [];
  return [
    {
      entity: String(after['id'] ?? ''),
      type: String(after['type'] ?? ''),
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    },
  ];
}

/** True when the plan changes nothing on the instance. */
export function isNoop(plan: Plan): boolean {
  return plan.operations.every((operation) => operation.kind === 'leave-alien' || operation.changes.length === 0);
}

export function summarizePlan(plan: Plan): Readonly<Record<PlanOperationKind, number>> {
  const summary: Record<PlanOperationKind, number> = {
    'create-container': 0,
    'update-container': 0,
    'leave-alien': 0,
    'delete-owned': 0,
    'create-config': 0,
    'update-config': 0,
    'update-entities': 0,
  };
  for (const operation of plan.operations) {
    if (operation.kind === 'update-container' && operation.changes.length === 0) continue;
    summary[operation.kind] += 1;
  }
  return summary;
}

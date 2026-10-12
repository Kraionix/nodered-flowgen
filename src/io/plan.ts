/**
 * Plan and merge: what `apply` will do, before it does anything.
 *
 * The server cannot help here. `POST /flows` replaces the *entire* flow set regardless of the
 * deployment type (verified), so a tool that wants to add one tab has to read the current set,
 * merge, and write the union back. Ownership is therefore a client-side responsibility:
 *
 * * containers the lockfile records as ours are updated;
 * * containers we do not own are **copied through untouched** — never merged into, never
 *   rewritten — and reported as `leave-alien`, so the plan is honest about what it will not do;
 * * a container of ours that disappeared from the sources is only removed with `--prune`.
 *
 * ## Why this file computes the payload *and* the operations
 *
 * It used to do neither: `planDeployment` diffed `desired` against `current` to produce the
 * operations while `mergeFlowSets` independently produced the flow set to write. Two
 * implementations of one decision, and they disagreed:
 *
 * ```
 * ops: [ 'update-container:t1 changes=0', 'update-config:c9 changes=1' ]   # the plan…
 * merged config name actually written: [ 'theirs' ]                        # …and the payload
 * ops when our config vanishes: [ 'update-container:t1' ]  deletions: []   # 100% invisible
 * ```
 *
 * The plan described a write that was not going to happen, and stayed silent about one that was.
 * There is now a single `planMerge`, whose operations are derived by **diffing `current` against
 * the payload it just built** — never against `desired`. That makes "every operation is a real
 * difference, and every difference is reported" true by construction, and `io-plan.test.ts`
 * asserts it over a matrix of situations.
 *
 * ## Decisions are operations too
 *
 * `leave-alien` and `keep-config` change nothing on the instance; they record a *decision* and
 * carry a reason. They are separated from the mutations (`MUTATION_KINDS`) so the agreement
 * property above stays checkable: mutations correspond to differences, decisions to the absence of
 * one.
 */

import { emitEntries } from '../emit/flowJson.ts';
import {
  eachConfig,
  eachGroup,
  eachNode,
  type ConfigNode,
  type EntityId,
  type Flow,
  type FlowSet,
  type Node,
  type SubflowDef,
} from '../model/entities.ts';
import { createIdAllocator } from '../model/ids.ts';
import { inboundReferences, type Reference } from '../model/references.ts';
import type { PaletteType } from '../palette/model.ts';
import type { Problem } from '../diagnostics/index.ts';

export type PlanOperationKind =
  | 'create-container'
  | 'update-container'
  | 'delete-container'
  | 'leave-alien'
  | 'create-config'
  | 'update-config'
  | 'delete-config'
  | 'keep-config'
  | 'create-node'
  | 'update-node'
  | 'delete-node';

/** The operations that change the instance. Everything else records a decision. */
export const MUTATION_KINDS: readonly PlanOperationKind[] = [
  'create-container',
  'update-container',
  'delete-container',
  'create-config',
  'update-config',
  'delete-config',
  'create-node',
  'update-node',
  'delete-node',
];

/** Property-level difference between what the instance holds and what the payload will hold. */
export interface PropertyChange {
  readonly entity: EntityId;
  readonly type: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface PlanOperation {
  readonly kind: PlanOperationKind;
  /** Container, config node or containerless node the operation concerns. */
  readonly id: EntityId;
  readonly label: string;
  readonly changes: readonly PropertyChange[];
  /** Why a decision was taken; always set for `keep-config` and `leave-alien`. */
  readonly reason?: string;
}

/** A decision that is not about one entity. */
export interface PlanNote {
  readonly code: 'reassigned';
  readonly entity: EntityId;
  readonly message: string;
}

export interface MergeRequest {
  readonly target: string;
  /** Revision the plan was computed against; `apply` sends it back as a compare-and-swap. */
  readonly rev: string;
  readonly current: FlowSet;
  readonly desired: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** Containers the lockfile records as ours. */
  readonly owned: ReadonlySet<EntityId>;
  /** Every id we have ever allocated: nodes, config nodes and groups included. */
  readonly ownedEntities: ReadonlySet<EntityId>;
  readonly prune?: boolean;
  /** Give a colliding container a fresh id instead of refusing to write it. */
  readonly reassign?: boolean;
  /** Include `x`/`y`/`w`/`h` in the diff (off by default). */
  readonly diffGeometry?: boolean;
  /** Problems from the validation gate, carried through so one report holds everything. */
  readonly problems?: readonly Problem[];
}

export interface DeploymentPlan {
  readonly target: string;
  readonly rev: string;
  /** The exact flow set `apply` will write. */
  readonly payload: FlowSet;
  readonly operations: readonly PlanOperation[];
  /** Containers of ours that would be removed. */
  readonly deletions: readonly EntityId[];
  /** Containers present on the instance that we do not own: reported, never touched. */
  readonly unowned: readonly EntityId[];
  readonly notes: readonly PlanNote[];
  readonly problems: readonly Problem[];
}

type Container = Flow | SubflowDef;

interface Placement {
  /** Container id on the instance (`id` differs from it after a reassignment). */
  readonly previous: EntityId;
  readonly container: Container;
}

export function planMerge(request: MergeRequest): DeploymentPlan {
  const prune = request.prune === true;
  const problems: Problem[] = [...(request.problems ?? [])];
  const notes: PlanNote[] = [];
  const operations: PlanOperation[] = [];
  const mine = (id: EntityId): boolean => request.ownedEntities.has(id);

  const currentContainers = new Map<EntityId, Container>();
  for (const flow of request.current.flows) currentContainers.set(flow.id, flow);
  for (const subflow of request.current.subflows) currentContainers.set(subflow.id, subflow);

  // ------------------------------------------------------------------------------------
  // 1. Containers: the ids the payload uses, and the instance's containers we leave alone
  // ------------------------------------------------------------------------------------

  const usedIds = new Set<EntityId>([
    ...currentContainers.keys(),
    ...request.desired.flows.map((flow) => flow.id),
    ...request.desired.subflows.map((subflow) => subflow.id),
    ...request.ownedEntities,
  ]);

  const placements: Placement[] = [];

  const place = (container: Container): void => {
    const existing = currentContainers.get(container.id);
    if (existing === undefined || request.owned.has(container.id)) {
      placements.push({ previous: container.id, container });
      return;
    }

    // The id belongs to a container we do not own. Writing ours would overwrite somebody else's
    // work — the exact thing ownership exists to prevent — and it used to happen silently.
    if (request.reassign !== true) {
      problems.push({
        code: 'plan/id-collision',
        severity: 'error',
        entity: container.id,
        path: 'id',
        message: `"${container.id}" already exists on ${request.target} and is not ours`,
        hint: 'rename it in the sources, or pass --reassign to deploy it under a fresh id',
      });
      return;
    }

    // The same base with the next free ordinal (`orders` → `orders_2`), allocated by the one
    // allocator the builder uses, so a reassigned id looks like every other id we generate.
    const allocator = createIdAllocator({ existing: usedIds });
    const fresh = allocator.allocate(container.id, { slug: container.id });
    usedIds.add(fresh);
    placements.push({ previous: container.id, container: renameContainer(container, fresh) });
    notes.push({
      code: 'reassigned',
      entity: container.id,
      message: `${container.id} → ${fresh}: "${container.id}" is taken on ${request.target} by a container we do not own`,
    });
  };

  for (const flow of request.desired.flows) place(flow);
  for (const subflow of request.desired.subflows) place(subflow);

  // Only a placement that keeps its id replaces something. A reassigned container leaves the
  // alien it collided with exactly where it was — dropping it here would delete a container we do
  // not own, which is the one thing the merge must never do.
  const replaced = new Set<EntityId>(placements.filter((entry) => entry.previous === entry.container.id).map((entry) => entry.previous));

  // ------------------------------------------------------------------------------------
  // 2. Config nodes, in every scope (D20), and containerless nodes
  // ------------------------------------------------------------------------------------

  const alienContainers = new Set<EntityId>([...currentContainers.keys()].filter((id) => !request.owned.has(id)));
  const inAlienContainer = (z: EntityId | undefined): boolean => z !== undefined && alienContainers.has(z);

  const foreign = foreignReferences(request.current, request.palette, request.owned, request.ownedEntities);
  const currentConfigs = eachConfig(request.current).filter((config) => !inAlienContainer(config.z));
  const currentLoose = request.current.loose.filter((node) => !inAlienContainer(node.z));

  const configPlan = planEntities<ConfigNode>({
    current: currentConfigs,
    desired: eachConfig(request.desired),
    mine,
    prune,
    foreign,
  });

  const loosePlan = planEntities<Node>({
    current: currentLoose,
    desired: request.desired.loose,
    mine,
    prune,
    foreign: new Map(),
  });

  for (const collision of [...configPlan.collisions, ...loosePlan.collisions]) {
    problems.push({
      code: 'plan/id-collision',
      severity: 'error',
      entity: collision.id,
      path: 'id',
      message: `"${collision.id}" already exists on ${request.target} and is not ours`,
      hint: 'change its key in the sources so it gets a different id',
    });
  }

  // ------------------------------------------------------------------------------------
  // 3. The payload
  // ------------------------------------------------------------------------------------

  const prunedConfigs = new Set<EntityId>(configPlan.deleted.map((config) => config.id));
  const payloadFlows: Flow[] = [];
  const payloadSubflows: SubflowDef[] = [];
  const unowned: EntityId[] = [];
  const deletions: EntityId[] = [];

  for (const container of [...request.current.flows, ...request.current.subflows]) {
    if (replaced.has(container.id)) continue;

    if (request.owned.has(container.id) && prune) {
      // Ours, absent from the sources, and pruning was asked for.
      if (!containsContainer(request.desired, container.id)) {
        deletions.push(container.id);
        continue;
      }
    }

    if (!request.owned.has(container.id)) unowned.push(container.id);
    // A config node we decided to delete has to leave the container it lives in, even when the
    // container itself is copied through — otherwise the plan would report a deletion that the
    // payload does not perform.
    pushContainer({ ...container, configs: container.configs.filter((config) => !prunedConfigs.has(config.id)) }, payloadFlows, payloadSubflows);
  }

  for (const placement of placements) {
    const previous = currentContainers.get(placement.previous);
    const scope = placement.container.id;
    const keptHere = previous === undefined ? [] : configPlan.kept.filter((config) => config.z === placement.previous);
    const writtenHere = configPlan.written.filter((config) => config.z === placement.previous || config.z === scope);

    pushContainer(
      {
        ...placement.container,
        // Config nodes scoped to the container come from two places and both matter: the ones the
        // sources declare, and the ones we decided to keep. The old merge replaced the container
        // wholesale, so an owned config scoped to our own tab died with it (P1-5).
        configs: [...keptHere.map((config) => ({ ...config, z: scope })), ...writtenHere.map((config) => ({ ...config, z: scope }))],
      },
      payloadFlows,
      payloadSubflows,
    );
  }

  const payload: FlowSet = {
    subflows: payloadSubflows,
    configs: [
      ...configPlan.kept.filter((config) => config.z === undefined),
      ...configPlan.written.filter((config) => config.z === undefined),
    ],
    flows: payloadFlows,
    loose: [...loosePlan.kept, ...loosePlan.written],
    modules: { ...request.current.modules, ...request.desired.modules },
  };

  // ------------------------------------------------------------------------------------
  // 4. Operations: the payload against the instance, entity by entity
  // ------------------------------------------------------------------------------------

  const currentEntries = byId(emitEntries(request.current, { palette: request.palette, includeManifest: false }));
  const payloadEntries = byId(emitEntries(payload, { palette: request.palette, includeManifest: false }));
  const differences = diffAll(currentEntries, payloadEntries, request.diffGeometry === true);
  const changedFor = (ids: Iterable<EntityId>): readonly PropertyChange[] =>
    [...ids].flatMap((id) => {
      const change = differences.get(id);
      return change === undefined ? [] : [change];
    });

  for (const id of unowned) {
    const container = currentContainers.get(id) as Container;
    operations.push({ kind: 'leave-alien', id, label: labelOf(container), changes: [], reason: 'not ours: copied through untouched' });
  }

  for (const placement of placements) {
    const id = placement.container.id;
    const exists = id === placement.previous && currentContainers.has(id);
    // Config nodes have their own operations; everything else that lives in the container is
    // reported here, with the property names that differ.
    // Both sides of the diff: a node the payload no longer has is as much a change as one it
    // gained, and its id only appears in the *previous* container.
    const previous = exists ? currentContainers.get(id) : undefined;
    const changes = changedFor([
      ...containerNodeIds(placement.container),
      ...(previous === undefined ? [] : containerNodeIds(previous)),
      ...(exists ? [id] : []),
    ]);
    if (exists && changes.length === 0) continue;
    operations.push({ kind: exists ? 'update-container' : 'create-container', id, label: labelOf(placement.container), changes });
  }

  for (const id of deletions) {
    const container = currentContainers.get(id) as Container;
    operations.push({ kind: 'delete-container', id, label: labelOf(container), changes: [] });
  }

  for (const config of configPlan.written) {
    const exists = currentEntries.has(config.id);
    const changes = changedFor([config.id]);
    if (exists && changes.length === 0) continue;
    operations.push({ kind: exists ? 'update-config' : 'create-config', id: config.id, label: config.type, changes });
  }
  for (const config of configPlan.deleted) {
    operations.push({ kind: 'delete-config', id: config.id, label: config.type, changes: [] });
  }
  for (const decision of configPlan.keptDecisions) {
    operations.push({ kind: 'keep-config', id: decision.entity.id, label: decision.entity.type, changes: [], reason: decision.reason });
  }

  for (const node of loosePlan.written) {
    const exists = currentEntries.has(node.id);
    const changes = changedFor([node.id]);
    if (exists && changes.length === 0) continue;
    operations.push({ kind: exists ? 'update-node' : 'create-node', id: node.id, label: node.type, changes });
  }
  for (const node of loosePlan.deleted) {
    operations.push({ kind: 'delete-node', id: node.id, label: node.type, changes: [] });
  }

  return { target: request.target, rev: request.rev, payload, operations, deletions, unowned, notes, problems };
}

function containsContainer(flowSet: FlowSet, id: EntityId): boolean {
  return flowSet.flows.some((flow) => flow.id === id) || flowSet.subflows.some((subflow) => subflow.id === id);
}

// ---------------------------------------------------------------------------------------------
// Ownership of config nodes and containerless nodes (D20)
// ---------------------------------------------------------------------------------------------

interface Decision<T> {
  readonly entity: T;
  readonly reason: string;
}

interface EntityPlan<T> {
  /** Ours, or new: written into the payload. */
  readonly written: readonly T[];
  /** Ours, undeclared, pruned and unreferenced: dropped from the payload. */
  readonly deleted: readonly T[];
  /** Copied through from the instance, unchanged. */
  readonly kept: readonly T[];
  /** The kept ones that need a reason in the plan. */
  readonly keptDecisions: readonly Decision<T>[];
  /** Declared with an id that belongs to somebody else: refused. */
  readonly collisions: readonly T[];
}

/**
 * A node we own but no longer declare is not simply dropped. Deleting it is opt-in (`--prune`)
 * *and* conditional: if something we do not control still references it — an alien tab holding
 * `broker: "cfg1"` — removing it would break a flow we never touched, so it is kept and the plan
 * says why. That is the one case where "we did nothing" needs an explanation attached.
 */
function planEntities<T extends { readonly id: EntityId; readonly type: string }>(options: {
  readonly current: readonly T[];
  readonly desired: readonly T[];
  readonly mine: (id: EntityId) => boolean;
  readonly prune: boolean;
  readonly foreign: ReadonlyMap<EntityId, readonly Reference[]>;
}): EntityPlan<T> {
  const currentById = new Map(options.current.map((entity) => [entity.id, entity]));
  const desiredIds = new Set(options.desired.map((entity) => entity.id));
  const written: T[] = [];
  const kept: T[] = [];
  const deleted: T[] = [];
  const keptDecisions: Decision<T>[] = [];
  const collisions: T[] = [];

  for (const entity of options.desired) {
    const existing = currentById.get(entity.id);
    if (existing === undefined || options.mine(entity.id)) {
      written.push(entity);
      continue;
    }
    // Somebody else's entity holds the id we want. Dropping ours silently is what used to happen;
    // refusing is the decision (D21), and their version stays in the payload because refusing has
    // to mean "the instance is left alone", not "the entity disappears from the write".
    collisions.push(entity);
    kept.push(existing);
    keptDecisions.push({ entity: existing, reason: 'not ours, and the sources declare a different definition for this id' });
  }

  for (const entity of options.current) {
    if (desiredIds.has(entity.id)) continue;
    if (!options.mine(entity.id)) {
      // Somebody else's, and we do not declare it either: copied through, like an alien container.
      // Dropping it here would take somebody's config node off their instance.
      kept.push(entity);
      continue;
    }

    const references = options.foreign.get(entity.id) ?? [];
    if (options.prune && references.length === 0) {
      deleted.push(entity);
      continue;
    }
    kept.push(entity);
    keptDecisions.push({
      entity,
      reason:
        options.prune && references.length > 0
          ? `undeclared, but still referenced by ${references.map(describeReference).join(', ')}`
          : 'undeclared, and --prune was not given',
    });
  }

  return { written, deleted, kept, keptDecisions, collisions };
}

function describeReference(reference: Reference): string {
  return `${reference.from} (${reference.path})`;
}

/**
 * References to an entity from outside our own containers.
 *
 * "Ours" is decided by ownership, not by scope: a node in one of our tabs is ours, a node in
 * somebody else's tab is not, and a config node we do not own is not ours either. A reference from
 * the top level counts as foreign — conservative, and a top-level reference has no container to
 * prove otherwise.
 */
function foreignReferences(
  current: FlowSet,
  palette: Readonly<Record<string, PaletteType>>,
  owned: ReadonlySet<EntityId>,
  ownedEntities: ReadonlySet<EntityId>,
): ReadonlyMap<EntityId, readonly Reference[]> {
  const containerOf = new Map<EntityId, EntityId | undefined>();
  for (const node of eachNode(current)) containerOf.set(node.id, node.z);
  for (const config of eachConfig(current)) containerOf.set(config.id, config.z);
  for (const group of eachGroup(current)) containerOf.set(group.id, group.z);

  const isOurs = (from: EntityId): boolean => {
    if (ownedEntities.has(from)) return true;
    const container = containerOf.get(from);
    return container !== undefined && owned.has(container);
  };

  const foreign = new Map<EntityId, readonly Reference[]>();
  for (const [id, references] of inboundReferences(current, palette)) {
    const outside = references.filter((reference) => !isOurs(reference.from));
    if (outside.length > 0) foreign.set(id, outside);
  }
  return foreign;
}

// ---------------------------------------------------------------------------------------------
// Payload assembly helpers
// ---------------------------------------------------------------------------------------------

function containerNodeIds(container: Container): readonly EntityId[] {
  return [...container.nodes.map((node) => node.id), ...container.groups.map((group) => group.id)];
}

function pushContainer(container: Container, flows: Flow[], subflows: SubflowDef[]): void {
  if (isFlow(container)) flows.push(container);
  else subflows.push(container);
}

function isFlow(container: Container): container is Flow {
  return 'label' in container;
}

function labelOf(container: Container): string {
  return isFlow(container) ? container.label : container.name;
}

/** Rewrites a container's own id, and the scope of everything inside it. */
function renameContainer(container: Container, id: EntityId): Container {
  const rescope = <T extends { readonly z?: EntityId | undefined }>(entity: T): T =>
    entity.z === container.id ? { ...entity, z: id } : entity;

  return {
    ...container,
    id,
    nodes: container.nodes.map(rescope),
    groups: container.groups.map(rescope),
    configs: container.configs.map(rescope),
  };
}

// ---------------------------------------------------------------------------------------------
// Emission diffing
// ---------------------------------------------------------------------------------------------

function byId(entries: readonly Record<string, unknown>[]): Map<EntityId, Record<string, unknown>> {
  const map = new Map<EntityId, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry['id'];
    if (typeof id === 'string') map.set(id, entry);
  }
  return map;
}

const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h']);

/** Entity id → what changed about it, for every entity whose emitted form differs. */
function diffAll(
  current: ReadonlyMap<EntityId, Record<string, unknown>>,
  payload: ReadonlyMap<EntityId, Record<string, unknown>>,
  diffGeometry: boolean,
): ReadonlyMap<EntityId, PropertyChange> {
  const changes = new Map<EntityId, PropertyChange>();
  for (const id of new Set([...current.keys(), ...payload.keys()])) {
    const change = diffEntry(current.get(id), payload.get(id), diffGeometry);
    if (change !== null) changes.set(id, change);
  }
  return changes;
}

function diffEntry(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  diffGeometry: boolean,
): PropertyChange | null {
  if (before === undefined && after === undefined) return null;

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (!diffGeometry && GEOMETRY_KEYS.has(key)) continue;
    const had = before !== undefined && Object.hasOwn(before, key);
    const has = after !== undefined && Object.hasOwn(after, key);
    if (!had && has) added.push(key);
    else if (had && !has) removed.push(key);
    else if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) changed.push(key);
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;

  const source = after ?? before ?? {};
  return {
    entity: String(source['id'] ?? ''),
    type: String(source['type'] ?? ''),
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

/** True when the plan changes nothing on the instance. */
export function isNoop(plan: DeploymentPlan): boolean {
  return plan.operations.every((operation) => !MUTATION_KINDS.includes(operation.kind) || operation.changes.length === 0);
}

export function summarizePlan(plan: DeploymentPlan): Readonly<Record<PlanOperationKind, number>> {
  const summary: Record<PlanOperationKind, number> = {
    'create-container': 0,
    'update-container': 0,
    'delete-container': 0,
    'leave-alien': 0,
    'create-config': 0,
    'update-config': 0,
    'delete-config': 0,
    'keep-config': 0,
    'create-node': 0,
    'update-node': 0,
    'delete-node': 0,
  };
  // `planMerge` does not emit an update that changes nothing, so every operation here is real.
  for (const operation of plan.operations) summary[operation.kind] += 1;
  return summary;
}

/**
 * Containers in the payload that are ours to record: everything the write touches, minus the ones
 * that are only there because they were copied through.
 *
 * The distinction matters more than it looks. Recording every container in the payload as owned
 * claims somebody else's tab — and a later `apply --prune` would then delete it.
 */
export function writtenContainers(plan: DeploymentPlan): readonly EntityId[] {
  const untouched = new Set(plan.unowned);
  return [...plan.payload.flows.map((flow) => flow.id), ...plan.payload.subflows.map((subflow) => subflow.id)]
    .filter((id) => !untouched.has(id))
    .sort();
}

/** Ids of every entity a container owns, including its nodes, groups and config nodes. */
export function containerEntityIds(flowSet: FlowSet, containerId: EntityId): readonly EntityId[] {
  const flow = flowSet.flows.find((candidate) => candidate.id === containerId);
  if (flow !== undefined) return [...containerNodeIds(flow), ...flow.configs.map((config) => config.id)];
  const subflow = flowSet.subflows.find((candidate) => candidate.id === containerId);
  if (subflow === undefined) return [];
  return [...containerNodeIds(subflow), ...subflow.configs.map((config) => config.id)];
}

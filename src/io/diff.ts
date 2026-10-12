/**
 * `flowgen diff` — two flow sets compared, semantically and by default without geometry.
 *
 * This is the question `import` creates. You pull a live instance into sources, edit them, and the
 * only thing that tells you what you actually changed is a diff — against what is deployed, or
 * against what a receipt says was there before the last deploy. `plan` answers a related question
 * but not this one: it is ownership-scoped (it refuses to describe what it will not write), it
 * only ever compares *your* sources with *one* instance, and it reports operations rather than
 * entities. A reviewer looking at somebody else's instance needs the raw comparison.
 *
 * ## What "semantic" means here
 *
 * Both sides are parsed into the IR and emitted again with the *same* emitter, and entities are
 * matched by id. So the diff compares what the tool would write, not how a file happens to be
 * spelled: reordered keys, a missing `wires` array, `d: false` versus absent, or the defaults an
 * editor export leaves out are not differences. What survives is:
 *
 * * entities that exist on one side only (`added` / `removed`);
 * * entities whose emitted form differs, property by property (`changed`);
 * * the module list, which is what "it worked on my machine" is made of.
 *
 * **Geometry is ignored by default** (`--geometry` includes it) because the editor recomputes
 * `x`/`y`/`w`/`h` on load and on every arrange: a diff that reports twenty moved nodes hides the
 * one changed `func`.
 *
 * ## Impact, not just difference
 *
 * A removed entity is interesting in proportion to what still points at it. The reference analysis
 * (`model/references.ts`, the same walk the validator and the layout use) gives the referrers, so
 * a removal that leaves a dangling wire or a config reference is reported with the entities that
 * are still pointing at it — which is the difference between "one node went away" and "three
 * surviving nodes now point at nothing".
 */

import { emitEntries } from '../emit/flowJson.ts';
import type { EntityId, FlowSet } from '../model/entities.ts';
import { inboundReferences, type Reference } from '../model/references.ts';
import { diffEmittedEntries, entriesById, type PropertyChange } from './plan.ts';
import type { PaletteType } from '../palette/model.ts';

/** One side of the comparison: a flow set, the palette it is read against, and how to name it. */
export interface DiffSide {
  /** What the reader is looking at: a path, a URL, `before` for a receipt. */
  readonly label: string;
  readonly flowSet: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
}

export type DiffStatus = 'added' | 'removed' | 'changed';

/** What an entity is, for the reader: the emitted `type` is not always enough (`tab` vs `group`). */
export type DiffKind = 'container' | 'group' | 'config' | 'node';

export interface DiffEntity {
  readonly id: EntityId;
  readonly type: string;
  readonly status: DiffStatus;
  readonly kind: DiffKind;
  /** Container the entity lives in; `null` for a container, a global config or a loose node. */
  readonly container: EntityId | null;
  readonly label: string;
  /** Property-level difference; empty for `added` and `removed`, which are whole-entity facts. */
  readonly changes: readonly PropertyChange[];
  /** Entities pointing at this one, on the side where it exists. */
  readonly referencedBy: readonly EntityId[];
  /**
   * The sentence a reviewer needs, or `null` when nothing points at it: for a removal, how many
   * entities that are *still there* would be left dangling.
   */
  readonly impact: string | null;
}

export interface ModuleChange {
  readonly module: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface FlowSetDiff {
  readonly before: string;
  readonly after: string;
  /** True when nothing differs at all — entities and modules. */
  readonly identical: boolean;
  readonly entities: readonly DiffEntity[];
  readonly modules: readonly ModuleChange[];
  /** Entity ids that exist on both sides with an identical emitted form. */
  readonly unchanged: readonly EntityId[];
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly containers: number;
  };
  /** What the comparison could not see, or had to assume. Never empty when it matters. */
  readonly notes: readonly string[];
}

export interface DiffOptions {
  /** Include `x`/`y`/`w`/`h`. Off by default: the editor recomputes them. */
  readonly geometry?: boolean;
}

export function diffFlowSets(before: DiffSide, after: DiffSide, options: DiffOptions = {}): FlowSetDiff {
  const geometry = options.geometry === true;
  const beforeEntries = emitEntries(before.flowSet, { palette: before.palette, includeManifest: false });
  const afterEntries = emitEntries(after.flowSet, { palette: after.palette, includeManifest: false });
  const beforeById = entriesById(beforeEntries);
  const afterById = entriesById(afterEntries);
  const changes = diffEmittedEntries(beforeById, afterById, geometry);

  // Classification uses both palettes: a removed config node is not in the `after` palette's world
  // any more, and calling it a plain node would misreport what disappeared.
  const palettes = { ...before.palette, ...after.palette };
  const beforeRefs = inboundReferences(before.flowSet, before.palette);
  const afterRefs = inboundReferences(after.flowSet, after.palette);

  const entities: DiffEntity[] = [];
  const unchanged: EntityId[] = [];

  for (const id of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) {
    const had = beforeById.has(id);
    const has = afterById.has(id);
    const entry = afterById.get(id) ?? beforeById.get(id) ?? {};
    const type = String(entry['type'] ?? '');
    const status: DiffStatus = !had ? 'added' : !has ? 'removed' : 'changed';
    const change = changes.get(id);

    if (status === 'changed' && change === undefined) {
      unchanged.push(id);
      continue;
    }

    // Referrers come from the side the entity exists on. For a removal, only the referrers that
    // also exist on the other side matter: those are the ones left dangling.
    const index = has ? afterRefs : beforeRefs;
    const referrers = (index.get(id) ?? []).map((reference: Reference) => reference.from);
    const relevant = status === 'removed' ? referrers.filter((from) => afterById.has(from)) : referrers;

    entities.push({
      id,
      type,
      status,
      kind: classify(type, palettes),
      container: containerOf(entry),
      label: labelOf(entry),
      // A whole-entity fact is not a property list: "added: id, type, wires, z" is every key the
      // entity has, and printing it buries the one line that matters.
      changes: status === 'changed' && change !== undefined ? [change] : [],
      referencedBy: [...new Set(relevant)].sort(),
      impact: impactOf(status, relevant),
    });
  }

  const modules = diffModules(before.flowSet.modules, after.flowSet.modules);
  const counts = {
    added: entities.filter((entity) => entity.status === 'added').length,
    removed: entities.filter((entity) => entity.status === 'removed').length,
    changed: entities.filter((entity) => entity.status === 'changed').length,
    unchanged: unchanged.length,
    containers: entities.filter((entity) => entity.kind === 'container').length,
  };

  const notes: string[] = [];
  if (!geometry) notes.push('geometry (x, y, w, h) is ignored; pass --geometry to include it');
  if (before.flowSet.modules['flowgen:inline'] !== undefined || after.flowSet.modules['flowgen:inline'] !== undefined) {
    notes.push('the module list carries flowgen:inline, which is this tool\'s own marker for a subflow-only flow set');
  }
  if (before.palette !== after.palette) {
    notes.push(`each side was read against its own palette: ${before.label} has ${Object.keys(before.palette).length} type(s), ${after.label} has ${Object.keys(after.palette).length}`);
  }

  return {
    before: before.label,
    after: after.label,
    identical: entities.length === 0 && modules.length === 0,
    entities,
    modules,
    unchanged,
    counts,
    notes,
  };
}

function classify(type: string, palette: Readonly<Record<string, PaletteType>>): DiffKind {
  if (type === 'tab' || type === 'subflow') return 'container';
  if (type === 'group') return 'group';
  if (palette[type]?.isConfig === true) return 'config';
  // A config node whose type the palettes do not know is still a config node if it is not in any
  // container: the editor writes `z` for everything that lives on a canvas.
  return 'node';
}

function containerOf(entry: Record<string, unknown>): EntityId | null {
  const z = entry['z'];
  return typeof z === 'string' && z !== '' ? z : null;
}

function labelOf(entry: Record<string, unknown>): string {
  for (const key of ['label', 'name']) {
    const value = entry[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function impactOf(status: DiffStatus, referrers: readonly EntityId[]): string | null {
  const unique = [...new Set(referrers)];
  if (unique.length === 0) return null;
  const names = unique.slice(0, 3).join(', ');
  const more = unique.length > 3 ? ` (+${unique.length - 3} more)` : '';
  const count = `${unique.length} entit${unique.length === 1 ? 'y' : 'ies'}`;
  if (status === 'removed') {
    return `still referenced by ${count} ${unique.length === 1 ? 'that is' : 'that are'} still there: ${names}${more} — the reference is left dangling`;
  }
  return `referenced by ${count}: ${names}${more}`;
}

function diffModules(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): readonly ModuleChange[] {
  const changes: ModuleChange[] = [];
  for (const module of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const had = before[module] ?? null;
    const has = after[module] ?? null;
    if (had !== has) changes.push({ module, before: had, after: has });
  }
  return changes;
}

/**
 * The human rendering, one line per entity — the shape `flowgen diff` prints and `--check` gates on.
 *
 * Deliberately not a unified diff: a flow file is a JSON array, and a line-based diff of two of
 * them says "everything changed" the moment an entry is inserted. The unit here is an entity, and
 * a change names the properties that moved.
 */
export function describeDiff(diff: FlowSetDiff): readonly string[] {
  if (diff.identical) return [`no differences (${diff.counts.unchanged} entit(ies) compared)`];

  const lines: string[] = [
    `${diff.counts.added} added, ${diff.counts.removed} removed, ${diff.counts.changed} changed, ${diff.counts.unchanged} unchanged`,
  ];

  for (const entity of diff.entities) {
    const marker = entity.status === 'added' ? '+' : entity.status === 'removed' ? '-' : '~';
    const where = entity.container === null ? '' : ` in ${entity.container}`;
    const named = entity.label === '' ? '' : ` "${entity.label}"`;
    lines.push(`${marker} ${entity.kind} ${entity.id} (${entity.type})${named}${where}`);
    if (entity.changes.length > 0) {
      const change = entity.changes[0] as PropertyChange;
      const parts: string[] = [];
      if (change.added.length > 0) parts.push(`+${change.added.join(', +')}`);
      if (change.removed.length > 0) parts.push(`-${change.removed.join(', -')}`);
      if (change.changed.length > 0) parts.push(`~${change.changed.join(', ~')}`);
      lines.push(`    ${parts.join('  ')}`);
    }
    if (entity.impact !== null) lines.push(`    ${entity.impact}`);
  }

  for (const module of diff.modules) {
    lines.push(
      module.after === null
        ? `- module ${module.module} ${module.before ?? ''}`
        : module.before === null
          ? `+ module ${module.module} ${module.after}`
          : `~ module ${module.module} ${module.before} → ${module.after}`,
    );
  }

  for (const note of diff.notes) lines.push(`note: ${note}`);
  return lines;
}

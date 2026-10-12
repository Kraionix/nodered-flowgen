/**
 * The palette ports.
 *
 * A *source* produces a complete snapshot from somewhere (a running instance, an
 * installation on disk, a vendored file). An *overlay* transforms a snapshot — it is how
 * curated knowledge (typed-input value lists, references the extractor cannot see, inline
 * subflows) is layered on top of derived data without ever being written into the generated
 * snapshot files, so regeneration can never lose it.
 *
 * Both are plain interfaces: no registry, no lifecycle, no globals. The CLI wires them by
 * constructor arguments, which is also what lets two targets with different palettes be
 * processed in one process without shared state.
 */

import { createPaletteSnapshot, type PaletteSnapshot } from '../snapshot.ts';
import type { PaletteNodeSet, PaletteType } from '../model.ts';

import { assembleNodeSets } from '../extract/attribute.ts';

export interface PaletteSource {
  /** Stable identifier, used in diagnostics and for per-target keying. */
  readonly id: string;
  load(): Promise<PaletteSnapshot>;
}

export interface PaletteOverlay {
  readonly id: string;
  /** Pure: returns a new snapshot, never mutates the input. */
  apply(snapshot: PaletteSnapshot): PaletteSnapshot;
}

export type PaletteSourceErrorCode =
  | 'http-error'
  | 'unauthorized'
  | 'invalid-response'
  | 'not-found'
  | 'invalid-snapshot'
  | 'no-node-red-installation';

export class PaletteSourceError extends Error {
  readonly code: PaletteSourceErrorCode;
  readonly status: number | null;
  readonly details: readonly string[];

  constructor(code: PaletteSourceErrorCode, message: string, options: { status?: number; details?: readonly string[] } = {}) {
    super(message);
    this.name = 'PaletteSourceError';
    this.code = code;
    this.status = options.status ?? null;
    this.details = options.details ?? [];
  }
}

export function applyOverlays(snapshot: PaletteSnapshot, overlays: readonly PaletteOverlay[]): PaletteSnapshot {
  return overlays.reduce((current, overlay) => overlay.apply(current), snapshot);
}

export interface RebuildOptions {
  readonly types: readonly PaletteType[];
  /** Defaults to the snapshot's own node sets, re-derived from the types. */
  readonly nodeSets?: readonly PaletteNodeSet[];
}

/**
 * Rebuilds a snapshot around a changed type list, recomputing the content hash and
 * re-deriving node set membership. Every mutation path (overlays, subflows, type patches)
 * goes through here, so a snapshot can never drift from its hash.
 */
export function rebuildPalette(snapshot: PaletteSnapshot, options: RebuildOptions): PaletteSnapshot {
  return createPaletteSnapshot({
    nodeRedVersion: snapshot.nodeRedVersion,
    nodeSets: assembleNodeSets(options.types, options.nodeSets ?? snapshot.nodeSets),
    types: options.types,
    provenance: snapshot.provenance,
    generator: snapshot.generator,
  });
}

/** Replaces or adds a single type, keeping declaration order for the untouched ones. */
export function withType(snapshot: PaletteSnapshot, type: PaletteType): PaletteSnapshot {
  const types = Object.values(snapshot.types).map((existing) => (existing.id === type.id ? type : existing));
  if (!Object.hasOwn(snapshot.types, type.id)) types.push(type);
  return rebuildPalette(snapshot, { types });
}

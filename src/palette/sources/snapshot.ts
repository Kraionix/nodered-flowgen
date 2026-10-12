/**
 * Vendored snapshot source: the committed `palettes/<profile>.json`.
 *
 * This is what makes the tool work offline and reproducibly (D3/D11): the palette is pulled
 * from an instance once, committed, and every later `types gen`, `validate` or `plan` runs
 * against the committed file until someone pulls again. Writing is content-addressed — an
 * unchanged palette produces no file write, so a regeneration never shows up as a diff.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  parsePaletteSnapshot,
  serializePaletteSnapshot,
  type ParsePaletteOptions,
  type PaletteSnapshot,
} from '../snapshot.ts';

import { PaletteSourceError, type PaletteSource } from './source.ts';

export interface SnapshotSourceOptions extends ParsePaletteOptions {
  readonly id?: string;
}

/** Parses snapshot text; throws a `PaletteSourceError` carrying every structural issue. */
export function parseSnapshotText(text: string, options: SnapshotSourceOptions = {}): PaletteSnapshot {
  const parsed = parsePaletteSnapshot(text, options);
  if (!parsed.ok) {
    throw new PaletteSourceError('invalid-snapshot', 'the palette snapshot is not valid', {
      details: parsed.errors.map((issue) => `${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`),
    });
  }
  return parsed.value;
}

export function snapshotSource(text: string, options: SnapshotSourceOptions = {}): PaletteSource {
  return {
    id: options.id ?? 'snapshot',
    load: async (): Promise<PaletteSnapshot> => parseSnapshotText(text, options),
  };
}

export async function readSnapshotFile(file: string, options: SnapshotSourceOptions = {}): Promise<PaletteSnapshot> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    throw new PaletteSourceError('not-found', `cannot read palette snapshot ${file}`, {
      details: [cause instanceof Error ? cause.message : String(cause)],
    });
  }
  return parseSnapshotText(text, options);
}

export function fileSnapshotSource(file: string, options: SnapshotSourceOptions = {}): PaletteSource {
  return {
    id: options.id ?? `snapshot:${file}`,
    load: async (): Promise<PaletteSnapshot> => readSnapshotFile(file, options),
  };
}

export interface WriteResult {
  /** `unchanged` means the file already had exactly this content. */
  readonly status: 'written' | 'unchanged';
  readonly bytes: number;
}

/**
 * Writes only when the content differs. Returns `unchanged` otherwise, which is what lets
 * `palette pull` be run in CI without producing spurious diffs. The directory is created when it
 * is missing: `palettes/` does not exist in a fresh project, and failing there would make the
 * first pull of every project a two-step ritual.
 */
export async function writeSnapshotFile(
  file: string,
  snapshot: PaletteSnapshot,
  options: { readonly indent?: number } = {},
): Promise<WriteResult> {
  const text = serializePaletteSnapshot(snapshot, options.indent === undefined ? {} : { indent: options.indent });
  const existing = await readIfPresent(file);
  if (existing === text) {
    return { status: 'unchanged', bytes: text.length };
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return { status: 'written', bytes: text.length };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Writing generated files: only when the content differs.
 *
 * Generated artifacts are committed, so a regeneration that rewrites identical bytes would
 * produce a diff-free but timestamp-churning working tree and make `--check` in CI impossible.
 * Every write goes through here and reports whether it actually changed anything.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface WriteOutcome {
  readonly path: string;
  readonly status: 'written' | 'unchanged';
  readonly bytes: number;
}

export async function writeIfChanged(file: string, content: string): Promise<WriteOutcome> {
  const existing = await readIfPresent(file);
  if (existing === content) return { path: file, status: 'unchanged', bytes: content.length };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: file, status: 'written', bytes: content.length };
}

/** True when the file already has exactly this content; used by `--check` without writing. */
export async function isCurrent(file: string, content: string): Promise<boolean> {
  return (await readIfPresent(file)) === content;
}

export async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export function summarizeWrites(outcomes: readonly WriteOutcome[], root: string): string {
  const written = outcomes.filter((outcome) => outcome.status === 'written').length;
  const unchanged = outcomes.length - written;
  const bytes = outcomes.reduce((total, outcome) => total + outcome.bytes, 0);
  const names = outcomes.map((outcome) => path.relative(root, outcome.path) || outcome.path);
  const detail = names.length <= 3 ? `: ${names.join(', ')}` : ` in ${names.length} files`;
  return `${written} written, ${unchanged} unchanged (${bytes} bytes)${detail}`;
}

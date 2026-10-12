/**
 * The layer guard.
 *
 * The README promises a dependency story — "dependencies point inward only: `model` and `palette`
 * depend on nothing, `emit`/`validate` derive from them, and `io`/`import`/`authoring`/`cli` sit on
 * top" — and until this test existed nothing checked it. What it found on the first run was a
 * directory cycle: `model/normalize.ts` imported `Problem` from `validate/problem.ts` while every
 * file in `validate/` imported `model/entities.ts`, so the two layers each depended on the other
 * and the sentence was simply untrue.
 *
 * The rule is one line: **a file may import from a strictly lower layer, or from its own layer.**
 * The graph is read from the source files, not from a declaration someone has to remember to
 * update — an import is the only thing that can actually create a cycle, so an import is what gets
 * checked.
 *
 * When this fails, the fix is almost never to move the offending file up a layer: it is to ask
 * which of the two things being coupled is really the lower one. `Problem` was the lower one, and
 * it now lives in `src/diagnostics/`.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

/**
 * Layers, lowest first. A file belongs to the layer named by the first path segment under `src/`;
 * a file directly under `src/` belongs to the layer of its own basename (`result.ts` → `result`).
 *
 * The order is not a preference: it is what the imports already do, made explicit so that a new
 * one cannot quietly invert it.
 */
const LAYERS: readonly (readonly string[])[] = [
  // Nothing here imports anything else here: pure data and pure vocabulary.
  ['result', 'typing', 'diagnostics', 'toolkit'],
  // The palette is data about the *editor*; `result` is all it needs.
  ['palette'],
  // The IR is data about a *flow set*, and it is expressed in palette terms (what a type declares).
  ['model'],
  // The three functions of the IR: turn it into a flow file, into source, and check it.
  // `codegen` sits here rather than beside `authoring` because it *reads* the IR the way `emit`
  // does — its output happens to be source, but it depends on nothing the builder knows.
  ['emit', 'import', 'validate', 'codegen'],
  // Things that hold a flow set and do something with it.
  ['authoring', 'io'],
  // Project configuration binds authoring and targets together.
  ['config'],
  // The binary is the only thing allowed to know about all of the above at once.
  ['cli'],
  // The public barrel re-exports every layer by design.
  ['index'],
];

interface SourceFile {
  /** Path relative to `src/`, with forward slashes. */
  readonly rel: string;
  readonly area: string;
  readonly imports: readonly { readonly specifier: string; readonly target: string | null; readonly line: number }[];
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

function layerRank(area: string): number {
  const rank = LAYERS.findIndex((layer) => layer.includes(area));
  return rank;
}

async function walk(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** `foo/bar.ts` → `foo`; `index.ts` → `index`. */
function areaOf(rel: string): string {
  const parts = rel.split('/');
  return parts.length === 1 ? (parts[0] as string).replace(/\.ts$/, '') : (parts[0] as string);
}

/**
 * Every relative import of a file, resolved to a path relative to `src/`. Static `from '…'` and
 * dynamic `import('…')` are both matched: a cycle created by a lazy import is still a cycle.
 */
function importsOf(rel: string, source: string): SourceFile['imports'] {
  const found: { specifier: string; target: string | null; line: number }[] = [];
  const patterns = [/\bfrom\s+'(\.[^']+)'/g, /\bimport\(\s*'(\.[^']+)'\s*\)/g];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] as string;
      const line = source.slice(0, match.index).split('\n').length;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
      found.push({ specifier, target: resolved.startsWith('..') ? null : resolved, line });
    }
  }
  return found;
}

async function readSource(): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for (const full of await walk(SRC)) {
    const rel = path.relative(SRC, full).split(path.sep).join('/');
    files.push({ rel, area: areaOf(rel), imports: importsOf(rel, await readFile(full, 'utf8')) });
  }
  return files;
}

/** The rule, as a function of the graph — so it can be exercised on a graph that does violate it. */
function findViolations(files: readonly SourceFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const from = layerRank(file.area);
    if (from < 0) {
      violations.push({ file: file.rel, line: 0, from: file.area, to: '?', specifier: 'unknown layer' });
      continue;
    }
    for (const entry of file.imports) {
      if (entry.target === null) continue; // outside `src/`: nothing to rank
      const to = layerRank(areaOf(entry.target));
      if (to > from) {
        violations.push({ file: file.rel, line: entry.line, from: file.area, to: areaOf(entry.target), specifier: entry.specifier });
      }
    }
  }
  return violations;
}

function describe(violation: Violation): string {
  return `${violation.file}:${violation.line} — ${violation.from} must not import ${violation.to} ("${violation.specifier}")`;
}

test('every import points inward, and the layering the README describes is the real one', async () => {
  const files = await readSource();
  assert.ok(files.length > 40, `only ${files.length} source files found; the walk is wrong`);

  const violations = findViolations(files);
  assert.deepEqual(violations.map(describe), [], `imports against the layer order:\n${violations.map(describe).join('\n')}`);
});

test('the model layer knows nothing about validation, and diagnostics is below both', async () => {
  const files = await readSource();
  const modelFiles = files.filter((file) => file.area === 'model');
  assert.ok(modelFiles.length >= 4, 'the model layer went missing');

  // The specific cycle this test was written for: `normalize.ts` used to reach into `validate/`.
  const reaching = modelFiles.flatMap((file) =>
    file.imports.filter((entry) => entry.target?.startsWith('validate/')).map((entry) => `${file.rel} → ${entry.specifier}`),
  );
  assert.deepEqual(reaching, []);

  const diagnostics = files.find((file) => file.rel === 'diagnostics/index.ts');
  assert.ok(diagnostics, 'the diagnostics contract moved; update this test and the README together');
  assert.deepEqual(
    diagnostics.imports,
    [],
    'the diagnostics contract must stay dependency-free, or it cannot sit under `model`',
  );
});

test('the checker reports a violation when there is one', () => {
  // The guard is only worth having if it can fail; this feeds it a graph shaped like the cycle it
  // was written to prevent.
  const synthetic: SourceFile[] = [
    { rel: 'model/normalize.ts', area: 'model', imports: [{ specifier: '../validate/problem.ts', target: 'validate/problem.ts', line: 23 }] },
    { rel: 'validate/graphChecks.ts', area: 'validate', imports: [{ specifier: '../model/entities.ts', target: 'model/entities.ts', line: 12 }] },
    { rel: 'validate/report.ts', area: 'validate', imports: [{ specifier: './graphChecks.ts', target: 'validate/graphChecks.ts', line: 5 }] },
    { rel: 'cli/index.ts', area: 'cli', imports: [{ specifier: '../model/entities.ts', target: 'model/entities.ts', line: 1 }] },
  ];

  assert.deepEqual(findViolations(synthetic).map(describe), [
    'model/normalize.ts:23 — model must not import validate ("../validate/problem.ts")',
  ]);
});

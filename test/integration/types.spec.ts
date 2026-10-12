/**
 * E3, enforced: the generated palette types must type-check a correct flow description and
 * **reject** a wrong one with the diagnostics we expect.
 *
 * The augmentations are regenerated here from the pinned installation (not committed), so the
 * fixture can never drift from the generator. Both projects are compiled with the real
 * compiler; TypeScript 7 ships no programmatic API, so the diagnostics are parsed from its
 * structured, line-oriented output (`--pretty false`) rather than grepped as prose.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { emitTypes } from '../../src/palette/codegen/emitTypes.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TYPES_DIR = path.join(REPO_ROOT, 'test', 'types');
const GENERATED_DIR = path.join(TYPES_DIR, 'palettes');

interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

async function compile(project: string): Promise<{ code: number; diagnostics: readonly Diagnostic[] }> {
  const child = spawn(process.execPath, [TSC, '--noEmit', '--pretty', 'false', '-p', project], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number>((resolve) => child.once('close', (exit) => resolve(exit ?? -1)));
  return { code, diagnostics: parseDiagnostics(output) };
}

/**
 * TypeScript prints a diagnostic as a chain: the headline line, then indented elaborations
 * ("Property 'group' is missing in type …"). Only the headline carries the `file(line,col)`
 * prefix, so an indented line is appended to the diagnostic it belongs to. Dropping them loses
 * the half of the message that actually tells an author what to change.
 */
function parseDiagnostics(output: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (match === null) {
      const previous = diagnostics[diagnostics.length - 1];
      if (previous !== undefined && /^\s+\S/.test(line)) {
        diagnostics[diagnostics.length - 1] = { ...previous, message: `${previous.message}\n${line.trim()}` };
      }
      continue;
    }
    diagnostics.push({
      file: path.relative(REPO_ROOT, match[1] as string),
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4] as string,
      message: match[5] as string,
    });
  }
  return diagnostics;
}

test('generate the palette augmentations from the pinned installation', async () => {
  const palette = await filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
    userDir: REPO_ROOT,
  }).load();

  await rm(GENERATED_DIR, { recursive: true, force: true });
  const files = emitTypes(palette, { directory: 'test/types/palettes/local.d' });
  for (const file of files) {
    const full = path.join(REPO_ROOT, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content, 'utf8');
  }

  assert.ok(files.length >= 3, 'core, dashboard and the index');
  assert.equal(files.reduce((total, file) => total + file.types.length, 0), Object.keys(palette.types).length);
});

test('the positive fixture compiles with no diagnostics', async () => {
  const result = await compile(path.join(TYPES_DIR, 'tsconfig.json'));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.code, 0);
});

test('the negative fixture fails with exactly the expected diagnostics', async () => {
  const result = await compile(path.join(TYPES_DIR, 'negative', 'tsconfig.json'));
  const diagnostics = result.diagnostics.map((diagnostic) => ({
    line: diagnostic.line,
    code: diagnostic.code,
    message: diagnostic.message,
  }));

  assert.equal(result.code, 1);
  assert.deepEqual(
    diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.code}`),
    ['11:TS2353', '14:TS2322', '17:TS2322', '20:TS2322', '24:TS2820', '27:TS2322'],
  );
  assert.match(diagnostics[0]?.message ?? '', /'minX' does not exist in type/);
  assert.match(diagnostics[2]?.message ?? '', /"ui_tab"' is not assignable to type '"ui_group"'/);
  // The first line names the alias; the elaboration underneath names the property that is
  // missing and the type it must be, which is what the author needs to fix it.
  assert.match(diagnostics[3]?.message ?? '', /Property '"group"' is missing/);
  assert.match(diagnostics[3]?.message ?? '', /group: Ref<"ui_group">; order\?: number/);
  assert.match(diagnostics[4]?.message ?? '', /Did you mean '"ui_gauge"'/);
  assert.match(diagnostics[5]?.message ?? '', /not assignable to type 'EnvValue'/);
});

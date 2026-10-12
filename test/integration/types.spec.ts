/**
 * E3, enforced: the generated palette types must type-check a correct flow description and
 * **reject** a wrong one with the diagnostics we expect.
 *
 * The augmentations under `test/types/palettes/local.d/` are committed, because the repository's
 * own `tsc --noEmit` needs them: without them a fresh clone reports twenty-odd errors in `src/`,
 * the example and the tests. This spec regenerates them from the pinned installation and compares
 * byte for byte, so a committed file that has drifted from its generator — or from a new Node-RED
 * version — fails here with the file and the first difference, instead of quietly type-checking
 * the project against a palette that no longer exists.
 *
 * Both projects are compiled with the real compiler; TypeScript 7 ships no programmatic API, so
 * the diagnostics are parsed from its structured, line-oriented output (`--pretty false`) rather
 * than grepped as prose.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateLocalTypes, LOCAL_TYPES_DIRECTORY, pinnedPalette, REPO_ROOT } from '../types/generate.ts';

const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TYPES_DIR = path.join(REPO_ROOT, 'test', 'types');
const COMMITTED_DIR = path.join(REPO_ROOT, LOCAL_TYPES_DIRECTORY);

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

test('the committed augmentations are exactly what the pinned installation generates', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'flowgen-types-'));
  try {
    const files = await generateLocalTypes(path.join(scratch, 'local.d'));
    const palette = await pinnedPalette();
    assert.ok(files.length >= 3, 'core, dashboard and the index');
    assert.equal(
      files.reduce((total, file) => total + file.types.length, 0),
      Object.keys(palette.types).length,
      'every type of the pinned installation is covered exactly once',
    );

    const written: string[] = [];
    for (const file of files) {
      const name = path.basename(file.path);
      written.push(name);
      await mkdir(path.dirname(path.join(scratch, 'local.d', name)), { recursive: true });
      await writeFile(path.join(scratch, 'local.d', name), file.content, 'utf8');

      const committed = await readFile(path.join(COMMITTED_DIR, name), 'utf8').catch(() => null);
      assert.notEqual(committed, null, `${LOCAL_TYPES_DIRECTORY}/${name} is not committed; run \`npm run types:regen\``);
      assert.equal(
        committed,
        file.content,
        `${LOCAL_TYPES_DIRECTORY}/${name} has drifted from the generator; run \`npm run types:regen\``,
      );
    }

    // A file the generator no longer produces is stale by definition: a renamed node set or a
    // module that was uninstalled would otherwise leave a phantom augmentation behind.
    const onDisk = await readdir(COMMITTED_DIR);
    assert.deepEqual(
      [...onDisk].sort(),
      [...written].sort(),
      `the committed directory holds files the generator does not produce; run \`npm run types:regen\``,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

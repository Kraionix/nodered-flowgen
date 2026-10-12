/**
 * The packaging smoke test: the one test that can catch a package that cannot be installed.
 *
 * Every other test in this repository imports `../../src/…` directly, which is exactly why the
 * previous packaging was broken for two milestones without a single red test: the sources run
 * fine through Node's type stripping *in the repository*, and Node refuses to strip types for any
 * file under a `node_modules` path. `node_modules/@kraionix/nodered-flowgen/src/cli/index.ts`
 * therefore failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for every consumer, while
 * 180 tests stayed green.
 *
 * This test therefore does what a consumer does, and nothing less: pack the tarball, unpack it
 * into a real `node_modules` directory, run the bin, import the entry point, build a flow set
 * through the *installed* module, and type-check a consumer file against the published
 * declarations.
 *
 * It does not run `prepack` (`--ignore-scripts`): `npm test` builds first, and two builds sharing
 * one `dist/` while other test files read it would be a race. Running `npm pack` by hand still
 * builds, because `prepack` is wired.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_NAME = '@kraionix/nodered-flowgen';
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Packs the repository and returns every entry name plus the extracted package directory. */
async function packInto(consumer: string): Promise<{ entries: readonly string[]; installed: string }> {
  const tarballs = await mkdtemp(path.join(os.tmpdir(), 'flowgen-pack-'));
  const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs], {
    env: { npm_config_cache: path.join(tarballs, 'npm-cache') },
  });
  assert.equal(packed.code, 0, `npm pack failed:\n${packed.stderr}${packed.stdout}`);

  const [result] = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  assert.ok(result !== undefined, `npm pack printed no result:\n${packed.stdout}`);
  const tarball = path.join(tarballs, result.filename);

  const entries = result.files.map((file) => file.path);
  const installed = path.join(consumer, 'node_modules', ...PACKAGE_NAME.split('/'));
  await mkdir(installed, { recursive: true });
  const extracted = await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
  assert.equal(extracted.code, 0, `tar failed:\n${extracted.stderr}`);
  return { entries, installed };
}

test('the packed tarball installs into a consumer, runs its bin, and imports as JavaScript', async () => {
  assert.ok(
    existsSync(DIST_ENTRY),
    `dist/ is missing: the packaging test needs a build. Run \`npm run build\` (or \`npm test\`, which builds first).`,
  );

  const consumer = await mkdtemp(path.join(os.tmpdir(), 'flowgen-consumer-'));
  try {
    const { entries, installed } = await packInto(consumer);

    // What the tarball must *not* contain: the sources, which a consumer cannot run, and the
    // test tree, which would drag `node-red` into an install.
    assert.ok(!entries.some((entry) => entry.startsWith('src/')), `the tarball ships sources: ${entries.join(', ')}`);
    assert.ok(!entries.some((entry) => entry.startsWith('test/')), 'the tarball ships the test tree');
    assert.ok(entries.includes('dist/index.js'), `dist/index.js is missing from the tarball: ${entries.join(', ')}`);
    assert.ok(entries.includes('dist/index.d.ts'), 'the tarball ships no declarations');
    assert.ok(
      !entries.some((entry) => entry.startsWith('dist/') && entry.endsWith('.ts') && !entry.endsWith('.d.ts')),
      'dist contains raw .ts files, which a consumer cannot run',
    );

    // `exports` has to name files that exist, or the import fails with a confusing
    // ERR_MODULE_NOT_FOUND inside node_modules.
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>;
      bin: Record<string, string>;
    };
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === './package.json') continue;
      assert.ok(existsSync(path.join(installed, target.default as string)), `exports["${subpath}"] points at a missing file`);
      assert.ok(existsSync(path.join(installed, target.types as string)), `exports["${subpath}"].types points at a missing file`);
    }

    // The bin, reached the way a consumer reaches it. npm links `node_modules/.bin/flowgen` to
    // the file `bin` names, and the OS then executes *through that symlink* — the path the
    // interpreter is handed is the link, not the target. The old entry point compared that path
    // with `import.meta.url` (the resolved target), decided it was not the entry point, and exited
    // 0 in silence: `npx flowgen` did nothing at all.
    const binTarget = path.join(installed, manifest.bin['flowgen'] as string);
    assert.ok(existsSync(binTarget), 'bin.flowgen points at a missing file');
    assert.equal((await readFile(binTarget, 'utf8')).split('\n')[0], '#!/usr/bin/env node', 'the bin lost its shebang');

    const binDir = path.join(consumer, 'node_modules', '.bin');
    const binLink = path.join(binDir, 'flowgen');
    await mkdir(binDir, { recursive: true });
    await symlink(path.relative(binDir, binTarget), binLink);

    const help = await run(process.execPath, [binLink, '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /usage: flowgen <command>/, 'the CLI ran through the .bin symlink and printed nothing');
    assert.notEqual(help.stdout.trim(), '', 'running the bin through its symlink must not exit 0 silently');

    // The import a consumer writes, resolved through `exports` — no type stripping involved.
    const program = `
import { defineFlowSet, emitFlowSet } from ${JSON.stringify(PACKAGE_NAME)};
const definition = defineFlowSet((f) => {
  const tab = f.flow('main', { label: 'Main' });
  tab.chain(tab.untyped('inject', { key: 'tick', name: 'tick' }), tab.untyped('debug', { key: 'sink' }));
});
const built = definition.build({ palette: {} });
const entries = JSON.parse(emitFlowSet(built.flowSet, { palette: {} }));
console.log(entries.map((entry) => entry.id + ':' + entry.type).join(','));
`;
    await writeFile(path.join(consumer, 'consumer.mjs'), program, 'utf8');
    const imported = await run(process.execPath, ['consumer.mjs'], { cwd: consumer });
    assert.equal(imported.code, 0, `importing the installed package failed:\n${imported.stderr}`);
    assert.match(imported.stdout, /main:tab/);
    assert.match(imported.stdout, /tick:inject/);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});

test('the published declarations type-check a consumer file', async () => {
  assert.ok(existsSync(DIST_ENTRY), 'dist/ is missing: run `npm run build` first');

  const consumer = await mkdtemp(path.join(os.tmpdir(), 'flowgen-consumer-types-'));
  try {
    await packInto(consumer);

    await writeFile(
      path.join(consumer, 'flow.ts'),
      `import { defineFlowSet, type FlowSetDefinition } from ${JSON.stringify(PACKAGE_NAME)};

export const definition: FlowSetDefinition = defineFlowSet((f) => {
  const tab = f.flow('main', { label: 'Main' });
  tab.node('inject' as never, {});
});
`,
      'utf8',
    );
    await writeFile(
      path.join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2024',
          lib: ['es2024'],
          module: 'nodenext',
          moduleResolution: 'nodenext',
          types: [],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['flow.ts'],
      }),
      'utf8',
    );

    const compiled = await run(process.execPath, [TSC, '--noEmit', '--pretty', 'false', '-p', consumer]);
    assert.equal(compiled.code, 0, `a consumer cannot type-check against the published declarations:\n${compiled.stdout}${compiled.stderr}`);

    // ...and the same program must be reachable: the declaration files are real, not empty shells.
    const declarations = await readdir(path.join(consumer, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist'));
    assert.ok(declarations.includes('cli'), 'the published dist has no cli directory');
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});

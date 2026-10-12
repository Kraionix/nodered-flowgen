/**
 * CLI tests: the parser, the renderings, and whole commands driven in-process.
 *
 * The commands are exercised through `runCli` with a temporary project, so what is asserted is
 * the contract a user sees — exit code, stdout, files on disk — rather than the internals of a
 * command function. Nothing here needs a Node-RED instance: `validate`, `types gen` and
 * `palette check` all work from a committed snapshot, which is the property that makes them
 * usable in CI.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closest, flag, parseArgv, rejectPositionals, text, texts, GLOBAL_OPTIONS, type OptionSpec } from '../../src/cli/args.ts';
import { renderHuman, renderJson, severityLine, type CommandResult } from '../../src/cli/output.ts';
import { EXIT, UsageError } from '../../src/cli/exit.ts';
import { runCli } from '../../src/cli/index.ts';
import { defineConfig, resolveConfig, resolveProfile } from '../../src/config/index.ts';
import { defineFlowSet } from '../../src/authoring/defineFlowSet.ts';
import { createPaletteSnapshot, serializePaletteSnapshot } from '../../src/palette/snapshot.ts';
import { paletteProperty, paletteType, type PaletteNodeSet } from '../../src/palette/model.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_ENTRY = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href;

const SPEC: readonly OptionSpec[] = [
  { name: 'target', kind: 'string', alias: 't', placeholder: '<name>', description: 'target' },
  { name: 'prune', kind: 'boolean', description: 'prune' },
  { name: 'palette', kind: 'string', multiple: true, placeholder: '<file>', description: 'palette' },
];

test('parseArgv accepts every documented form', () => {
  const parsed = parseArgv(['--target', 'local', '--prune', '--palette', 'a.json', '--palette=b.json', 'extra'], SPEC);
  assert.equal(text(parsed, 'target'), 'local');
  assert.equal(flag(parsed, 'prune'), true);
  assert.deepEqual(texts(parsed, 'palette'), ['a.json', 'b.json']);
  assert.deepEqual(parsed.positionals, ['extra']);
});

test('parseArgv supports short aliases, negation and the -- terminator', () => {
  const parsed = parseArgv(['-t', 'prod', '--no-prune', '--', '--not-an-option'], SPEC);
  assert.equal(text(parsed, 'target'), 'prod');
  assert.equal(flag(parsed, 'prune'), false);
  assert.deepEqual(parsed.positionals, ['--not-an-option']);
});

test('parseArgv rejects unknown options with a suggestion', () => {
  assert.throws(
    () => parseArgv(['--prun'], SPEC),
    (error: unknown) => error instanceof UsageError && /unknown option --prun/.test(error.message) && error.hint === 'did you mean --prune?',
  );
  assert.throws(() => parseArgv(['--target'], SPEC), (error: unknown) => error instanceof UsageError && /needs a value/.test(error.message));
  assert.throws(() => parseArgv(['--target', 'a', '-t', 'b'], SPEC), (error: unknown) => error instanceof UsageError && /single value/.test(error.message));
});

test('rejectPositionals refuses stray arguments', () => {
  const parsed = parseArgv(['oops'], SPEC);
  assert.throws(() => rejectPositionals(parsed, 'flowgen validate'), (error: unknown) => error instanceof UsageError && /unexpected argument: oops/.test(error.message));
  assert.doesNotThrow(() => rejectPositionals(parseArgv([], SPEC), 'flowgen validate'));
});

test('closest only suggests near misses', () => {
  assert.equal(closest('prun', ['prune', 'target']), 'prune');
  assert.equal(closest('completely-different', ['prune', 'target']), undefined);
});

test('renderJson is the documented machine shape', () => {
  const result: CommandResult = {
    command: 'validate',
    exitCode: EXIT.problems,
    diagnostics: [{ code: 'palette/unknown-type', severity: 'error', entity: 'n1', path: '', message: 'nope' }],
    messages: ['ignored in json mode'],
    data: { report: { hasErrors: true } },
  };
  const parsed = JSON.parse(renderJson(result)) as Record<string, unknown>;
  assert.equal(parsed['command'], 'validate');
  assert.equal(parsed['exitCode'], 1);
  assert.equal(parsed['outcome'], 'the check said no (validation problems, or --check found a difference)');
  assert.deepEqual(parsed['report'], { hasErrors: true });
  assert.equal((parsed['diagnostics'] as unknown[]).length, 1);
  assert.equal(parsed['messages'], undefined);
});

test('renderHuman prints problems with hints and stays silent when there is nothing to say', () => {
  const rendered = renderHuman({
    command: 'validate',
    exitCode: EXIT.problems,
    diagnostics: [{ code: 'palette/unknown-type', severity: 'error', entity: 'n1', path: 'type', message: 'unknown', hint: 'install it' }],
    messages: ['checked 1 tab'],
  });
  assert.match(rendered, /checked 1 tab/);
  assert.match(rendered, /error palette\/unknown-type n1\.type — unknown/);
  assert.match(rendered, /hint: install it/);

  const silent = renderHuman({ command: 'help', exitCode: EXIT.ok, diagnostics: [], messages: [] });
  assert.equal(silent, '');
  assert.equal(severityLine([]), '0 error(s), 0 warning(s), 0 info');
});

test('defineConfig is identity and resolveConfig fills in the defaults', () => {
  const definition = defineFlowSet(() => {});
  const config = defineConfig({ flowSet: definition });
  const resolved = resolveConfig(config, '/tmp/flowgen.config.ts');
  assert.equal(resolved.defaultProfile, 'local');
  assert.equal(resolved.lockfile, '.flowgen.lock.json');
  assert.equal(resolved.receipts, '.flowgen/receipts');
  assert.deepEqual(resolved.targets, {});

  const profile = resolveProfile(resolved, 'local');
  assert.equal(profile.snapshotPath, 'palettes/local.json');
  assert.equal(profile.typesPath, 'palettes/local.d');
  assert.equal(profile.cheatSheetPath, 'palettes/local.md');
  assert.equal(resolveProfile(resolved, 'prod').typesPath, 'palettes/prod.d');

  const named = resolveConfig(
    { flowSet: definition, palette: { default: 'prod', profiles: { prod: { snapshot: 'p.json', cheatSheet: false } } } },
    '/tmp/flowgen.config.ts',
  );
  assert.equal(resolveProfile(named, 'prod').cheatSheetPath, null);
  assert.equal(resolveProfile(named, 'prod').snapshotPath, 'p.json');
});

// ---------------------------------------------------------------------------------------
// Whole commands, in a temporary project
// ---------------------------------------------------------------------------------------

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cwd: string, argv: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
    cwd,
    env: { ...env },
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'flowgen-cli-'));
}

/** A palette with one node type, written the way `palette pull` would write it. */
function paletteFixture(version = '5.0.8'): string {
  const types = [
    paletteType('inject', {
      module: 'node-red',
      nodeSet: 'node-red/inject',
      version,
      category: 'common',
      inputs: 0,
      outputs: 1,
      defaults: {
        name: paletteProperty({ value: '' }),
        topic: paletteProperty({ value: '' }),
        payload: paletteProperty({ value: '' }),
        repeat: paletteProperty({ value: '' }),
        once: paletteProperty({ value: false }),
      },
    }),
  ];
  const nodeSets: PaletteNodeSet[] = [
    { id: 'node-red/inject', name: 'inject', module: 'node-red', version, enabled: true, local: false, user: false, types: ['inject'] },
  ];
  return serializePaletteSnapshot(
    createPaletteSnapshot({
      nodeRedVersion: version,
      nodeSets,
      types,
      provenance: { kind: 'snapshot', url: null, userDir: null, nodeModulesDirs: null },
    }),
  );
}

async function scaffold(dir: string, options: { readonly flow: string; readonly url?: string } = { flow: 'inject' }): Promise<void> {
  await writeFile(path.join(dir, 'flowgen.config.ts'), configSource(options), 'utf8');
  await writeFile(path.join(dir, 'palette.json'), paletteFixture(), 'utf8');
}

/** Two nodes wired into each other: legal Node-RED, and the shape that used to hang the CLI. */
function cyclicConfigSource(): string {
  return `import { defineConfig, defineFlowSet } from ${JSON.stringify(PACKAGE_ENTRY)};

export default defineConfig({
  flowSet: defineFlowSet((f) => {
    const tab = f.flow('main', { label: 'Main' });
    const first = tab.node('inject', { key: 'first', name: 'first' });
    const second = tab.node('inject', { key: 'second', name: 'second' });
    first.to(second);
    second.to(first);
  }),
  palette: { default: 'local', profiles: { local: { snapshot: 'palette.json', typesDirectory: 'types.d', cheatSheet: 'palette.md' } } },
});
`;
}

function configSource(options: { readonly flow: string; readonly url?: string }): string {
  const flow =
    options.flow === 'inject'
      ? `    const tab = f.flow('main', { label: 'Main' });
    tab.node('inject', { key: 'tick', name: 'tick', repeat: '60' });
`
      : `    const tab = f.flow('main', { label: 'Main' });
    tab.node('${options.flow}', { key: 'ghost' });
`;
  return `import { defineConfig, defineFlowSet } from ${JSON.stringify(PACKAGE_ENTRY)};

export default defineConfig({
  flowSet: defineFlowSet((f) => {
${flow}  }),
  palette: { default: 'local', profiles: { local: { snapshot: 'palette.json', typesDirectory: 'types.d', cheatSheet: 'palette.md' } } },
${options.url === undefined ? '' : `  targets: { local: { url: ${JSON.stringify(options.url)} } },\n`}});
`;
}

test('flowgen --version prints the manifest version, with or without a command', async () => {
  const dir = await tempDir();
  try {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };

    const bare = await run(dir, ['--version']);
    assert.equal(bare.code, EXIT.ok, bare.stderr);
    assert.equal(bare.stdout.trim(), manifest.version);

    // `--version` is a global option: asking any command for the version must not run it.
    const afterCommand = await run(dir, ['validate', '--version']);
    assert.equal(afterCommand.code, EXIT.ok, afterCommand.stderr);
    assert.equal(afterCommand.stdout.trim(), manifest.version);
    assert.doesNotMatch(afterCommand.stdout, /checked/, 'the command must not have run');

    assert.match((await run(dir, ['--help'])).stdout, /--version\s+print the version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the rendering is decided by the parsed options, not by scanning argv for --json', async () => {
  const dir = await tempDir();
  try {
    // `--json` here is the *value* of `--config`, not a flag. A raw `argv.includes('--json')`
    // cannot tell the difference and would render this failure as JSON on stdout.
    const asValue = await run(dir, ['validate', '--config', '--json']);
    assert.equal(asValue.code, EXIT.usage);
    assert.equal(asValue.stdout, '', 'the failure is text, because no --json flag was given');
    assert.match(asValue.stderr, /--json|flowgen\.config\.ts/);

    // Everything after `--` is a positional, so this is a stray argument — and the error about it
    // is not JSON either.
    const terminated = await run(dir, ['validate', '--', '--json']);
    assert.equal(terminated.code, EXIT.usage);
    assert.equal(terminated.stdout, '');
    assert.match(terminated.stderr, /unexpected argument/);

    // The flag itself still works, and still prints on stdout.
    const real = await run(dir, ['validate', '--json']);
    assert.equal(real.code, EXIT.usage);
    assert.equal(real.stderr, '');
    assert.equal((JSON.parse(real.stdout) as { exitCode: number }).exitCode, EXIT.usage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flowgen validate counts every node, including subflow bodies', async () => {
  const dir = await tempDir();
  try {
    await writeFile(
      path.join(dir, 'flowgen.config.ts'),
      `import { defineConfig, defineFlowSet } from ${JSON.stringify(PACKAGE_ENTRY)};

export default defineConfig({
  flowSet: defineFlowSet((f) => {
    const pass = f.subflow('pass', { name: 'pass', ports: { in: ['value'], out: ['value'] } }, (s) => {
      const work = s.node('inject', { key: 'work', name: 'work' });
      s.in(work);
      s.out(work, 0);
    });
    const tab = f.flow('main', { label: 'Main' });
    tab.instance(pass, { key: 'pass_1' });
    tab.node('inject', { key: 'tick', name: 'tick' });
  }),
  palette: { default: 'local', profiles: { local: { snapshot: 'palette.json', typesDirectory: 'types.d', cheatSheet: 'palette.md' } } },
});
`,
      'utf8',
    );
    await writeFile(path.join(dir, 'palette.json'), paletteFixture(), 'utf8');

    const result = await run(dir, ['validate']);
    assert.equal(result.code, EXIT.ok, result.stdout + result.stderr);
    // Two nodes in the tab (the instance and the inject) and one inside the subflow definition:
    // the count used to say 2, because it only looked at `flows[].nodes`.
    assert.match(result.stdout, /1 tab\(s\)\/1 subflow\(s\), 3 node\(s\)/);

    const json = JSON.parse((await run(dir, ['validate', '--json'])).stdout) as { flowSet: { nodes: number } };
    assert.equal(json.flowSet.nodes, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bin runs when it is reached through a symlinked directory', async () => {
  // `node_modules/.bin/flowgen` is a symlink, so this is the *normal* way an installed CLI is
  // started — and the old entry guard compared `argv[1]` (the link) with `import.meta.url` (the
  // resolved target), decided it was not the entry point, and exited 0 without printing a thing.
  const link = await mkdtemp(path.join(os.tmpdir(), 'flowgen-link-'));
  try {
    await symlink(path.join(REPO_ROOT, 'src', 'cli'), path.join(link, 'cli'));
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(link, 'cli', 'bin.ts'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /usage: flowgen <command>/, 'the CLI printed nothing through the symlink');
  } finally {
    await rm(link, { recursive: true, force: true });
  }
});

test('flowgen init scaffolds a config, ignore entries and refuses to clobber', async () => {
  const dir = await tempDir();
  try {
    const first = await run(dir, ['init', '--url', 'http://127.0.0.1:1880', '--token-env', 'NR_TOKEN']);
    assert.equal(first.code, EXIT.ok, first.stderr);
    const config = await readFile(path.join(dir, 'flowgen.config.ts'), 'utf8');
    assert.match(config, /defineConfig/);
    assert.match(config, /url: 'http:\/\/127\.0\.0\.1:1880'/);
    assert.match(config, /tokenEnv: 'NR_TOKEN'/);
    assert.match(await readFile(path.join(dir, '.gitignore'), 'utf8'), /\.flowgen\//);

    const again = await run(dir, ['init']);
    assert.equal(again.code, EXIT.usage);
    assert.match(again.stderr, /already exists/);
    assert.match(again.stderr, /--force/);

    const forced = await run(dir, ['init', '--force']);
    assert.equal(forced.code, EXIT.ok, forced.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flowgen validate exits 0 on a valid flow set and 1 on an unknown node type', async () => {
  const good = await tempDir();
  const bad = await tempDir();
  try {
    await scaffold(good);

    const ok = await run(good, ['validate']);
    assert.equal(ok.code, EXIT.ok, ok.stderr);
    assert.match(ok.stdout, /checked 1 tab\(s\)\/0 subflow\(s\), 1 node\(s\)/);

    const json = await run(good, ['validate', '--json']);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    assert.equal(parsed['exitCode'], 0);
    assert.equal((parsed['report'] as { hasErrors: boolean }).hasErrors, false);

    await writeFile(path.join(bad, 'flowgen.config.ts'), configSource({ flow: 'no such node' }), 'utf8');
    await writeFile(path.join(bad, 'palette.json'), paletteFixture(), 'utf8');
    const failed = await run(bad, ['validate']);
    assert.equal(failed.code, EXIT.problems);
    assert.match(failed.stdout, /palette\/unknown-type/);
  } finally {
    await rm(good, { recursive: true, force: true });
    await rm(bad, { recursive: true, force: true });
  }
});

test('a feedback loop is laid out and reported instead of hanging the command', async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, 'flowgen.config.ts'), cyclicConfigSource(), 'utf8');
    await writeFile(path.join(dir, 'palette.json'), paletteFixture(), 'utf8');

    // Before the layout fix this command never returned: no output, no exit code, no timeout.
    const result = await run(dir, ['validate']);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /info layout\/cycle first\.wires — nodes form a loop: first → second/);
    assert.match(result.stdout, /hint: geometry is advisory/);

    const json = await run(dir, ['validate', '--json']);
    const parsed = JSON.parse(json.stdout) as { report: { problems: { code: string }[] } };
    assert.deepEqual(
      parsed.report.problems.map((problem) => problem.code),
      ['layout/cycle'],
      'the build\u2019s own advice belongs in the same report as the validators\u2019 findings',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flowgen types gen writes the augmentations, is idempotent, and --check detects drift', async () => {
  const dir = await tempDir();
  try {
    await scaffold(dir);
    const generated = await run(dir, ['types', 'gen']);
    assert.equal(generated.code, EXIT.ok, generated.stderr);

    const index = await readFile(path.join(dir, 'types.d', 'index.d.ts'), 'utf8');
    assert.match(index, /reference path="\.\/node-red@5\.0\.8\.d\.ts"/);
    const module = await readFile(path.join(dir, 'types.d', 'node-red@5.0.8.d.ts'), 'utf8');
    assert.match(module, /inject/);
    // Without a top-level `export {}` the augmentations become an ambient module declaration.
    assert.match(module, /export \{\}/);
    assert.match(await readFile(path.join(dir, 'palette.md'), 'utf8'), /Node palette/);

    const again = await run(dir, ['types', 'gen']);
    assert.match(again.stdout, /0 written, 3 unchanged/);

    const checked = await run(dir, ['types', 'gen', '--check']);
    assert.equal(checked.code, EXIT.ok, checked.stderr);
    assert.match(checked.stdout, /generated types are current/);

    // A palette that moved and generated files that did not: exactly what CI must catch.
    await writeFile(path.join(dir, 'palette.json'), paletteFixture('5.0.9'), 'utf8');
    const stale = await run(dir, ['types', 'gen', '--check']);
    assert.equal(stale.code, EXIT.problems);
    assert.match(stale.stdout, /palette\/generated-stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flowgen reports configuration mistakes as usage errors, not crashes', async () => {
  const empty = await tempDir();
  const broken = await tempDir();
  try {
    const missing = await run(empty, ['validate']);
    assert.equal(missing.code, EXIT.usage);
    assert.match(missing.stderr, /no flowgen\.config\.ts found/);

    await writeFile(path.join(broken, 'flowgen.config.ts'), 'export default 42;\n', 'utf8');
    const wrong = await run(broken, ['validate']);
    assert.equal(wrong.code, EXIT.usage);
    assert.match(wrong.stderr, /does not export a flow set/);

    const unknown = await run(empty, ['pallett', 'pull']);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr, /unknown command "pallett"/);

    const help = await run(empty, ['--help']);
    assert.equal(help.code, EXIT.ok);
    assert.match(help.stdout, /usage: flowgen <command> \[options\]/);

    const commandHelp = await run(empty, ['apply', '--help']);
    assert.equal(commandHelp.code, EXIT.ok);
    assert.match(commandHelp.stdout, /--expect-rev/);
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(broken, { recursive: true, force: true });
  }
});

test('flowgen fails with a documented exit code when the instance is not reachable', async () => {
  const dir = await tempDir();
  try {
    await scaffold(dir, { flow: 'inject', url: 'http://127.0.0.1:9' });
    const pulled = await run(dir, ['palette', 'pull', '--url', 'http://127.0.0.1:9']);
    assert.equal(pulled.code, EXIT.unreachable, pulled.stdout + pulled.stderr);
    assert.match(pulled.stderr, /cannot read the palette/);

    const planned = await run(dir, ['plan', '--json']);
    assert.equal(planned.code, EXIT.unreachable);
    const parsed = JSON.parse(planned.stdout) as Record<string, unknown>;
    assert.equal(parsed['exitCode'], 4);
    assert.equal(parsed['outcome'], 'target unreachable or not permitted');

    const human = await run(dir, ['plan']);
    assert.equal(human.code, EXIT.unreachable);
    assert.match(human.stderr, /cannot read flows from http:\/\/127\.0\.0\.1:9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flowgen needs an explicit target when more than one is configured', async () => {
  const dir = await tempDir();
  try {
    const source = `import { defineConfig, defineFlowSet } from ${JSON.stringify(PACKAGE_ENTRY)};

export default defineConfig({
  flowSet: defineFlowSet((f) => {
    f.flow('main', { label: 'Main' });
  }),
  palette: { default: 'local', profiles: { local: {} } },
  targets: { a: { url: 'http://127.0.0.1:1' }, b: { url: 'http://127.0.0.1:2' } },
});
`;
    await writeFile(path.join(dir, 'flowgen.config.ts'), source, 'utf8');
    const ambiguous = await run(dir, ['plan']);
    assert.equal(ambiguous.code, EXIT.usage);
    assert.match(ambiguous.stderr, /more than one target is configured \(a, b\)/);

    const unknown = await run(dir, ['plan', '--target', 'c']);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr, /unknown target "c"/);
    assert.match(unknown.stderr, /configured targets: a, b/);

    const noPalette = await run(dir, ['plan', '--target', 'a']);
    assert.equal(noPalette.code, EXIT.usage);
    assert.match(noPalette.stderr, /palette pull/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('global options are accepted by every command', () => {
  const names = GLOBAL_OPTIONS.map((option) => option.name);
  assert.deepEqual(names, ['cwd', 'config', 'json', 'quiet', 'help', 'version']);
});

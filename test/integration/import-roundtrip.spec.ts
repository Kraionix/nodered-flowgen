/**
 * The import round trip: what `flowgen import` prints must rebuild what it read.
 *
 * This is the test that makes the feature trustworthy rather than plausible. For every fixture:
 *
 * ```text
 * ir    = normalize(parse(f))
 * ts    = print(ir)
 * built = build(ts, { lockfile: print.ids })
 * emit(built) === emit(ir)          // byte for byte
 * ```
 *
 * The comparison is against `emit(ir)` and not against the fixture's own text on purpose: our
 * array order, property order and canonicalisation are the documented ones (the emitter's fixed
 * point is asserted in `emit-roundtrip.spec.ts`), and a printer that reproduced a *foreign*
 * file's spelling of them would be reproducing someone else's conventions.
 *
 * The fixtures are chosen for what they exercise, not for size: a hand-built demo with a subflow
 * and a config node, an editor export with `global-config` (dashboard configs and a widget, a link
 * pair, a junction, a tab-scoped config, a loose node), the project's own example, and a file whose
 * node types the palette has never seen.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

import type { FlowSetDefinition } from '../../src/authoring/defineFlowSet.ts';
import { printFlowSet, type PrintReport } from '../../src/codegen/print.ts';
import { emitFlowSet } from '../../src/emit/flowJson.ts';
import { parseFlowSetText } from '../../src/import/fromFlowJson.ts';
import type { FlowSet } from '../../src/model/entities.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
import { materialiseDefaults } from '../../src/model/defaults.ts';
import type { PaletteSnapshot } from '../../src/palette/snapshot.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import { subflowOverlay } from '../../src/palette/sources/subflow.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATED = path.join(REPO_ROOT, '.tmp', 'import-roundtrip');
const FIXTURES = [
  'flows-recon-demo.json',
  'flows-editor-export.json',
  'flows-unrepresentable.json',
  'flows-hand-written.json',
];

/** Where a generated file finds the library, relative to `GENERATED`. */
const MODULE = '../../src/index.ts';

/**
 * The compiler settings a generated file is checked under: the repository's own, with the palette
 * the generated code was written against — the same arrangement a consumer has, where the
 * augmentations attach to the package name and the package resolves to its built sources.
 */
const CHECK_TSCONFIG = {
  compilerOptions: {
    target: 'es2024',
    lib: ['es2024'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    types: ['node'],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
    paths: { '@kraionix/nodered-flowgen': ['../../src/index.ts'] },
  },
  include: ['./flowset.ts', '../../test/types/palettes/local.d/**/*.d.ts'],
};

/** Runs a repository-local tool and captures its output. */
async function run(tool: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, tool), ...args], { cwd: REPO_ROOT });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

let base: PaletteSnapshot;
const sources = new Map<string, string>();
let counter = 0;

before(async () => {
  base = await filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
    userDir: REPO_ROOT,
  }).load();
  for (const name of FIXTURES) {
    sources.set(name, await readFile(path.join(REPO_ROOT, 'test', 'fixtures', name), 'utf8'));
  }
  await mkdir(GENERATED, { recursive: true });
});

after(async () => {
  await rm(path.join(REPO_ROOT, '.tmp'), { recursive: true, force: true });
});

interface RoundTrip {
  readonly report: PrintReport;
  readonly ids: ReadonlyMap<string, string>;
  readonly source: string;
  readonly before: string;
  readonly after: string;
}

/** Prints a flow set, rebuilds it from the printed source, and returns both flow files. */
async function roundTrip(flowSet: FlowSet, name: string): Promise<RoundTrip> {
  const palette = subflowOverlay(flowSet.subflows).apply(base).types;
  const printed = printFlowSet(flowSet, { palette, moduleName: MODULE, source: name });

  counter += 1;
  const file = path.join(GENERATED, `${counter}-${name.replace(/[^A-Za-z0-9]+/g, '_')}.ts`);
  await writeFile(file, printed.source, 'utf8');
  const module = (await import(pathToFileURL(file).href)) as { default: FlowSetDefinition };
  const built = module.default.build({ palette, lockfile: printed.ids }).flowSet;

  return {
    report: printed.report,
    ids: printed.ids,
    source: printed.source,
    before: emitFlowSet(flowSet, { palette }),
    after: emitFlowSet(built, { palette }),
  };
}

function importFixture(name: string): FlowSet {
  const text = sources.get(name) as string;
  const palette = { ...base.types };
  return normalizeFlowSet(parseFlowSetText(text, { palette }), { palette });
}

/**
 * What `flowgen import` does to a file before printing it: the palette defaults a hand-written
 * flow file leaves out, filled the way the runtime fills them when it loads it. Without this step
 * the comparison below would compare a rebuild (which always has them) with a file that never did.
 */
function asImported(name: string): { readonly flowSet: FlowSet; readonly filled: number } {
  const materialised = materialiseDefaults(importFixture(name), { palette: base.types });
  return { flowSet: materialised.flowSet, filled: materialised.filled };
}

const FIXTURE_CASES = [
  { fixture: 'flows-recon-demo.json', untyped: 0 },
  // The editor export deliberately contains one type this palette has never seen.
  { fixture: 'flows-editor-export.json', untyped: 1 },
];

for (const { fixture, untyped } of FIXTURE_CASES) {
  test(`import → print → build → emit reproduces ${fixture} byte for byte`, async () => {
    const result = await roundTrip(importFixture(fixture), fixture);
    assert.equal(result.after, result.before, 'the printed source rebuilds the same flow file');
    assert.equal(result.report.untyped, untyped, 'only the types the palette does not know go untyped');
    assert.equal(result.report.comments, 0, 'nothing needed a review comment');
  });
}

test('the project example survives the round trip', async () => {
  // The example is the flow set an author would actually write, so it is also the one the printer
  // has to be able to read back: a dashboard tree, a subflow with typed parameters and an instance
  // override, a three-output switch, a canvas group and a shared broker.
  const module = (await import('../../examples/acceptance/flowgen.config.ts')) as {
    default: { flowSet: FlowSetDefinition };
  };
  // The example is authored without coordinates, so the layout places it — which is exactly what
  // the printed source then carries and the rebuild preserves.
  const built = module.default.flowSet.build({ palette: { ...base.types } }).flowSet;
  const result = await roundTrip(built, 'acceptance-example');

  assert.equal(result.after, result.before, 'the printed source rebuilds the same flow file');
  assert.equal(result.report.untyped, 0);
  assert.equal(result.report.comments, 0);
  assert.ok(result.source.includes('f.manifest('), 'the dashboard module is declared, not derived');
  assert.match(result.source, /f\.subflow\(/, 'the subflow is a definition, not a raw node');
  assert.match(result.source, /\.instance\(/, 'and its instance is an instance');
});

test('a hand-written file round-trips once its defaults are filled', async () => {
  const { flowSet, filled } = asImported('flows-hand-written.json');
  assert.equal(filled, 13, 'the properties a hand-written entry leaves out are exactly these');
  assert.deepEqual(flowSet.flows[0]?.nodes[0]?.props.known['repeat'], '', 'the runtime fills them on load');
  assert.equal(flowSet.flows[0]?.nodes[2]?.props.extras['l'], false, 'and the file\'s own extras stay extras');

  const result = await roundTrip(flowSet, 'hand-written');
  assert.equal(result.after, result.before, 'the printed source rebuilds the same flow file');
  assert.equal(result.report.notes.length, 0);
});

test('the printed source compiles', async () => {
  // The strongest statement the printer can make short of deploying: the file it writes is
  // accepted by the same compiler settings the library itself is written under, against the
  // palette augmentations a consumer would have committed — including `noUnusedLocals`, which is
  // what an unused `const` per container would trip over.
  const flowSet = importFixture('flows-editor-export.json');
  const palette = subflowOverlay(flowSet.subflows).apply(base).types;
  const printed = printFlowSet(flowSet, { palette, source: 'typecheck' });
  await writeFile(path.join(GENERATED, 'flowset.ts'), printed.source, 'utf8');
  await writeFile(path.join(GENERATED, 'tsconfig.json'), `${JSON.stringify(CHECK_TSCONFIG, null, 2)}\n`, 'utf8');

  const result = await run('node_modules/typescript/bin/tsc', ['-p', path.join(GENERATED, 'tsconfig.json')]);
  assert.equal(result.code, 0, `tsc rejected the generated source:\n${result.output}`);
});

test('an unrepresentable node round-trips and is reported', async () => {
  const result = await roundTrip(importFixture('flows-unrepresentable.json'), 'unrepresentable');

  assert.equal(result.after, result.before, 'the fallback is lossless even where it is not idiomatic');
  assert.equal(result.report.untyped, 2, 'both unknown types went through the open surface');
  assert.match(result.source, /\.untyped\("acme-thing", \{/, 'the open surface is visible in the source');
  assert.ok(
    result.source.includes('nest: { id: "a", type: "b" }'),
    'a property value that merely looks like a handle stays data',
  );

  const dropped = result.report.notes.filter((note) => note.action === 'dropped');
  assert.deepEqual(dropped.map((note) => note.reason), ['credentials'], 'credentials are never printed');
  const literals = result.report.notes.filter((note) => note.action === 'literal');
  assert.equal(literals.length, 1, 'the forward reference is the one id left in the source');
  assert.match(result.source, /links: \[ "link2" \]/, 'and that is what it looks like');
});

test('every entity id is recorded, under the key the builder will look it up by', async () => {
  const flowSet = importFixture('flows-editor-export.json');
  const { ids } = await roundTrip(flowSet, 'ids');
  const recorded = new Set(ids.values());

  const expected = [
    ...flowSet.subflows.map((subflow) => subflow.id),
    ...flowSet.subflows.flatMap((subflow) => subflow.nodes.map((node) => node.id)),
    ...flowSet.flows.map((flow) => flow.id),
    ...flowSet.flows.flatMap((flow) => flow.nodes.map((node) => node.id)),
    ...flowSet.flows.flatMap((flow) => flow.groups.map((group) => group.id)),
    ...flowSet.loose.map((node) => node.id),
    ...flowSet.configs.map((config) => config.id),
    ...flowSet.flows.flatMap((flow) => flow.configs.map((config) => config.id)),
  ];
  const missing = expected.filter((id) => !recorded.has(id));
  assert.deepEqual(missing, [], 'an id with no lockfile entry would be re-derived on the next build');

  assert.ok(ids.has('global-config'), 'the manifest entry is keyed like any other entity');
  for (const key of ids.keys()) {
    assert.ok(
      /^(tab|subflow|group|config|node|instance|global-config)/.test(key),
      `"${key}" is not a key the builder derives`,
    );
  }
});

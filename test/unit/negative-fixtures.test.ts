/**
 * Negative regression fixtures: the seven defects the prior art shipped, each one caught.
 *
 * Provenance: `recon/PRIOR-ART-2026-10.md` §2 lists behaviours that were *measured* on a
 * competing Python flow builder. Each file in `test/fixtures/negative/` is the flow file that
 * tool would have written, and each test below asserts the invariant that makes the defect
 * impossible here — either because the pipeline reports it, or because it repairs it loudly.
 *
 * "Caught" therefore means one of two things, and the test says which:
 *
 * * an **error** diagnostic (the pipeline refuses: a dangling wire, an unresolvable reference);
 * * a **reported fix** plus a complete document (the editor would repair it silently; we repair
 *   it and say so, because a silent repair hides an authoring bug).
 *
 * The palette is the installed Node-RED core, so the fixtures are checked against the real
 * registrations rather than against a hand-written stub.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { layoutFlowSet } from '../../src/authoring/layout.ts';
import { emitFlowSet } from '../../src/emit/flowJson.ts';
import { parseFlowFile } from '../../src/import/fromFlowJson.ts';
import { normalizeFlowSetWithFixes } from '../../src/model/normalize.ts';
import type { FlowSet } from '../../src/model/entities.ts';
import { subflowDefinitionLike } from '../../src/model/subflows.ts';
import type { PaletteType } from '../../src/palette/model.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import type { PaletteSnapshot } from '../../src/palette/snapshot.ts';
import { applyOverlays } from '../../src/palette/sources/source.ts';
import { subflowOverlay } from '../../src/palette/sources/subflow.ts';
import type { Problem } from '../../src/diagnostics/index.ts';
import { defaultValidators } from '../../src/validate/index.ts';
import { runValidators } from '../../src/validate/report.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'negative');

let basePalette: Record<string, PaletteType>;
let baseSnapshot: PaletteSnapshot;

before(async () => {
  baseSnapshot = await filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
  }).load();
  basePalette = { ...baseSnapshot.types };
});

interface Pipeline {
  readonly flowSet: FlowSet;
  readonly palette: Record<string, PaletteType>;
  readonly fixes: readonly Problem[];
  readonly problems: readonly Problem[];
  readonly emitted: readonly Record<string, unknown>[];
}

/** Import → normalise → validate → emit, exactly as the CLI does it. */
async function pipeline(name: string, layout = false): Promise<Pipeline> {
  const flows = JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as unknown[];
  const imported = parseFlowFile(flows, { palette: basePalette });
  // An inline subflow is never in `GET /nodes`: its type comes from the definition itself.
  const palette = {
    ...applyOverlays(baseSnapshot, [subflowOverlay(imported.subflows.map(subflowDefinitionLike))]).types,
  };

  const normalised = normalizeFlowSetWithFixes(imported, { palette });
  const flowSet = layout ? layoutFlowSet(normalised.flowSet) : normalised.flowSet;
  const report = await runValidators(
    defaultValidators(),
    { flowSet, palette, targetVersion: null },
    { mode: 'collect' },
  );

  return {
    flowSet,
    palette,
    fixes: normalised.fixes,
    problems: report.problems,
    emitted: JSON.parse(emitFlowSet(flowSet, { palette })) as Record<string, unknown>[],
  };
}

function entry(pipeline: Pipeline, id: string): Record<string, unknown> {
  const found = pipeline.emitted.find((candidate) => candidate['id'] === id);
  assert.ok(found, `entry ${id} is missing from the emitted flow set`);
  return found;
}

function codes(problems: readonly Problem[]): readonly string[] {
  return problems.map((problem) => problem.code);
}

test('partial wires are padded to the declared port count, and reported', async () => {
  const result = await pipeline('function-partial-wires.json');

  // The prior art emitted `"wires": [["dbg1"]]` for a three-output function; the editor always
  // writes one array per output, and the runtime indexes into that array.
  const fn = entry(result, 'fn1');
  assert.equal((fn['wires'] as unknown[]).length, 3);
  assert.deepEqual(fn['wires'], [['dbg1'], [], []]);
  assert.deepEqual(codes(result.fixes), ['normalize/wire-arity']);
  assert.deepEqual(result.problems, [], 'padding is a fix, not an error');
});

test('a node without a wires key still gets one', async () => {
  const result = await pipeline('change-without-wires.json');

  // `wires` was absent entirely for nodes with no outgoing connection.
  const change = entry(result, 'ch1');
  assert.ok(Object.hasOwn(change, 'wires'), 'wires is always present for a non-config node');
  assert.deepEqual(change['wires'], [[]]);
  assert.deepEqual(codes(result.fixes), ['normalize/wire-arity']);
});

test('every non-config node comes out with coordinates', async () => {
  const raw = await pipeline('node-without-coordinates.json');
  const placed = await pipeline('node-without-coordinates.json', true);

  // Keys are never absent: the emitter writes a position even when the source had none.
  const inject = entry(raw, 'in1');
  assert.equal(inject['x'], 0);
  assert.equal(inject['y'], 0);

  // ... and the layout pass is what turns "no position" into a usable one, without moving the
  // node that already had a position.
  const laidOut = entry(placed, 'in1');
  assert.ok((laidOut['x'] as number) > 0 && (laidOut['y'] as number) > 0, 'a node with no geometry is placed');
  assert.equal(entry(placed, 'dbg1')['x'], 400, 'a node that had coordinates keeps them');
});

test('groups always carry real bounds', async () => {
  const raw = await pipeline('group-without-bounds.json');
  const boxed = await pipeline('group-without-bounds.json', true);

  // The prior art wrote a group with no x/y/w/h at all. Ours never omits them...
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Object.hasOwn(entry(raw, 'grp1'), key), `group carries ${key}`);
  }

  // ... and the layout pass makes them the bounding box of the members, not a degenerate 0×0.
  const group = entry(boxed, 'grp1');
  const member = entry(boxed, 'sw1');
  const [gx, gy, gw, gh] = [group['x'] as number, group['y'] as number, group['w'] as number, group['h'] as number];
  const [mx, my] = [member['x'] as number, member['y'] as number];
  assert.ok(gw > 0 && gh > 0, 'the box has area');
  assert.ok(gx < mx && mx < gx + gw && gy < my && my < gy + gh, 'the box contains its member');
});

test('a dangling wire is an error, not a silent deletion', async () => {
  const result = await pipeline('dangling-wire.json');

  // The prior art's cleanup loop compared a list to a string and left the dangling id in place.
  assert.deepEqual(codes(result.problems.filter((problem) => problem.severity === 'error')), ['graph/wire-target-missing']);
  assert.deepEqual(entry(result, 'in1')['wires'], [['node_that_was_deleted']]);
});

test('config nodes are recognised from palette metadata and referenced by id', async () => {
  const result = await pipeline('config-node-inside-tab.json');

  // The prior art hardcoded two config type names and gave a `tls-config` a bogus container.
  // Config-ness is `category: 'config'` in the palette, and a config node carries no container,
  // no coordinates and no wires.
  assert.deepEqual(
    result.flowSet.configs.map((config) => `${config.type}#${config.id}`),
    ['tls-config#tls1', 'mqtt-broker#broker1'],
  );
  assert.deepEqual(
    result.emitted.slice(0, 2).map((node) => node['id']),
    ['tls1', 'broker1'],
    'shared config nodes are written before the tabs that use them',
  );
  for (const id of ['tls1', 'broker1']) {
    const config = entry(result, id);
    assert.equal(config['z'], undefined, 'a global config node has no container');
    assert.equal(config['x'], undefined, 'a config node has no coordinates');
    assert.equal(config['wires'], undefined, 'a config node has no wires');
  }

  // An empty reference is *unset*, not dangling: the editor writes `"broker": ""` for every
  // optional config reference the author never selected.
  assert.deepEqual(
    result.problems.filter((problem) => problem.code.startsWith('palette/ref')),
    [],
    'a resolved reference and an empty one are both fine',
  );
});

test('subflow instances keep their parameter overrides and full wires', async () => {
  const result = await pipeline('bare-subflow-instance.json');

  // The prior art produced a bare node: no `env`, and wires only as long as the author had used.
  const instance = entry(result, 'sfi1');
  assert.deepEqual(instance['env'], [{ name: 'factor', type: 'num', value: '3' }], 'the override survives the round trip');
  assert.deepEqual(instance['wires'], [[]], 'wires match the subflow port count');
  assert.deepEqual(codes(result.fixes), ['normalize/wire-arity']);
  assert.deepEqual(result.problems.filter((problem) => problem.severity === 'error'), []);
});

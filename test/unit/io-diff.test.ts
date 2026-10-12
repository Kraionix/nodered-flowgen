/**
 * The diff, asserted on the properties the command promises.
 *
 * The interesting assertions are the negative ones: a diff is only useful if it does *not* report
 * the differences a reader cannot act on. So this file checks that reordered keys, omitted
 * defaults, an absent `wires` array and moved geometry all compare equal, and that everything a
 * reviewer would act on — a changed function body, a removed node something still points at, a
 * module version — survives.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeDiff, diffFlowSets, type DiffSide } from '../../src/io/diff.ts';
import { emitFlowSet } from '../../src/emit/flowJson.ts';
import { materialiseDefaults } from '../../src/model/defaults.ts';
import { normalizeFlowSetWithFixes } from '../../src/model/normalize.ts';
import { parseFlowFile } from '../../src/import/fromFlowJson.ts';
import { paletteProperty, paletteType, type PaletteType } from '../../src/palette/model.ts';
import type { FlowSet } from '../../src/model/entities.ts';

const PALETTE: Record<string, PaletteType> = {
  inject: paletteType('inject', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      topic: paletteProperty({ value: '' }),
      payload: paletteProperty({ value: '' }),
      repeat: paletteProperty({ value: '' }),
    },
  }),
  debug: paletteType('debug', {
    module: 'node-red',
    nodeSet: 'node-red/debug',
    version: '5.0.8',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }), active: paletteProperty({ value: true }) },
  }),
  'mqtt-broker': paletteType('mqtt-broker', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    category: 'config',
    defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883 }) },
  }),
  'mqtt out': paletteType('mqtt out', {
    module: 'node-red',
    nodeSet: 'node-red/mqtt',
    version: '5.0.8',
    inputs: 1,
    outputs: 0,
    defaults: { name: paletteProperty({ value: '' }), broker: paletteProperty({ type: 'mqtt-broker' }) },
  }),
};

/** A side from a flow-file document, put through the same pipeline the command uses. */
function side(label: string, document: readonly Record<string, unknown>[], modules: Record<string, string> = {}): DiffSide {
  const parsed = parseFlowFile(document, { palette: PALETTE });
  const filled = materialiseDefaults(normalizeFlowSetWithFixes(parsed, { palette: PALETTE }).flowSet, { palette: PALETTE });
  const flowSet: FlowSet = { ...filled.flowSet, modules: { ...filled.flowSet.modules, ...modules } };
  return { label, flowSet, palette: PALETTE };
}

function inject(id: string, z: string, init: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'inject', z, name: id, x: 100, y: 100, wires: [['sink']], ...init };
}

const TAB = { id: 'main', type: 'tab', label: 'Main', disabled: false, info: '' };
const SINK = { id: 'sink', type: 'debug', z: 'main', name: 'sink', x: 300, y: 100, wires: [] };

test('key order, omitted defaults, geometry and an absent wires array are not differences', () => {
  const before = side('before', [TAB, inject('tick', 'main'), SINK]);
  // The same flow as an editor might have written it: keys in another order, the optional
  // properties the runtime fills in left out, the node moved, and `wires` omitted entirely.
  const after = side('after', [
    { type: 'tab', label: 'Main', id: 'main' },
    { wires: [['sink']], y: 400, x: 999, z: 'main', type: 'inject', id: 'tick', name: 'tick' },
    { name: 'sink', z: 'main', type: 'debug', id: 'sink' },
  ]);

  const diff = diffFlowSets(before, after);
  assert.equal(diff.identical, true, describeDiff(diff).join('\n'));
  assert.deepEqual(diff.counts, { added: 0, removed: 0, changed: 0, unchanged: 3, containers: 0 });
  assert.deepEqual(diff.entities, []);
  // The note is what stops "no differences" from being read as "the files are identical".
  assert.match(diff.notes.join('\n'), /geometry \(x, y, w, h\) is ignored/);
});

test('--geometry turns moved nodes into differences, and nothing else', () => {
  const before = side('before', [TAB, inject('tick', 'main'), SINK]);
  const after = side('after', [TAB, { ...inject('tick', 'main'), x: 500 }, SINK]);

  assert.equal(diffFlowSets(before, after).identical, true);
  const withGeometry = diffFlowSets(before, after, { geometry: true });
  assert.equal(withGeometry.counts.changed, 1);
  const change = withGeometry.entities[0];
  assert.equal(change?.id, 'tick');
  assert.deepEqual(change?.changes[0]?.changed, ['x']);
});

test('a changed property is reported by name, and a changed body is not hidden by a moved node', () => {
  const before = side('before', [TAB, inject('tick', 'main', { topic: 'a' }), SINK]);
  const after = side('after', [TAB, inject('tick', 'main', { topic: 'b', x: 777 }), SINK]);

  const diff = diffFlowSets(before, after);
  assert.equal(diff.counts.changed, 1);
  assert.deepEqual(diff.entities[0]?.changes[0]?.changed, ['topic']);
  assert.equal(diff.entities[0]?.container, 'main');
  assert.equal(diff.entities[0]?.kind, 'node');
  assert.equal(diff.entities[0]?.label, 'tick');
});

test('a removal names the surviving entities left pointing at it', () => {
  const before = side('before', [TAB, inject('tick', 'main'), SINK, { ...inject('spare', 'main') }]);
  // `spare` is gone, and `tick` still wires to `sink` — but `sink` itself is what we remove here,
  // so the dangling reference is the one a reviewer has to fix.
  const after = side('after', [TAB, inject('tick', 'main')]);

  const diff = diffFlowSets(before, after);
  const removed = diff.entities.filter((entity) => entity.status === 'removed');
  assert.deepEqual(removed.map((entity) => entity.id).sort(), ['sink', 'spare']);

  const sink = removed.find((entity) => entity.id === 'sink');
  assert.deepEqual(sink?.referencedBy, ['tick']);
  assert.match(sink?.impact ?? '', /still referenced by 1 entity that is still there: tick/);
  assert.match(sink?.impact ?? '', /left dangling/);

  // `spare` pointed at `sink`, which is also gone: nothing that survives references it, so there
  // is no impact to report — the interesting/quiet distinction is the whole point of the field.
  const spare = removed.find((entity) => entity.id === 'spare');
  assert.deepEqual(spare?.referencedBy, []);
  assert.equal(spare?.impact, null);
});

test('a container, a config node and a module version are all differences', () => {
  const before = side(
    'before',
    [
      TAB,
      inject('tick', 'main'),
      SINK,
      { id: 'broker', type: 'mqtt-broker', name: 'broker', port: 1883 },
      { id: 'out', type: 'mqtt out', z: 'main', name: 'out', broker: 'broker', wires: [] },
    ],
    { 'node-red': '5.0.8' },
  );
  const after = side(
    'after',
    [
      TAB,
      inject('tick', 'main'),
      SINK,
      { id: 'broker', type: 'mqtt-broker', name: 'broker', port: 8883 },
      { id: 'out', type: 'mqtt out', z: 'main', name: 'out', broker: 'broker', wires: [] },
      { id: 'second', type: 'tab', label: 'Second' },
    ],
    { 'node-red': '5.0.9' },
  );

  const diff = diffFlowSets(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.modules, [{ module: 'node-red', before: '5.0.8', after: '5.0.9' }]);

  const broker = diff.entities.find((entity) => entity.id === 'broker');
  assert.equal(broker?.kind, 'config');
  assert.equal(broker?.status, 'changed');
  assert.deepEqual(broker?.changes[0]?.changed, ['port']);
  assert.deepEqual(broker?.referencedBy, ['out']);

  const second = diff.entities.find((entity) => entity.id === 'second');
  assert.equal(second?.kind, 'container');
  assert.equal(second?.status, 'added');
  assert.equal(second?.container, null);
  assert.equal(second?.label, 'Second');
  // An addition is a whole-entity fact: listing every key it has would bury the line.
  assert.deepEqual(second?.changes, []);
});

test('the human rendering is the same facts, one line per entity', () => {
  const before = side('before', [TAB, inject('tick', 'main'), SINK]);
  const after = side('after', [TAB, inject('tick', 'main', { topic: 'b' })]);

  const rendered = describeDiff(diffFlowSets(before, after));
  assert.match(rendered[0] ?? '', /^0 added, 1 removed, 1 changed, 1 unchanged$/);
  assert.ok(rendered.some((line) => line.startsWith('~ node tick (inject) "tick" in main')));
  assert.ok(rendered.some((line) => line.trim() === '~topic'));
  assert.ok(rendered.some((line) => line.startsWith('- node sink')));
  assert.ok(rendered.some((line) => line.startsWith('note: geometry')));

  assert.deepEqual(describeDiff(diffFlowSets(before, before)), ['no differences (3 entit(ies) compared)']);
});

test('the two sides are emitted by the same emitter, so the diff never sees a spelling', () => {
  // A flow file that has been through `flowgen import` and one the editor exported describe the
  // same flow; the diff is between IRs, so nothing but the flow itself can show up.
  const editor = side('editor', [TAB, inject('tick', 'main'), SINK]);
  const roundTripped = side('round-tripped', JSON.parse(emitFlowSet(editor.flowSet, { palette: PALETTE })) as readonly Record<string, unknown>[]);

  assert.equal(diffFlowSets(editor, roundTripped).identical, true);
});

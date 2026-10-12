import assert from 'node:assert/strict';
import test from 'node:test';

import { emitCheatSheet, emitPaletteModule } from '../../src/palette/codegen/emitSnapshot.ts';
import { emitTypes, sanitize } from '../../src/palette/codegen/emitTypes.ts';
import { paletteProperty, paletteType, type PaletteNodeSet } from '../../src/palette/model.ts';
import { createPaletteSnapshot, type PaletteSnapshot } from '../../src/palette/snapshot.ts';

function snapshot(): PaletteSnapshot {
  const nodeSets: PaletteNodeSet[] = [
    { id: 'node-red/inject', name: 'inject', module: 'node-red', version: '5.0.8', enabled: true, local: false, user: false, types: ['inject'] },
    { id: 'node-red/mqtt', name: 'mqtt', module: 'node-red', version: '5.0.8', enabled: true, local: false, user: false, types: ['mqtt-broker'] },
    { id: 'acme/widget', name: 'widget', module: '@acme/nodes', version: '2.0.0', enabled: true, local: true, user: true, types: ['widget'] },
    { id: 'flowgen:inline', name: 'inline', module: 'flowgen:inline', version: '0.0.0', enabled: true, local: false, user: false, types: ['subflow:scale'] },
  ];

  return createPaletteSnapshot({
    nodeRedVersion: '5.0.8',
    nodeSets,
    provenance: { kind: 'snapshot', url: null, userDir: null, nodeModulesDirs: null },
    types: [
      paletteType('inject', {
        module: 'node-red',
        nodeSet: 'node-red/inject',
        version: '5.0.8',
        category: 'common',
        inputs: 0,
        outputs: 1,
        defaults: {
          name: paletteProperty({ value: '' }),
          once: paletteProperty({ value: false }),
          onceDelay: paletteProperty({ value: 0.1 }),
          props: paletteProperty({ value: [{ p: 'payload' }, { p: 'topic', vt: 'str' }] }),
          empty: paletteProperty({ value: [] }),
          computed: paletteProperty({ dynamic: true }),
          tags: paletteProperty({ type: '*[]' }),
        },
      }),
      paletteType('mqtt-broker', {
        module: 'node-red',
        nodeSet: 'node-red/mqtt',
        version: '5.0.8',
        category: 'config',
        defaults: { name: paletteProperty({ value: '' }), port: paletteProperty({ value: 1883, required: true }) },
        credentials: { user: paletteProperty({ value: '' }) },
      }),
      paletteType('widget', {
        module: '@acme/nodes',
        nodeSet: 'acme/widget',
        version: '2.0.0',
        category: 'acme',
        inputs: 1,
        outputs: 1,
        defaults: {
          name: paletteProperty({ value: '' }),
          broker: paletteProperty({ type: 'mqtt-broker', required: true }),
          'odd"key': paletteProperty({ value: 'x' }),
        },
      }),
      paletteType('subflow:scale', {
        module: 'flowgen:inline',
        nodeSet: 'flowgen:inline',
        version: '0.0.0',
        paletteLabel: 'scale × factor',
        inputs: 1,
        outputs: 1,
        defaults: { name: paletteProperty({ value: '' }) },
        params: [
          { name: 'factor', type: 'num', value: '2', ui: undefined },
          { name: 'verbose', type: 'bool', value: 'true', ui: undefined },
        ],
      }),
    ],
  });
}

function fileContaining(files: readonly { path: string; content: string }[], needle: string): string {
  const file = files.find((candidate) => candidate.path.includes(needle));
  assert.ok(file, `expected a generated file for ${needle}`);
  return (file as { content: string }).content;
}

test('one augmentation file per npm module, plus an index of references', () => {
  const files = emitTypes(snapshot());
  assert.deepEqual(
    files.map((file) => file.path),
    [
      'palettes/local.d/acme-nodes@2.0.0.d.ts',
      'palettes/local.d/flowgen-inline@0.0.0.d.ts',
      'palettes/local.d/node-red@5.0.8.d.ts',
      'palettes/local.d/index.d.ts',
    ],
  );
  assert.match(fileContaining(files, 'index.d.ts'), /\/\/\/ <reference path="\.\/node-red@5\.0\.8\.d\.ts" \/>/);
});

test('every generated file is an augmentation, never an ambient module', () => {
  for (const file of emitTypes(snapshot())) {
    if (file.path.endsWith('index.d.ts')) continue;
    assert.match(file.content, /^\/\*\*[\s\S]*?\*\/\nexport \{\};\n/, `${file.path} starts with a header and export {}`);
    assert.match(file.content, /declare module '@kraionix\/nodered-flowgen' \{/, file.path);
  }
});

test('required-and-defaultless properties are enforced, defaulted ones are optional', () => {
  const content = fileContaining(emitTypes(snapshot()), 'acme-nodes');
  assert.match(content, /"broker": Ref<"mqtt-broker">;/);
  assert.match(content, /"name"\?: string;/);
});

test('value types are inferred from the declared default', () => {
  const content = fileContaining(emitTypes(snapshot()), 'node-red@');
  assert.match(content, /"once"\?: boolean;/);
  assert.match(content, /"onceDelay"\?: number;/);
  assert.match(content, /"props"\?: Array<\{ "p"\?: string; "vt"\?: string; \} & Record<string, unknown>>;/);
  assert.match(content, /"empty"\?: unknown\[\];/);
  assert.match(content, /"computed"\?: unknown;/, 'a computed default cannot be typed');
  assert.match(content, /"tags"\?: Ref;/, 'a wildcard reference accepts any node type');
});

test('property names are escaped, so odd node types cannot break the file', () => {
  assert.match(fileContaining(emitTypes(snapshot()), 'acme-nodes'), /"odd\\"key"\?: string;/);
});

test('subflow parameters become a typed env override bag', () => {
  const content = fileContaining(emitTypes(snapshot()), 'flowgen-inline');
  assert.match(content, /env\?: \{/);
  assert.match(content, /"factor"\?: number \| string;/);
  assert.match(content, /"verbose"\?: boolean \| string;/);
});

test('generation is deterministic and honours the package-name and directory options', () => {
  const first = emitTypes(snapshot());
  const second = emitTypes(snapshot());
  assert.deepEqual(first, second);

  const custom = emitTypes(snapshot(), { directory: 'types/palette', packageName: 'my-flowgen', header: false });
  assert.equal(custom[0]?.path.startsWith('types/palette/'), true);
  assert.doesNotMatch(custom[0]?.content ?? '', /Generated by flowgen/);
  assert.match(fileContaining(custom, 'node-red@'), /declare module 'my-flowgen' \{/);
});

test('a type with no properties still emits an (empty) property bag', () => {
  const content = fileContaining(emitTypes(snapshot()), 'node-red@');
  assert.match(content, /"mqtt-broker": \{\s*"name"\?: string;\s*"port"\?: number;\s*\};/);
});

test('the cheat sheet lists types by module with their properties', () => {
  const markdown = emitCheatSheet(snapshot());
  assert.match(markdown, /## node-red@5\.0\.8/);
  assert.match(markdown, /### ui_|### inject/);
  assert.match(markdown, /\| `once` \| boolean \| `false` \|/);
  assert.match(markdown, /→ mqtt-broker/);
  assert.match(markdown, /Subflow parameters/);

  const filtered = emitCheatSheet(snapshot(), { modules: ['@acme/nodes'] });
  assert.doesNotMatch(filtered, /### inject/);
  assert.match(filtered, /### widget/);
});

test('the palette module is the snapshot plus a generated header', () => {
  const text = emitPaletteModule(snapshot());
  assert.match(text, /^\/\/ Generated by flowgen — do not edit\.\nexport default \{/);
  assert.match(text, /"contentHash": "sha256:/);
});

test('module names are sanitised into portable file names', () => {
  assert.equal(sanitize('@acme/nodes'), 'acme-nodes');
  assert.equal(sanitize('flowgen:inline'), 'flowgen-inline');
  assert.equal(sanitize('node-red'), 'node-red');
});

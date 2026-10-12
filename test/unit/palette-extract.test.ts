import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assembleNodeSets,
  extractFromMarkedHtml,
  parseNodeSets,
  splitHtmlByModuleMarker,
} from '../../src/palette/extract/attribute.ts';
import { normalizeRegisteredType } from '../../src/palette/extract/normalize.ts';
import { extractRegisteredTypes, type ExtractionIssue } from '../../src/palette/extract/registerType.ts';
import type { PaletteNodeSet, PaletteType } from '../../src/palette/model.ts';

// --------------------------------------------------------------------------------------
// A hermetic document: markers, several script blocks, a template block, a document-ready
// registration, a throwing block and a type declared without editor registration.
// --------------------------------------------------------------------------------------

const FIXTURE_HTML = `<!-- --- [red-module:acme/widget] --- -->
<script>
  RED.nodes.registerType('widget', {
    category: 'acme',
    color: '#123456',
    defaults: {
      name: { value: '' },
      broker: { type: 'mqtt-broker', required: true },
      tags: { type: '*[]' },
      links: { type: 'link out[]' },
      computed: { value: function () { return 1; } },
      labelled: { value: 'x', label: function () { return 'X'; } }
    },
    credentials: { token: { value: '' } },
    inputs: 1,
    outputs: 2
  });
</script>
<script data-template-name="acme/widget">
  <div>registerType is not code in here</div>
</script>
<script type="text/html" data-help-name="acme/widget">
  <p>registerType in help text</p>
</script>
<script>
  $(function () {
    RED.nodes.registerType('ready-node', { category: 'acme', defaults: {}, inputs: 0, outputs: 1 });
  });
</script>
<script>
  RED.nodes.registerType('half-broken', { category: 'acme', defaults: {} });
  throw new Error('boom');
</script>
<!-- --- [red-module:acme/config] --- -->
<script>
  RED.nodes.registerType('acme-config', { category: 'config', defaults: { name: { value: '' } } });
</script>
`;

function acmeNodeSets(): PaletteNodeSet[] {
  return [
    {
      id: 'acme/widget',
      name: 'widget',
      module: 'acme',
      version: '1.2.3',
      enabled: true,
      local: true,
      user: true,
      types: ['widget', 'ready-node', 'ghost'],
    },
    {
      id: 'acme/config',
      name: 'config',
      module: 'acme',
      version: '1.2.3',
      enabled: true,
      local: true,
      user: true,
      types: ['acme-config'],
    },
  ];
}

test('script blocks are classified: definitions run, templates and help are skipped', () => {
  const extraction = extractRegisteredTypes(FIXTURE_HTML, { source: 'fixture' });
  const types = extraction.registered.map((entry) => entry.type);

  assert.deepEqual(types, ['widget', 'ready-node', 'half-broken', 'acme-config']);
  assert.equal(extraction.blocks, 4, 'the two template blocks and the throwing one are not evaluated twice');
  assert.deepEqual(
    extraction.issues.map((issue) => issue.message),
    ['boom'],
    'a throwing block is reported, not swallowed',
  );
});

test('normalisation turns a registration into palette data', () => {
  const extraction = extractRegisteredTypes(FIXTURE_HTML, { source: 'fixture' });
  const widget = normalizeRegisteredType(extraction.registered[0]!, {
    module: 'acme',
    nodeSet: 'acme/widget',
    version: '1.2.3',
  });

  assert.equal(widget.module, 'acme');
  assert.equal(widget.nodeSet, 'acme/widget');
  assert.equal(widget.version, '1.2.3');
  assert.equal(widget.category, 'acme');
  assert.equal(widget.isConfig, false);
  assert.equal(widget.synthetic, false);
  assert.equal(widget.inputs, 1);
  assert.equal(widget.outputs, 2);
  assert.deepEqual(widget.refs, {
    broker: { kind: 'one', targets: ['mqtt-broker'] },
    tags: { kind: 'many', targets: '*' },
    links: { kind: 'many', targets: ['link out'] },
  });
  assert.deepEqual(Object.keys(widget.credentials), ['token']);

  // Function-valued declarations cannot be reconstructed: they are flagged, not guessed.
  assert.deepEqual(widget.dynamics.defaults, ['computed', 'labelled']);
  assert.equal(widget.defaults['computed']?.dynamic, true);
  assert.equal(widget.defaults['computed']?.value, undefined);
  assert.equal(widget.defaults['labelled']?.dynamic, true);
  assert.equal(widget.defaults['labelled']?.value, 'x', 'the literal part of the declaration survives');
  assert.equal(widget.defaults['broker']?.required, true);
});

test('a registration made before a failure is kept, and document-ready ones are collected', () => {
  const extraction = extractRegisteredTypes(FIXTURE_HTML, { source: 'fixture' });
  assert.deepEqual(
    extraction.registered.map((entry) => entry.type),
    ['widget', 'ready-node', 'half-broken', 'acme-config'],
    'the ready callback runs and a throw does not discard earlier registrations',
  );
});

test('extraction attributes types to node sets and synthesises declared-but-missing ones', () => {
  const result = extractFromMarkedHtml(FIXTURE_HTML, acmeNodeSets());

  assert.deepEqual(
    result.types.map((type) => type.id),
    ['widget', 'ready-node', 'half-broken', 'acme-config', 'ghost'],
  );
  assert.deepEqual(result.extractionIssues.map((issue) => issue.message), ['boom']);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ['undeclared-type', 'acme/widget'],
      ['missing-definition', 'acme/widget'],
    ],
  );

  const ghost = result.types.find((type) => type.id === 'ghost') as PaletteType;
  assert.equal(ghost.synthetic, true);
  assert.equal(ghost.module, 'acme');
  assert.equal(ghost.nodeSet, 'acme/widget');
  assert.equal(ghost.version, '1.2.3');
  assert.deepEqual(Object.keys(ghost.defaults), []);

  const config = result.types.find((type) => type.id === 'acme-config') as PaletteType;
  assert.equal(config.isConfig, true);
  assert.equal(config.nodeSet, 'acme/config');
});

test('a node set present in the HTML but absent from the node list is reported', () => {
  const result = extractFromMarkedHtml(FIXTURE_HTML, [acmeNodeSets()[0] as PaletteNodeSet]);

  assert.deepEqual(
    result.issues.filter((issue) => issue.code === 'unknown-node-set').map((issue) => issue.path),
    ['acme/config'],
  );
  const config = result.types.find((type) => type.id === 'acme-config') as PaletteType;
  assert.equal(config.module, 'acme', 'the module is derived from the node set id');
  assert.equal(config.version, '');
});

test('splitting on module markers keeps unattributed leading content visible', () => {
  const sections = splitHtmlByModuleMarker(`<script>var a = 1;</script><!-- --- [red-module:x/y] --- --><script>b()</script>`);

  assert.deepEqual(
    sections.map((section) => section.nodeSet),
    [null, 'x/y'],
  );
});

test('node set parsing rejects malformed entries without losing the valid ones', () => {
  const parsed = parseNodeSets([
    { id: 'node-red/inject', name: 'inject', types: ['inject'], module: 'node-red', version: '5.0.8', enabled: true, local: false, user: false },
    { name: 'no-id', types: ['x'] },
    'nonsense',
    { id: 'user/thing', types: ['thing', 7] },
  ]);

  assert.deepEqual(
    parsed.nodeSets.map((nodeSet) => nodeSet.id),
    ['node-red/inject', 'user/thing'],
  );
  assert.deepEqual(parsed.nodeSets[1]?.module, 'user', 'the module falls back to the id prefix');
  assert.deepEqual(parsed.nodeSets[1]?.types, ['thing'], 'non-string types are dropped');
  assert.equal(parsed.issues.length, 2);
  assert.ok(parsed.issues.every((issue) => issue.code === 'invalid-node-set'));
});

test('assembleNodeSets keeps declared metadata and synthesises undeclared sets', () => {
  const declared = acmeNodeSets();
  const extracted = extractFromMarkedHtml(FIXTURE_HTML, declared);
  const withExtra = [
    ...extracted.types,
    normalizeRegisteredType(
      { type: 'inline-helper', definition: {}, source: 'overlay' },
      { module: 'flowgen:inline', nodeSet: 'flowgen:inline', version: '9.9.9' },
    ),
  ];

  const nodeSets = assembleNodeSets(withExtra, declared);
  const widget = nodeSets.find((nodeSet) => nodeSet.id === 'acme/widget') as PaletteNodeSet;
  assert.deepEqual(widget.types, ['widget', 'ready-node', 'half-broken', 'ghost']);
  assert.equal(widget.local, true);
  assert.equal(widget.user, true);
  assert.equal(widget.version, '1.2.3');

  const inline = nodeSets.find((nodeSet) => nodeSet.id === 'flowgen:inline') as PaletteNodeSet;
  assert.deepEqual(inline, {
    id: 'flowgen:inline',
    name: 'flowgen:inline',
    module: 'flowgen:inline',
    version: '9.9.9',
    enabled: true,
    local: false,
    user: false,
    types: ['inline-helper'],
  });
});

// --------------------------------------------------------------------------------------
// The real packages, pinned by devDependencies: node-red@5.0.8 and node-red-dashboard@3.6.6
// --------------------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

interface PackageExtraction {
  readonly types: readonly PaletteType[];
  readonly issues: readonly ExtractionIssue[];
}

function extractPackage(dir: string, moduleName: string, include: (relative: string) => boolean): PackageExtraction {
  const types: PaletteType[] = [];
  const issues: ExtractionIssue[] = [];
  for (const file of walk(dir)) {
    const relative = path.relative(dir, file);
    if (!include(relative)) continue;
    const extraction = extractRegisteredTypes(fs.readFileSync(file, 'utf8'), { source: relative });
    issues.push(...extraction.issues);
    const nodeSet = `${moduleName}/${path.basename(file, '.html').replace(/^\d+-/, '')}`;
    for (const registered of extraction.registered) {
      types.push(normalizeRegisteredType(registered, { module: moduleName, nodeSet, version: 'pinned' }));
    }
  }
  return { types, issues };
}

const CORE = extractPackage('node_modules/@node-red/nodes', 'node-red', () => true);
const DASHBOARD = extractPackage('node_modules/node-red-dashboard', 'node-red-dashboard', (relative) =>
  relative.startsWith('nodes/'),
);

function find(types: readonly PaletteType[], id: string): PaletteType {
  const type = types.find((candidate) => candidate.id === id);
  assert.ok(type, `expected ${id} in the extracted palette`);
  return type as PaletteType;
}

test('the pinned core package yields 49 types with no extraction issues', () => {
  assert.equal(CORE.types.length, 49);
  assert.deepEqual(CORE.issues, []);
});

test('the pinned dashboard package yields 21 types with no extraction issues', () => {
  assert.equal(DASHBOARD.types.length, 21);
  assert.deepEqual(DASHBOARD.issues, []);
});

test('core definitions match the editor: defaults order, config nodes, references', () => {
  const inject = find(CORE.types, 'inject');
  assert.deepEqual(Object.keys(inject.defaults), [
    'name',
    'props',
    'repeat',
    'crontab',
    'once',
    'onceDelay',
    'topic',
    'payload',
    'payloadType',
  ]);
  assert.equal(inject.category, 'common');
  assert.equal(inject.color, '#a6bbcf');
  assert.equal(inject.icon, 'inject.svg');
  assert.equal(inject.inputs, 0);
  assert.equal(inject.outputs, 1);
  assert.equal(inject.align, null, 'unspecified fields stay null rather than becoming empty strings');
  assert.equal(inject.defaults['onceDelay']?.value, 0.1);
  assert.equal(inject.dynamics.defaults.length, 0, 'validators are runtime-only and are not "dynamic values"');

  const mqttIn = find(CORE.types, 'mqtt in');
  assert.deepEqual(mqttIn.refs, { broker: { kind: 'one', targets: ['mqtt-broker'] } });

  const linkOut = find(CORE.types, 'link out');
  assert.deepEqual(linkOut.refs, { links: { kind: 'many', targets: ['link in'] } });
  assert.equal(linkOut.outputs, 0);
  assert.equal(linkOut.inputs, 1);

  const broker = find(CORE.types, 'mqtt-broker');
  assert.equal(broker.isConfig, true);
  assert.equal(broker.category, 'config');
  assert.deepEqual(Object.keys(broker.credentials), ['user', 'password']);
  assert.equal(broker.outputs, null, 'config nodes declare no ports');

  const fn = find(CORE.types, 'function');
  assert.deepEqual(fn.dynamics.defaults, ['timeout'], 'function.timeout is computed in the editor');
  assert.equal(fn.defaults['timeout']?.dynamic, true);
  assert.equal(fn.defaults['timeout']?.value, undefined);
});

test('dashboard definitions carry i18n keys as labels and typed config references', () => {
  const gauge = find(DASHBOARD.types, 'ui_gauge');
  assert.deepEqual(gauge.refs, { group: { kind: 'one', targets: ['ui_group'] } });
  assert.equal(gauge.category, 'node-red-dashboard/ui_base:ui_base.label.category');
  assert.equal(gauge.icon, 'ui_gauge.png');
  assert.equal(gauge.inputs, 1);
  assert.equal(gauge.outputs, 0);
  assert.equal(gauge.defaults['min']?.required, true);

  const base = find(DASHBOARD.types, 'ui_base');
  assert.equal(base.isConfig, true);
});

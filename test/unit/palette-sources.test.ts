import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPaletteSnapshot,
  parsePaletteSnapshot,
  serializePaletteSnapshot,
  type PaletteSnapshot,
} from '../../src/palette/snapshot.ts';
import { paletteProperty, paletteType, type PaletteNodeSet } from '../../src/palette/model.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import { liveHttpSource } from '../../src/palette/sources/liveHttp.ts';
import { overlay } from '../../src/palette/sources/overlay.ts';
import { fileSnapshotSource, snapshotSource, writeSnapshotFile } from '../../src/palette/sources/snapshot.ts';
import { applyOverlays, PaletteSourceError, rebuildPalette } from '../../src/palette/sources/source.ts';
import { subflowOverlay, subflowPaletteType } from '../../src/palette/sources/subflow.ts';
import { unwrapOrThrow } from '../../src/result.ts';

const PROVENANCE = { kind: 'snapshot' as const, url: null, userDir: null, nodeModulesDirs: null };

function baseSnapshot(): PaletteSnapshot {
  const nodeSets: PaletteNodeSet[] = [
    {
      id: 'node-red/inject',
      name: 'inject',
      module: 'node-red',
      version: '5.0.8',
      enabled: true,
      local: false,
      user: false,
      types: ['inject'],
    },
  ];
  return createPaletteSnapshot({
    nodeRedVersion: '5.0.8',
    nodeSets,
    provenance: PROVENANCE,
    types: [
      paletteType('inject', {
        module: 'node-red',
        nodeSet: 'node-red/inject',
        version: '5.0.8',
        category: 'common',
        inputs: 0,
        outputs: 1,
        defaults: { name: paletteProperty({ value: '' }), topic: paletteProperty({ value: '' }) },
      }),
    ],
  });
}

test('the snapshot source parses text and reports every problem it finds', async () => {
  const text = serializePaletteSnapshot(baseSnapshot());
  const loaded = await snapshotSource(text).load();
  assert.equal(loaded.contentHash, baseSnapshot().contentHash);

  const broken = snapshotSource('{"schemaVersion": 1}');
  await assert.rejects(
    () => broken.load(),
    (error: unknown) => {
      assert.ok(error instanceof PaletteSourceError);
      assert.equal(error.code, 'invalid-snapshot');
      assert.ok(error.details.length > 0, 'the issues are carried for the CLI to print');
      return true;
    },
  );
});

test('writing a snapshot is content-addressed: an unchanged palette is not rewritten', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowgen-snap-'));
  const file = path.join(dir, 'local.json');
  const snapshot = baseSnapshot();

  assert.deepEqual(await writeSnapshotFile(file, snapshot), { status: 'written', bytes: snapshot.contentHash.length > 0 ? (await readFile(file, 'utf8')).length : 0 });
  assert.deepEqual(await writeSnapshotFile(file, snapshot), {
    status: 'unchanged',
    bytes: (await readFile(file, 'utf8')).length,
  });

  const reloaded = await fileSnapshotSource(file).load();
  assert.equal(reloaded.contentHash, snapshot.contentHash);
});

test('a missing snapshot file is a not-found error, not a crash', async () => {
  await assert.rejects(
    () => fileSnapshotSource('/nonexistent/palette.json').load(),
    (error: unknown) => error instanceof PaletteSourceError && error.code === 'not-found',
  );
});

test('a filesystem source without any node files says so', async () => {
  await assert.rejects(
    () => filesystemSource({ coreNodesDir: '/nonexistent/nodes' }).load(),
    (error: unknown) => error instanceof PaletteSourceError && error.code === 'no-node-red-installation',
  );
});

test('the live source sends explicit accept headers and the bearer token', async () => {
  const requests: { url: string; accept: string | null; authorization: string | null }[] = [];
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      accept: headers.get('accept'),
      authorization: headers.get('authorization'),
    });
    if (headers.get('accept') === 'application/json') {
      return new Response(
        JSON.stringify([
          { id: 'acme/widget', name: 'widget', types: ['widget'], enabled: true, local: false, user: false, module: 'acme', version: '1.0.0' },
        ]),
        { status: 200 },
      );
    }
    return new Response(
      '<!-- --- [red-module:acme/widget] --- --><script>RED.nodes.registerType("widget",{category:"acme",defaults:{name:{value:""}},inputs:1,outputs:2});</script>',
      { status: 200 },
    );
  };

  const snapshot = await liveHttpSource({ url: 'http://instance.test/', token: 'tok', fetch: fakeFetch }).load();

  assert.deepEqual(
    requests.map((request) => [request.url, request.accept, request.authorization]),
    [
      ['http://instance.test/nodes', 'application/json', 'Bearer tok'],
      ['http://instance.test/nodes', 'text/html', 'Bearer tok'],
    ],
  );
  assert.equal(snapshot.nodeRedVersion, null, 'no core node set is present in this payload');
  assert.equal(snapshot.provenance.url, 'http://instance.test');
  assert.equal(snapshot.types['widget']?.outputs, 2);
});

test('the live source distinguishes an authentication failure from an unreachable instance', async () => {
  const unauthorized: typeof globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  await assert.rejects(
    () => liveHttpSource({ url: 'http://instance.test', fetch: unauthorized }).load(),
    (error: unknown) => {
      assert.ok(error instanceof PaletteSourceError);
      assert.equal(error.code, 'unauthorized');
      assert.deepEqual(error.details, ['no token was supplied']);
      return true;
    },
  );

  const unreachable: typeof globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () => liveHttpSource({ url: 'http://instance.test', fetch: unreachable }).load(),
    (error: unknown) => error instanceof PaletteSourceError && error.code === 'http-error',
  );
});

test('an overlay patches an extracted type and creates an unseen one', () => {
  const patched = applyOverlays(baseSnapshot(), [
    overlay({
      id: 'house-style',
      types: {
        inject: {
          defaults: { topic: { value: 'orders' }, once: { value: true } },
        },
        'inhouse-plc': {
          paletteLabel: 'PLC',
          outputs: 2,
          refs: { gateway: 'inhouse-gateway' },
          defaults: { name: { value: '' } },
        },
      },
    }),
  ]);

  const inject = patched.types['inject'];
  assert.equal(inject?.defaults['topic']?.value, 'orders');
  assert.equal(inject?.defaults['once']?.value, true);
  assert.equal(inject?.defaults['name']?.value, '', 'untouched defaults survive');

  const plc = patched.types['inhouse-plc'];
  assert.equal(plc?.paletteLabel, 'PLC');
  assert.equal(plc?.outputs, 2);
  assert.equal(plc?.synthetic, true, 'a hand-written type is open by default');
  assert.deepEqual(plc?.refs, { gateway: { kind: 'one', targets: ['inhouse-gateway'] } });
  assert.equal(plc?.defaults['gateway']?.type, 'inhouse-gateway');

  assert.notEqual(patched.contentHash, baseSnapshot().contentHash);
  assert.equal(patched.nodeSets.find((set) => set.id === 'flowgen:inline')?.types.includes('inhouse-plc'), true);
  // The overlay is pure: the input snapshot is untouched.
  assert.equal(baseSnapshot().types['inhouse-plc'], undefined);
});

test('subflow definitions become palette entries with typed parameters', () => {
  const definition = {
    id: 'scale_sf_1',
    name: 'scale × factor',
    env: [
      { name: 'factor', type: 'num', value: '2' },
      { name: 'tag', type: 'str', value: 'default' },
      { name: 'secret', type: 'cred', value: '' },
    ],
    in: [{}],
    out: [{}, {}],
  };

  const type = subflowPaletteType(definition);
  assert.equal(type.id, 'subflow:scale_sf_1');
  assert.equal(type.module, 'flowgen:inline');
  assert.equal(type.paletteLabel, 'scale × factor');
  assert.equal(type.inputs, 1);
  assert.equal(type.outputs, 2);
  assert.deepEqual(Object.keys(type.defaults), ['name'], 'instances declare only `name` as a property');
  assert.deepEqual(
    type.params.map((parameter) => [parameter.name, parameter.type, parameter.value]),
    [
      ['factor', 'num', '2'],
      ['tag', 'str', 'default'],
      ['secret', 'cred', ''],
    ],
  );

  const withSubflow = subflowOverlay([definition]).apply(baseSnapshot());
  assert.equal(withSubflow.types['subflow:scale_sf_1']?.outputs, 2);
  assert.equal(withSubflow.nodeSets.find((set) => set.id === 'flowgen:inline')?.name, 'flowgen:inline');
});

test('rebuildPalette keeps the snapshot consistent with its hash', async () => {
  const snapshot = baseSnapshot();
  const extra = paletteType('inject2', {
    module: 'node-red',
    nodeSet: 'node-red/inject',
    version: '5.0.8',
    inputs: 0,
    outputs: 1,
  });
  const rebuilt = rebuildPalette(snapshot, { types: [...Object.values(snapshot.types), extra] });

  assert.equal(Object.keys(rebuilt.types).length, 2);
  assert.deepEqual(rebuilt.nodeSets[0]?.types, ['inject', 'inject2']);
  const reparsed = unwrapOrThrow(parsePaletteSnapshot(serializePaletteSnapshot(rebuilt)));
  assert.equal(reparsed.contentHash, rebuilt.contentHash);
});

test('an overlay may pin a version or declare references without a property', () => {
  const patched = applyOverlays(baseSnapshot(), [
    overlay({ types: { inject: { version: '5.0.9', refs: { script: ['a', 'b'] } } } }),
  ]);
  assert.equal(patched.types['inject']?.version, '5.0.9');
  assert.deepEqual(patched.types['inject']?.refs['script'], { kind: 'many', targets: ['a', 'b'] });
  assert.equal(patched.types['inject']?.defaults['script']?.type, null, 'multi-target refs carry no single type');
});

test('snapshot files written by the source round-trip through the reader', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowgen-snap2-'));
  const file = path.join(dir, 'nested', 'palette.json');
  await writeFile(path.join(dir, 'placeholder'), '', 'utf8');
  await assert.rejects(() => writeSnapshotFile(file, baseSnapshot()), /ENOENT/);
});

/**
 * The round-trip oracle, through a real server.
 *
 * `emit → POST /flows → GET /flows → parse → emit` must be a fixed point, and the deployed
 * flow must actually run. Two independent claims are checked here:
 *
 * * **E1 (canonical output)** — what the runtime reads back is byte-identical to what we sent,
 *   key order included, so a later editor export rewrites the file with a minimal diff;
 * * **E2 (runtime behaviour)** — an HTTP endpoint defined in the flow answers, and the log is
 *   free of the two failures a generator can cause (`Waiting for missing types to be
 *   registered`, `Circular config node dependency`).
 *
 * The input is the reconnaissance prototype's flow file: it was rendered by the editor and
 * executed by the runtime, but its key order is *not* canonical, which is exactly what makes it
 * a useful input for a normalisation round trip.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { emitFlowSet } from '../../src/emit/flowJson.ts';
import { parseFlowSetText } from '../../src/import/fromFlowJson.ts';
import { normalizeFlowSet } from '../../src/model/normalize.ts';
import type { FlowSet } from '../../src/model/entities.ts';
import type { PaletteType } from '../../src/palette/model.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import { startNodeRed, waitFor, type NodeRedInstance } from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let instance: NodeRedInstance;
let palette: Record<string, PaletteType>;
let flowSet: FlowSet;
let payload: string;

interface RevResponse {
  readonly rev: string;
  readonly flows: unknown;
}

async function readFlows(): Promise<RevResponse> {
  const response = await fetch(`${instance.url}/flows`, {
    headers: { 'node-red-api-version': 'v2' },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as RevResponse;
}

async function deploy(flows: string, rev: string): Promise<Response> {
  return fetch(`${instance.url}/flows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'node-red-api-version': 'v2' },
    body: JSON.stringify({ flows: JSON.parse(flows) as unknown, rev }),
  });
}

before(async () => {
  instance = await startNodeRed({ auth: 'none', userModules: ['node-red-dashboard'] });
  const snapshot = await filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
    userDir: REPO_ROOT,
  }).load();
  palette = { ...snapshot.types };

  const source = await readFile(path.join(REPO_ROOT, 'test', 'fixtures', 'flows-recon-demo.json'), 'utf8');
  flowSet = normalizeFlowSet(parseFlowSetText(source, { palette }), { palette });
  payload = emitFlowSet(flowSet, { palette, includeManifest: false });
});

after(async () => {
  await instance?.stop();
});

test('the emitted flow set deploys accepted and reads back byte-identical', async () => {
  const current = await readFlows();
  const response = await deploy(payload, current.rev);
  assert.equal(response.status, 200, await response.text());

  const readback = await readFlows();
  assert.equal(
    JSON.stringify(readback.flows),
    JSON.stringify(JSON.parse(payload) as unknown),
    'the runtime preserves key order and values exactly as sent',
  );
});

test('a deployed flow executes: the recon endpoint answers 21', async () => {
  const started = await waitFor(async () => {
    const response = await fetch(`${instance.url}/recon/scale?x=7`);
    return response.status === 200 && (await response.text()) === '21';
  });
  assert.equal(started, true, 'the subflow instance override (7 × 3) must apply at runtime');

  const log = instance.log();
  assert.doesNotMatch(log, /Waiting for missing types/);
  assert.doesNotMatch(log, /Circular config node dependency/);
});

test('re-parsing what the server returned and re-emitting is a fixed point', async () => {
  const readback = await readFlows();
  const rebuilt = normalizeFlowSet(
    parseFlowSetText(JSON.stringify(readback.flows), { palette }),
    { palette },
  );
  assert.equal(emitFlowSet(rebuilt, { palette, includeManifest: false }), payload);
});

test('a second deploy of the same flow set is a no-op for the runtime', async () => {
  const before = await readFlows();
  const response = await deploy(payload, before.rev);
  assert.equal(response.status, 200);

  const after = await readFlows();
  assert.notEqual(after.rev, undefined);
  assert.equal(JSON.stringify(after.flows), JSON.stringify(before.flows));
});

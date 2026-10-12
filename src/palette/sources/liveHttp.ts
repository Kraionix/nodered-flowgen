/**
 * Live palette source: reads the deployed truth from a running Node-RED instance.
 *
 * Two requests, both against `/nodes`:
 *
 * * `Accept: application/json` → the node sets (`{id, name, types, enabled, local, user,
 *   module, version}`), which is where module attribution and versions come from;
 * * `Accept: text/html` → the concatenated editor bundles, prefixed with
 *   `<!-- --- [red-module:<setId>] --- -->` markers, which is where the definitions
 *   (defaults, credentials, ports, references) come from.
 *
 * A plain HTTP client sends the wildcard accept header, which Node-RED answers with HTML —
 * hence the explicit headers here, and hence the recon's "one request yields the deployed
 * palette" claim being off by one request.
 */

import type { PaletteProvenance } from '../model.ts';
import { createPaletteSnapshot, type PaletteSnapshot } from '../snapshot.ts';
import { extractFromMarkedHtml, parseNodeSets } from '../extract/attribute.ts';

import { PaletteSourceError, type PaletteSource } from './source.ts';

export interface LiveHttpSourceOptions {
  /** Base URL of the instance, e.g. `http://127.0.0.1:1890` (with or without a path prefix). */
  readonly url: string;
  /** Admin API bearer token; required when the instance has `adminAuth` enabled. */
  readonly token?: string;
  readonly timeoutMs?: number;
  /** Injection point for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly id?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function liveHttpSource(options: LiveHttpSourceOptions): PaletteSource {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof doFetch !== 'function') {
    throw new PaletteSourceError('invalid-response', 'no fetch implementation available (Node >= 18 required)');
  }

  return {
    id: options.id ?? `live:${base}`,
    async load(): Promise<PaletteSnapshot> {
      const [nodeListJson, html] = await Promise.all([
        request(`${base}/nodes`, 'application/json'),
        request(`${base}/nodes`, 'text/html'),
      ]);

      return snapshotFromNodeList(nodeListJson, html, {
        kind: 'live',
        url: base,
        userDir: null,
        nodeModulesDirs: null,
      });
    },
  };

  async function request(path: string, accept: string): Promise<string> {
    const headers: Record<string, string> = { accept };
    if (options.token !== undefined && options.token !== '') {
      headers['authorization'] = `Bearer ${options.token}`;
    }

    let response: Response;
    try {
      response = await doFetch(path, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (cause) {
      throw new PaletteSourceError('http-error', `cannot reach ${path}`, {
        details: [cause instanceof Error ? cause.message : String(cause)],
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new PaletteSourceError('unauthorized', `${path} refused the request (${response.status})`, {
        status: response.status,
        details: options.token === undefined ? ['no token was supplied'] : ['the supplied token was rejected'],
      });
    }
    if (!response.ok) {
      throw new PaletteSourceError('http-error', `${path} answered ${response.status}`, { status: response.status });
    }
    return response.text();
  }
}

/**
 * Assembles a snapshot from the two `GET /nodes` representations.
 *
 * Split out from the source on purpose: the committed palette fixtures in
 * `test/fixtures/palettes/` are exactly this pair of payloads, so the extraction the tests
 * verify offline is the same code path a live pull runs — not a re-implementation of it.
 */
export function snapshotFromNodeList(
  nodeListJson: string,
  html: string,
  provenance: PaletteProvenance,
  label = 'GET /nodes',
): PaletteSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nodeListJson);
  } catch (cause) {
    throw new PaletteSourceError('invalid-response', `${label} did not return JSON`, {
      details: [cause instanceof Error ? cause.message : String(cause)],
    });
  }

  const { nodeSets, issues } = parseNodeSets(parsed);
  if (nodeSets.length === 0) {
    throw new PaletteSourceError('invalid-response', `${label} reported no node sets`, {
      details: issues.map((issue) => `${issue.path}: ${issue.message}`),
    });
  }

  const extraction = extractFromMarkedHtml(html, nodeSets);
  if (extraction.types.length === 0) {
    throw new PaletteSourceError(
      'invalid-response',
      `${label} returned no editor definitions; is this a Node-RED editor endpoint?`,
    );
  }

  return createPaletteSnapshot({
    nodeRedVersion: coreVersion(nodeSets.map((nodeSet) => ({ module: nodeSet.module, version: nodeSet.version }))),
    nodeSets,
    types: extraction.types,
    provenance,
  });
}

/**
 * The Node-RED version is the version of the core module. `GET /nodes` does not report a
 * separate instance version, and every core node set carries the same one.
 */
function coreVersion(nodeSets: readonly { module: string; version: string }[]): string | null {
  const core = nodeSets.find((nodeSet) => nodeSet.module === 'node-red');
  return core?.version ?? null;
}

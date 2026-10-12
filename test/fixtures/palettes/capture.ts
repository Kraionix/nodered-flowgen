/**
 * Palette fixture capture — the only way `test/fixtures/palettes/` is allowed to change.
 *
 * A fixture is the *raw* pair of `GET /nodes` responses (JSON and HTML) plus the content hash the
 * extractor derives from them. Committing the raw bytes rather than the resulting snapshot is the
 * point: the extractor is the most fragile part of the palette layer, and a fixture that stored
 * only its output could not catch a regression in parsing — it would just be compared with
 * itself. With the bytes committed, `test/unit/palette-fixtures.test.ts` re-runs the real
 * assembly offline and compares hashes.
 *
 * Capture is deterministic: the JSON is written exactly as the instance sent it, the HTML is
 * written exactly as it was received, and the manifest is sorted. Capturing the same instance
 * twice must therefore produce byte-identical files — if it does not, the fixture directory is
 * stale and `git diff` says so.
 *
 * ```sh
 * node test/fixtures/palettes/capture.ts --url http://127.0.0.1:1880 --name core-5.0.8
 * node test/fixtures/palettes/capture.ts --url http://127.0.0.1:1890 --name core-5.0.7 --token-env NR_TOKEN \
 *   --core-only --label 'developer instance, Node-RED 5.0.7'
 * ```
 *
 * `--core-only` keeps the node sets whose module is `node-red` and drops the sections of the
 * editor bundle that belong to other modules. User-installed modules make a capture an order of
 * magnitude larger and say nothing about the extractor, so the committed fixtures are core-only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseNodeSets, splitHtmlByModuleMarker } from '../../../src/palette/extract/attribute.ts';
import { snapshotFromNodeList } from '../../../src/palette/sources/liveHttp.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, 'manifest.json');

interface ManifestEntry {
  readonly name: string;
  readonly nodeRedVersion: string | null;
  readonly contentHash: string;
  readonly typeCount: number;
  readonly nodeSetCount: number;
  readonly coreOnly: boolean;
  readonly capturedFrom: string;
  readonly note: string;
}

interface Manifest {
  readonly fixtures: readonly ManifestEntry[];
}

interface Options {
  readonly url: string;
  readonly name: string;
  readonly token: string | undefined;
  readonly coreOnly: boolean;
  readonly note: string;
  /** Stable description of where the bytes came from; defaults to the URL. */
  readonly label: string;
}

export async function capture(options: Options): Promise<ManifestEntry> {
  const json = await request(`${options.url}/nodes`, 'application/json', options.token);
  const html = await request(`${options.url}/nodes`, 'text/html', options.token);

  const trimmed = options.coreOnly ? coreOnly(json, html) : { json, html };
  const snapshot = snapshotFromNodeList(trimmed.json, trimmed.html, {
    kind: 'live',
    url: options.url,
    userDir: null,
    nodeModulesDirs: null,
  });

  await mkdir(HERE, { recursive: true });
  await writeFile(path.join(HERE, `${options.name}.nodes.json`), trimmed.json, 'utf8');
  await writeFile(path.join(HERE, `${options.name}.nodes.html`), trimmed.html, 'utf8');

  const entry: ManifestEntry = {
    name: options.name,
    nodeRedVersion: snapshot.nodeRedVersion,
    contentHash: snapshot.contentHash,
    typeCount: Object.keys(snapshot.types).length,
    nodeSetCount: snapshot.nodeSets.length,
    coreOnly: options.coreOnly,
    capturedFrom: options.label,
    note: options.note,
  };

  await writeManifest(entry);
  return entry;
}

/**
 * Re-renders a module marker. Must stay in step with `MODULE_MARKER` in
 * `src/palette/extract/attribute.ts`: sections are returned *without* their marker, so a trim
 * that simply joined the bodies would silently strip every attribution and leave the extractor
 * with nothing but synthesised stubs.
 */
function marker(nodeSet: string): string {
  return `<!-- --- [red-module:${nodeSet}] --- -->\n`;
}

/** Keeps the `node-red` module's node sets and the HTML sections that belong to them. */
function coreOnly(json: string, html: string): { json: string; html: string } {
  const parsed = JSON.parse(json) as unknown;
  const { nodeSets } = parseNodeSets(parsed);
  const core = nodeSets.filter((nodeSet) => nodeSet.module === 'node-red');
  if (core.length === 0) throw new Error('the instance reported no core node sets');

  const kept = new Set(core.map((nodeSet) => nodeSet.id));
  const sections = splitHtmlByModuleMarker(html).filter((section) => section.nodeSet === null || kept.has(section.nodeSet));
  const trimmedHtml = sections.map((section) => `${section.nodeSet === null ? '' : marker(section.nodeSet)}${section.html}`).join('');

  // Self-check: the trimmed bundle must still be attributable section by section.
  const rebuilt = splitHtmlByModuleMarker(trimmedHtml);
  const lost = rebuilt.filter((section) => section.nodeSet !== null && !kept.has(section.nodeSet));
  if (lost.length > 0 || rebuilt.length !== sections.length) {
    throw new Error(`trimming lost the module markers (${sections.length} sections in, ${rebuilt.length} out)`);
  }

  // The JSON is re-serialised because it has to agree with the trimmed HTML: the node list is
  // what the extractor attributes every definition to.
  const nodeList = parsed as readonly { id?: unknown }[];
  const filtered = Array.isArray(nodeList) ? nodeList.filter((entry) => typeof entry.id === 'string' && kept.has(entry.id)) : [];
  return { json: `${JSON.stringify(filtered, null, 2)}\n`, html: trimmedHtml };
}

async function writeManifest(entry: ManifestEntry): Promise<void> {
  let manifest: Manifest = { fixtures: [] };
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  } catch {
    manifest = { fixtures: [] };
  }

  const fixtures = [...manifest.fixtures.filter((candidate) => candidate.name !== entry.name), entry].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  await writeFile(MANIFEST, `${JSON.stringify({ fixtures }, null, 2)}\n`, 'utf8');
}

async function request(url: string, accept: string, token: string | undefined): Promise<string> {
  const headers: Record<string, string> = { accept };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

function parseArgv(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }

  const url = values.get('url');
  const name = values.get('name');
  if (url === undefined || name === undefined) {
    throw new Error('usage: capture.ts --url <url> --name <fixture> [--token <t>|--token-env <VAR>] [--core-only] [--note <text>]');
  }

  const tokenEnv = values.get('token-env');
  const token = values.get('token') ?? (tokenEnv === undefined ? undefined : process.env[tokenEnv]);
  if (tokenEnv !== undefined && token === undefined) throw new Error(`environment variable ${tokenEnv} is empty or unset`);

  return {
    url: url.replace(/\/+$/, ''),
    name,
    token,
    coreOnly: flags.has('core-only'),
    note: values.get('note') ?? '',
    // A disposable instance listens on a random port, so the URL is not a stable description:
    // `--label` records what the fixture actually is, which is what a reviewer needs.
    label: values.get('label') ?? url,
  };
}

// Only run when invoked directly: the tests import `capture` for the offline paths.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const entry = await capture(parseArgv(process.argv.slice(2)));
    process.stdout.write(
      `captured ${entry.name}: ${entry.typeCount} types from ${entry.nodeSetCount} node sets, Node-RED ${entry.nodeRedVersion ?? 'unknown'}, ${entry.contentHash}\n`,
    );
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}

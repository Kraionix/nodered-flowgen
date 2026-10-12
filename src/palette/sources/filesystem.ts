/**
 * Filesystem palette source: reads a Node-RED installation without starting it.
 *
 * The discovery rules are Node-RED's own (`@node-red/registry/lib/localfilesystem.js`), which
 * is what makes this source agree with `liveHttpSource` on the same installation:
 *
 * * core nodes live in `settings.coreNodesDir` (`<install>/node_modules/@node-red/nodes`),
 *   are attributed to the module **`node-red`**, and their node set name is the JS file name
 *   without its ordering prefix (`core/common/20-inject.js` → `node-red/inject`);
 * * a JS file counts only if a sibling `.html` exists — that is why `05-junction.html` exists
 *   as an empty file, and why `junction` must be synthesised rather than extracted;
 * * user modules come from `<userDir>/node_modules`, are named by the package, and their node
 *   set names come from the `node-red.nodes` map in the package's `package.json`
 *   (`{"ui_gauge": "nodes/ui_gauge.js"}` → `node-red-dashboard/ui_gauge`);
 * * `nodesDir` entries behave like core files but are skipped when they are a valid
 *   Node-RED module themselves.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { createPaletteSnapshot, type PaletteSnapshot } from '../snapshot.ts';
import type { PaletteNodeSet, PaletteType } from '../model.ts';
import { extractRegisteredTypes } from '../extract/registerType.ts';
import { normalizeRegisteredType, synthesizeType } from '../extract/normalize.ts';

import { PaletteSourceError, type PaletteSource } from './source.ts';

export interface FilesystemSourceOptions {
  /** `<install>/node_modules/@node-red/nodes`. */
  readonly coreNodesDir?: string;
  /** Node-RED user directory; `<userDir>/node_modules` is scanned for installed modules. */
  readonly userDir?: string;
  /** Extra directories scanned the way Node-RED's `nodesDir` setting is. */
  readonly nodesDirs?: readonly string[];
  /** Overrides the reported Node-RED version (default: the core nodes package version). */
  readonly nodeRedVersion?: string;
  readonly id?: string;
}

interface NodeFileRecord {
  readonly htmlPath: string;
  readonly nodeSet: string;
  readonly name: string;
  readonly module: string;
  readonly version: string;
  readonly local: boolean;
  readonly user: boolean;
}

const JAVASCRIPT_FILE = /\.[cm]?js$/;
const ORDERING_PREFIX = /^\d+-/;

export function filesystemSource(options: FilesystemSourceOptions): PaletteSource {
  return {
    id: options.id ?? `filesystem:${options.coreNodesDir ?? options.userDir ?? options.nodesDirs?.join(',') ?? '(none)'}`,
    async load(): Promise<PaletteSnapshot> {
      const nodeRedVersion: string | null = await readNodeRedVersion(options.coreNodesDir, options.nodeRedVersion);
      const records: NodeFileRecord[] = [];

      if (options.coreNodesDir !== undefined) {
        records.push(...(await scanFlatDirectory(options.coreNodesDir, nodeRedVersion, { local: false, user: false })));
      }
      for (const dir of options.nodesDirs ?? []) {
        records.push(...(await scanFlatDirectory(dir, nodeRedVersion, { local: false, user: false })));
      }
      if (options.userDir !== undefined) {
        records.push(
          ...(await scanModuleDirectory(
            path.join(options.userDir, 'node_modules'),
            await userInstalledPackages(options.userDir),
          )),
        );
      }
      if (options.coreNodesDir !== undefined) {
        // The installation's own modules are discovered by walking up from the core nodes
        // directory, exactly like Node-RED does; these are neither `local` nor `user`.
        records.push(...(await scanInstallationTree(options.coreNodesDir)));
      }

      if (records.length === 0) {
        throw new PaletteSourceError(
          'no-node-red-installation',
          'no node files found; check coreNodesDir / userDir / nodesDirs',
        );
      }

      const types: PaletteType[] = [];
      const declaredSets: PaletteNodeSet[] = [];
      const seen = new Set<string>();

      // A module can be reached twice (user directory and installation tree). Node-RED keys
      // modules by name and the last scan wins, which is what the later flags reflect.
      for (const record of dedupeByNodeSet(records)) {
        const html = await readIfPresent(record.htmlPath);
        const context = { module: record.module, nodeSet: record.nodeSet, version: record.version };
        const registered = html === null ? [] : extractRegisteredTypes(html, { source: record.htmlPath }).registered;

        const setTypes: string[] = [];
        for (const entry of registered) {
          if (seen.has(entry.type)) continue;
          seen.add(entry.type);
          setTypes.push(entry.type);
          types.push(normalizeRegisteredType(entry, context));
        }
        if (setTypes.length === 0 && !seen.has(record.name)) {
          // The runtime registers this type from JavaScript without any editor definition.
          seen.add(record.name);
          setTypes.push(record.name);
          types.push(synthesizeType(record.name, context));
        }

        declaredSets.push({
          id: record.nodeSet,
          name: record.name,
          module: record.module,
          version: record.version,
          enabled: true,
          local: record.local,
          user: record.user,
          types: setTypes,
        });
      }

      return createPaletteSnapshot({
        nodeRedVersion,
        nodeSets: declaredSets,
        types,
        provenance: {
          kind: 'filesystem',
          url: null,
          userDir: options.userDir ?? null,
          nodeModulesDirs: options.nodesDirs === undefined ? null : [...options.nodesDirs],
        },
      });
    },
  };
}

/**
 * Core-style scan: every `.js` file with a sibling `.html`, sorted by name like Node-RED does.
 * Directories are walked because core nodes are grouped by category (`core/common`, …).
 */
async function scanFlatDirectory(
  dir: string,
  version: string | null,
  flags: { local: boolean; user: boolean },
): Promise<readonly NodeFileRecord[]> {
  const records: NodeFileRecord[] = [];
  for (const file of await walk(dir)) {
    if (!JAVASCRIPT_FILE.test(file)) continue;
    const htmlPath = file.replace(JAVASCRIPT_FILE, '.html');
    if (!(await isFile(htmlPath))) continue;
    const name = path.basename(file).replace(ORDERING_PREFIX, '').replace(JAVASCRIPT_FILE, '');
    records.push({ htmlPath, nodeSet: `node-red/${name}`, name, module: 'node-red', version: version ?? '', ...flags });
  }
  return records.sort((a, b) => (a.nodeSet < b.nodeSet ? -1 : a.nodeSet > b.nodeSet ? 1 : 0));
}

/**
 * `<userDir>/node_modules` scan: one record per entry of a package's `node-red.nodes` map.
 *
 * `userInstalled` mirrors Node-RED's own distinction (`localfilesystem.js`): everything found
 * under `<userDir>/node_modules` is *local*, but only packages listed in the user directory's
 * `package.json` dependencies count as *user* installed.
 */
async function scanModuleDirectory(
  dir: string,
  userInstalled: ReadonlySet<string>,
): Promise<readonly NodeFileRecord[]> {
  const records: NodeFileRecord[] = [];
  for (const packageDir of await packageDirectories(dir)) {
    const manifest = await readJson(path.join(packageDir, 'package.json'));
    if (manifest === null) continue;
    const name = typeof manifest['name'] === 'string' ? manifest['name'] : null;
    const nodes = manifest['node-red'];
    if (name === null || nodes === null || typeof nodes !== 'object') continue;

    const map = (nodes as Record<string, unknown>)['nodes'];
    if (map === null || typeof map !== 'object') continue;

    const version = typeof manifest['version'] === 'string' ? manifest['version'] : '';
    for (const [key, entry] of Object.entries(map as Record<string, unknown>)) {
      if (typeof entry !== 'string') continue;
      const setPart = key.includes(':') ? (key.split(':')[1] as string) : key;
      records.push({
        htmlPath: path.join(packageDir, entry.replace(JAVASCRIPT_FILE, '.html')),
        nodeSet: `${name}/${setPart}`,
        name: setPart,
        module: name,
        version,
        local: true,
        user: userInstalled.has(name),
      });
    }
  }
  return records.sort((a, b) => (a.nodeSet < b.nodeSet ? -1 : a.nodeSet > b.nodeSet ? 1 : 0));
}

/**
 * Modules installed alongside Node-RED: walk up from the core nodes directory scanning every
 * `node_modules` on the way (`@node-red/registry/lib/localfilesystem.js`).
 */
async function scanInstallationTree(coreNodesDir: string): Promise<readonly NodeFileRecord[]> {
  const records: NodeFileRecord[] = [];
  let dir = path.resolve(coreNodesDir, '..');
  for (;;) {
    records.push(...(await scanModuleDirectory(path.join(dir, 'node_modules'), new Set())));
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return records;
}

function dedupeByNodeSet(records: readonly NodeFileRecord[]): readonly NodeFileRecord[] {
  const byId = new Map<string, NodeFileRecord>();
  for (const record of records) byId.set(record.nodeSet, record);
  return [...byId.values()];
}

/** Package directories in a `node_modules` folder, including `@scope/name` entries. */
async function packageDirectories(dir: string): Promise<readonly string[]> {
  const entries: string[] = [];
  for (const entry of await readDirSafe(dir)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (entry.startsWith('@')) {
      for (const scoped of await readDirSafe(full)) {
        if (!scoped.startsWith('.')) entries.push(path.join(full, scoped));
      }
      continue;
    }
    if (await isDirectory(full)) entries.push(full);
  }
  return entries.sort();
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry);
    if (await isDirectory(full)) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function readDirSafe(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir);
    return entries.sort();
  } catch {
    return [];
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const text = await readIfPresent(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function userInstalledPackages(userDir: string): Promise<ReadonlySet<string>> {
  const manifest = await readJson(path.join(userDir, 'package.json'));
  const dependencies = manifest?.['dependencies'];
  if (dependencies === null || dependencies === undefined || typeof dependencies !== 'object') return new Set();
  return new Set(Object.keys(dependencies as Record<string, unknown>));
}

/**
 * Reproduces Node-RED's own version derivation (`@node-red/runtime/lib/index.js:getVersion`),
 * so a filesystem palette and a live palette taken from the same installation carry the same
 * version string: the version comes from `@node-red/runtime/package.json` (falling back to the
 * core nodes package), and Node-RED appends `-git` when the installation root is a git
 * checkout. Without this, a development checkout reports `5.0.8-git` live but `5.0.8` on disk,
 * and the two snapshots — which are otherwise identical — would never compare equal.
 */
async function readNodeRedVersion(
  coreNodesDir: string | undefined,
  override: string | undefined,
): Promise<string | null> {
  if (override !== undefined) return override;
  if (coreNodesDir === undefined) return null;

  const installRoot = path.resolve(coreNodesDir, '..', '..', '..');
  const runtimeManifest = await readJson(path.resolve(coreNodesDir, '..', 'runtime', 'package.json'));
  const coreManifest = await readJson(path.join(coreNodesDir, 'package.json'));
  const version = runtimeManifest?.['version'] ?? coreManifest?.['version'];
  if (typeof version !== 'string') return null;
  return (await isDirectory(path.join(installRoot, '.git'))) ? `${version}-git` : version;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

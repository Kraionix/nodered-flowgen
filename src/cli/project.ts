/**
 * Project discovery: the config file, the lockfile, and the paths derived from them.
 *
 * The config is imported, not parsed. Node strips the types, so `flowgen.config.ts` is ordinary
 * user code that gets the compiler's help — and the CLI's job is only to find it, check that it
 * exports something usable, and resolve every relative path against the project root (never
 * against the shell's current directory, or a `cd` would silently change what gets deployed).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_CONFIG_FILE,
  resolveConfig,
  type FlowgenConfig,
  type ResolvedConfig,
} from '../config/index.ts';
import { emptyLockfile, parseLockfile, serializeLockfile, type Lockfile } from '../io/lockfile.ts';
import type { FlowSetDefinition } from '../authoring/defineFlowSet.ts';

import { flag, text, type ParsedArgs } from './args.ts';
import { CliFailure, EXIT, UsageError } from './exit.ts';
import type { CliContext } from './context.ts';

const CONFIG_CANDIDATES = [DEFAULT_CONFIG_FILE, 'flowgen.config.mts', 'flowgen.config.js', 'flowgen.config.mjs'];

export interface Project {
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly configFile: string;
  readonly lockfilePath: string;
  readonly lockfile: Lockfile;
  readonly receiptsDir: string;
}

export async function loadProject(context: CliContext, args: ParsedArgs): Promise<Project> {
  const root = path.resolve(context.cwd, text(args, 'cwd') ?? '.');
  const requested = text(args, 'config');
  const configFile = requested === undefined ? await findConfigFile(root) : path.resolve(root, requested);

  if (configFile === null) {
    throw new UsageError(
      `no ${DEFAULT_CONFIG_FILE} found in ${root} or any parent directory`,
      'run `flowgen init` to scaffold one, or pass --config <file>',
    );
  }

  const config = await importConfig(configFile, root);
  const lockfilePath = path.resolve(root, config.lockfile);
  const lockfile = await readLockfile(lockfilePath);

  return {
    root,
    config,
    configFile,
    lockfilePath,
    lockfile,
    receiptsDir: path.resolve(root, config.receipts),
  };
}

/** Walks up from `start`, so `flowgen validate` works from a subdirectory of the project. */
export async function findConfigFile(start: string): Promise<string | null> {
  let directory = path.resolve(start);
  for (;;) {
    for (const candidate of CONFIG_CANDIDATES) {
      const file = path.join(directory, candidate);
      if (await isFile(file)) return file;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function importConfig(file: string, root: string): Promise<ResolvedConfig> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new CliFailure(
      EXIT.usage,
      `cannot import ${path.relative(root, file) || file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'the config is ordinary TypeScript; run it directly to see the full stack',
    );
  }

  const exported = (module as { default?: unknown }).default;
  if (exported === undefined || exported === null) {
    throw new UsageError(`${path.relative(root, file)} has no default export`, 'export defineConfig({...}) or defineFlowSet(...)');
  }

  // A bare flow-set definition is the minimal config; everything else takes a default.
  if (isFlowSetDefinition(exported)) {
    return resolveConfig({ flowSet: exported }, file);
  }

  if (typeof exported === 'object' && isFlowSetDefinition((exported as FlowgenConfig).flowSet)) {
    return resolveConfig(exported as FlowgenConfig, file);
  }

  throw new UsageError(
    `${path.relative(root, file)} does not export a flow set`,
    'the default export must be defineConfig({ flowSet: defineFlowSet(...) }) or defineFlowSet(...)',
  );
}

function isFlowSetDefinition(value: unknown): value is FlowSetDefinition {
  return typeof value === 'object' && value !== null && typeof (value as { build?: unknown }).build === 'function';
}

export async function readLockfile(file: string): Promise<Lockfile> {
  let text_: string;
  try {
    text_ = await readFile(file, 'utf8');
  } catch {
    return emptyLockfile();
  }

  const parsed = parseLockfile(text_);
  if (parsed.ok) return parsed.value;

  const issues = parsed.errors.map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`).join('; ');
  throw new CliFailure(EXIT.usage, `${path.basename(file)} is not usable: ${issues}`, 'delete it to start from an empty ownership record');
}

export async function writeLockfile(file: string, lockfile: Lockfile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeLockfile(lockfile), 'utf8');
}

/** True when the flag is set, or the config enables it for this target. */
export function pruneRequested(args: ParsedArgs, targetPrune: boolean | undefined): boolean {
  if (flag(args, 'no-prune')) return false;
  if (flag(args, 'prune')) return true;
  return targetPrune === true;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function displayPath(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative === '' ? '.' : relative;
}

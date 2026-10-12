/**
 * Where the palette comes from, and the one place that decides it.
 *
 * A palette can be read from a committed snapshot, from a live instance, or from an installation
 * on disk. All three produce the same content hash for the same Node-RED, so the choice is about
 * the environment, not about semantics — and it is decided here, once, instead of in each
 * command. Precedence is explicit, most specific first:
 *
 * 1. `--palette <file>` — a reviewer running against a vendored snapshot;
 * 2. `--url` / the profile's `url` — the deployed truth (needs a token when `adminAuth` is on);
 * 3. the profile's `coreNodesDir` / `userDir` — an installation on disk, no server involved;
 * 4. the profile's snapshot file — the committed default.
 *
 * `--offline` removes steps 2 and 3 from consideration, which is what generated types are
 * regenerated with in CI on a machine that has no Node-RED at all.
 */

import path from 'node:path';

import { resolveProfile, type ResolvedProfile } from '../config/index.ts';
import { PaletteSourceError, type PaletteSource } from '../palette/sources/source.ts';
import { filesystemSource } from '../palette/sources/filesystem.ts';
import { liveHttpSource } from '../palette/sources/liveHttp.ts';
import { fileSnapshotSource } from '../palette/sources/snapshot.ts';
import type { PaletteSnapshot } from '../palette/snapshot.ts';

import { envToken, type CliContext } from './context.ts';
import { CliFailure, EXIT, UsageError } from './exit.ts';
import type { Project } from './project.ts';

export type PaletteOrigin = 'live' | 'snapshot' | 'filesystem';

export interface PaletteRequest {
  readonly profile?: string | undefined;
  readonly paletteFile?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly tokenEnv?: string | undefined;
  readonly offline?: boolean | undefined;
}

export interface PalettePlan {
  readonly profile: ResolvedProfile;
  readonly origin: PaletteOrigin;
  readonly source: PaletteSource;
  /** Absolute path of the snapshot file this profile owns, whether or not it exists yet. */
  readonly snapshotFile: string;
  readonly url: string | null;
  readonly token: string | undefined;
}

export interface LoadedPalette extends PalettePlan {
  readonly snapshot: PaletteSnapshot;
}

/** Decides where the palette comes from. Does not read anything except the environment. */
export function planPalette(context: CliContext, project: Project, request: PaletteRequest): PalettePlan {
  const profile = resolveProfile(project.config, request.profile ?? project.config.defaultProfile);
  const snapshotFile = path.resolve(project.root, request.paletteFile ?? profile.snapshotPath);
  const offline = request.offline === true;

  if (request.paletteFile !== undefined) {
    return { profile, origin: 'snapshot', source: fileSnapshotSource(snapshotFile), snapshotFile, url: null, token: undefined };
  }

  const url = request.url ?? profile.url ?? null;
  if (url !== null && !offline) {
    // The token is resolved only here: a project whose profile names a `tokenEnv` must still
    // `validate` and `types gen` offline, where no token is needed.
    const token = resolveToken(context, request, profile);
    return {
      profile,
      origin: 'live',
      source: liveHttpSource({ url, ...(token === undefined ? {} : { token }), ...context.fetchOption }),
      snapshotFile,
      url,
      token,
    };
  }

  if (!offline && (profile.coreNodesDir !== undefined || profile.userDir !== undefined || profile.nodeModulesDirs !== undefined)) {
    return {
      profile,
      origin: 'filesystem',
      source: filesystemSource({
        ...(profile.coreNodesDir === undefined ? {} : { coreNodesDir: path.resolve(project.root, profile.coreNodesDir) }),
        ...(profile.userDir === undefined ? {} : { userDir: path.resolve(project.root, profile.userDir) }),
        ...(profile.nodeModulesDirs === undefined
          ? {}
          : { nodesDirs: profile.nodeModulesDirs.map((entry) => path.resolve(project.root, entry)) }),
      }),
      snapshotFile,
      url: null,
      token: undefined,
    };
  }

  return { profile, origin: 'snapshot', source: fileSnapshotSource(snapshotFile), snapshotFile, url: null, token: undefined };
}

/** Reads the palette, translating source failures into exit codes a caller can act on. */
export async function loadPalette(context: CliContext, project: Project, request: PaletteRequest): Promise<LoadedPalette> {
  const plan = planPalette(context, project, request);
  try {
    return { ...plan, snapshot: await plan.source.load() };
  } catch (cause) {
    throw paletteFailure(cause, plan, project.root);
  }
}

/**
 * Reads only the live instance, whatever the profile says. `plan` uses this to warn about drift:
 * the pinned snapshot is what the sources were written against, the live one is what will
 * actually run them.
 */
export async function loadLivePalette(
  context: CliContext,
  url: string,
  token: string | undefined,
): Promise<PaletteSnapshot> {
  const source = liveHttpSource({ url, ...(token === undefined ? {} : { token }), ...context.fetchOption });
  return source.load();
}

function paletteFailure(cause: unknown, plan: PalettePlan, root: string): Error {
  if (cause instanceof PaletteSourceError) {
    const hint =
      plan.origin === 'snapshot'
        ? `run \`flowgen palette pull\` to create ${path.relative(root, plan.snapshotFile) || plan.snapshotFile}`
        : 'check the URL and the token, or pass --palette <file> to work from a committed snapshot';
    const exitCode =
      cause.code === 'unauthorized' || cause.code === 'http-error' || cause.code === 'invalid-response'
        ? EXIT.unreachable
        : EXIT.usage;
    const details = cause.details.length === 0 ? '' : ` (${cause.details.join('; ')})`;
    return new CliFailure(exitCode, `${cause.message}${details}`, hint);
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

function resolveToken(context: CliContext, request: PaletteRequest, profile: ResolvedProfile): string | undefined {
  if (request.token !== undefined && request.token !== '') return request.token;
  const name = request.tokenEnv ?? profile.tokenEnv;
  if (name !== undefined) {
    const value = envToken(context, name);
    if (value === undefined) {
      throw new UsageError(`environment variable ${name} is empty or unset`, 'export it, or pass --token <token>');
    }
    return value;
  }
  return envToken(context, 'FLOWGEN_TOKEN');
}

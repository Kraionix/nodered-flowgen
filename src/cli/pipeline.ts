/**
 * The pipeline every command shares: resolve a target, build the flow set, validate it.
 *
 * Ordering is deliberate and is the same in `validate`, `plan` and `apply`: the flow set is built
 * against the palette, subflow definitions are folded into that palette as types (an inline
 * subflow is never in `GET /nodes`, so its ports only become known once the source has been
 * read), and only then do the validators run. `apply` adds one rule on top: it validates in
 * `bail` mode and refuses to deploy anything with an error, because the server will accept a
 * broken flow set without complaint.
 */

import { subflowOverlay } from '../palette/sources/subflow.ts';
import { applyOverlays } from '../palette/sources/source.ts';
import type { PaletteType } from '../palette/model.ts';
import { subflowDefinitionLike } from '../model/subflows.ts';
import type { FlowSet } from '../model/entities.ts';
import { lockfileIdMap, ownedContainers, knownIds } from '../io/lockfile.ts';
import { AdminApiClient } from '../io/adminApi.ts';
import { defaultValidators } from '../validate/index.ts';
import { runValidators, type Capability, type ValidationReport } from '../validate/report.ts';

import { envToken, type CliContext } from './context.ts';
import { UsageError } from './exit.ts';
import { loadPalette, type LoadedPalette, type PaletteRequest } from './palette.ts';
import type { Project } from './project.ts';

export interface TargetRequest {
  readonly target?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly tokenEnv?: string | undefined;
  readonly profile?: string | undefined;
}

export interface ResolvedTarget {
  readonly name: string;
  readonly url: string;
  readonly token: string | undefined;
  /** Palette profile pinned to this target; falls back to the project default. */
  readonly profile: string;
  readonly prune: boolean | undefined;
  readonly readOnly: boolean;
}

export function resolveTarget(context: CliContext, project: Project, request: TargetRequest): ResolvedTarget {
  const configured = project.config.targets;
  const names = Object.keys(configured).sort();
  let name = request.target;
  let entry = name === undefined ? undefined : configured[name];

  if (name !== undefined && entry === undefined && request.url === undefined) {
    throw new UsageError(
      `unknown target "${name}"`,
      names.length === 0 ? 'no targets are configured; add one to flowgen.config.ts or pass --url' : `configured targets: ${names.join(', ')}`,
    );
  }

  // Safety default from the spec: an ambiguous target is never guessed.
  if (name === undefined) {
    if (names.length === 1) {
      name = names[0] as string;
      entry = configured[name];
    } else if (names.length === 0) {
      if (request.url === undefined) {
        throw new UsageError('no target configured and no --url given', 'pass --url <http://host:port> or add targets to flowgen.config.ts');
      }
      name = 'cli';
    } else {
      throw new UsageError(`more than one target is configured (${names.join(', ')})`, 'pass --target <name>');
    }
  }

  const url = request.url ?? entry?.url;
  if (url === undefined || url === '') {
    throw new UsageError(`target "${name}" has no url`, 'set targets.<name>.url in flowgen.config.ts or pass --url');
  }

  const tokenEnv = request.tokenEnv ?? entry?.tokenEnv;
  const token =
    request.token !== undefined && request.token !== ''
      ? request.token
      : tokenEnv !== undefined
        ? envToken(context, tokenEnv)
        : envToken(context, 'FLOWGEN_TOKEN');

  if (tokenEnv !== undefined && token === undefined && request.token === undefined) {
    throw new UsageError(`environment variable ${tokenEnv} is empty or unset`, `export it, or pass --token <token>`);
  }

  return {
    name,
    url,
    token,
    profile: request.profile ?? entry?.paletteProfile ?? project.config.defaultProfile,
    prune: entry?.prune,
    readOnly: entry?.readOnly === true,
  };
}

export function adminClientFor(context: CliContext, target: ResolvedTarget): AdminApiClient {
  return new AdminApiClient({
    url: target.url,
    ...(target.token === undefined ? {} : { token: target.token }),
    ...context.fetchOption,
  });
}

export interface BuiltProject {
  readonly flowSet: FlowSet;
  /** Authoring key → id, straight from the builder; written to the lockfile on apply. */
  readonly keys: ReadonlyMap<string, string>;
  readonly duplicateKeys: readonly string[];
  /** Base palette plus one entry per inline subflow definition. */
  readonly palette: Readonly<Record<string, PaletteType>>;
}

/**
 * Builds the flow set, then re-reads its subflows into the palette.
 *
 * The two steps are not an accident of implementation: defaults come from the palette, and an
 * inline subflow's ports come from the flow set, so one pass cannot know both. Re-running the
 * build with the enriched palette would be wasteful — the only thing the extra types change is
 * validation and emission of the instances.
 */
export function buildProject(project: Project, palette: LoadedPalette): BuiltProject {
  const built = project.config.flowSet.build({
    palette: palette.snapshot.types,
    lockfile: lockfileIdMap(project.lockfile),
    ...(project.config.layout === undefined ? {} : { layout: project.config.layout }),
  });

  const overlaid = applyOverlays(palette.snapshot, [
    subflowOverlay(built.flowSet.subflows.map(subflowDefinitionLike)),
  ]);

  return {
    flowSet: built.flowSet,
    keys: built.keys,
    duplicateKeys: built.duplicateKeys,
    palette: overlaid.types,
  };
}

export interface PrepareOptions {
  readonly palette: PaletteRequest;
  readonly target?: ResolvedTarget | undefined;
  /** `bail` stops at the first validator that reports an error; used before any write. */
  readonly mode?: 'collect' | 'bail';
}

export interface Prepared {
  readonly palette: LoadedPalette;
  readonly built: BuiltProject;
  readonly report: ValidationReport;
}

export async function prepare(context: CliContext, project: Project, options: PrepareOptions): Promise<Prepared> {
  const palette = await loadPalette(context, project, options.palette);
  const built = buildProject(project, palette);
  const capabilities = new Set<Capability>();
  if (options.target !== undefined) capabilities.add('liveInstance');

  const report = runValidators(
    defaultValidators({ extra: project.config.validators }),
    {
      flowSet: built.flowSet,
      palette: built.palette,
      targetVersion: palette.snapshot.nodeRedVersion,
    },
    { mode: options.mode ?? 'collect', capabilities },
  );

  return { palette, built, report };
}

/** Containers this tool owns on a target, and every id it has ever allocated. */
export function ownership(project: Project, target: ResolvedTarget): { owned: ReadonlySet<string>; ids: ReadonlySet<string> } {
  return {
    owned: ownedContainers(project.lockfile, target.name),
    ids: knownIds(project.lockfile),
  };
}

/** Container ids of the desired flow set: tabs and subflow definitions, nothing nested. */
export function containersOf(flowSet: FlowSet): readonly string[] {
  return [...flowSet.flows.map((flow) => flow.id), ...flowSet.subflows.map((subflow) => subflow.id)].sort();
}

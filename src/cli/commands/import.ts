/**
 * `flowgen import` — an existing flow file (or a deployed flow set) becomes sources.
 *
 * The command mirrors `apply`, and it exists because adopting an instance somebody already built
 * is the only honest way to start using this tool on it: nobody rewrites forty tabs by hand, and a
 * generator that produced *different* ids would turn adoption into a full redeploy.
 *
 * Four steps, each visible in the result:
 *
 * 1. **parse** the file into the IR (the importer's losslessness contract);
 * 2. **normalise** it with the editor's fix-ups, every repair reported as an info problem;
 * 3. **materialise** the palette defaults a hand-written file leaves out, because the runtime
 *    fills them on load and the generated source cannot not fill them;
 * 4. **print** the source, together with the `key → id` record that makes a rebuild reproduce the
 *    file it came from.
 *
 * The ids are the part to be careful with. They go to the project's lockfile — never over an entry
 * that already means something else, which is reported and skipped rather than taken — so that
 * `flowgen plan` against the instance the flow came from shows nothing at all. Importing claims no
 * ownership: that is `plan`/`apply --adopt`'s job, and a tool that silently declared a stranger's
 * tabs its own would be one nobody could point at a production instance.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { printFlowSet } from '../../codegen/print.ts';
import { parseFlowFile } from '../../import/fromFlowJson.ts';
import { emptyLockfile, serializeLockfile, type Lockfile } from '../../io/lockfile.ts';
import { materialiseDefaults } from '../../model/defaults.ts';
import { normalizeFlowSetWithFixes } from '../../model/normalize.ts';
import { subflowDefinitionLike } from '../../model/subflows.ts';
import type { PaletteType } from '../../palette/model.ts';
import { subflowOverlay } from '../../palette/sources/subflow.ts';
import { defaultValidators } from '../../validate/index.ts';
import { runValidators } from '../../validate/report.ts';
import { countBySeverity } from '../../diagnostics/index.ts';

import { flag, text, type OptionSpec, type ParsedArgs } from '../args.ts';
import type { CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { writeIfChanged, type WriteOutcome } from '../files.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadPalette, type PaletteRequest } from '../palette.ts';
import { adminClientFor, type ResolvedTarget } from '../pipeline.ts';
import { displayPath, loadProject, writeLockfile, type Project } from '../project.ts';
import { readFlows } from '../deploy.ts';

export const IMPORT_OPTIONS: readonly OptionSpec[] = [
  { name: 'from', kind: 'string', placeholder: '<file>', description: 'flow file to import, as the editor exports it' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'import what is deployed on this instance instead (read-only)' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'out', kind: 'string', placeholder: '<file>', description: 'write the sources here (default: stdout)' },
  { name: 'stdout', kind: 'boolean', description: 'write the sources to stdout as well as to --out' },
  { name: 'ids', kind: 'string', placeholder: '<file>', description: 'write the id record here instead of merging it into the lockfile' },
  { name: 'no-ids', kind: 'boolean', description: 'record no ids at all; a rebuild will derive its own' },
  { name: 'no-lock', kind: 'boolean', description: 'leave the lockfile alone' },
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile (default: the project default)' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'snapshot to classify and type against' },
];

export const IMPORT_USAGE: readonly string[] = [
  'import --from flows.json [--out flowset.ts | --stdout] [--json]',
  'import --url http://127.0.0.1:1880 [--token <token>] [--out flowset.ts]',
];

export async function importCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const from = text(args, 'from');
  const url = text(args, 'url');
  if (from === undefined && url === undefined) {
    throw new UsageError('nothing to import', 'pass --from <flows.json>, or --url <instance> to read what is deployed');
  }
  if (from !== undefined && url !== undefined) {
    throw new UsageError('--from and --url are alternatives', 'a file needs no instance, and an instance needs no file');
  }

  const palette = await loadPalette(context, project, {
    profile: text(args, 'profile'),
    paletteFile: text(args, 'palette'),
    // A file import is offline by construction: reaching an instance to classify a local JSON file
    // would make the command fail on a machine with no Node-RED running, for nothing.
    offline: url === undefined,
    ...(url === undefined ? {} : { url, token: text(args, 'token'), tokenEnv: text(args, 'token-env') }),
  } satisfies PaletteRequest);
  const types: Record<string, PaletteType> = { ...palette.snapshot.types };

  const text_ =
    from === undefined
      ? await readDeployed(context, project, args, url as string)
      : await readFlowFile(context.cwd, from);
  const json = parseJson(text_, from ?? url ?? 'flows');

  let flowSet;
  try {
    flowSet = parseFlowFile(json, { palette: types });
  } catch (cause) {
    throw new UsageError(
      `${from ?? url} is not a flow file: ${cause instanceof Error ? cause.message : String(cause)}`,
      'a flow file is a JSON array of entries, the way the editor exports it',
    );
  }

  const normalized = normalizeFlowSetWithFixes(flowSet, { palette: types });
  const materialised = materialiseDefaults(normalized.flowSet, { palette: types });
  const overlaid = subflowOverlay(materialised.flowSet.subflows.map(subflowDefinitionLike)).apply(palette.snapshot);
  const printed = printFlowSet(materialised.flowSet, { palette: overlaid.types, source: from ?? url });

  const report = await runValidators(
    defaultValidators({ extra: project.config.validators }),
    { flowSet: materialised.flowSet, palette: overlaid.types, targetVersion: palette.snapshot.nodeRedVersion },
    { mode: 'collect', priorProblems: normalized.fixes },
  );

  const out = text(args, 'out');
  const json_ = flag(args, 'json');
  const writes: WriteOutcome[] = [];
  if (out !== undefined) writes.push(await writeIfChanged(path.resolve(project.root, out), printed.source));
  // The sources go to stdout when they have nowhere else to go. In `--json` mode they travel in
  // the envelope instead: a report a pipeline can parse must not have a source file in front of it.
  if (!json_ && (out === undefined || flag(args, 'stdout'))) context.stdout(printed.source);

  const ids = await recordIds(project, args, printed.ids);
  const counts = countBySeverity(report.problems);

  return {
    command: 'import',
    // An import that finds errors still produces sources — that is what the sources are for — but
    // it does not pretend the file was fine.
    exitCode: report.hasErrors ? EXIT.problems : EXIT.ok,
    diagnostics: report.problems,
    skipped: report.skipped,
    messages: lines(
      `imported ${materialised.flowSet.flows.length} tab(s)/${materialised.flowSet.subflows.length} subflow(s) from ${from ?? url}`,
      `printed ${printed.report.printed} entit(ies) against ${palette.origin} palette ${palette.snapshot.contentHash.slice(0, 19)}: ${printed.report.untyped} untyped, ${printed.report.comments} comment(s), ${printed.report.dropped} dropped`,
      materialised.filled === 0
        ? null
        : `filled ${materialised.filled} palette default(s) the file left out (the runtime does the same on load)`,
      ids.summary,
      writeSummary(writes, project),
      `${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info`,
    ),
    data: {
      report: {
        printed: printed.report.printed,
        untyped: printed.report.untyped,
        comments: printed.report.comments,
        dropped: printed.report.dropped,
        notes: printed.report.notes,
      },
      materialised: { filled: materialised.filled, entities: materialised.entities },
      ids: ids.data,
      sources: writes.map((write) => ({ path: displayPath(project.root, write.path), status: write.status })),
      ...(out === undefined && json_ ? { source: printed.source } : {}),
      problems: report.problems,
      palette: {
        origin: palette.origin,
        contentHash: palette.snapshot.contentHash,
        typeCount: Object.keys(palette.snapshot.types).length,
      },
    },
  };
}

async function readFlowFile(cwd: string, file: string): Promise<string> {
  try {
    // Relative to the invocation, not to the project root: `--from flows.json` means the file the
    // caller is looking at, the same way it does for every other path a command is given.
    return await readFile(path.resolve(cwd, file), 'utf8');
  } catch (cause) {
    throw new UsageError(
      `cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'pass the flow file the editor exported',
    );
  }
}

/** `GET /flows`, read-only: the deployed flow set is the most accurate documentation there is. */
async function readDeployed(
  context: CliContext,
  project: Project,
  args: ParsedArgs,
  url: string,
): Promise<string> {
  const token = text(args, 'token') ?? tokenFromEnv(context, args);
  const target: ResolvedTarget = {
    name: 'import',
    url,
    token,
    profile: text(args, 'profile') ?? project.config.defaultProfile,
    prune: undefined,
    readOnly: true,
  };
  const state = await readFlows(adminClientFor(context, target), target);
  return JSON.stringify(state.flows);
}

function tokenFromEnv(context: CliContext, args: ParsedArgs): string | undefined {
  const name = text(args, 'token-env');
  const value = name === undefined ? context.env['FLOWGEN_TOKEN'] : context.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function parseJson(source: string, origin: string): unknown {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new UsageError(`${origin} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

interface IdOutcome {
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Records the ids, either as a standalone lockfile or in the project's.
 *
 * A key that already maps to a *different* id is never overwritten. The lockfile is what keeps
 * deployed entities stable, and an import that quietly reassigned one would be renaming somebody's
 * flow; conflicts are reported and skipped instead, which makes importing into a project that
 * already contains part of the same flow set safe and visible.
 */
async function recordIds(
  project: Project,
  args: ParsedArgs,
  ids: ReadonlyMap<string, string>,
): Promise<IdOutcome> {
  if (flag(args, 'no-ids') || flag(args, 'no-lock')) {
    const why = flag(args, 'no-ids') ? '--no-ids' : '--no-lock';
    return {
      summary: `ids not recorded (${why}): a rebuild will derive its own`,
      data: { written: false, count: 0, conflicts: [] },
    };
  }

  const file = text(args, 'ids');
  if (file !== undefined) {
    const fragment: Lockfile = { ...emptyLockfile(), ids: Object.fromEntries(ids) };
    const write = await writeIfChanged(path.resolve(project.root, file), serializeLockfile(fragment));
    return {
      summary: `ids written to ${displayPath(project.root, write.path)} (${ids.size} entries)`,
      data: { written: true, path: displayPath(project.root, write.path), count: ids.size, conflicts: [] },
    };
  }

  const merged: Record<string, string> = { ...project.lockfile.ids };
  const conflicts: string[] = [];
  let added = 0;
  for (const [key, id] of ids) {
    const existing = merged[key];
    if (existing === id) continue;
    if (existing !== undefined) {
      conflicts.push(key);
      continue;
    }
    merged[key] = id;
    added += 1;
  }

  if (added > 0) await writeLockfile(project.lockfilePath, { ...project.lockfile, ids: merged });

  const relative = displayPath(project.root, project.lockfilePath);
  return {
    summary: lines(
      added === 0 ? null : `recorded ${added} id(s) in ${relative}`,
      added > 0 || conflicts.length > 0 ? null : 'ids already recorded: nothing to do',
      conflicts.length === 0
        ? null
        : `${conflicts.length} key(s) already meant something else and were left alone: ${conflicts.slice(0, 3).join(', ')}`,
    ).join('; '),
    data: { written: added > 0, path: relative, count: added, conflicts },
  };
}

function writeSummary(writes: readonly WriteOutcome[], project: Project): string | null {
  if (writes.length === 0) return null;
  const written = writes.filter((write) => write.status === 'written');
  if (written.length === 0) return `${writes.length} file(s) unchanged`;
  return `wrote ${written.map((write) => displayPath(project.root, write.path)).join(', ')}`;
}

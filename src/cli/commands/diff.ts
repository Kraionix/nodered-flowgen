/**
 * `flowgen diff` — compare two flow sets: a file, an instance, or a receipt.
 *
 * Each side is named by one option, and the *value* says what kind of thing it is:
 *
 * ```
 * flowgen diff --from flows.json --to @target:staging
 * flowgen diff --from @last --to @target:local          # what the last deploy replaced
 * flowgen diff --from @receipt:.flowgen/receipts/x.json --to flows-new.json
 * ```
 *
 * The vocabulary is deliberately tiny and explicit, because the alternative — three options per
 * side — makes six ways to say "same file", and a bare path that could also be a target name is
 * how a comparison silently happens against the wrong thing. A file path is anything that is not
 * `@…`; `@target:<name>`, `@receipt:<file>` and `@last` are the other three.
 *
 * Read-only throughout: an instance is read with `GET /flows`, never written, and needs no more
 * than a read token.
 *
 * ## Exit code
 *
 * `0` when the command ran, whether or not there were differences — the plan's own proposal, and
 * the reason is that `diff` is a *report*. Pipelines that want it as a gate pass `--check`, which
 * exits `1` when the two sides differ. That reuses the documented "the check said no" code rather
 * than inventing a sixth one, and it keeps `flowgen diff | less` from looking like a failure.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describeDiff, diffFlowSets, type DiffSide } from '../../io/diff.ts';
import { parseReceipt } from '../../io/receipt.ts';
import { parseFlowFile } from '../../import/fromFlowJson.ts';
import { materialiseDefaults } from '../../model/defaults.ts';
import { normalizeFlowSetWithFixes } from '../../model/normalize.ts';
import { unwrapOrThrow } from '../../result.ts';
import type { FlowSet } from '../../model/entities.ts';
import type { PaletteType } from '../../palette/model.ts';

import { flag, text, type OptionSpec, type ParsedArgs } from '../args.ts';
import { readFlows, TARGET_OPTIONS } from '../deploy.ts';
import { EXIT, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadPalette, loadLivePalette } from '../palette.ts';
import { adminClientFor, resolveTarget, type ResolvedTarget } from '../pipeline.ts';
import { displayPath, loadProject, type Project } from '../project.ts';
import type { CliContext } from '../context.ts';

export const DIFF_OPTIONS: readonly OptionSpec[] = [
  ...TARGET_OPTIONS,
  { name: 'from', kind: 'string', placeholder: '<spec>', description: 'left side: a flow file, @target:<name>, @receipt:<file> or @last' },
  { name: 'to', kind: 'string', placeholder: '<spec>', description: 'right side, same vocabulary (default: @target:<the resolved target>)' },
  { name: 'geometry', kind: 'boolean', description: 'include x/y/w/h in the comparison (they are ignored by default)' },
  { name: 'check', kind: 'boolean', description: 'exit 1 when the two sides differ, so the command can gate a pipeline' },
  { name: 'no-live-palette', kind: 'boolean', description: 'classify a target side with the pinned palette instead of the instance\'s own' },
];

export const DIFF_USAGE: readonly string[] = [
  'diff --from <spec> [--to <spec>] [--geometry] [--check]',
  'diff --from flows.json --to @target:staging',
  'diff --from @last --to @target:local',
];

export async function diffCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);

  const from = text(args, 'from');
  if (from === undefined) {
    throw new UsageError(
      'nothing to compare',
      'pass --from <file|@target:<name>|@receipt:<file>|@last>; --to defaults to the resolved target',
    );
  }

  const palette = await loadPalette(context, project, {
    profile: text(args, 'profile'),
    paletteFile: text(args, 'palette'),
    offline: true,
  });

  // The right side defaults to the target every other command would talk to, which is the
  // question a reviewer actually asks: "does what I am about to deploy match what is out there?"
  const toSpec = text(args, 'to') ?? '@target:default';
  // One object for both sides when both are read against the pinned palette: `diffFlowSets` uses
  // the identity of these maps to notice that the two sides were classified differently, and a
  // fresh copy per side would make that note permanent noise.
  const pinned: Record<string, PaletteType> = { ...palette.snapshot.types };
  const before = await readSide(context, project, args, from, palette.origin, pinned);
  const after = await readSide(context, project, args, toSpec, palette.origin, pinned);

  const diff = diffFlowSets(before, after, { geometry: flag(args, 'geometry') });
  const identical = diff.identical;
  const check = flag(args, 'check');

  return {
    command: 'diff',
    exitCode: check && !identical ? EXIT.problems : EXIT.ok,
    diagnostics: [],
    messages: lines(
      `diff ${diff.before} → ${diff.after} (palette ${palette.snapshot.contentHash.slice(0, 19)})`,
      ...describeDiff(diff),
      check && !identical ? 'check: the two sides differ' : null,
    ),
    data: {
      from: { label: diff.before, entities: diff.counts.unchanged + diff.counts.changed + diff.counts.removed },
      to: { label: diff.after, entities: diff.counts.unchanged + diff.counts.changed + diff.counts.added },
      identical,
      check,
      geometry: flag(args, 'geometry'),
      counts: diff.counts,
      entities: diff.entities,
      modules: diff.modules,
      notes: diff.notes,
      palette: { profile: palette.profile.name, origin: palette.origin, contentHash: palette.snapshot.contentHash },
    },
  };
}

/**
 * Reads one side into the IR.
 *
 * Both sides go through the *same* pipeline — parse, normalise, fill declared defaults — which is
 * what makes the comparison semantic rather than textual. Filling defaults matters most when one
 * side is a file somebody wrote by hand and the other is what the runtime loaded: the runtime
 * fills them, so a diff that did not would report every default as a difference.
 */
async function readSide(
  context: CliContext,
  project: Project,
  args: ParsedArgs,
  spec: string,
  origin: string,
  pinned: Readonly<Record<string, PaletteType>>,
): Promise<DiffSide> {

  if (spec.startsWith('@target:')) {
    const name = spec.slice('@target:'.length);
    if (name === 'default') {
      const target = resolveTarget(context, project, {
        target: text(args, 'target'),
        url: text(args, 'url'),
        token: text(args, 'token'),
        tokenEnv: text(args, 'token-env'),
        profile: text(args, 'profile'),
      });
      return readTargetSide(context, args, target, origin, pinned);
    }
    const configured = project.config.targets[name];
    if (configured === undefined) {
      throw new UsageError(
        `unknown target "${name}"`,
        `configured targets: ${Object.keys(project.config.targets).join(', ') || '(none)'}`,
      );
    }
    const target = resolveTarget(context, project, { target: name, profile: text(args, 'profile') });
    return readTargetSide(context, args, target, origin, pinned);
  }

  if (spec === '@last') {
    return readReceiptSide(project, await latestReceipt(project), pinned);
  }

  if (spec.startsWith('@receipt:')) {
    return readReceiptSide(project, spec.slice('@receipt:'.length), pinned);
  }

  if (spec.startsWith('@')) {
    throw new UsageError(
      `"${spec}" is not a spec this command knows`,
      'use a file path, @target:<name>, @receipt:<file> or @last',
    );
  }

  const text_ = await readText(project.root, spec, 'flow file');
  return toSide(JSON.parse(text_) as unknown, pinned, `${spec} (pinned ${origin} palette)`);
}

/**
 * A deployed flow set.
 *
 * The instance's *own* palette is used to read it when it answers, because that is the only
 * palette that classifies its nodes correctly — a user module the pinned snapshot has never seen
 * would otherwise be read as a plain node. A failure to fetch it is not a failure to compare: the
 * pinned palette is used, and the report says so.
 */
async function readTargetSide(
  context: CliContext,
  args: ParsedArgs,
  target: ResolvedTarget,
  origin: string,
  pinned: Readonly<Record<string, PaletteType>>,
): Promise<DiffSide> {
  const state = await readFlows(adminClientFor(context, target), target);

  // `--target`-style options apply to the *default* side; @target:<name> carries its own credentials
  // from the config, and the token still comes from the environment.
  if (flag(args, 'no-live-palette')) {
    return toSide(state.flows, pinned, `@target:${target.name} (pinned ${origin} palette)`);
  }

  try {
    const live = await loadLivePalette(context, target.url, target.token);
    return toSide(state.flows, { ...live.types }, `@target:${target.name} (its own palette)`);
  } catch {
    return toSide(
      state.flows,
      pinned,
      `@target:${target.name} (pinned ${origin} palette; the instance did not answer GET /nodes)`,
    );
  }
}

async function readReceiptSide(
  project: Project,
  file: string,
  pinned: Readonly<Record<string, PaletteType>>,
): Promise<DiffSide> {
  const full = path.resolve(project.root, file);
  const receipt = unwrapOrThrow(parseReceipt(await readText(project.root, file, 'receipt')));
  const label = `@receipt:${displayPath(project.root, full)} (before ${receipt.deployedAt}, target ${receipt.target})`;
  return toSide(receipt.previousFlows, pinned, label);
}

function toSide(
  json: unknown,
  types: Readonly<Record<string, PaletteType>>,
  describe: string,
): DiffSide {
  const parsed = parseFlowFile(json, { palette: types });
  const normalized = normalizeFlowSetWithFixes(parsed, { palette: types });
  const filled = materialiseDefaults(normalized.flowSet, { palette: types });
  const flowSet: FlowSet = filled.flowSet;
  return { label: describe, flowSet, palette: types };
}

/** The newest receipt in the project's receipts directory, by name (they are timestamped). */
async function latestReceipt(project: Project): Promise<string> {
  const entries = await readdir(project.receiptsDir).catch(() => [] as string[]);
  const receipts = entries.filter((entry) => entry.endsWith('.json')).sort();
  const last = receipts[receipts.length - 1];
  if (last === undefined) {
    throw new UsageError(
      `no receipts in ${displayPath(project.root, project.receiptsDir)}`,
      '@last means "what the most recent deploy replaced"; run `flowgen apply` first, or pass @receipt:<file>',
    );
  }
  return path.join(project.receiptsDir, last);
}

async function readText(root: string, file: string, kind: string): Promise<string> {
  const full = path.isAbsolute(file) ? file : path.resolve(root, file);
  try {
    return await readFile(full, 'utf8');
  } catch (cause) {
    throw new UsageError(
      `cannot read ${kind} ${displayPath(root, full)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

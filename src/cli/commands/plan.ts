/**
 * `flowgen plan` — what `apply` would do, computed from the instance's actual state.
 *
 * The plan is computed against the *pinned* palette, not the instance's: the sources were
 * authored against what is committed, and building them against a live palette would make the
 * same commit produce different flow sets depending on when it ran. A live palette that differs
 * is reported as a warning instead — that is the reviewer's cue to pull and re-review.
 *
 * Ownership decides what the plan is even allowed to mention: containers of ours become
 * `create`/`update`, everything else is an explicit `leave-alien` line. Nothing of theirs is
 * merged into, and deletion only happens with `--prune`.
 */

import { flag, text } from '../args.ts';
import { EXIT } from '../exit.ts';
import { describePlan, checkPaletteDrift, planAgainstTarget, TARGET_OPTIONS } from '../deploy.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject, pruneRequested } from '../project.ts';
import { prepare, resolveTarget } from '../pipeline.ts';
import type { CliContext } from '../context.ts';
import type { OptionSpec } from '../args.ts';
import type { ParsedArgs } from '../args.ts';

export const PLAN_OPTIONS: readonly OptionSpec[] = [
  ...TARGET_OPTIONS,
  { name: 'prune', kind: 'boolean', description: 'plan the removal of our containers that the sources no longer define' },
  { name: 'no-prune', kind: 'boolean', description: 'never plan deletions, whatever the config says' },
  { name: 'diff-geometry', kind: 'boolean', description: 'include x/y/w/h in the diff (off by default: the editor recomputes them)' },
  { name: 'no-palette-check', kind: 'boolean', description: 'skip the live-palette drift warning' },
];

export const PLAN_USAGE: readonly string[] = ['plan [options]'];

export async function planCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const target = resolveTarget(context, project, {
    target: text(args, 'target'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    profile: text(args, 'profile'),
  });

  const prepared = await prepare(context, project, {
    palette: {
      profile: target.profile,
      paletteFile: text(args, 'palette'),
      offline: true,
    },
    target,
    // Planning must never write, so the first error is enough to stop.
    mode: 'bail',
  });

  if (prepared.report.hasErrors) {
    return {
      command: 'plan',
      exitCode: EXIT.problems,
      diagnostics: prepared.report.problems,
      skipped: prepared.report.skipped,
      messages: lines(`refusing to plan: the sources do not validate against palette ${prepared.palette.snapshot.contentHash}`),
      data: { target: target.name, url: target.url, palette: paletteData(prepared, undefined) },
    };
  }

  const prune = pruneRequested(args, target.prune);
  const live = await planAgainstTarget(context, project, target, prepared, {
    prune,
    diffGeometry: flag(args, 'diff-geometry'),
  });

  const drift = flag(args, 'no-palette-check')
    ? { checked: false, problems: [] }
    : await checkPaletteDrift(context, target, prepared.palette.snapshot);

  const diagnostics = [...prepared.report.problems, ...drift.problems];

  return {
    command: 'plan',
    exitCode: EXIT.ok,
    diagnostics,
    skipped: prepared.report.skipped,
    messages: lines(
      `plan for target "${target.name}" at ${target.url} (rev ${live.rev === '' ? '(none)' : live.rev.slice(0, 12)}, prune ${prune ? 'on' : 'off'})`,
      ...describePlan(live.plan),
      flag(args, 'no-palette-check') ? null : drift.checked ? (drift.problems.length === 0 ? 'palette: the instance matches the pinned snapshot' : null) : 'palette: drift check skipped (the instance did not answer GET /nodes)',
    ),
    data: {
      target: target.name,
      url: target.url,
      rev: live.rev,
      prune,
      plan: live.plan,
      palette: paletteData(prepared, drift.checked ? (drift.liveHash ?? null) : null),
    },
  };
}

export function paletteData(
  prepared: { readonly palette: { readonly profile: { readonly name: string }; readonly origin: string; readonly snapshot: { readonly contentHash: string } } },
  liveHash: string | null | undefined,
): Record<string, unknown> {
  return {
    profile: prepared.palette.profile.name,
    origin: prepared.palette.origin,
    contentHash: prepared.palette.snapshot.contentHash,
    ...(liveHash === undefined ? {} : { liveHash }),
  };
}

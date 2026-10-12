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

import { flag, text, texts } from '../args.ts';
import { EXIT } from '../exit.ts';
import {
  checkPaletteDrift,
  combineOutcomes,
  describePlan,
  failureOutcome,
  planAgainstTarget,
  selectedTargets,
  TARGET_OPTIONS,
  type TargetOutcome,
} from '../deploy.ts';
import { hasErrors } from '../../diagnostics/index.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject, pruneRequested, type Project } from '../project.ts';
import { prepare, type ResolvedTarget } from '../pipeline.ts';
import type { CliContext } from '../context.ts';
import type { OptionSpec } from '../args.ts';
import type { ParsedArgs } from '../args.ts';

export const PLAN_OPTIONS: readonly OptionSpec[] = [
  ...TARGET_OPTIONS,
  { name: 'prune', kind: 'boolean', description: 'plan the removal of our containers that the sources no longer define' },
  { name: 'no-prune', kind: 'boolean', description: 'never plan deletions, whatever the config says' },
  { name: 'reassign', kind: 'boolean', description: 'plan a fresh id for a container whose id already exists on the target' },
  { name: 'adopt', kind: 'string', placeholder: '<id>', multiple: true, description: 'take ownership of a container that already exists on the target (repeatable)' },
  { name: 'diff-geometry', kind: 'boolean', description: 'include x/y/w/h in the diff (off by default: the editor recomputes them)' },
  { name: 'no-palette-check', kind: 'boolean', description: 'skip the live-palette drift warning' },
  { name: 'all-targets', kind: 'boolean', description: 'plan every configured target, one after another' },
];

export const PLAN_USAGE: readonly string[] = ['plan [options]', 'plan --all-targets'];

export async function planCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const targets = selectedTargets(context, project, args, {
    target: text(args, 'target'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    profile: text(args, 'profile'),
  });

  const outcomes: TargetOutcome[] = [];
  for (const target of targets) {
    // One target fails loudly; a fan-out reports that target and carries on, because stopping at
    // the first unreachable instance would leave every later one unplanned and unreported.
    if (targets.length === 1) outcomes.push(await planTarget(context, project, args, target));
    else {
      try {
        outcomes.push(await planTarget(context, project, args, target));
      } catch (cause) {
        outcomes.push(failureOutcome(target, cause));
      }
    }
  }
  return combineOutcomes('plan', outcomes);
}

async function planTarget(
  context: CliContext,
  project: Project,
  args: ParsedArgs,
  target: ResolvedTarget,
): Promise<TargetOutcome> {
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
      name: target.name,
      url: target.url,
      exitCode: EXIT.problems,
      diagnostics: prepared.report.problems,
      skipped: prepared.report.skipped,
      messages: lines(`refusing to plan: the sources do not validate against palette ${prepared.palette.snapshot.contentHash}`),
      data: { target: target.name, url: target.url, palette: paletteData(prepared, undefined) },
    };
  }

  const prune = pruneRequested(args, target.prune);
  const adopted = texts(args, 'adopt');
  const live = await planAgainstTarget(context, project, target, prepared, {
    prune,
    diffGeometry: flag(args, 'diff-geometry'),
    reassign: flag(args, 'reassign'),
    ...(adopted.length === 0 ? {} : { adopt: adopted }),
  });

  const drift = flag(args, 'no-palette-check')
    ? { checked: false, problems: [] }
    : await checkPaletteDrift(context, target, prepared.palette.snapshot);

  // `prepared.report.problems` is already inside `live.plan.problems` — the plan is seeded with
  // them so that one report holds the validation gate and the plan's own findings. They used to be
  // dropped on the floor here, which made an id collision invisible: the plan silently wrote a
  // payload without our container, printed "no changes", and exited 0.
  const diagnostics = [...drift.problems, ...live.plan.problems];
  const planErrors = diagnostics.filter((problem) => problem.severity === 'error').length;

  return {
    name: target.name,
    url: target.url,
    exitCode: hasErrors(diagnostics) ? EXIT.problems : EXIT.ok,
    diagnostics,
    skipped: prepared.report.skipped,
    messages: lines(
      `plan for target "${target.name}" at ${target.url} (rev ${live.rev === '' ? '(none)' : live.rev.slice(0, 12)}, prune ${prune ? 'on' : 'off'})`,
      ...describePlan(live.plan),
      flag(args, 'no-palette-check') ? null : drift.checked ? (drift.problems.length === 0 ? 'palette: the instance matches the pinned snapshot' : null) : 'palette: drift check skipped (the instance did not answer GET /nodes)',
      planErrors === 0 ? null : `plan refused: ${planErrors} error(s) must be fixed before apply`,
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

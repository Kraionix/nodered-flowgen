/**
 * The deploy path, shared by `plan` and `apply`.
 *
 * Both commands answer the same question — "what would change on this instance?" — and differ
 * only in whether they then write. Keeping the read, the parse, the ownership lookup and the
 * rendering in one place is what guarantees that the plan a reviewer approved is the plan that
 * `apply` executes; a second implementation would eventually disagree with the first.
 *
 * Two facts about the server shape all of this: `POST /flows` replaces the whole flow set, so
 * the merge is client-side; and the write is a compare-and-swap on `rev`, so a stale plan is
 * refused rather than silently applied.
 */

import { AdminApiError, type AdminApiClient } from '../io/adminApi.ts';
import { isNoop, planMerge, summarizePlan, type DeploymentPlan } from '../io/plan.ts';
import { parseFlowFile } from '../import/fromFlowJson.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteSnapshot } from '../palette/snapshot.ts';
import { samePaletteContent } from '../palette/snapshot.ts';
import type { Problem } from '../diagnostics/index.ts';

import { classifyFailure, CliFailure, EXIT, UsageError, type ExitCode } from './exit.ts';
import { lines, type CommandResult } from './output.ts';
import { loadLivePalette } from './palette.ts';
import { adminClientFor, ownership, resolveTarget, type Prepared, type ResolvedTarget } from './pipeline.ts';
import type { CliContext } from './context.ts';
import type { OptionSpec, ParsedArgs } from './args.ts';
import type { Project } from './project.ts';
import type { SkippedValidator } from '../validate/report.ts';

export const TARGET_OPTIONS: readonly OptionSpec[] = [
  { name: 'target', kind: 'string', alias: 't', placeholder: '<name>', description: 'configured target to talk to' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance URL, overriding the target' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile pinned to this deploy' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'palette snapshot to build against' },
];

export interface LivePlan {
  readonly client: AdminApiClient;
  readonly rev: string;
  readonly plan: DeploymentPlan;
}

export interface PlanOptions {
  readonly prune: boolean;
  readonly diffGeometry: boolean;
  /** Deploy a container under a fresh id when its id already exists on the target. */
  readonly reassign?: boolean;
  /** Containers that already exist on the target and that this run takes ownership of. */
  readonly adopt?: readonly string[];
}

/** Reads the instance, parses what is there, and plans the merge. Read-only. */
export async function planAgainstTarget(
  context: CliContext,
  project: Project,
  target: ResolvedTarget,
  prepared: Prepared,
  options: PlanOptions,
): Promise<LivePlan> {
  const client = adminClientFor(context, target);
  const state = await readFlows(client, target);

  let current: FlowSet;
  try {
    current = parseFlowFile(state.flows, { palette: prepared.built.palette });
  } catch (cause) {
    throw new CliFailure(
      EXIT.problems,
      `the flow set on ${target.url} could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      'this build cannot reason about that instance; inspect it in the editor, or plan against another target',
    );
  }

  const { owned, ids } = ownership(project, target);
  const plan = planMerge({
    target: target.name,
    rev: state.rev,
    current,
    desired: prepared.built.flowSet,
    palette: prepared.built.palette,
    owned,
    ownedEntities: ids,
    prune: options.prune,
    ...(options.reassign === true ? { reassign: true } : {}),
    ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
    diffGeometry: options.diffGeometry,
    problems: prepared.report.problems,
  });

  return { client, rev: state.rev, plan };
}

export async function readFlows(client: AdminApiClient, target: ResolvedTarget): Promise<{ rev: string; flows: readonly unknown[] }> {
  try {
    return await client.readFlows();
  } catch (cause) {
    if (cause instanceof AdminApiError) {
      throw new CliFailure(
        EXIT.unreachable,
        `cannot read flows from ${target.url}: ${cause.message}`,
        cause.code === 'unauthorized' || cause.code === 'forbidden'
          ? `set ${target.token === undefined ? 'a token' : 'a token with write permission'} for target "${target.name}"`
          : 'check that the instance is running and the URL is right',
      );
    }
    throw cause;
  }
}

export interface DriftCheck {
  readonly checked: boolean;
  readonly liveHash?: string;
  readonly problems: readonly Problem[];
}

/**
 * Compares the instance's live palette with the pinned snapshot.
 *
 * Deploying a flow set built against a stale palette is how "works on my machine" starts, so the
 * mismatch is a warning attached to the plan. A failure to *check* is not a failure to plan: an
 * instance the palette endpoint refuses still accepts flows, so the check degrades to a message.
 */
export async function checkPaletteDrift(
  context: CliContext,
  target: ResolvedTarget,
  pinned: PaletteSnapshot,
): Promise<DriftCheck> {
  try {
    const live = await loadLivePalette(context, target.url, target.token);
    if (samePaletteContent(pinned, live)) return { checked: true, liveHash: live.contentHash, problems: [] };
    return {
      checked: true,
      liveHash: live.contentHash,
      problems: [
        {
          code: 'palette/module-version-drift',
          severity: 'warn',
          entity: target.name,
          path: 'palette',
          message: `the instance's palette differs from the pinned snapshot (${pinned.contentHash} → ${live.contentHash})`,
          hint: 'run `flowgen palette check`, then `flowgen palette pull` and commit the result',
        },
      ],
    };
  } catch {
    return { checked: false, problems: [] };
  }
}

/** One line per operation, plus the summary line; empty when there is nothing to do. */
export function describePlan(plan: DeploymentPlan): readonly string[] {
  const lines: string[] = [];
  for (const note of plan.notes) lines.push(`  note   ${note.message}`);
  for (const operation of plan.operations) {
    if (operation.kind === 'leave-alien' || operation.kind === 'keep-config') {
      const verb = operation.kind === 'leave-alien' ? 'leave' : 'keep';
      lines.push(`  ${verb.padEnd(6)} ${operation.id} (${operation.label}) — ${operation.reason ?? ''}`);
      continue;
    }
    const detail =
      operation.changes.length === 0
        ? ''
        : ` — ${operation.changes
            .map((change) => `${change.entity}: ${[change.added.length > 0 ? `+${change.added.length}` : null, change.removed.length > 0 ? `-${change.removed.length}` : null, change.changed.length > 0 ? `~${change.changed.length}` : null].filter((entry) => entry !== null).join(' ')}`)
            .join(', ')}`;
    lines.push(`  ${operation.kind.padEnd(16)} ${operation.id} (${operation.label})${detail}`);
  }

  if (plan.deletions.length > 0) {
    lines.push(`  ${plan.deletions.length} container(s) of ours are absent from the sources and would be pruned: ${plan.deletions.join(', ')}`);
  }

  const summary = summarizePlan(plan);
  const counts = Object.entries(summary)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(', ');
  lines.push(isNoop(plan) ? '  no changes: the instance already matches the sources' : `  plan: ${counts}`);
  return lines;
}

export function planIsEmpty(plan: DeploymentPlan): boolean {
  return isNoop(plan);
}

/** One line for what a finished deploy actually did — the plan, minus the containers it left alone. */
export function appliedSummary(plan: DeploymentPlan): string {
  if (isNoop(plan)) return 'deployed: the instance already matched the sources';
  const counts = Object.entries(summarizePlan(plan))
    .filter(([kind, count]) => count > 0 && kind !== 'leave-alien' && kind !== 'keep-config')
    .map(([kind, count]) => `${kind} ${count}`);
  return counts.length === 0 ? 'deployed: nothing needed changing' : `deployed: ${counts.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// More than one target
// ---------------------------------------------------------------------------------------------

/**
 * One target's outcome, before it is folded into a command result.
 *
 * `plan` and `apply` were written as one command = one target. `--all-targets` turns them into a
 * loop, and a loop needs the per-target facts separately: its own exit code, its own diagnostics
 * and its own payload, or the summary cannot say which instance failed.
 */
export interface TargetOutcome {
  readonly name: string;
  readonly url: string;
  readonly exitCode: ExitCode;
  readonly diagnostics: readonly Problem[];
  readonly skipped?: readonly SkippedValidator[];
  /** Human narration, one entry per line. */
  readonly messages: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The targets a command runs against.
 *
 * `--all-targets` means "every configured target, in name order"; naming one as well is a usage
 * error rather than a preference, because the two answers cannot both be right. With neither, the
 * single target every other command resolves is used — so nothing changes for the common case.
 */
export function selectedTargets(
  context: CliContext,
  project: Project,
  args: ParsedArgs,
  request: { readonly target?: string | undefined; readonly url?: string | undefined; readonly token?: string | undefined; readonly tokenEnv?: string | undefined; readonly profile?: string | undefined },
): readonly ResolvedTarget[] {
  const all = flagAll(args);
  if (!all) return [resolveTarget(context, project, request)];

  if (request.target !== undefined || request.url !== undefined) {
    throw new UsageError(
      '--all-targets and --target/--url are alternatives',
      '--all-targets already names every configured target; drop the other option',
    );
  }

  const names = Object.keys(project.config.targets).sort();
  if (names.length === 0) {
    throw new UsageError('--all-targets was given, but no targets are configured', 'add targets to flowgen.config.ts');
  }
  return names.map((name) => resolveTarget(context, project, { target: name, ...(request.profile === undefined ? {} : { profile: request.profile }) }));
}

function flagAll(args: ParsedArgs): boolean {
  const values = args.options.get('all-targets');
  return values !== undefined && values[values.length - 1] !== 'false';
}

/**
 * Folds per-target outcomes into one result.
 *
 * The exit code is the **highest** of the targets, which is the conservative reading of "did the
 * fan-out work": a failure is never hidden behind a success. Nothing is aborted early — a deploy
 * that stops at the first failure leaves the instances after it stale, and every apply writes its
 * own receipt, so the ones that did run are recoverable on their own.
 */
/**
 * A target that failed inside the fan-out, as an outcome instead of an exception.
 *
 * `--all-targets` runs every configured target and reports each one, so a single unreachable
 * instance cannot leave the rest undeployed. The classification is the same function the CLI's
 * top-level handler uses, which is what keeps "failed alone" and "failed in a loop" identical.
 */
export function failureOutcome(target: ResolvedTarget, cause: unknown): TargetOutcome {
  const failure = classifyFailure(cause);
  return {
    name: target.name,
    url: target.url,
    exitCode: failure.exitCode,
    diagnostics: [],
    messages: lines(failure.message, failure.hint === undefined ? null : `hint: ${failure.hint}`),
    data: { target: target.name, url: target.url, failed: failure.message },
  };
}

export function combineOutcomes(command: string, outcomes: readonly TargetOutcome[]): CommandResult {
  const [only] = outcomes;
  if (outcomes.length === 1 && only !== undefined) {
    return {
      command,
      exitCode: only.exitCode,
      diagnostics: only.diagnostics,
      ...(only.skipped === undefined ? {} : { skipped: only.skipped }),
      messages: only.messages,
      data: only.data,
    };
  }

  const failed = outcomes.filter((outcome) => outcome.exitCode !== EXIT.ok);
  return {
    command,
    exitCode: outcomes.reduce<ExitCode>((worst, outcome) => (outcome.exitCode > worst ? outcome.exitCode : worst), EXIT.ok),
    diagnostics: outcomes.flatMap((outcome) => outcome.diagnostics),
    skipped: outcomes.flatMap((outcome) => outcome.skipped ?? []),
    messages: lines(
      `${outcomes.length} target(s): ${failed.length === 0 ? 'all ok' : `${failed.length} failed (${failed.map((outcome) => outcome.name).join(', ')})`}`,
      ...outcomes.flatMap((outcome) => [`-- target "${outcome.name}" at ${outcome.url}`, ...outcome.messages.map((message) => `   ${message}`)]),
      'note: each target was attempted; the exit code is the highest of them',
    ),
    data: { targets: outcomes.map((outcome) => outcome.data), count: outcomes.length, failed: failed.map((outcome) => outcome.name) },
  };
}

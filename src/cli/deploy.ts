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
import { isNoop, planDeployment, summarizePlan, type Plan } from '../io/plan.ts';
import { parseFlowFile } from '../import/fromFlowJson.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteSnapshot } from '../palette/snapshot.ts';
import { samePaletteContent } from '../palette/snapshot.ts';
import type { Problem } from '../diagnostics/index.ts';

import { CliFailure, EXIT } from './exit.ts';
import { loadLivePalette } from './palette.ts';
import { adminClientFor, ownership, type Prepared, type ResolvedTarget } from './pipeline.ts';
import type { CliContext } from './context.ts';
import type { OptionSpec } from './args.ts';
import type { Project } from './project.ts';

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
  readonly plan: Plan;
}

export interface PlanOptions {
  readonly prune: boolean;
  readonly diffGeometry: boolean;
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
  const plan = planDeployment({
    target: target.name,
    rev: state.rev,
    current,
    desired: prepared.built.flowSet,
    palette: prepared.built.palette,
    owned,
    ownedEntities: ids,
    prune: options.prune,
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
export function describePlan(plan: Plan): readonly string[] {
  const lines: string[] = [];
  for (const operation of plan.operations) {
    if (operation.kind === 'leave-alien') {
      lines.push(`  leave  ${operation.id} (${operation.label}) — not ours, copied through untouched`);
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

export function planIsEmpty(plan: Plan): boolean {
  return isNoop(plan);
}

/** One line for what a finished deploy actually did — the plan, minus the containers it left alone. */
export function appliedSummary(plan: Plan): string {
  if (isNoop(plan)) return 'deployed: the instance already matched the sources';
  const counts = Object.entries(summarizePlan(plan))
    .filter(([kind, count]) => count > 0 && kind !== 'leave-alien')
    .map(([kind, count]) => `${kind} ${count}`);
  return counts.length === 0 ? 'deployed: nothing needed changing' : `deployed: ${counts.join(', ')}`;
}

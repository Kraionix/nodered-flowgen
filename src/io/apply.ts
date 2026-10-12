/**
 * Apply: plan → compare-and-swap → receipt, with bounded re-planning.
 *
 * The write is a compare-and-swap: the revision read during planning is sent back with the
 * payload, and a concurrent deploy (someone clicked Deploy in the editor) makes the server answer
 * `409 version_mismatch`. That is not an error to retry blindly — the flow set changed, so the
 * plan is stale — hence: re-read, re-plan, retry a bounded number of times, then give up with a
 * clear message rather than overwriting somebody's work.
 */

import { emitFlowSet } from '../emit/flowJson.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteType } from '../palette/model.ts';
import type { Problem } from '../validate/problem.ts';
import { hasErrors } from '../validate/problem.ts';

import { parseFlowFile } from '../import/fromFlowJson.ts';

import { AdminApiError, type AdminApiClient } from './adminApi.ts';
import { mergeFlowSets, planDeployment, summarizePlan, type Plan } from './plan.ts';
import { createReceipt, writeReceipt, type Receipt } from './receipt.ts';

export type ApplyAbortReason = 'validation' | 'version-mismatch' | 'unauthorized' | 'unreachable' | 'no-op';

export interface ApplyOptions {
  readonly client: AdminApiClient;
  readonly target: string;
  readonly desired: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
  readonly owned: ReadonlySet<string>;
  readonly ownedEntities?: ReadonlySet<string>;
  readonly prune?: boolean;
  /** Problems from the validation gate; errors abort the deploy. */
  readonly problems?: readonly Problem[];
  /** Bounded retries when the revision moved under us. */
  readonly maxRetries?: number;
  /** Write the reverse operation here so `rollback` can undo this deploy. */
  readonly receiptPath?: string;
  /** Compute the plan but do not write anything. */
  readonly dryRun?: boolean;
  readonly now?: () => Date;
}

export interface ApplyResult {
  readonly applied: boolean;
  readonly reason?: ApplyAbortReason;
  readonly plan: Plan;
  readonly rev: string;
  readonly receipt?: Receipt;
  readonly message: string;
}

const DEFAULT_RETRIES = 3;

export async function applyDeployment(options: ApplyOptions): Promise<ApplyResult> {
  const problems = options.problems ?? [];
  if (hasErrors(problems)) {
    return {
      applied: false,
      reason: 'validation',
      plan: planDeployment({
        target: options.target,
        rev: '',
        current: { subflows: [], configs: [], flows: [], loose: [], modules: {} },
        desired: options.desired,
        palette: options.palette,
        owned: options.owned,
        problems,
      }),
      rev: '',
      message: `refusing to deploy: ${problems.filter((problem) => problem.severity === 'error').length} validation error(s)`,
    };
  }

  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let state;
    try {
      state = await options.client.readFlows();
    } catch (cause) {
      return abortFromError(cause, 'unreachable');
    }

    const current = parseCurrent(state.flows, options.palette);
    const plan = planDeployment({
      target: options.target,
      rev: state.rev,
      current,
      desired: options.desired,
      palette: options.palette,
      owned: options.owned,
      ...(options.ownedEntities === undefined ? {} : { ownedEntities: options.ownedEntities }),
      ...(options.prune === undefined ? {} : { prune: options.prune }),
      problems,
    });

    if (options.dryRun === true) {
      return { applied: false, reason: 'no-op', plan, rev: state.rev, message: 'dry run: nothing was written' };
    }

    const merged = mergeFlowSets(current, options.desired, {
      owned: options.owned,
      ownedEntities: options.ownedEntities ?? new Set(),
      prune: options.prune === true,
    });
    const payload = JSON.parse(emitFlowSet(merged.flowSet, { palette: options.palette })) as unknown[];

    try {
      const deployed = await options.client.writeFlows(payload, state.rev);
      const receipt = createReceipt({
        target: options.target,
        url: options.client.url,
        previousRev: state.rev,
        previousFlows: state.flows,
        deployedRev: deployed.rev,
        deployedAt: (options.now ?? (() => new Date()))().toISOString(),
        summary: describePlan(plan),
      });
      if (options.receiptPath !== undefined) await writeReceipt(options.receiptPath, receipt);

      return {
        applied: true,
        plan,
        rev: deployed.rev,
        receipt,
        message: `deployed to ${options.client.url}`,
      };
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.code === 'version-mismatch' && attempt <= maxRetries) {
        // Someone else deployed while we were planning: re-read, re-plan, try again.
        continue;
      }
      return abortFromError(cause, 'unreachable');
    }
  }
}

/** Rolls the instance back to the state a receipt recorded. */
export async function rollbackDeployment(
  client: AdminApiClient,
  receipt: Receipt,
): Promise<{ readonly restored: boolean; readonly rev: string; readonly message: string }> {
  try {
    const deployed = await client.writeFlows(receipt.previousFlows, null);
    return { restored: true, rev: deployed.rev, message: `restored ${receipt.previousFlows.length} entries` };
  } catch (cause) {
    const aborted = abortFromError(cause, 'unreachable');
    return { restored: false, rev: '', message: aborted.message };
  }
}

function abortFromError(cause: unknown, fallback: ApplyAbortReason): ApplyResult {
  if (cause instanceof AdminApiError) {
    const reason: ApplyAbortReason =
      cause.code === 'version-mismatch'
        ? 'version-mismatch'
        : cause.code === 'unauthorized' || cause.code === 'forbidden'
          ? 'unauthorized'
          : 'unreachable';
    return {
      applied: false,
      reason,
      plan: emptyPlan(),
      rev: '',
      message: cause.message,
    };
  }
  return {
    applied: false,
    reason: fallback,
    plan: emptyPlan(),
    rev: '',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function emptyPlan(): Plan {
  return { target: '', rev: '', operations: [], unowned: [], deletions: [], problems: [] };
}

function describePlan(plan: Plan): readonly string[] {
  const summary = summarizePlan(plan);
  return Object.entries(summary)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}: ${count}`);
}

/**
 * The current flow set, parsed through the importer. A parse failure is not fatal: an instance
 * may hold entries this build does not understand, and refusing to deploy because of them would
 * be worse than leaving them alone — they are copied through by the merge either way.
 */
function parseCurrent(flows: readonly unknown[], palette: Readonly<Record<string, PaletteType>>): FlowSet {
  try {
    return parseFlowFile(flows, { palette });
  } catch {
    return { subflows: [], configs: [], flows: [], loose: [], modules: {} };
  }
}

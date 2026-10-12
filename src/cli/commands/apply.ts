/**
 * `flowgen apply` — plan, write, record a receipt.
 *
 * The command is built so that every failure mode leaves the instance untouched or reversible:
 *
 * * validation runs first and in `bail` mode — an error stops before a single request is sent;
 * * the write is a compare-and-swap on `rev`, so a deploy that raced another writer is refused
 *   (`409`), re-planned against the new state, and retried a bounded number of times;
 * * `--expect-rev` turns "deploy this on top of exactly that revision" into an explicit
 *   precondition for pipelines that read the revision earlier;
 * * a receipt is written next to the deploy, which is what makes `rollback` possible;
 * * the lockfile grows ownership of the containers that were written — never anything else.
 */

import path from 'node:path';

import { applyDeployment } from '../../io/apply.ts';
import { writtenContainers } from '../../io/plan.ts';
import { updateLockfile, type Lockfile } from '../../io/lockfile.ts';
import type { Problem } from '../../diagnostics/index.ts';

import { flag, text, texts, type OptionSpec } from '../args.ts';
import {
  appliedSummary,
  checkPaletteDrift,
  combineOutcomes,
  describePlan,
  failureOutcome,
  selectedTargets,
  TARGET_OPTIONS,
  type TargetOutcome,
} from '../deploy.ts';
import { CliFailure, EXIT, exitCodeForApplyReason, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject, pruneRequested, writeLockfile, type Project } from '../project.ts';
import { adminClientFor, ownership, prepare, type ResolvedTarget } from '../pipeline.ts';
import { paletteData } from './plan.ts';
import type { CliContext } from '../context.ts';
import type { ParsedArgs } from '../args.ts';

export const APPLY_OPTIONS: readonly OptionSpec[] = [
  ...TARGET_OPTIONS,
  { name: 'prune', kind: 'boolean', description: 'remove our containers that the sources no longer define' },
  { name: 'no-prune', kind: 'boolean', description: 'never delete anything, whatever the config says' },
  { name: 'dry-run', kind: 'boolean', description: 'print the plan and exit without writing' },
  { name: 'reassign', kind: 'boolean', description: 'give a container a fresh id when its id already exists and is not ours' },
  { name: 'adopt', kind: 'string', placeholder: '<id>', multiple: true, description: 'take ownership of a container that already exists on the target, without redeploying it (repeatable)' },
  { name: 'expect-rev', kind: 'string', placeholder: '<rev>', description: 'refuse to deploy unless the instance is at this revision' },
  { name: 'receipt', kind: 'string', placeholder: '<file>', description: 'where to write the reverse operation' },
  { name: 'no-receipt', kind: 'boolean', description: 'do not write a receipt (rollback will not be possible)' },
  { name: 'max-retries', kind: 'string', placeholder: '<n>', description: 'how many times to re-plan after a revision conflict (default 3)' },
  { name: 'diff-geometry', kind: 'boolean', description: 'include x/y/w/h in the plan diff' },
  { name: 'no-palette-check', kind: 'boolean', description: 'skip the live-palette drift warning' },
  { name: 'all-targets', kind: 'boolean', description: 'deploy to every configured target, one after another' },
];

export const APPLY_USAGE: readonly string[] = ['apply [options]', 'apply --all-targets'];

export async function applyCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const targets = selectedTargets(context, project, args, {
    target: text(args, 'target'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    profile: text(args, 'profile'),
  });

  // The lockfile is one file for every target, so the loop has to carry the version it has already
  // written: `project.lockfile` is the file as it was read at startup, and a second target writing
  // from that snapshot would drop the first target's ownership.
  let lockfile = project.lockfile;
  const outcomes: TargetOutcome[] = [];
  for (const target of targets) {
    // A read-only target is a *config* decision, and `--all-targets` is a request to deploy
    // everywhere: the config wins, and the instance is reported as skipped rather than failing the
    // fan-out. Naming that target explicitly is still an error — that request contradicts itself.
    if (targets.length > 1 && target.readOnly) {
      outcomes.push({
        name: target.name,
        url: target.url,
        exitCode: EXIT.ok,
        diagnostics: [],
        messages: lines(`skipped: target "${target.name}" is marked readOnly in flowgen.config.ts`),
        data: { target: target.name, url: target.url, applied: false, skipped: 'readOnly' },
      });
      continue;
    }
    try {
      const applied = await applyTarget(context, { ...project, lockfile }, args, target);
      lockfile = applied.lockfile;
      outcomes.push(applied.outcome);
    } catch (cause) {
      // One target fails loudly; a fan-out reports that target and carries on, because stopping at
      // the first unreachable instance would leave every later one undeployed and unreported.
      if (targets.length === 1) throw cause;
      outcomes.push(failureOutcome(target, cause));
    }
  }
  return combineOutcomes('apply', outcomes);
}

/** One target's outcome plus the lockfile as it now stands, for the next target in a fan-out. */
interface AppliedTarget {
  readonly outcome: TargetOutcome;
  readonly lockfile: Lockfile;
}

async function applyTarget(
  context: CliContext,
  project: Project,
  args: ParsedArgs,
  target: ResolvedTarget,
): Promise<AppliedTarget> {
  const prepared = await prepare(context, project, {
    palette: { profile: target.profile, paletteFile: text(args, 'palette'), offline: true },
    target,
    mode: 'bail',
  });

  if (prepared.report.hasErrors) {
    return {
      lockfile: project.lockfile,
      outcome: {
        name: target.name,
        url: target.url,
        exitCode: EXIT.problems,
        diagnostics: prepared.report.problems,
        skipped: prepared.report.skipped,
        messages: lines('refusing to deploy: the sources do not validate'),
        data: { target: target.name, url: target.url, applied: false, palette: paletteData(prepared, undefined) },
      },
    };
  }

  if (target.readOnly) {
    throw new CliFailure(EXIT.usage, `target "${target.name}" is marked readOnly`, 'remove readOnly from flowgen.config.ts to deploy to it');
  }

  const prune = pruneRequested(args, target.prune);
  const dryRun = flag(args, 'dry-run');
  // The client is created here, but the instance is not read: `applyDeployment` reads, plans and
  // writes under one compare-and-swap, so an extra read would only be a plan that goes stale.
  const client = adminClientFor(context, target);

  const expectRev = text(args, 'expect-rev');
  if (expectRev !== undefined) {
    const state = await readState(client, target);
    if (state.rev !== expectRev) {
      const diagnostic: Problem = {
        code: 'deploy/version-mismatch',
        severity: 'error',
        entity: target.name,
        path: 'rev',
        message: `expected revision ${expectRev}, the instance is at ${state.rev}`,
        hint: 'someone else deployed; re-run `flowgen plan` and review the difference',
      };
      return {
        lockfile: project.lockfile,
        outcome: {
          name: target.name,
          url: target.url,
          exitCode: EXIT.conflict,
          diagnostics: [diagnostic],
          messages: lines(`refusing to deploy to "${target.name}": revision moved`),
          data: { target: target.name, url: target.url, applied: false, expectedRev: expectRev, rev: state.rev },
        },
      };
    }
  }

  // Every path in the CLI resolves against the project root, never against the shell's current
  // directory: `--receipt` used to be taken verbatim, so a relative path wrote the receipt
  // wherever the command happened to be run from - losing the undo record of a real deploy.
  const requestedReceipt = text(args, 'receipt');
  const receiptPath =
    dryRun || flag(args, 'no-receipt')
      ? undefined
      : requestedReceipt === undefined
        ? defaultReceiptPath(project.receiptsDir, target, context)
        : path.resolve(project.root, requestedReceipt);
  const maxRetries = readRetries(text(args, 'max-retries'));
  const adopt = texts(args, 'adopt');
  const { owned, ids } = ownership(project, target);

  const result = await applyDeployment({
    client,
    target: target.name,
    desired: prepared.built.flowSet,
    palette: prepared.built.palette,
    owned,
    ownedEntities: ids,
    prune,
    ...(flag(args, 'reassign') ? { reassign: true } : {}),
    ...(adopt.length === 0 ? {} : { adopt }),
    problems: prepared.report.problems,
    ...(receiptPath === undefined ? {} : { receiptPath }),
    ...(dryRun ? { dryRun: true } : {}),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    now: context.now,
  });

  const drift = flag(args, 'no-palette-check') ? { checked: false, liveHash: null as string | null, problems: [] } : await checkPaletteDrift(context, target, prepared.palette.snapshot);
  const abortDiagnostics = result.applied || result.reason === 'no-op' || result.reason === 'validation' ? [] : abortProblems(result.reason, result.message, target);
  const receiptDiagnostics: readonly Problem[] =
    result.receiptError === undefined
      ? []
      : [
          {
            code: 'deploy/receipt-failed',
            severity: 'warn',
            entity: target.name,
            path: 'receipt',
            message: `the flow set was deployed, but the receipt could not be written: ${result.receiptError}`,
            hint: 'the deploy is live; without a receipt `flowgen rollback` cannot undo it',
          },
        ];
  // `plan.problems` carries the validation gate *and* the plan's own findings (an id collision, an
  // adoption that named nothing); leaving them out made a refused update look like a deploy.
  const diagnostics = [...drift.problems, ...abortDiagnostics, ...receiptDiagnostics, ...result.plan.problems];

  // Adoption is a lockfile operation, so a takeover that changes nothing on the instance still has
  // to be recorded: `--adopt orders` on sources that already match is a no-op deploy whose whole
  // point was the ownership. Every other no-op keeps the lockfile untouched.
  const adopted = result.plan.adopted;
  const recordOwnership = !dryRun && (result.applied || (result.reason === 'no-op' && adopted.length > 0));
  let lockfileWritten: string | null = null;
  let nextLockfile = project.lockfile;
  if (recordOwnership) {
    const updated = updateLockfile(project.lockfile, {
      target: target.name,
      url: target.url,
      paletteProfile: target.profile,
      paletteHash: prepared.palette.snapshot.contentHash,
      keys: prepared.built.keys,
      // The *payload*, not the sources — a container deployed under a reassigned id has to be
      // recorded under the id that actually exists now — but never the containers we only copied
      // through, or the next `--prune` would delete somebody else's tab. Adopted containers are in
      // the payload and not in `unowned`, which is exactly how they end up recorded.
      containers: writtenContainers(result.plan),
    });
    await writeLockfile(project.lockfilePath, updated);
    nextLockfile = updated;
    lockfileWritten = path.relative(project.root, project.lockfilePath) || project.lockfilePath;
  }

  const exitCode = result.applied ? EXIT.ok : exitCodeForApplyReason(result.reason ?? 'unreachable');

  return {
    lockfile: nextLockfile,
    outcome: {
      name: target.name,
      url: target.url,
      exitCode,
      diagnostics,
      skipped: prepared.report.skipped,
      messages: lines(
        `${dryRun ? 'dry run for' : 'deploying to'} target "${target.name}" at ${target.url} (rev ${result.rev === '' ? '(none)' : result.rev.slice(0, 12)}, prune ${prune ? 'on' : 'off'})`,
        ...describePlan(result.plan),
        result.applied ? appliedSummary(result.plan) : result.message,
        result.receiptError !== undefined ? `receipt not written: ${result.receiptError}` : null,
        result.receipt === undefined || result.receiptError !== undefined
          ? null
          : `receipt: ${path.relative(project.root, receiptPath ?? '') || receiptPath} (rollback with \`flowgen rollback --receipt ${path.relative(project.root, receiptPath ?? '') || receiptPath}\`)`,
        adopted.length === 0
          ? null
          : `adopted ${adopted.length} container(s): ${adopted.join(', ')}${result.applied ? '' : ' (nothing was written to the instance)'}`,
        lockfileWritten === null ? null : `lockfile updated: ${lockfileWritten}`,
        flag(args, 'no-palette-check') || !drift.checked || drift.problems.length === 0 ? null : 'palette: the instance differs from the pinned snapshot — see the warning above',
      ),
      data: {
        target: target.name,
        url: target.url,
        applied: result.applied,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.receiptError === undefined ? {} : { receiptError: result.receiptError }),
        dryRun,
        prune,
        rev: result.rev,
        plan: result.plan,
        ...(result.receipt === undefined || result.receiptError === undefined
          ? {}
          : { receipt: result.receipt, receiptPath: receiptPath === undefined ? null : path.relative(project.root, receiptPath) || receiptPath }),
        lockfile: lockfileWritten,
        adopted,
        palette: paletteData(prepared, drift.liveHash),
      },
    },
  };
}

function abortProblems(reason: string | undefined, message: string, target: ResolvedTarget): readonly Problem[] {
  if (reason === 'version-mismatch') {
    return [
      {
        code: 'deploy/version-mismatch',
        severity: 'error',
        entity: target.name,
        path: 'rev',
        message,
        hint: 'somebody deployed while we were planning; re-run `flowgen plan` and review the difference',
      },
    ];
  }
  return [
    {
      code: 'deploy/unreachable',
      severity: 'error',
      entity: target.name,
      path: 'url',
      message,
      hint: 'check that the instance is running and that the token may write',
    },
  ];
}

function readRetries(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`--max-retries expects a non-negative integer, got "${raw}"`);
  return value;
}

function defaultReceiptPath(receiptsDir: string, target: ResolvedTarget, context: CliContext): string {
  const stamp = context.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return path.join(receiptsDir, `${target.name}-${stamp}.json`);
}

async function readState(client: { readFlows(): Promise<{ rev: string }> }, target: ResolvedTarget): Promise<{ rev: string }> {
  try {
    return await client.readFlows();
  } catch (cause) {
    throw new CliFailure(EXIT.unreachable, `cannot read flows from ${target.url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

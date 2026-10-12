/**
 * `flowgen rollback` — put the instance back the way a receipt recorded it.
 *
 * Every `apply` writes a receipt holding the *previous* flow set and revision, so undoing a
 * deploy is a write of that payload and nothing else: no reconstruction, no guessing. The write
 * deliberately does not use compare-and-swap — a rollback is an explicit "make it like this",
 * and refusing it because somebody else touched the instance would defeat the purpose.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { rollbackDeployment } from '../../io/apply.ts';
import { readReceiptFile, type Receipt } from '../../io/receipt.ts';

import { flag, text, type OptionSpec } from '../args.ts';
import { envToken, type CliContext } from '../context.ts';
import { CliFailure, EXIT, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { adminClientFor, resolveTarget } from '../pipeline.ts';
import { loadProject, type Project } from '../project.ts';
import type { ParsedArgs } from '../args.ts';
import type { ResolvedTarget } from '../pipeline.ts';

export const ROLLBACK_OPTIONS: readonly OptionSpec[] = [
  { name: 'receipt', kind: 'string', placeholder: '<file>', description: 'receipt written by `apply`' },
  { name: 'last', kind: 'boolean', description: 'use the most recent receipt in the receipts directory' },
  { name: 'target', kind: 'string', alias: 't', placeholder: '<name>', description: 'configured target to roll back' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance URL, overriding the receipt' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile (used only to resolve configured targets)' },
];

export const ROLLBACK_USAGE: readonly string[] = [
  'rollback --receipt <file> [options]',
  'rollback --last [--target <name>] [options]',
];

export async function rollbackCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const requested = text(args, 'receipt');
  const useLast = flag(args, 'last');

  if (requested === undefined && !useLast) {
    throw new UsageError('rollback needs a receipt', 'pass --receipt <file>, or --last to use the most recent one');
  }
  if (requested !== undefined && useLast) {
    throw new UsageError('--receipt and --last are mutually exclusive');
  }

  const receiptFile =
    requested !== undefined
      ? path.resolve(project.root, requested)
      : await latestReceipt(project.receiptsDir, text(args, 'target'));

  let receipt: Receipt;
  try {
    receipt = await readReceiptFile(receiptFile);
  } catch (cause) {
    throw new CliFailure(
      EXIT.usage,
      `cannot read the receipt ${path.relative(project.root, receiptFile) || receiptFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'receipts are written by `flowgen apply`; check the path and the file contents',
    );
  }

  const target = resolveRollbackTarget(context, project, args, receipt);
  const relative = path.relative(project.root, receiptFile) || receiptFile;
  const result = await rollbackDeployment(adminClientFor(context, target), receipt);

  if (!result.restored) {
    return {
      command: 'rollback',
      exitCode: EXIT.unreachable,
      diagnostics: [
        {
          code: 'deploy/unreachable',
          severity: 'error',
          entity: target.name,
          path: 'url',
          message: result.message,
          hint: 'check that the instance is running and that the token may write',
        },
      ],
      messages: lines(`rollback failed for target "${target.name}" at ${target.url}`, `receipt: ${relative} (deployed ${receipt.deployedAt})`),
      data: { target: target.name, url: target.url, receipt: relative, restored: false },
    };
  }

  return {
    command: 'rollback',
    exitCode: EXIT.ok,
    diagnostics: [],
    messages: lines(
      `rolled back target "${target.name}" at ${target.url} to revision ${result.rev === '' ? '(none)' : result.rev.slice(0, 12)}`,
      `restored ${receipt.previousFlows.length} entries from ${relative} (deployed ${receipt.deployedAt})`,
      result.message,
    ),
    data: {
      target: target.name,
      url: target.url,
      receipt: relative,
      restored: true,
      rev: result.rev,
      entries: receipt.previousFlows.length,
      previousRev: receipt.previousRev,
      deployedAt: receipt.deployedAt,
    },
  };
}

/**
 * Target resolution for a rollback: the receipt already names where it came from, so an explicit
 * flag wins, a configured target of the same name comes next, and the receipt's own URL is the
 * fallback. That keeps `flowgen rollback --last` working in a project whose config has changed.
 */
function resolveRollbackTarget(context: CliContext, project: Project, args: ParsedArgs, receipt: Receipt): ResolvedTarget {
  const named = text(args, 'target') ?? (project.config.targets[receipt.target] === undefined ? undefined : receipt.target);
  const url = text(args, 'url');

  if (named !== undefined || url !== undefined || project.config.targets[receipt.target] !== undefined) {
    return resolveTarget(context, project, {
      target: named,
      url,
      token: text(args, 'token'),
      tokenEnv: text(args, 'token-env'),
      profile: text(args, 'profile'),
    });
  }

  return {
    name: receipt.target,
    url: receipt.url,
    token: text(args, 'token') ?? envToken(context, text(args, 'token-env') ?? 'FLOWGEN_TOKEN'),
    profile: text(args, 'profile') ?? project.config.defaultProfile,
    prune: undefined,
    readOnly: false,
  };
}

async function latestReceipt(receiptsDir: string, target: string | undefined): Promise<string> {
  let entries: readonly string[];
  try {
    entries = await readdir(receiptsDir);
  } catch {
    throw new UsageError(`no receipts in ${receiptsDir}`, 'pass --receipt <file>, or run `flowgen apply` first');
  }

  const candidates = entries
    .filter((entry) => entry.endsWith('.json'))
    .filter((entry) => target === undefined || entry.startsWith(`${target}-`))
    .sort()
    .reverse();

  const newest = candidates[0];
  if (newest === undefined) {
    throw new UsageError(
      target === undefined ? `no receipts in ${receiptsDir}` : `no receipts for target "${target}" in ${receiptsDir}`,
      'run `flowgen apply` first, or pass --receipt <file>',
    );
  }
  return path.join(receiptsDir, newest);
}

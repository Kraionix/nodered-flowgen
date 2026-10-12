/**
 * `flowgen palette pull` — read the deployed palette and commit it as a snapshot.
 *
 * The snapshot is the project's pinned truth: generated types, validation and the plan all read
 * it, so that a build does not depend on an instance being up. Pulling is therefore the one
 * command that *must* talk to a source — a `pull` that silently reread the file it was about to
 * write would look like success while pinning nothing.
 */

import path from 'node:path';

import { describePalette } from '../../palette/snapshot.ts';
import { writeSnapshotFile } from '../../palette/sources/snapshot.ts';

import { flag, text, type OptionSpec } from '../args.ts';
import { CliFailure, EXIT, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject } from '../project.ts';
import { planPalette } from '../palette.ts';
import type { CliContext } from '../context.ts';
import type { ParsedArgs } from '../args.ts';

export const PALETTE_PULL_OPTIONS: readonly OptionSpec[] = [
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile to pull (default: the project default)' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'write the snapshot here instead of the profile path' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance to read the palette from' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'offline', kind: 'boolean', description: 'read an installation on disk instead of an instance' },
  { name: 'types', kind: 'boolean', description: 'regenerate the TypeScript augmentations afterwards' },
];

export const PALETTE_PULL_USAGE: readonly string[] = ['palette pull [options]'];

export async function palettePullCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const plan = planPalette(context, project, {
    profile: text(args, 'profile'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    offline: flag(args, 'offline'),
  });

  if (plan.origin === 'snapshot') {
    throw new UsageError(
      `profile "${plan.profile.name}" has no source to pull from`,
      'pass --url <http://host:port>, or set palette.profiles.<name>.url / .coreNodesDir in flowgen.config.ts',
    );
  }

  let snapshot;
  try {
    snapshot = await plan.source.load();
  } catch (cause) {
    throw new CliFailure(
      EXIT.unreachable,
      `cannot read the palette from ${plan.url ?? plan.profile.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'check the URL and the token; `flowgen validate --palette <file>` works without an instance',
    );
  }

  const outputFile = path.resolve(project.root, text(args, 'palette') ?? plan.profile.snapshotPath);
  const written = await writeSnapshotFile(outputFile, snapshot);
  const summary = describePalette(snapshot);
  const relative = path.relative(project.root, outputFile) || outputFile;
  const modules = summary.modules.map((module) => `${module.module}@${module.version}`).join(', ');

  const messages = lines(
    `pulled ${summary.typeCount} types from ${summary.nodeSetCount} node sets (${plan.origin}${plan.url === null ? '' : ` ${plan.url}`})`,
    `node-red ${summary.nodeRedVersion ?? 'unknown'}; ${modules}`,
    `snapshot ${written.status === 'unchanged' ? 'unchanged' : 'written'}: ${relative} (${written.bytes} bytes, ${snapshot.contentHash})`,
  );

  const data: Record<string, unknown> = {
    profile: plan.profile.name,
    origin: plan.origin,
    url: plan.url,
    snapshot: relative,
    status: written.status,
    bytes: written.bytes,
    contentHash: snapshot.contentHash,
    palette: summary,
  };

  if (flag(args, 'types')) {
    const { typesGenCommand } = await import('./typesGen.ts');
    const generated = await typesGenCommand(context, args);
    return {
      command: 'palette pull',
      exitCode: generated.exitCode,
      diagnostics: generated.diagnostics,
      messages: [...messages, ...generated.messages],
      data: { ...data, types: generated.data ?? {} },
    };
  }

  return { command: 'palette pull', exitCode: EXIT.ok, diagnostics: [], messages, data };
}

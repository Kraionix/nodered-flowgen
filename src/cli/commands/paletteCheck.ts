/**
 * `flowgen palette check` — has the instance drifted from the pinned snapshot?
 *
 * This is the check that keeps "works on my machine" out of a deploy: the source is validated
 * and emitted against the committed snapshot, so if the target's palette has moved (a node
 * upgraded, a node set enabled, a property added), the generated flow set was written against
 * something the instance no longer runs. Drift is reported per type, with reasons, and exits `1`.
 */

import path from 'node:path';

import { diffPalette, describePalette, type PaletteSnapshot } from '../../palette/snapshot.ts';
import { readSnapshotFile } from '../../palette/sources/snapshot.ts';
import type { Problem } from '../../diagnostics/index.ts';

import { flag, text, type OptionSpec } from '../args.ts';
import { CliFailure, EXIT, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject } from '../project.ts';
import { planPalette } from '../palette.ts';
import type { CliContext } from '../context.ts';
import type { ParsedArgs } from '../args.ts';

export const PALETTE_CHECK_OPTIONS: readonly OptionSpec[] = [
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile to check (default: the project default)' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'snapshot to compare against' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance to compare with' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'offline', kind: 'boolean', description: 'compare against an installation on disk' },
];

export const PALETTE_CHECK_USAGE: readonly string[] = ['palette check [options]'];

export async function paletteCheckCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const plan = planPalette(context, project, {
    profile: text(args, 'profile'),
    paletteFile: text(args, 'palette'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    offline: flag(args, 'offline'),
  });
  const snapshotFile = plan.snapshotFile;

  if (plan.origin === 'snapshot') {
    throw new UsageError(
      `profile "${plan.profile.name}" has nothing to compare against`,
      'pass --url <http://host:port> (or --offline with a local installation configured)',
    );
  }

  let pinned: PaletteSnapshot;
  try {
    pinned = await readSnapshotFile(snapshotFile);
  } catch (cause) {
    throw new CliFailure(
      EXIT.usage,
      `cannot read the pinned snapshot ${path.relative(project.root, snapshotFile) || snapshotFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'run `flowgen palette pull` first',
    );
  }

  let fresh: PaletteSnapshot;
  try {
    fresh = await plan.source.load();
  } catch (cause) {
    throw new CliFailure(
      EXIT.unreachable,
      `cannot read the palette from ${plan.url ?? plan.profile.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'check the URL and the token',
    );
  }

  const diff = diffPalette(pinned, fresh);
  const relative = path.relative(project.root, snapshotFile) || snapshotFile;
  const summary = describePalette(fresh);

  if (diff.identical) {
    return {
      command: 'palette check',
      exitCode: EXIT.ok,
      diagnostics: [],
      messages: lines(
        `palette matches: ${summary.typeCount} types, ${summary.nodeSetCount} node sets (${fresh.contentHash})`,
        `pinned in ${relative}`,
      ),
      data: { profile: plan.profile.name, origin: plan.origin, url: plan.url, snapshot: relative, identical: true, palette: summary },
    };
  }

  const diagnostics: Problem[] = [
    ...diff.added.map((id) => drift(id, `the instance has a node type the snapshot does not: ${id}`, 'run `flowgen palette pull` and commit the result')),
    ...diff.removed.map((id) => drift(id, `the snapshot has a node type the instance no longer provides: ${id}`, 'install the missing node module, or pull a new snapshot')),
    ...diff.changed.map((change) => drift(change.id, `node type changed: ${change.reasons.join('; ')}`, 'review the change, then `flowgen palette pull`')),
    ...diff.nodeSets.map((change) =>
      drift(change.id, `node set ${change.kind}: ${change.from ?? '(absent)'} → ${change.to ?? '(absent)'}${change.reasons === undefined ? '' : ` (${change.reasons.join('; ')})`}`, 'run `flowgen palette pull` and commit the result'),
    ),
  ];

  return {
    command: 'palette check',
    exitCode: EXIT.problems,
    diagnostics,
    messages: lines(
      `palette drift: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.nodeSets.length} node set(s)`,
      `pinned ${pinned.contentHash} (${relative}), instance ${fresh.contentHash}`,
    ),
    data: {
      profile: plan.profile.name,
      origin: plan.origin,
      url: plan.url,
      snapshot: relative,
      identical: false,
      pinnedHash: pinned.contentHash,
      liveHash: fresh.contentHash,
      diff,
    },
  };
}

function drift(entity: string, message: string, hint: string): Problem {
  return { code: 'palette/module-version-drift', severity: 'error', entity, path: '', message, hint };
}

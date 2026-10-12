/**
 * `flowgen validate` — check the sources against the palette, without touching anything.
 *
 * This is the gate CI runs on every pull request. It never needs an instance (the palette comes
 * from the committed snapshot), and it reports what it could *not* check as loudly as what it
 * did: a validator whose capability is missing appears in `skipped`, so "green" never means
 * "silently checked less".
 */

import { eachNode } from '../../model/entities.ts';
import { describePalette } from '../../palette/snapshot.ts';
import type { Problem } from '../../diagnostics/index.ts';

import { flag, text, type OptionSpec } from '../args.ts';
import { EXIT, UsageError } from '../exit.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject } from '../project.ts';
import { prepare } from '../pipeline.ts';
import type { CliContext } from '../context.ts';
import type { ParsedArgs } from '../args.ts';

export const VALIDATE_OPTIONS: readonly OptionSpec[] = [
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile (default: the project default)' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'snapshot to validate against' },
  { name: 'live', kind: 'boolean', description: 'allow validators that need a reachable instance to run' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance for validators that need one' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
];

export const VALIDATE_USAGE: readonly string[] = ['validate [options]'];

export async function validateCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);

  // The palette always comes from the committed snapshot: a validation that changed its mind
  // depending on which instance happened to be reachable would not be a gate. `--live` only
  // grants validators the capability to reach an instance.
  const live = flag(args, 'live');
  const liveUrl = text(args, 'url');
  if (live && liveUrl === undefined) {
    throw new UsageError('--live needs --url <url>', 'pass the instance validators should reach');
  }

  const prepared = await prepare(context, project, {
    palette: {
      profile: text(args, 'profile'),
      paletteFile: text(args, 'palette'),
      offline: true,
    },
    ...(live && liveUrl !== undefined
      ? {
          target: {
            name: 'cli',
            url: liveUrl,
            token: text(args, 'token'),
            profile: text(args, 'profile') ?? project.config.defaultProfile,
            prune: undefined,
            readOnly: false,
          },
        }
      : {}),
    mode: 'collect',
  });

  // Every node, not just the tabs': a number that ignores subflow bodies and containerless nodes
  // reads as "we validated less than you think", and it moves when nothing visible changed.
  const nodes = eachNode(prepared.built.flowSet).length;
  const problems: readonly Problem[] = prepared.report.problems;
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const summary = describePalette(prepared.palette.snapshot);

  return {
    command: 'validate',
    exitCode: prepared.report.hasErrors ? EXIT.problems : EXIT.ok,
    diagnostics: problems,
    skipped: prepared.report.skipped,
    messages: lines(
      `checked ${prepared.built.flowSet.flows.length} tab(s)/${prepared.built.flowSet.subflows.length} subflow(s), ${nodes} node(s) against ${summary.typeCount} types (${prepared.palette.snapshot.contentHash})`,
      prepared.built.duplicateKeys.length === 0
        ? null
        : `authoring keys reused (each got its own id): ${prepared.built.duplicateKeys.join(', ')}`,
      `${prepared.report.ran.length} validator(s) ran, ${prepared.report.skipped.length} skipped; ${errors} error(s), ${problems.length - errors} other`,
    ),
    data: {
      report: {
        problems,
        skipped: prepared.report.skipped,
        ran: prepared.report.ran,
        hasErrors: prepared.report.hasErrors,
      },
      flowSet: {
        tabs: prepared.built.flowSet.flows.map((flow) => flow.id),
        subflows: prepared.built.flowSet.subflows.map((subflow) => subflow.id),
        configs: prepared.built.flowSet.configs.map((config) => config.id),
        nodes,
      },
      palette: {
        profile: prepared.palette.profile.name,
        origin: prepared.palette.origin,
        contentHash: prepared.palette.snapshot.contentHash,
        typeCount: summary.typeCount,
        nodeRedVersion: summary.nodeRedVersion,
      },
    },
  };
}

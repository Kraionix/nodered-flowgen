/**
 * `flowgen types gen` — snapshot → committed TypeScript augmentations.
 *
 * Generation is deterministic and idempotent, so the generated files are committed and a fresh
 * clone type-checks without a reachable Node-RED. The command therefore reads the *snapshot* by
 * default and only goes to an instance with `--live`; `--check` verifies that what is committed
 * matches what would be generated, which is the CI guard against editing a flow against a stale
 * palette.
 */

import path from 'node:path';

import { emitCheatSheet } from '../../palette/codegen/emitSnapshot.ts';
import { emitTypes } from '../../palette/codegen/emitTypes.ts';
import type { Problem } from '../../validate/problem.ts';

import { flag, text, type OptionSpec } from '../args.ts';
import { EXIT } from '../exit.ts';
import { isCurrent, summarizeWrites, writeIfChanged, type WriteOutcome } from '../files.ts';
import { lines, type CommandResult } from '../output.ts';
import { loadProject } from '../project.ts';
import { loadPalette } from '../palette.ts';
import type { CliContext } from '../context.ts';
import type { ParsedArgs } from '../args.ts';

export const TYPES_GEN_OPTIONS: readonly OptionSpec[] = [
  { name: 'profile', kind: 'string', placeholder: '<name>', description: 'palette profile (default: the project default)' },
  { name: 'palette', kind: 'string', placeholder: '<file>', description: 'snapshot to generate from' },
  { name: 'out', kind: 'string', placeholder: '<dir>', description: 'output directory for the augmentations' },
  { name: 'cheatsheet', kind: 'string', placeholder: '<file>', description: 'where to write the Markdown cheat sheet' },
  { name: 'no-cheatsheet', kind: 'boolean', description: 'do not write the cheat sheet' },
  { name: 'package', kind: 'string', placeholder: '<name>', description: 'module specifier the files augment' },
  { name: 'live', kind: 'boolean', description: 'read the palette from the configured instance instead of the snapshot' },
  { name: 'url', kind: 'string', placeholder: '<url>', description: 'instance to read the palette from' },
  { name: 'token', kind: 'string', placeholder: '<token>', description: 'admin API bearer token' },
  { name: 'token-env', kind: 'string', placeholder: '<VAR>', description: 'environment variable holding the token' },
  { name: 'check', kind: 'boolean', description: 'verify the generated files are current; write nothing' },
];

export const TYPES_GEN_USAGE: readonly string[] = ['types gen [options]'];

export async function typesGenCommand(context: CliContext, args: ParsedArgs): Promise<CommandResult> {
  const project = await loadProject(context, args);
  const palette = await loadPalette(context, project, {
    profile: text(args, 'profile'),
    paletteFile: text(args, 'palette'),
    url: text(args, 'url'),
    token: text(args, 'token'),
    tokenEnv: text(args, 'token-env'),
    // Types are generated from the committed snapshot unless the caller asks for the instance:
    // a build step that silently depends on a running Node-RED is not reproducible.
    offline: !flag(args, 'live'),
  });

  const directory = text(args, 'out') ?? palette.profile.typesPath;
  const packageName = text(args, 'package') ?? palette.profile.packageName;
  const files = emitTypes(palette.snapshot, { directory, packageName });

  const cheatSheetFile = flag(args, 'no-cheatsheet')
    ? null
    : (text(args, 'cheatsheet') ?? palette.profile.cheatSheetPath);
  const cheatSheet = cheatSheetFile === null ? null : emitCheatSheet(palette.snapshot);
  const check = flag(args, 'check');

  const outcomes: WriteOutcome[] = [];
  const stale: string[] = [];

  for (const file of files) {
    const absolute = path.resolve(project.root, file.path);
    if (check) {
      if (!(await isCurrent(absolute, file.content))) stale.push(file.path);
      continue;
    }
    outcomes.push(await writeIfChanged(absolute, file.content));
  }

  if (cheatSheet !== null && cheatSheetFile !== null) {
    const absolute = path.resolve(project.root, cheatSheetFile);
    if (check) {
      if (!(await isCurrent(absolute, cheatSheet))) stale.push(cheatSheetFile);
    } else {
      outcomes.push(await writeIfChanged(absolute, cheatSheet));
    }
  }

  const typeCount = Object.keys(palette.snapshot.types).length;
  const data: Record<string, unknown> = {
    profile: palette.profile.name,
    origin: palette.origin,
    contentHash: palette.snapshot.contentHash,
    directory,
    packageName,
    typeCount,
    files: files.map((file) => file.path),
    ...(cheatSheetFile === null ? {} : { cheatSheet: cheatSheetFile }),
    ...(check ? { current: stale.length === 0, stale } : { writes: outcomes.map((outcome) => ({ path: path.relative(project.root, outcome.path), status: outcome.status })) }),
  };

  if (check) {
    if (stale.length === 0) {
      return {
        command: 'types gen',
        exitCode: EXIT.ok,
        diagnostics: [],
        messages: lines(`generated types are current: ${files.length} files, ${typeCount} types (${palette.snapshot.contentHash})`),
        data,
      };
    }

    const diagnostics: Problem[] = stale.map((file) => ({
      code: 'palette/generated-stale',
      severity: 'error',
      entity: file,
      path: '',
      message: 'generated file is out of date with the palette snapshot',
      hint: 'run `flowgen types gen` and commit the result',
    }));
    return {
      command: 'types gen',
      exitCode: EXIT.problems,
      diagnostics,
      messages: lines(`generated types are stale: ${stale.length} of ${files.length + (cheatSheetFile === null ? 0 : 1)} files`),
      data,
    };
  }

  return {
    command: 'types gen',
    exitCode: EXIT.ok,
    diagnostics: [],
    messages: lines(
      `generated ${typeCount} types from ${palette.profile.name} (${palette.origin}, ${palette.snapshot.contentHash})`,
      summarizeWrites(outcomes, project.root),
      cheatSheetFile === null ? null : `cheat sheet: ${cheatSheetFile}`,
    ),
    data,
  };
}

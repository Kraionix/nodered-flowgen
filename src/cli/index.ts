/**
 * `flowgen` — argv in, exit code out.
 *
 * Two responsibilities, and deliberately no more: turn `argv` into a command invocation, and turn
 * whatever comes back into a process exit code. All the work lives in the command modules, and
 * `runCli` is exported separately from `main` so tests can drive the whole CLI in-process with a
 * captured environment — a subprocess per assertion would make the test suite unusable.
 *
 * This module has **no import side effects**. Invoking the CLI is `bin.ts`'s job, and that
 * separation is what replaced the `import.meta.url === argv[1]` guard, which silently disabled the
 * CLI when it was reached through a symlink — that is, through `node_modules/.bin/flowgen`, which
 * is how npm, npx and pnpm all run an installed bin.
 *
 * Error handling follows the exit-code contract: a `UsageError` is the caller's mistake (`2`), a
 * `CliFailure` carries its own code, and anything else is a defect in this tool (`5`) and is
 * printed with its stack, because hiding it behind "internal error" would make bug reports
 * worthless.
 */

import { parseArgv, flag, GLOBAL_OPTIONS, renderUsage, rejectPositionals, type OptionSpec, type ParsedArgs } from './args.ts';
import { createContext, type CliContext, type CliIo } from './context.ts';
import { CliFailure, EXIT, UsageError, EXIT_DESCRIPTIONS, type ExitCode } from './exit.ts';
import { renderHuman, renderJson, type CommandResult } from './output.ts';
import { APPLY_OPTIONS, APPLY_USAGE, applyCommand } from './commands/apply.ts';
import { INIT_OPTIONS, INIT_USAGE, initCommand } from './commands/init.ts';
import { PALETTE_CHECK_OPTIONS, PALETTE_CHECK_USAGE, paletteCheckCommand } from './commands/paletteCheck.ts';
import { PALETTE_PULL_OPTIONS, PALETTE_PULL_USAGE, palettePullCommand } from './commands/palettePull.ts';
import { PLAN_OPTIONS, PLAN_USAGE, planCommand } from './commands/plan.ts';
import { ROLLBACK_OPTIONS, ROLLBACK_USAGE, rollbackCommand } from './commands/rollback.ts';
import { TYPES_GEN_OPTIONS, TYPES_GEN_USAGE, typesGenCommand } from './commands/typesGen.ts';
import { VALIDATE_OPTIONS, VALIDATE_USAGE, validateCommand } from './commands/validate.ts';

const PROGRAM = 'flowgen';

interface CommandSpec {
  /** Positional path, e.g. `['palette', 'pull']`. */
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: readonly string[];
  readonly options: readonly OptionSpec[];
  readonly run: (context: CliContext, args: ParsedArgs) => Promise<CommandResult>;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    path: ['init'],
    summary: 'scaffold flowgen.config.ts, ignore entries and (with --pull) the first palette snapshot',
    usage: INIT_USAGE,
    options: INIT_OPTIONS,
    run: initCommand,
  },
  {
    path: ['palette', 'pull'],
    summary: 'read the palette from an instance or an installation and commit it as a snapshot',
    usage: PALETTE_PULL_USAGE,
    options: PALETTE_PULL_OPTIONS,
    run: palettePullCommand,
  },
  {
    path: ['palette', 'check'],
    summary: 'compare the pinned snapshot with the instance, exit 1 on drift',
    usage: PALETTE_CHECK_USAGE,
    options: PALETTE_CHECK_OPTIONS,
    run: paletteCheckCommand,
  },
  {
    path: ['types', 'gen'],
    summary: 'generate the TypeScript augmentations (and cheat sheet) from the snapshot',
    usage: TYPES_GEN_USAGE,
    options: TYPES_GEN_OPTIONS,
    run: typesGenCommand,
  },
  {
    path: ['validate'],
    summary: 'validate the sources against the palette without touching an instance',
    usage: VALIDATE_USAGE,
    options: VALIDATE_OPTIONS,
    run: validateCommand,
  },
  {
    path: ['plan'],
    summary: 'show what apply would change on a target',
    usage: PLAN_USAGE,
    options: PLAN_OPTIONS,
    run: planCommand,
  },
  {
    path: ['apply'],
    summary: 'validate, merge, deploy and write a receipt',
    usage: APPLY_USAGE,
    options: APPLY_OPTIONS,
    run: applyCommand,
  },
  {
    path: ['rollback'],
    summary: 'restore an instance from a receipt written by apply',
    usage: ROLLBACK_USAGE,
    options: ROLLBACK_OPTIONS,
    run: rollbackCommand,
  },
];

export interface RunOptions extends CliIo {
  readonly argv: readonly string[];
}

/** Runs one CLI invocation and returns its exit code. Never throws. */
export async function runCli(options: RunOptions): Promise<ExitCode> {
  const context = createContext(options);
  const { argv } = options;

  let result: CommandResult;
  try {
    result = await dispatch(context, argv);
  } catch (cause) {
    const failure = classify(cause);
    const payload: CommandResult = {
      command: commandName(argv),
      exitCode: failure.exitCode,
      diagnostics: [],
      messages: [failure.message, ...(failure.hint === undefined ? [] : [`hint: ${failure.hint}`])],
    };
    // A failure in `--json` mode still prints JSON, and on stdout: the entire point of the flag
    // is that a pipeline can parse the outcome without caring whether the exit code was zero.
    if (flagOf(argv, '--json')) {
      context.stdout(renderJson(payload));
    } else {
      context.stderr(renderHuman(payload, { quiet: false }));
    }
    if (failure.exitCode === EXIT.internal && cause instanceof Error && cause.stack !== undefined) {
      context.stderr(`${cause.stack}\n`);
    }
    return failure.exitCode;
  }

  const render = flagOf(argv, '--json') ? renderJson(result) : renderHuman(result, { quiet: flagOf(argv, '--quiet') });
  if (render !== '') context.stdout(render);
  return result.exitCode;
}

async function dispatch(context: CliContext, argv: readonly string[]): Promise<CommandResult> {
  const head = argv[0];

  if (head === undefined || head === '--help' || head === '-h' || head === 'help') {
    if (head === undefined) throw new UsageError('no command given', `run \`${PROGRAM} --help\` to see the commands`);
    context.stdout(`${renderHelp()}\n`);
    return { command: 'help', exitCode: EXIT.ok, diagnostics: [], messages: [] };
  }

  const spec = matchCommand(argv);
  if (spec === undefined) throw unknownCommand(argv);

  const consumed = spec.path.length;
  const args = parseArgv(argv.slice(consumed), [...spec.options, ...GLOBAL_OPTIONS]);

  if (flag(args, 'help')) {
    context.stdout(`${renderUsage(PROGRAM, spec.summary, [...spec.options, ...GLOBAL_OPTIONS], [...spec.usage])}\n`);
    return { command: spec.path.join(' '), exitCode: EXIT.ok, diagnostics: [], messages: [] };
  }

  // `init` takes no positional arguments; every other command takes none either, and silently
  // ignoring one is how a typo becomes a wrong deploy.
  rejectPositionals(args, `${PROGRAM} ${spec.usage[0] ?? spec.path.join(' ')}`);

  return spec.run(context, args);
}

function matchCommand(argv: readonly string[]): CommandSpec | undefined {
  let best: CommandSpec | undefined;
  for (const spec of COMMANDS) {
    if (spec.path.every((token, index) => argv[index] === token)) {
      if (best === undefined || spec.path.length > best.path.length) best = spec;
    }
  }
  return best;
}

function unknownCommand(argv: readonly string[]): UsageError {
  const [head, second] = argv;
  const groups = new Map<string, readonly string[]>();
  for (const spec of COMMANDS) {
    const group = spec.path[0] as string;
    const rest = spec.path.slice(1).join(' ');
    groups.set(group, [...(groups.get(group) ?? []), rest]);
  }

  const subcommands = groups.get(head ?? '');
  if (subcommands !== undefined && second !== undefined) {
    return new UsageError(`unknown command "${head} ${second}"`, `known: ${subcommands.map((entry) => `${head} ${entry}`).join(', ')}`);
  }
  return new UsageError(
    head === undefined ? 'no command given' : `unknown command "${head}"`,
    `known commands: ${[...groups.keys()].join(', ')} — run \`${PROGRAM} --help\``,
  );
}

export function renderHelp(): string {
  const lines: string[] = [
    `${PROGRAM} — declarative Node-RED flows: palette-derived types, a canonical emitter, rev-checked deploys`,
    '',
    `usage: ${PROGRAM} <command> [options]`,
    '',
    'commands:',
  ];
  const width = Math.max(...COMMANDS.map((spec) => spec.path.join(' ').length));
  for (const spec of COMMANDS) {
    lines.push(`  ${spec.path.join(' ').padEnd(width)}  ${spec.summary}`);
  }
  lines.push(
    '',
    'global options:',
  );
  const optionWidth = Math.max(...GLOBAL_OPTIONS.map((option) => option.name.length + 4));
  for (const option of GLOBAL_OPTIONS) {
    lines.push(`  --${option.name}`.padEnd(optionWidth + 2) + option.description);
  }
  lines.push(
    '',
    'exit codes:',
    ...(Object.entries(EXIT_DESCRIPTIONS) as [string, string][]).map(([code, description]) => `  ${code}  ${description}`),
    '',
    `run \`${PROGRAM} <command> --help\` for the options of one command.`,
  );
  return lines.join('\n');
}

function classify(cause: unknown): { exitCode: ExitCode; message: string; hint?: string } {
  if (cause instanceof UsageError) {
    return { exitCode: EXIT.usage, message: cause.message, ...(cause.hint === undefined ? {} : { hint: cause.hint }) };
  }
  if (cause instanceof CliFailure) {
    return { exitCode: cause.exitCode, message: cause.message, ...(cause.hint === undefined ? {} : { hint: cause.hint }) };
  }
  return { exitCode: EXIT.internal, message: `internal error: ${cause instanceof Error ? cause.message : String(cause)}` };
}

function commandName(argv: readonly string[]): string {
  return matchCommand(argv)?.path.join(' ') ?? (argv[0] ?? '');
}

/** A last-resort peek at the raw argv: the failure paths run before options are parsed. */
function flagOf(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli({ argv });
}

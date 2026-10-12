/**
 * Argument parsing, by hand, with no dependencies.
 *
 * The surface is small enough that a parser is cheaper than a dependency, and the shapes it has
 * to support are fixed: long options (`--target local`), `--target=local`, negations
 * (`--no-palette-check`), short aliases (`-t local`), repeated options for lists, positional
 * arguments, and `--` to stop option parsing. Anything else is a usage error with a suggestion,
 * because a typo'd flag silently ignored is how a deploy goes somewhere unintended.
 */

import { UsageError } from './exit.ts';

export type OptionKind = 'boolean' | 'string';

export interface OptionSpec {
  readonly name: string;
  readonly kind: OptionKind;
  /** Single-character alias without the dash. */
  readonly alias?: string;
  /** Placeholder shown in help for a value-taking option, e.g. `<name>`. */
  readonly placeholder?: string;
  /** Allow the option more than once; the values are collected in order. */
  readonly multiple?: boolean;
  readonly description: string;
}

export interface ParsedArgs {
  /** Option name → raw values; a boolean flag is `['true']` or `['false']`. */
  readonly options: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

/** Options every command accepts. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: 'cwd', kind: 'string', placeholder: '<dir>', description: 'project directory (default: the current one)' },
  { name: 'config', kind: 'string', placeholder: '<file>', description: 'config file (default: flowgen.config.ts)' },
  { name: 'json', kind: 'boolean', description: 'machine-readable output on stdout' },
  { name: 'quiet', kind: 'boolean', description: 'hide info-level diagnostics' },
  { name: 'help', kind: 'boolean', alias: 'h', description: 'show this help' },
  { name: 'version', kind: 'boolean', description: 'print the version and exit' },
];

export function parseArgv(argv: readonly string[], spec: readonly OptionSpec[]): ParsedArgs {
  const byName = new Map<string, OptionSpec>();
  for (const option of spec) {
    byName.set(option.name, option);
    if (option.alias !== undefined) byName.set(option.alias, option);
  }

  const options = new Map<string, string[]>();
  const positionals: string[] = [];
  const record = (name: string, value: string): void => {
    const existing = options.get(name);
    if (existing === undefined) options.set(name, [value]);
    else existing.push(value);
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;

    if (token === '--') {
      positionals.push(...argv.slice(index));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const body = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const equals = body.indexOf('=');
    let name = equals < 0 ? body : body.slice(0, equals);
    const inline = equals < 0 ? undefined : body.slice(equals + 1);

    // `--no-flag` is the only negation form; it is a boolean-only shorthand.
    let negated = false;
    if (equals < 0 && name.startsWith('no-')) {
      const positive = name.slice(3);
      const candidate = byName.get(positive);
      if (candidate?.kind === 'boolean') {
        name = positive;
        negated = true;
      }
    }

    const option = byName.get(name);
    if (option === undefined) throw unknownOption(token, body, spec);

    if (option.kind === 'boolean') {
      if (inline !== undefined) {
        if (inline !== 'true' && inline !== 'false') {
          throw new UsageError(`--${option.name} takes no value (use --${option.name} or --no-${option.name})`);
        }
        record(option.name, inline);
        continue;
      }
      record(option.name, negated ? 'false' : 'true');
      continue;
    }

    if (negated) throw new UsageError(`--${option.name} needs a value and cannot be negated`);
    if (inline !== undefined) {
      record(option.name, inline);
      continue;
    }

    const value = argv[index];
    if (value === undefined) throw new UsageError(`--${option.name} needs a value`, `try --${option.name}${option.placeholder === undefined ? ' <value>' : ` ${option.placeholder}`}`);
    index += 1;
    record(option.name, value);
  }

  for (const [name, values] of options) {
    const option = byName.get(name) as OptionSpec;
    if (option.multiple !== true && values.length > 1) {
      throw new UsageError(`--${name} was given ${values.length} times but takes a single value`);
    }
  }

  return { options, positionals };
}

/** A boolean flag: absent means false, `--no-x` means false, anything else true. */
export function flag(args: ParsedArgs, name: string): boolean {
  const values = args.options.get(name);
  if (values === undefined) return false;
  return values[values.length - 1] === 'true';
}

/** Last value of a single-valued option. */
export function text(args: ParsedArgs, name: string): string | undefined {
  const values = args.options.get(name);
  return values === undefined ? undefined : values[values.length - 1];
}

/** Every value of a repeatable option, in order. */
export function texts(args: ParsedArgs, name: string): readonly string[] {
  return args.options.get(name) ?? [];
}

export function rejectPositionals(args: ParsedArgs, usage: string): void {
  const extra = args.positionals.filter((value) => value !== '');
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`, `usage: ${usage}`);
  }
}

/** Renders help from the specs, so usage text cannot drift from the parser. */
export function renderUsage(program: string, summary: string, spec: readonly OptionSpec[], usage: readonly string[]): string {
  const lines: string[] = [`usage: ${program} ${usage[0] ?? ''}`.trimEnd()];
  for (const alternative of usage.slice(1)) lines.push(`       ${program} ${alternative}`);
  lines.push('', summary, '', 'options:');
  const width = Math.max(...spec.map((option) => optionLabel(option).length));
  for (const option of spec) {
    lines.push(`  ${optionLabel(option).padEnd(width)}  ${option.description}`);
  }
  return lines.join('\n');
}

function optionLabel(option: OptionSpec): string {
  const alias = option.alias === undefined ? '' : `-${option.alias}, `;
  const value = option.kind === 'string' ? ` ${option.placeholder ?? '<value>'}` : '';
  return `${alias}--${option.name}${value}`;
}

function unknownOption(token: string, body: string, spec: readonly OptionSpec[]): UsageError {
  const name = body.split('=')[0] as string;
  const suggestion = closest(name, spec.map((option) => option.name));
  return new UsageError(
    `unknown option ${token}`,
    suggestion === undefined ? 'run with --help to see the options' : `did you mean --${suggestion}?`,
  );
}

/** Damerau-free Levenshtein distance, capped: only used for a "did you mean" hint. */
export function closest(input: string, candidates: readonly string[], maxDistance = 3): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min((previous[j] as number) + 1, (previous[j - 1] as number) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

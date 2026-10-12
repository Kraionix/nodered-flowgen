/**
 * Command output: one shape, two renderings.
 *
 * Every command returns a `CommandResult` and never prints directly. That is what makes `--json`
 * trustworthy — the machine rendering is the same data the human rendering formats, not a
 * parallel `console.log` that drifts — and it is what lets the tests call `runCli` and assert on
 * a value instead of scraping stdout.
 */

import { formatProblems, formatSkipped, type SkippedValidator } from '../validate/report.ts';
import { countBySeverity, type Problem } from '../diagnostics/index.ts';

import { EXIT_DESCRIPTIONS, type ExitCode } from './exit.ts';

export interface CommandResult {
  /** Command path as invoked, e.g. `palette pull`. */
  readonly command: string;
  readonly exitCode: ExitCode;
  /** Diagnostics in the library's own `Problem` shape, so CI can allowlist by code. */
  readonly diagnostics: readonly Problem[];
  /** Human-readable narration, one line per entry. */
  readonly messages: readonly string[];
  /** Validators that could not run and what they were missing. */
  readonly skipped?: readonly SkippedValidator[];
  /** Command-specific payload: `plan`, `report`, `deployment`, … */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RenderOptions {
  readonly quiet?: boolean;
}

/** `{command, exitCode, diagnostics[], …payload}` — the documented machine contract. */
export function renderJson(result: CommandResult): string {
  return `${JSON.stringify(
    {
      command: result.command,
      exitCode: result.exitCode,
      outcome: EXIT_DESCRIPTIONS[result.exitCode],
      diagnostics: result.diagnostics,
      ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
      ...(result.data ?? {}),
    },
    null,
    2,
  )}\n`;
}

export function renderHuman(result: CommandResult, options: RenderOptions = {}): string {
  // A command that reported nothing at all already printed its own output (`--help` prints the
  // usage text straight to stdout); adding "no problems" after it would be noise.
  if (result.messages.length === 0 && result.diagnostics.length === 0 && result.data === undefined) return '';

  const lines: string[] = [...result.messages];
  const skipped = result.skipped ?? [];
  if (skipped.length > 0) {
    const rendered = formatSkipped(skipped);
    if (rendered !== '') lines.push(rendered);
  }

  if (result.diagnostics.length > 0) {
    lines.push(formatProblems(result.diagnostics, { includeInfo: options.quiet !== true }));
  }

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Severity counts, for commands that report "n errors, m warnings" themselves. */
export function severityLine(problems: readonly Problem[]): string {
  const counts = countBySeverity(problems);
  return `${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info`;
}

/** Convenience for the common "one line per fact" case. */
export function lines(...entries: readonly (string | null | undefined)[]): readonly string[] {
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * Exit codes and the two error kinds the CLI distinguishes.
 *
 * The codes are part of the public contract (spec §3) — CI branches on them, so they are
 * *stable* and documented in the README rather than derived from an errno:
 *
 * * `0` ok;
 * * `1` the check said no — validation problems, or `diff --check` found a difference (in both
 *   cases the target was never touched);
 * * `2` usage or configuration error (bad flags, missing config, unusable palette file);
 * * `3` deploy conflict — the revision moved under us and re-planning did not settle it;
 * * `4` the target is not usable: unreachable, unauthorized, or refuses writes;
 * * `5` internal error — a bug in this tool, not in the caller's project.
 *
 * Everything that is *expected* to go wrong is one of the first four; only a genuine defect
 * reaches `5`, which keeps "our bug" separable from "your flow is wrong" in CI logs.
 */

import type { ApplyAbortReason } from '../io/apply.ts';

export const EXIT = {
  ok: 0,
  problems: 1,
  usage: 2,
  conflict: 3,
  unreachable: 4,
  internal: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_DESCRIPTIONS: Readonly<Record<ExitCode, string>> = {
  0: 'ok',
  1: 'the check said no (validation problems, or --check found a difference)',
  2: 'usage or configuration error',
  3: 'deploy conflict (revision mismatch)',
  4: 'target unreachable or not permitted',
  5: 'internal error',
};

/** A mistake in how the CLI was invoked or configured: the caller can fix it. */
export class UsageError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

/** A failure that already knows which exit code it deserves. */
export class CliFailure extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(exitCode: ExitCode, message: string, hint?: string) {
    super(message);
    this.name = 'CliFailure';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/**
 * What a thrown value means: which exit code it deserves and what to print.
 *
 * Shared because `--all-targets` has to turn a failure into a *per-target* outcome rather than
 * aborting the fan-out, and "which code, which message" must not be answered differently in the
 * two places — a target that fails inside a loop has to look exactly like one that fails alone.
 */
export interface FailureClassification {
  readonly exitCode: ExitCode;
  readonly message: string;
  readonly hint?: string;
}

export function classifyFailure(cause: unknown): FailureClassification {
  if (cause instanceof UsageError) {
    return { exitCode: EXIT.usage, message: cause.message, ...(cause.hint === undefined ? {} : { hint: cause.hint }) };
  }
  if (cause instanceof CliFailure) {
    return { exitCode: cause.exitCode, message: cause.message, ...(cause.hint === undefined ? {} : { hint: cause.hint }) };
  }
  return {
    exitCode: EXIT.internal,
    message: `internal error: ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

/** Maps an aborted deploy onto the documented codes: the target's fault is never `1`. */
export function exitCodeForApplyReason(reason: ApplyAbortReason): ExitCode {
  switch (reason) {
    case 'validation':
      return EXIT.problems;
    case 'version-mismatch':
      return EXIT.conflict;
    case 'unauthorized':
    case 'unreachable':
      return EXIT.unreachable;
    case 'no-op':
      return EXIT.ok;
  }
}

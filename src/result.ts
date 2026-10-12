/**
 * A minimal `Result` type shared by every layer.
 *
 * Conditions the caller is expected to handle — a malformed snapshot, an unreachable
 * target, a flow set that fails validation — travel as *values*, never as exceptions:
 * the CLI has to report all of them, and `plan` in particular must collect the complete
 * problem list rather than stop at the first one. Genuine programming errors (broken
 * invariants, impossible states) still throw.
 *
 * This module is deliberately layer-less so that `model` and `palette`, which must not
 * depend on each other, can both use it.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(errors: E): Result<never, E> {
  return { ok: false, errors };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; errors: E } {
  return !result.ok;
}

/** Maps the success value, leaving failures untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, project: (value: T) => U): Result<U, E> {
  return result.ok ? { ok: true, value: project(result.value) } : result;
}

/**
 * Returns the success value or throws. Reserved for call sites where a failure means the
 * program is broken (tests, invariant checks) — user-facing paths must handle the error.
 */
export function unwrapOrThrow<T, E>(result: Result<T, E>, describe?: (errors: E) => string): T {
  if (result.ok) return result.value;
  throw new Error(describe ? describe(result.errors) : `unexpected failure: ${String(result.errors)}`);
}

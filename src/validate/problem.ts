/**
 * The diagnostics contract.
 *
 * Codes are namespaced and stable, because CI is expected to allowlist them and a rename would
 * silently turn an error into a warning. Every problem carries the entity it belongs to, a
 * path inside that entity, an English message and — where one exists — a hint that names the
 * fix.
 *
 * The namespace prefix also tells the reader *who* can fix it: `palette/*` means the flow
 * disagrees with the installed node, `graph/*` means the flow disagrees with itself,
 * `layout/*` and `normalize/*` are the build repairing or annotating what it was given,
 * `overlay/*` means a curated project rule was broken, `plan/*` and `deploy/*` belong to the
 * deploy path.
 */

export type Severity = 'error' | 'warn' | 'info';

export type BuiltinProblemCode =
  | 'palette/unknown-type'
  | 'palette/unknown-property'
  | 'palette/missing-required'
  | 'palette/type-mismatch'
  | 'palette/ref-missing'
  | 'palette/ref-wrong-type'
  | 'palette/module-version-drift'
  | 'palette/generated-stale'
  | 'graph/wire-target-missing'
  | 'graph/wire-arity'
  | 'graph/container-missing'
  | 'graph/group-membership'
  | 'graph/config-cycle'
  | 'graph/duplicate-id'
  | 'graph/subflow-recursion'
  | 'graph/unreachable'
  | 'layout/cycle'
  | 'normalize/wire-arity';

export type ProblemCode = BuiltinProblemCode | `overlay/${string}` | `plan/${string}` | `deploy/${string}`;

export interface Problem {
  readonly code: ProblemCode;
  readonly severity: Severity;
  /** Id of the entity the problem belongs to (`tab_1`, `inject_start`, `subflow:scale`, …). */
  readonly entity: string;
  /** Dotted path inside the entity, e.g. `props.broker` or `wires[2][0]`. */
  readonly path: string;
  readonly message: string;
  readonly hint?: string;
}

export function problem(init: Problem & { readonly hint?: string | undefined }): Problem {
  return init.hint === undefined ? { ...init } : init;
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((entry) => entry.severity === 'error');
}

export function countBySeverity(problems: readonly Problem[]): Readonly<Record<Severity, number>> {
  return {
    error: problems.filter((entry) => entry.severity === 'error').length,
    warn: problems.filter((entry) => entry.severity === 'warn').length,
    info: problems.filter((entry) => entry.severity === 'info').length,
  };
}

/** Level a CLI should exit with: errors fail a build, warnings and infos do not. */
export function exitCodeFor(problems: readonly Problem[]): 0 | 1 {
  return hasErrors(problems) ? 1 : 0;
}

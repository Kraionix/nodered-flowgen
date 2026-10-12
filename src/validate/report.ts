/**
 * Validation: declared dependencies, an explicit dispatch mode, and skips that are *reported*.
 *
 * Three ideas borrowed from cordis (see the architecture's framework verdict), all of them a
 * few lines of plain TypeScript:
 *
 * 1. **Declared dependencies with gated activation.** A validator that needs a live instance or
 *    `nrlint` declares it; when the environment cannot provide it the validator is *skipped and
 *    named*, never silently dropped. "Nothing was checked" must not look like "everything passed".
 * 2. **The dispatch mode is written at the call site.** `plan` collects the complete problem
 *    list, `apply` stops at the first error before touching a server. Two modes, one reducer,
 *    chosen where it is called.
 * 3. **Per-target keying.** A validator receives its context as an argument; no module-level
 *    state, so two targets with different palettes validate independently in one process.
 *
 * ## Why an environment and not a capability set
 *
 * v1 handed validators a `Set<Capability>` — `'liveInstance'`, `'nrlint'`, `'runtimeProbe'` — which
 * says *whether* a validator may run but gives it nothing to run *with*. `deploy/missing-types`
 * needs the target's palette and `runtimeProbe` needs somewhere to send a request, so both were
 * unimplementable: the contract could only ever gate checks that needed nothing. An environment
 * carries the ports themselves, and `requires` names the keys it must have — which makes the skip
 * list a derivation (`environment[key] === undefined`) instead of a second declaration that can
 * disagree with reality.
 *
 * The ports are deliberately narrow and structural. `LiveInstanceClient` is the one method a
 * validator has needed; the Admin API client satisfies it without this layer knowing that `io`
 * exists (the layering rule keeps `validate` below `io`).
 */

import { hasErrors, type Problem } from '../diagnostics/index.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteType } from '../palette/model.ts';

/** The read-only slice of an Admin API client a validator may use. */
export interface LiveInstanceClient {
  /** `GET /settings`. The only read any validator has needed so far. */
  readonly settings: () => Promise<Record<string, unknown>>;
}

/**
 * A reachable target: what the instance *is*, not just that it is there.
 *
 * `palette` is the instance's own palette, which is what `deploy/missing-types` compares the flow
 * set against — a node type the target cannot register is a deploy that half-works, and only the
 * target can answer that question.
 */
export interface LiveInstance {
  readonly client: LiveInstanceClient;
  readonly palette: Readonly<Record<string, PaletteType>>;
  readonly version: string | null;
}

/** `nrlint` as a port: the project supplies an implementation, this package has no dependency. */
export interface NrlintPort {
  readonly lint: (flowSet: FlowSet) => Promise<readonly Problem[]>;
}

/** A runtime probe: send the deployed flow set a request and report what came back. */
export interface RuntimeProbePort {
  readonly probe: (flowSet: FlowSet) => Promise<readonly Problem[]>;
}

/**
 * What a validator may reach for.
 *
 * `credentials` is the emitter's own map (name → value): the same values `apply` would write, so a
 * validator can tell "this credential has a provider" from "this credential has nowhere to come
 * from". Supplying it is optional; a project without one gets the warning rather than silence.
 */
export interface ValidatorEnvironment {
  readonly liveInstance?: LiveInstance | undefined;
  readonly nrlint?: NrlintPort | undefined;
  readonly runtimeProbe?: RuntimeProbePort | undefined;
  readonly credentials?: Readonly<Record<string, unknown>> | undefined;
}

/** The keys a validator can require. */
export type EnvironmentKey = keyof ValidatorEnvironment;

export interface ValidationContext {
  readonly flowSet: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** Node-RED version of the target, when it is known (`plan` against a live instance). */
  readonly targetVersion?: string | null;
}

export interface Validator {
  readonly name: string;
  /** Environment keys this validator needs; absent ones make it *skip*, loudly. */
  readonly requires?: readonly EnvironmentKey[];
  /**
   * `env` is the same object for every validator and may be empty; a validator that *wants*
   * something it did not require is expected to report the difference rather than assume it.
   * Async because the ports are: `nrlint` runs a linter, a probe sends a request.
   */
  validate(context: ValidationContext, env: ValidatorEnvironment): Promise<readonly Problem[]> | readonly Problem[];
}

export interface SkippedValidator {
  readonly name: string;
  readonly missing: readonly EnvironmentKey[];
}

export interface ValidationRun {
  readonly mode: 'collect' | 'bail';
  /** Ports the caller can provide. Omitted means "none", which every `requires` then reports. */
  readonly environment?: ValidatorEnvironment;
  /**
   * Problems found before any validator ran — normalisation repairs, `layout/cycle` advice.
   * The build path produces them, so they belong in the same report as everything else: a caller
   * that printed only the validators' findings would hide half of what the tool knows.
   */
  readonly priorProblems?: readonly Problem[];
}

export interface ValidationReport {
  readonly problems: readonly Problem[];
  readonly skipped: readonly SkippedValidator[];
  /** Names of the validators that actually ran, in order. */
  readonly ran: readonly string[];
  readonly hasErrors: boolean;
}

export async function runValidators(
  validators: readonly Validator[],
  context: ValidationContext,
  run: ValidationRun,
): Promise<ValidationReport> {
  const environment = run.environment ?? {};
  const problems: Problem[] = [...(run.priorProblems ?? [])];
  const skipped: SkippedValidator[] = [];
  const ran: string[] = [];

  // A build-time error is as fatal as a validation error, so bail mode never starts on top of one.
  let stopped = run.mode === 'bail' && hasErrors(problems);

  for (const validator of validators) {
    if (stopped) break;
    const missing = (validator.requires ?? []).filter((key) => environment[key] === undefined);
    if (missing.length > 0) {
      skipped.push({ name: validator.name, missing });
      continue;
    }

    ran.push(validator.name);
    const found = await validator.validate(context, environment);
    problems.push(...found);

    // Bail mode stops before the next validator once something is unfixable; the caller is
    // about to mutate a server, and continuing would only produce noise.
    if (run.mode === 'bail' && hasErrors(found)) stopped = true;
  }

  return { problems, skipped, ran, hasErrors: hasErrors(problems) };
}

export interface FormatOptions {
  /** Include info-level problems (default true; `--quiet` hides them). */
  readonly includeInfo?: boolean;
  /** Include the hint line under each problem (default true). */
  readonly includeHints?: boolean;
}

/** One line per problem: `severity code entity path — message`, then the hint indented. */
export function formatProblems(problems: readonly Problem[], options: FormatOptions = {}): string {
  const includeInfo = options.includeInfo ?? true;
  const includeHints = options.includeHints ?? true;

  const lines: string[] = [];
  for (const entry of problems) {
    if (!includeInfo && entry.severity === 'info') continue;
    const where = entry.path === '' ? entry.entity : `${entry.entity}.${entry.path}`;
    lines.push(`${entry.severity} ${entry.code} ${where} — ${entry.message}`);
    if (includeHints && entry.hint !== undefined && entry.hint !== '') lines.push(`  hint: ${entry.hint}`);
  }
  return lines.join('\n');
}

export function formatSkipped(skipped: readonly SkippedValidator[]): string {
  return skipped.map((entry) => `skipped ${entry.name}: needs ${entry.missing.join(', ')}`).join('\n');
}

/**
 * Validation: declared dependencies, an explicit dispatch mode, and skips that are *reported*.
 *
 * Three ideas borrowed from cordis (see the architecture's framework verdict), all of them a
 * few lines of plain TypeScript:
 *
 * 1. **Declared dependencies with gated activation.** A validator that needs a live instance or
 *    `nrlint` declares it; when the capability is absent the validator is *skipped and named*,
 *    never silently dropped. "Nothing was checked" must not look like "everything passed".
 * 2. **The dispatch mode is written at the call site.** `plan` collects the complete problem
 *    list, `apply` stops at the first error before touching a server. Two modes, one reducer,
 *    chosen where it is called.
 * 3. **Per-target keying.** A validator receives its context as an argument; no module-level
 *    state, so two targets with different palettes validate independently in one process.
 */

import { hasErrors, type Problem } from '../diagnostics/index.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteType } from '../palette/model.ts';

/** Something a validator may need from its environment. */
export type Capability = 'liveInstance' | 'nrlint' | 'runtimeProbe';

export interface ValidationContext {
  readonly flowSet: FlowSet;
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** Node-RED version of the target, when it is known (`plan` against a live instance). */
  readonly targetVersion?: string | null;
}

export interface Validator {
  readonly name: string;
  /** Capabilities this validator needs; absent ones make it *skip*, loudly. */
  readonly requires?: readonly Capability[];
  validate(context: ValidationContext): readonly Problem[];
}

export interface SkippedValidator {
  readonly name: string;
  readonly missing: readonly Capability[];
}

export interface ValidationRun {
  readonly mode: 'collect' | 'bail';
  /** Capabilities the caller can provide. */
  readonly capabilities?: ReadonlySet<Capability>;
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

export function runValidators(
  validators: readonly Validator[],
  context: ValidationContext,
  run: ValidationRun,
): ValidationReport {
  const capabilities = run.capabilities ?? new Set<Capability>();
  const problems: Problem[] = [...(run.priorProblems ?? [])];
  const skipped: SkippedValidator[] = [];
  const ran: string[] = [];

  // A build-time error is as fatal as a validation error, so bail mode never starts on top of one.
  let stopped = run.mode === 'bail' && hasErrors(problems);

  for (const validator of validators) {
    if (stopped) break;
    const missing = (validator.requires ?? []).filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      skipped.push({ name: validator.name, missing });
      continue;
    }

    ran.push(validator.name);
    const found = validator.validate(context);
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

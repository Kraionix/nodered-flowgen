/**
 * The validation pipeline as a product decision, not an implementation detail.
 *
 * Which checks run is fixed: palette first (does the flow agree with the nodes?), then graph
 * (does it agree with itself?), then the project's own rules. Ordering matters in `bail` mode —
 * a missing node type is a more useful first error than the wire that lands on it.
 *
 * Validators that need a live instance or `nrlint` are part of the list but declare their
 * capability, so an environment without them reports `skipped: needs …` instead of quietly
 * checking less.
 */

import { graphChecks } from './graphChecks.ts';
import { overlayRulesValidator, type OverlayRule } from './overlayRules.ts';
import { paletteChecks } from './paletteChecks.ts';
import type { Validator } from './report.ts';

export interface ValidatorSetOptions {
  readonly rules?: readonly OverlayRule[];
  readonly extra?: readonly Validator[];
}

export function defaultValidators(options: ValidatorSetOptions = {}): readonly Validator[] {
  return [paletteChecks, graphChecks, overlayRulesValidator(options.rules ?? []), ...(options.extra ?? [])];
}

export { graphChecks, paletteChecks, overlayRulesValidator };
export type { OverlayRule };

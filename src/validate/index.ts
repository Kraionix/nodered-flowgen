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

import { credentialChecks } from './credentialChecks.ts';
import { graphChecks } from './graphChecks.ts';
import { overlayRulesValidator, type OverlayRule } from './overlayRules.ts';
import { paletteChecks } from './paletteChecks.ts';
import { targetChecks } from './targetChecks.ts';
import type { Validator } from './report.ts';

export interface ValidatorSetOptions {
  readonly rules?: readonly OverlayRule[];
  readonly extra?: readonly Validator[];
}

export function defaultValidators(options: ValidatorSetOptions = {}): readonly Validator[] {
  return [
    // Offline first: the flow set against the palette it was written for, then against itself.
    paletteChecks,
    graphChecks,
    // Then the parts of the world the caller could hand over: what the target has installed, and
    // where credential values would come from. Both report a *skip* when their port is absent.
    targetChecks,
    credentialChecks,
    overlayRulesValidator(options.rules ?? []),
    ...(options.extra ?? []),
  ];
}

export { credentialChecks, graphChecks, paletteChecks, overlayRulesValidator, targetChecks };
export type { OverlayRule };

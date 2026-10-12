/**
 * Declarative overlay: curated knowledge that cannot be derived from an installation.
 *
 * The extractor sees exactly what the editor sees at registration time, which is not
 * everything a generator needs: typed-input *value lists* live in `oneditprepare`, and a
 * node type registered by a script the sandbox cannot run has no definition at all. Inhouse
 * nodes may never be installed anywhere the extractor can reach.
 *
 * An overlay is a plain object, applied to a snapshot in memory. It is deliberately **not**
 * written into the generated snapshot file, so `palette pull` can never lose curated data —
 * the file stays derived, the overlay stays authored, and `flowgen validate` sees both.
 *
 * ```ts
 * overlay({
 *   types: {
 *     'ui_gauge': { defaults: { min: { value: 0 } } },        // patch an extracted type
 *     'inhouse-plc': {                                         // define an unseen type
 *       paletteLabel: 'PLC',
 *       outputs: 2,
 *       refs: { gateway: 'inhouse-gateway' },
 *       defaults: { name: { value: '' }, gateway: { type: 'inhouse-gateway', required: true } },
 *     },
 *   },
 * });
 * ```
 */

import {
  deriveRefSpec,
  paletteProperty,
  paletteType,
  type PaletteParameter,
  type PaletteProperty,
  type PaletteType,
  type RefSpec,
} from '../model.ts';
import { withType, type PaletteOverlay } from './source.ts';

/**
 * Convenience encodings for a reference declaration:
 * `'mqtt-broker'` → one, `['a', 'b']` → many, `'*'` → one/any, `'*[]'` → many/any.
 */
export type RefDeclaration = RefSpec | string | readonly string[];

export interface PaletteTypePatch {
  readonly module?: string;
  readonly nodeSet?: string;
  readonly version?: string;
  readonly category?: string | null;
  readonly paletteLabel?: string | null;
  readonly color?: string | null;
  readonly icon?: string | null;
  readonly align?: string | null;
  readonly inputs?: number | null;
  readonly outputs?: number | null;
  readonly showLabel?: boolean | null;
  readonly isConfig?: boolean;
  /** Created types are open (`synthetic`) by default; set `false` to close the property set. */
  readonly synthetic?: boolean;
  readonly refs?: Readonly<Record<string, RefDeclaration>>;
  readonly defaults?: Readonly<Record<string, Partial<PaletteProperty>>>;
  readonly credentials?: Readonly<Record<string, Partial<PaletteProperty>>>;
  readonly params?: readonly PaletteParameter[];
}

export interface OverlayDeclaration {
  readonly id?: string;
  readonly types?: Readonly<Record<string, PaletteTypePatch>>;
}

export function overlay(declaration: OverlayDeclaration): PaletteOverlay {
  return {
    id: declaration.id ?? 'overlay',
    apply: (snapshot) => {
      let current = snapshot;
      for (const [id, patch] of Object.entries(declaration.types ?? {})) {
        current = withType(current, applyPatch(current.types[id], id, patch));
      }
      return current;
    },
  };
}

export function applyPatch(existing: PaletteType | undefined, id: string, patch: PaletteTypePatch): PaletteType {
  const base = existing ?? paletteType(id, { synthetic: true });
  const defaults = mergeProperties(base.defaults, patch.defaults);
  const credentials = mergeProperties(base.credentials, patch.credentials);

  const refs: Record<string, RefSpec> = { ...base.refs };
  for (const [property, declaration] of Object.entries(patch.refs ?? {})) {
    refs[property] = toRefSpec(declaration);
    // A declared reference implies a property; keep the two views consistent so the emitter
    // and the validator cannot disagree about what exists.
    if (!Object.hasOwn(defaults, property)) {
      defaults[property] = paletteProperty({ type: targetOf(declaration) });
    }
  }

  return {
    ...base,
    module: patch.module ?? base.module,
    nodeSet: patch.nodeSet ?? base.nodeSet,
    version: patch.version ?? base.version,
    category: patch.category === undefined ? base.category : patch.category,
    paletteLabel: patch.paletteLabel === undefined ? base.paletteLabel : patch.paletteLabel,
    color: patch.color === undefined ? base.color : patch.color,
    icon: patch.icon === undefined ? base.icon : patch.icon,
    align: patch.align === undefined ? base.align : patch.align,
    inputs: patch.inputs === undefined ? base.inputs : patch.inputs,
    outputs: patch.outputs === undefined ? base.outputs : patch.outputs,
    showLabel: patch.showLabel === undefined ? base.showLabel : patch.showLabel,
    isConfig: patch.isConfig ?? (patch.category === undefined ? base.isConfig : patch.category === 'config'),
    synthetic: patch.synthetic ?? base.synthetic,
    refs,
    defaults,
    credentials,
    params: patch.params ?? base.params,
  };
}

function mergeProperties(
  base: Readonly<Record<string, PaletteProperty>>,
  patch: Readonly<Record<string, Partial<PaletteProperty>>> | undefined,
): Record<string, PaletteProperty> {
  const merged: Record<string, PaletteProperty> = { ...base };
  for (const [name, property] of Object.entries(patch ?? {})) {
    merged[name] = { ...(merged[name] ?? paletteProperty()), ...property };
  }
  return merged;
}

export function toRefSpec(declaration: RefDeclaration): RefSpec {
  if (typeof declaration === 'string') return deriveRefSpec(declaration);
  if (Array.isArray(declaration)) return { kind: 'many', targets: [...(declaration as readonly string[])] };
  return declaration as RefSpec;
}

/** The reference target a property should carry, for the implied-default case. */
function targetOf(declaration: RefDeclaration): string | null {
  const spec = toRefSpec(declaration);
  if (spec.targets === '*') return null;
  return spec.targets.length === 1 ? (spec.targets[0] as string) : null;
}

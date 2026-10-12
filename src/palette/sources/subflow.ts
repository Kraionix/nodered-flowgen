/**
 * Inline subflows as palette entries.
 *
 * Subflows are defined *inside* a flow set, so they never appear in `GET /nodes` — verified:
 * the palette of the reference instance has 75 types and no `subflow:*` entry. Instances of a
 * subflow still have to be typed, validated and emitted, so their definitions are projected
 * into the palette as ordinary types with these mappings:
 *
 * | subflow definition        | palette entry                                  |
 * |---------------------------|------------------------------------------------|
 * | `id`                      | type id `subflow:<id>`                         |
 * | `name`                    | `paletteLabel`                                 |
 * | `in[].length`             | `inputs`                                       |
 * | `out[].length`            | `outputs`                                      |
 * | `env[]`                   | `params` (instance overrides live in `env`)    |
 *
 * The instance node itself only declares `name` as a property: parameter overrides are a
 * sibling `env` object on the node, not node properties — which is why they are modelled as
 * `params` rather than `defaults`.
 */

import { paletteProperty, type PaletteParameter, type PaletteType, subflowTypeId } from '../model.ts';
import { withType, type PaletteOverlay } from './source.ts';

/** Inline subflow definitions are attributed to this pseudo-module. */
export const INLINE_MODULE = 'flowgen:inline';

export interface SubflowParameterLike {
  readonly name: string;
  readonly type?: string;
  readonly value?: unknown;
  readonly ui?: unknown;
}

/** The subset of a flow-file subflow definition the palette needs. */
export interface SubflowDefinitionLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly category?: string | undefined;
  readonly color?: string | undefined;
  readonly icon?: string | undefined;
  readonly env?: readonly SubflowParameterLike[] | undefined;
  readonly in?: readonly unknown[] | undefined;
  readonly out?: readonly unknown[] | undefined;
}

export function subflowPaletteType(definition: SubflowDefinitionLike): PaletteType {
  const inputs = definition.in?.length ?? 0;
  const outputs = definition.out?.length ?? 0;

  return {
    id: subflowTypeId(definition.id),
    module: INLINE_MODULE,
    nodeSet: INLINE_MODULE,
    version: '0.0.0',
    category: definition.category ?? null,
    paletteLabel: definition.name ?? null,
    color: definition.color ?? null,
    icon: definition.icon ?? null,
    align: null,
    inputs,
    outputs,
    showLabel: null,
    isConfig: false,
    synthetic: false,
    refs: {},
    defaults: { name: paletteProperty({ value: '' }) },
    credentials: {},
    params: (definition.env ?? []).map(subflowParameter),
    dynamics: { inputs: false, outputs: false, paletteLabel: false, category: false, defaults: [] },
  };
}

function subflowParameter(parameter: SubflowParameterLike): PaletteParameter {
  return {
    name: parameter.name,
    type: parameter.type ?? 'str',
    value: parameter.value,
    ui: parameter.ui,
  };
}

/** Overlay that adds one palette entry per inline subflow definition. */
export function subflowOverlay(definitions: readonly SubflowDefinitionLike[]): PaletteOverlay {
  return {
    id: 'subflows',
    apply: (snapshot) =>
      definitions.reduce((current, definition) => withType(current, subflowPaletteType(definition)), snapshot),
  };
}

/**
 * `defineFlowSet` — the entry point an author's config file exports.
 *
 * ```ts
 * export default defineFlowSet((f) => {
 *   const tab = f.flow('orders', { label: 'Orders API' });
 *   tab.chain(tab.node('http in', { url: '/orders', method: 'get' }), tab.node('http response', {}));
 * });
 * ```
 *
 * The callback runs at *build* time, not at import time, because materialising palette defaults
 * needs the palette. That keeps configuration files free of side effects (the CLI can import
 * one to read metadata without building) and lets the same definition be built against different
 * palettes — which is exactly what deploying to two targets requires.
 */

import { normalizeFlowSet } from '../model/normalize.ts';
import type { FlowSet } from '../model/entities.ts';
import type { PaletteType } from '../palette/model.ts';

import { Builder, type FlowBuilder } from './builder.ts';
import { layoutFlowSet, type LayoutOptions } from './layout.ts';

export interface BuildOptions {
  /** Palette used to materialise defaults and to classify config nodes. */
  readonly palette: Readonly<Record<string, PaletteType>>;
  /** Authoring key → id from the lockfile; keeps ids stable across renames. */
  readonly lockfile?: ReadonlyMap<string, string>;
  /** Run the layout pass (default true). `false` keeps authored coordinates only. */
  readonly layout?: boolean | LayoutOptions;
}

export interface BuildResult {
  readonly flowSet: FlowSet;
  /** Authoring key → id, for the lockfile. */
  readonly keys: ReadonlyMap<string, string>;
  /** Authoring keys used more than once: each reuse was given its own id. */
  readonly duplicateKeys: readonly string[];
}

export interface FlowSetDefinition {
  readonly build: (options: BuildOptions) => BuildResult;
}

export function defineFlowSet(build: (f: FlowBuilder) => void): FlowSetDefinition {
  return {
    build: (options: BuildOptions): BuildResult => {
      const builder = new Builder({
        palette: options.palette,
        ...(options.lockfile === undefined ? {} : { lockfile: options.lockfile }),
      });
      build(builder);

      const raw = builder.toFlowSet();
      const laidOut = options.layout === false ? raw : layoutFlowSet(raw, options.layout === true ? {} : (options.layout ?? {}));

      return {
        flowSet: normalizeFlowSet(laidOut, { palette: options.palette }),
        keys: builder.keys,
        duplicateKeys: builder.duplicateKeys,
      };
    },
  };
}

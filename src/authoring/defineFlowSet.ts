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
import type { Problem } from '../diagnostics/index.ts';

import { Builder, type FlowBuilder } from './builder.ts';
import { layoutFlowSetWithDiagnostics, type LayoutOptions } from './layout.ts';

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
  /**
   * What the build itself has to say: `layout/cycle` advice, and nothing else today. Not a
   * validation failure — the flow set is complete and emittable either way — but "your nodes form
   * a loop, so their geometry is a row" is exactly the kind of thing a build log is for.
   */
  readonly problems: readonly Problem[];
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
      const laidOut =
        options.layout === false
          ? { flowSet: raw, problems: [] as readonly Problem[] }
          : layoutFlowSetWithDiagnostics(raw, {
              ...(typeof options.layout === 'object' ? options.layout : {}),
              // The palette is what makes `link` references visible to the layout: a `link out`
              // node has no wires at all, so without it a link-connected flow piles up in one
              // column. Geometry stays advisory either way.
              palette: options.palette,
            });

      return {
        flowSet: normalizeFlowSet(laidOut.flowSet, { palette: options.palette }),
        keys: builder.keys,
        duplicateKeys: builder.duplicateKeys,
        // Layout advice only. The repairs `normalizeFlowSetWithFixes` reports are deliberately
        // *not* surfaced here: the builder pads wires itself (a node wired through one port of a
        // three-output switch is normal authoring), so the build would emit an info diagnostic on
        // every validate and teach its reader to ignore the level. Those messages belong to
        // foreign data — the import path — where a repair really is news.
        problems: laidOut.problems,
      };
    },
  };
}

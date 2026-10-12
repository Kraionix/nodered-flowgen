/**
 * Subflow libraries: definitions that can be declared into any builder.
 *
 * A subflow defined inside one builder is invisible to every other one, which makes a family of
 * reusable subflows — a library, a second module, a shared package — impossible to write. A library
 * is the missing half of that: a definition *without* a builder, declared into whichever build
 * needs it.
 *
 * ```ts
 * // subflows/scale.ts
 * export const scaleLibrary = defineSubflowLibrary('scale', [
 *   {
 *     key: 'scale',
 *     options: { name: 'scale × factor', params: { factor: P.num(2) }, ports: { in: ['value'], out: ['scaled'] } },
 *     body: (s) => {
 *       const work = s.node('function', { key: 'work', func: '…' });
 *       s.in(work);
 *       s.out(work, 0);
 *     },
 *   },
 * ]);
 *
 * // flowgen.config.ts
 * const scale = f.subflowFrom(scaleLibrary).get('scale');
 * const tab = f.flow('orders');
 * tab.instance(scale, { env: { factor: 3 } });
 * ```
 *
 * `subflowFrom` returns the handles keyed by their library key, so a caller can find the one it
 * wants without repeating the definition's id — and because each declaration goes through the
 * builder's ordinary `subflow()`, the ids, the lockfile keys and the palette overlay are the same
 * as for a definition written inline.
 */

import type { FlowBuilder, SubflowHandle, SubflowOptions } from './builder.ts';

/** One definition: everything `subflow()` takes, minus the builder. */
export interface SubflowDefinition {
  readonly key: string;
  readonly options: SubflowOptions;
  readonly body: (s: SubflowHandle) => void;
}

export interface SubflowLibrary {
  readonly name: string;
  readonly definitions: readonly SubflowDefinition[];
}

export function defineSubflowLibrary(name: string, definitions: readonly SubflowDefinition[]): SubflowLibrary {
  return { name, definitions };
}

/** Declares a library into a builder: `f.use(subflows(library))` or `f.subflowFrom(library)`. */
export function subflows(library: SubflowLibrary): (builder: FlowBuilder) => ReadonlyMap<string, SubflowHandle> {
  return (builder) => builder.subflowFrom(library);
}

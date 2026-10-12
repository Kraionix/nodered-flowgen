/**
 * Subflow parameters (`P`) and the conversion between authoring values and flow-file values.
 *
 * A subflow parameter is *not* a node property: definitions declare `env` entries and instances
 * override them in a sibling `env` array. Node-RED stores those overrides as strings — a `num`
 * parameter is `"3"`, a `bool` is `"false"`, a `cred` is `""` — and the runtime converts them
 * back using the declared type. The authoring layer therefore accepts natural values
 * (`P.num(3)`) and performs the conversion in one place, instead of asking every author to
 * remember the wire format.
 */

import type { EnvParam } from '../model/entities.ts';
import type { EnvSpec } from '../typing.ts';

export type ParamType = 'str' | 'num' | 'bool' | 'json' | 'cred' | 'env' | 'flow' | 'global';

/** A declared parameter: the file's own shape (`EnvSpec`) with the type narrowed to the known set. */
export interface ParamSpec extends EnvSpec {
  readonly type: ParamType;
}

export const P = {
  str: (value: string): ParamSpec => ({ type: 'str', value }),
  num: (value: number): ParamSpec => ({ type: 'num', value: String(value) }),
  bool: (value: boolean): ParamSpec => ({ type: 'bool', value: value ? 'true' : 'false' }),
  json: (value: unknown): ParamSpec => ({ type: 'json', value: JSON.stringify(value) }),
  /** A credential: the value stays empty in the flow file and is injected at deploy time. */
  cred: (): ParamSpec => ({ type: 'cred', value: '' }),
  /** Read from an environment variable of the Node-RED process. */
  env: (name: string): ParamSpec => ({ type: 'env', value: name }),
  flow: (name: string): ParamSpec => ({ type: 'flow', value: name }),
  global: (name: string): ParamSpec => ({ type: 'global', value: name }),
} as const;

export type ParamDeclarations = Readonly<Record<string, ParamSpec>>;

export function toEnvParams(declarations: ParamDeclarations): readonly EnvParam[] {
  return Object.entries(declarations).map(([name, spec]) => ({
    name,
    type: spec.type,
    value: spec.value,
    // `ui` is the editor's own per-parameter bag; it round-trips or the manifest loses hints.
    ...(spec.ui === undefined ? {} : { ui: spec.ui }),
  }));
}

/**
 * Instance overrides: a bare JS value is converted using the *declared* parameter type, so
 * `{ factor: 3 }` becomes `{name: 'factor', type: 'num', value: '3'}` without the author having
 * to spell out the type twice.
 */
export function toEnvOverrides(
  overrides: Readonly<Record<string, unknown>>,
  declared: readonly EnvParam[],
): readonly EnvParam[] {
  const byName = new Map(declared.map((param) => [param.name, param]));
  const params: EnvParam[] = [];

  for (const [name, value] of Object.entries(overrides)) {
    const spec = byName.get(name);
    if (spec === undefined) {
      // Undeclared overrides are kept as strings: the runtime reads them as `str`, and dropping
      // them would silently lose an author's intent.
      params.push({ name, type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'num' : 'str', value: stringify(value) });
      continue;
    }
    params.push({ name, type: spec.type, value: stringify(value) });
  }

  return params;
}

function stringify(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

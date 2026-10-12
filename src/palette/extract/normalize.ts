/**
 * Normalisation of a raw registration into the palette model.
 *
 * The registration literal is arbitrary JavaScript: values, `type` targets and labels may
 * be functions (roughly 70 core defaults are), and a few definitions compute `inputs`,
 * `outputs`, `category` or `paletteLabel` from the node's properties. Those cannot be
 * reconstructed outside a browser, so they are recorded as *dynamic* facts instead of being
 * guessed — the emitter must not invent a value it never saw, and the type generator must
 * treat the property as optional rather than as a literal.
 */

import {
  deriveRefSpec,
  type PaletteProperty,
  type PaletteType,
  type RefSpec,
  type TypeDynamics,
} from '../model.ts';

import type { RegisteredType } from './registerType.ts';

export interface NormalizeContext {
  /** npm package providing the type, e.g. `node-red`. */
  readonly module: string;
  /** Node set id, e.g. `node-red/inject`. */
  readonly nodeSet: string;
  readonly version: string;
}

/**
 * Converts one `registerType` call into a palette type. Everything that cannot be expressed
 * as JSON is dropped and flagged, so the result is always serialisable.
 */
export function normalizeRegisteredType(registered: RegisteredType, context: NormalizeContext): PaletteType {
  const definition = registered.definition;

  const category = stringField(definition['category']);
  const outputs = numberField(definition['outputs']);
  const inputs = numberField(definition['inputs']);

  const defaults = normalizeProperties(definition['defaults']);
  const credentials = normalizeProperties(definition['credentials']);

  const refs: Record<string, RefSpec> = {};
  for (const [name, property] of Object.entries(defaults.properties)) {
    if (property.type !== null) refs[name] = deriveRefSpec(property.type);
  }

  const dynamics: TypeDynamics = {
    inputs: definition['inputs'] !== undefined && inputs === null,
    outputs: definition['outputs'] !== undefined && outputs === null,
    paletteLabel: definition['paletteLabel'] !== undefined && stringField(definition['paletteLabel']) === null,
    category: definition['category'] !== undefined && category === null,
    defaults: defaults.dynamic,
  };

  return {
    id: registered.type,
    module: context.module,
    nodeSet: context.nodeSet,
    version: context.version,
    category,
    paletteLabel: stringField(definition['paletteLabel']),
    color: stringField(definition['color']),
    icon: stringField(definition['icon']),
    align: stringField(definition['align']),
    inputs,
    outputs,
    showLabel: definition['showLabel'] === false ? false : definition['showLabel'] === true ? true : null,
    isConfig: category === 'config',
    synthetic: false,
    refs,
    defaults: defaults.properties,
    credentials: credentials.properties,
    params: [],
    dynamics,
  };
}

/**
 * A type that exists in the runtime but has no editor registration.
 *
 * The built-in example is `junction`: `@node-red/nodes/core/common/05-junction.html` is
 * deliberately empty so the node stays out of the editor palette, while `GET /nodes` still
 * reports the type. Representing it with no declared defaults and `synthetic: true` keeps
 * `import → emit` lossless (its properties are an open bag) and lets validation stay quiet
 * about properties it cannot know.
 */
export function synthesizeType(typeId: string, context: NormalizeContext): PaletteType {
  return {
    id: typeId,
    module: context.module,
    nodeSet: context.nodeSet,
    version: context.version,
    category: null,
    paletteLabel: null,
    color: null,
    icon: null,
    align: null,
    inputs: null,
    outputs: null,
    showLabel: null,
    isConfig: false,
    synthetic: true,
    refs: {},
    defaults: {},
    credentials: {},
    params: [],
    dynamics: { inputs: false, outputs: false, paletteLabel: false, category: false, defaults: [] },
  };
}

interface NormalizedProperties {
  readonly properties: Readonly<Record<string, PaletteProperty>>;
  /** Names whose declaration was computed rather than written out. */
  readonly dynamic: readonly string[];
}

function normalizeProperties(raw: unknown): NormalizedProperties {
  if (!isPlainObject(raw)) return { properties: {}, dynamic: [] };

  const properties: Record<string, PaletteProperty> = {};
  const dynamic: string[] = [];

  for (const [name, declaration] of Object.entries(raw)) {
    if (!isPlainObject(declaration)) {
      // `defaults: { name: "x" }` is not a valid Node-RED declaration, but tolerating it as a
      // value keeps a sloppy third-party node usable.
      const literal = jsonSafe(declaration);
      if (literal.ok) {
        properties[name] = palettePropertyOf(literal.value, null, false, null, undefined, false);
      } else {
        dynamic.push(name);
        properties[name] = palettePropertyOf(undefined, null, false, null, undefined, true);
      }
      continue;
    }

    const value = jsonSafe(declaration['value']);
    const declaredType = stringField(declaration['type']);
    const label = stringField(declaration['label']);
    const ui = jsonSafe(declaration['ui']);
    const isDynamic =
      !value.ok ||
      !ui.ok ||
      (declaration['type'] !== undefined && declaredType === null) ||
      (declaration['label'] !== undefined && label === null);

    if (isDynamic) dynamic.push(name);

    properties[name] = palettePropertyOf(
      value.ok ? value.value : undefined,
      declaredType,
      declaration['required'] === true,
      label,
      ui.ok ? ui.value : undefined,
      isDynamic,
    );
  }

  return { properties, dynamic };
}

function palettePropertyOf(
  value: unknown,
  type: string | null,
  required: boolean,
  label: string | null,
  ui: unknown,
  dynamic: boolean,
): PaletteProperty {
  return { value, type, required, label, ui, dynamic };
}

type JsonSafe = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Reports whether a value survives `JSON.stringify` unchanged in meaning. Functions,
 * symbols, bigints, class instances and cycles do not: a palette property holding one of
 * those is marked dynamic rather than silently stringified.
 */
function jsonSafe(value: unknown, depth = 0, seen: Set<unknown> = new Set()): JsonSafe {
  if (value === undefined || value === null) return { ok: true, value };
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return { ok: true, value };
  if (kind === 'number') return Number.isFinite(value as number) ? { ok: true, value } : { ok: false };
  if (kind !== 'object') return { ok: false };

  if (depth > 32 || seen.has(value)) return { ok: false };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        const safe = jsonSafe(item, depth + 1, seen);
        if (!safe.ok) return { ok: false };
        items.push(safe.value);
      }
      return { ok: true, value: items };
    }
    if (!isPlainObject(value)) return { ok: false };
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, depth + 1, seen);
      if (!safe.ok) return { ok: false };
      if (safe.value !== undefined) result[key] = safe.value;
    }
    return { ok: true, value: result };
  } finally {
    seen.delete(value);
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The palette model — the data contract between palette extraction and every consumer
 * (type codegen, the emitter, the validator, the authoring layer).
 *
 * Everything here is pure data plus derivation helpers: no I/O, no environment access.
 * That is what lets the same snapshot be produced by three different sources (a live
 * instance, a Node-RED installation on disk, a vendored file) and compared byte for byte.
 *
 * Vocabulary follows Node-RED's own: a *node set* registers one or more *types*; a type
 * declares *defaults* (properties with an initial value and/or a reference target) and
 * optionally *credentials*.
 */

/** Version of the snapshot wire format. Bumped whenever the emitted JSON shape changes. */
export const PALETTE_SCHEMA_VERSION = 1;

/**
 * Node-RED identifies an inline subflow *instance* by the type `subflow:<definitionId>`.
 * Inline subflows are not reported by `GET /nodes`, so the palette has to synthesise
 * entries for them (see the subflow source) — this is the shared naming helper.
 */
export const SUBFLOW_TYPE_PREFIX = 'subflow:';

export function isSubflowType(typeId: string): boolean {
  return typeId.startsWith(SUBFLOW_TYPE_PREFIX);
}

export function subflowTypeId(definitionId: string): string {
  return `${SUBFLOW_TYPE_PREFIX}${definitionId}`;
}

/** Returns the definition id of a subflow instance type, or `null` for any other type. */
export function subflowDefinitionId(typeId: string): string | null {
  return isSubflowType(typeId) ? typeId.slice(SUBFLOW_TYPE_PREFIX.length) : null;
}

/** `"*"` means "any type", an array means an explicit allow list. */
export type RefTargets = readonly string[] | '*';

/**
 * How a default property references other nodes, derived from the palette's `type` field.
 *
 * Node-RED encodes both the arity and the target type in one string; the trailing `[]`
 * is the multi-reference marker and `*` is the wildcard. Verified against the core and
 * dashboard palettes:
 *
 * | declared type      | kind   | targets            |
 * |--------------------|--------|--------------------|
 * | `"mqtt-broker"`    | `one`  | `["mqtt-broker"]`  |
 * | `"*"`              | `one`  | `"*"`              |
 * | `"link out[]"`     | `many` | `["link out"]`     |
 * | `"*[]"`            | `many` | `"*"`              |
 */
export interface RefSpec {
  readonly kind: 'one' | 'many';
  readonly targets: RefTargets;
}

export function deriveRefSpec(declaredType: string): RefSpec {
  const many = declaredType.endsWith('[]');
  const base = many ? declaredType.slice(0, -2) : declaredType;
  // An empty base (`"[]"`) carries no target information; treat it as "any" rather than
  // inventing a type named "".
  const targets: RefTargets = base === '' || base === '*' ? '*' : [base];
  return { kind: many ? 'many' : 'one', targets };
}

export function refAccepts(spec: RefSpec, typeId: string): boolean {
  return spec.targets === '*' || spec.targets.includes(typeId);
}

/** A single entry of a type's `defaults` (or `credentials`) declaration. */
export interface PaletteProperty {
  /**
   * Declared initial value, `undefined` when the palette declares a type-only property
   * (e.g. `group: { type: 'ui_group', required: true }`). Only JSON-representable values
   * survive extraction; a function-valued default is recorded as `dynamic` instead.
   */
  readonly value: unknown;
  /** Reference target type; `null` for ordinary value properties. */
  readonly type: string | null;
  readonly required: boolean;
  readonly label: string | null;
  /** Subflow environment-parameter UI descriptor (type, options, …); opaque on purpose. */
  readonly ui: unknown;
  /**
   * True when the original declaration computed this property (a function in the node's
   * HTML). The value cannot be reconstructed, so consumers must not materialise it.
   */
  readonly dynamic: boolean;
}

/** Which parts of a type's declaration were functions rather than literals. */
export interface TypeDynamics {
  readonly inputs: boolean;
  readonly outputs: boolean;
  readonly paletteLabel: boolean;
  readonly category: boolean;
  /** Names of `defaults` whose value/type/label came from a function. */
  readonly defaults: readonly string[];
}

/** One registered node type, normalised out of `RED.nodes.registerType(...)`. */
export interface PaletteType {
  readonly id: string;
  /** Id of the node set that registered this type (attribution). */
  readonly module: string;
  /** Version of that node set at capture time. */
  readonly setVersion: string;
  readonly category: string | null;
  /**
   * Display label. May be an i18n key (`node-red-dashboard/ui_base:ui_base.label.category`),
   * which is exactly why it is never used as identity — only for human-facing output.
   */
  readonly paletteLabel: string | null;
  readonly color: string | null;
  readonly icon: string | null;
  readonly align: string | null;
  readonly inputs: number | null;
  readonly outputs: number | null;
  /** The editor's rule: a config node is a type whose category is `"config"`. */
  readonly isConfig: boolean;
  readonly refs: Readonly<Record<string, RefSpec>>;
  /** Declaration order is preserved: the emitter writes defaults in this order. */
  readonly defaults: Readonly<Record<string, PaletteProperty>>;
  readonly credentials: Readonly<Record<string, PaletteProperty>>;
  readonly dynamics: TypeDynamics;
}

/** One node set as reported by `GET /nodes` (or synthesised from a filesystem scan). */
export interface PaletteModule {
  readonly id: string;
  /** Module name as reported by Node-RED; usually identical to `id`, not guaranteed. */
  readonly name: string;
  readonly version: string;
  /** Sorted type ids belonging to this set. */
  readonly types: readonly string[];
}

/** Where a snapshot came from. Excluded from the content hash: it differs per source. */
export type PaletteSourceKind = 'live' | 'filesystem' | 'snapshot' | 'subflow' | 'overlay' | 'composite';

export interface PaletteProvenance {
  readonly kind: PaletteSourceKind;
  /** Instance URL for the live source, `null` otherwise. */
  readonly url: string | null;
  /** Node-RED user directory for the filesystem source, `null` otherwise. */
  readonly userDir: string | null;
  /** Extra node module directories scanned by the filesystem source. */
  readonly nodeModulesDirs: readonly string[] | null;
}

export const EMPTY_DYNAMICS: TypeDynamics = {
  inputs: false,
  outputs: false,
  paletteLabel: false,
  category: false,
  defaults: [],
};

export function isConfigCategory(category: string | null): boolean {
  return category === 'config';
}

/** Output count used for wire-arity checks; config nodes have no outputs at all. */
export function outputCount(type: PaletteType): number {
  return type.outputs ?? 0;
}

export function inputCount(type: PaletteType): number {
  return type.inputs ?? 0;
}

/** Property names in declaration order (the emitter's write order). */
export function propertyNames(type: PaletteType): readonly string[] {
  return Object.keys(type.defaults);
}

export function requiredPropertyNames(type: PaletteType): readonly string[] {
  return Object.entries(type.defaults)
    .filter(([, property]) => property.required)
    .map(([name]) => name);
}

export function isReferenceProperty(property: PaletteProperty): boolean {
  return property.type !== null;
}

/** Reference properties of a type, in declaration order. */
export function referenceProperties(type: PaletteType): readonly (readonly [string, RefSpec])[] {
  return Object.entries(type.refs);
}

export function getPaletteType(types: Readonly<Record<string, PaletteType>>, typeId: string): PaletteType | null {
  return Object.hasOwn(types, typeId) ? (types[typeId] as PaletteType) : null;
}

// --------------------------------------------------------------------------------------
// Constructors — used by tests, by overlay declarations and by the subflow source, all of
// which need to build a type from partial data without repeating every nullable field.
// --------------------------------------------------------------------------------------

export function paletteProperty(init: Partial<PaletteProperty> = {}): PaletteProperty {
  return {
    value: init.value,
    type: init.type ?? null,
    required: init.required ?? false,
    label: init.label ?? null,
    ui: init.ui,
    dynamic: init.dynamic ?? false,
  };
}

export function paletteType(id: string, init: Partial<PaletteType> = {}): PaletteType {
  const defaults = init.defaults ?? {};
  const refs: Record<string, RefSpec> = {};
  for (const [name, property] of Object.entries(defaults)) {
    if (property.type !== null) refs[name] = deriveRefSpec(property.type);
  }
  return {
    id,
    module: init.module ?? 'flowgen:inline',
    setVersion: init.setVersion ?? '0.0.0',
    category: init.category ?? null,
    paletteLabel: init.paletteLabel ?? null,
    color: init.color ?? null,
    icon: init.icon ?? null,
    align: init.align ?? null,
    inputs: init.inputs ?? null,
    outputs: init.outputs ?? null,
    isConfig: init.isConfig ?? init.category === 'config',
    refs: init.refs ?? refs,
    defaults,
    credentials: init.credentials ?? {},
    dynamics: init.dynamics ?? EMPTY_DYNAMICS,
  };
}

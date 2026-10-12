/**
 * The typing surface that generated palette augmentations attach to.
 *
 * The library declares *open* interfaces and the generator augments them per npm module
 * (`palette/<module>@<version>.d.ts`). Two consequences that matter:
 *
 * * the library's public types never depend on one installation's palette — a team can
 *   regenerate one module, or hand-write an augmentation for a node the extractor cannot see;
 * * `KnownType` is a **closed union** recomputed from the augmentations, so `node('ui_gaug')`
 *   is a compile error while `untyped('anything')` remains the deliberate escape hatch.
 *
 * A generated file must contain a top-level `export {}`; without it TypeScript treats
 * `declare module` as an *ambient module declaration* instead of an augmentation and the
 * types silently disappear (verified in the reconnaissance spike).
 */

/** Marker interface: one `'<node type>': true` member per known type. */
export interface KnownTypes {}

/** The closed union of node types this project can author. */
export type KnownType = keyof KnownTypes;

/** Property bags: one `'<node type>': { …props }` member per known type. */
export interface PaletteTypes {}

/** A handle to a node in the flow set: an id plus the type it was created as. */
export interface NodeRef<T extends string = string> {
  readonly id: string;
  readonly type: T;
}

/**
 * A reference to another node. The authoring layer passes `NodeRef` handles; a raw id string
 * is accepted because flow files and imported flows carry ids, and refusing them would push
 * authors back to hand-written JSON. Dangling or mistyped references are caught by the
 * validator, which is where they can be reported with a useful message.
 */
export type Ref<T extends string = string> = NodeRef<T> | string;

/**
 * Properties every node accepts regardless of its palette definition.
 *
 * Only authoring metadata and the two advisory facets live here. Everything structural —
 * `id`, `type`, `z`, `g`, `wires`, `d` — is modelled by the builder as a reference, never as a
 * property, which is what removes hand-written ids from the authoring surface. Container
 * membership in particular is *not* an envelope field: for dashboard nodes `group` is a
 * palette-declared reference with its own target type (`Ref<'ui_group'>`), and intersecting a
 * generic `Ref<'group'>` with it would make both unusable.
 */
export interface NodeEnvelope {
  /** Authoring key; the lockfile maps it to a stable id. Never written to the flow file. */
  readonly key?: string;
  /** Written as `d: true` when set (the editor writes `d` only when true). */
  readonly disabled?: boolean;
  /** Advisory geometry: node centre, plus dimensions only when explicitly requested. */
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
}

/**
 * Props accepted by `node(type, props)`.
 *
 * A known type gets its generated property bag intersected with the envelope; anything else
 * gets an open bag. The conditional is also what keeps this declaration legal while
 * `PaletteTypes` is still empty (before any palette has been generated).
 */
export type PropsFor<T extends string> = T extends keyof PaletteTypes
  ? PaletteTypes[T] & NodeEnvelope
  : NodeEnvelope & Record<string, unknown>;

/** Environment-variable value of a subflow parameter override, as the flow file stores it. */
export type EnvValue = string | number | boolean | null;

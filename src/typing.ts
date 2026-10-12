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
  /**
   * Properties the palette does not declare, written verbatim in this order.
   *
   * The generated property bags are deliberately closed, so `topgic: 'x'` is a compile error;
   * but a flow file may legitimately carry keys this build's palette has never heard of (a newer
   * runtime's property, `l`, `icon`, a plugin's field), and dropping them would make
   * `import → build` lossy. `extras` is the one place those go.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
  /**
   * Node-level `env` parameters.
   *
   * A subflow *instance* spells overrides the same way but converts them with the declared
   * parameter types (`instance(def, {env})` is the surface for that); an ordinary node's `env`
   * is written as-is, which is what keeps an imported file byte-identical.
   */
  readonly env?: Readonly<Record<string, EnvSpec>>;
}

/** An `env` parameter as a flow file stores it: a declared type plus its value. */
export interface EnvSpec {
  /** `str`, `num`, `bool`, `json`, `cred`, `env`, `flow`, `global`. */
  readonly type: string;
  readonly value: unknown;
  /** The editor's own per-parameter extras (a `cred`'s label, say). Written verbatim. */
  readonly ui?: unknown;
}

/**
 * Props accepted by `node(type, props)`.
 *
 * A known type gets its generated property bag intersected with the envelope; anything else gets
 * an open bag.
 *
 * The `[T] extends [never]` guard is not decoration. `T` is inferred from the type argument, and
 * `KnownType` is `keyof KnownTypes` — which is `never` until some palette has been generated. A
 * bare conditional distributes over `never` and yields `never`, so `PropsFor<never>` was `never`
 * and every call in the library that passed a `KnownType`-typed value stopped compiling: the
 * library could not be built without one consumer's generated augmentations. Wrapping `T` in a
 * tuple switches that one test to non-distributive, and `never` now means what it should —
 * "no palette, so an open bag".
 */
export type PropsFor<T extends string> = NodeEnvelope &
  ([T] extends [never] ? Record<string, unknown> : T extends keyof PaletteTypes ? PaletteTypes[T] : Record<string, unknown>);

/** Environment-variable value of a subflow parameter override, as the flow file stores it. */
export type EnvValue = string | number | boolean | null;

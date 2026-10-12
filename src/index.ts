/**
 * `@kraionix/nodered-flowgen` — public surface.
 *
 * Everything a consumer may import is here, in one entry point, grouped by the question it
 * answers. There is no second entry point: `@kraionix/nodered-flowgen/toolkit` existed before this
 * tiering and stays, because it is a *separate extension mechanism* rather than another slice of
 * the same API, but nothing new is added to it.
 *
 * ## The four tiers
 *
 * | Tier | The question it answers | Roughly |
 * |---|---|---|
 * | **authoring** | "How do I declare my flows and my project?" | `defineConfig`, `defineFlowSet`, the builder's handles, helpers, parameters, layout, subflow libraries |
 * | **palette** | "What does my Node-RED know, and how do I describe the parts it does not?" | the palette model, the committed snapshot and its hashes/diffs, overlay declarations |
 * | **diagnostics** | "Is what I built acceptable, and where does that go wrong?" | `Problem`, the validator contract, the built-in validators, the environments and ports they need |
 * | **testing** | "How do I assert on the result without an instance?" | the IR, canonical emission, parsing, defaults, normalisation, printing back to source |
 *
 * A name lives in exactly one tier — the one whose reader would look for it — even when a second
 * tier also uses it: `PaletteTypes` is in the palette tier because that is what a generated
 * augmentation extends, and the authoring tier reaches it through `PropsFor`.
 *
 * ## What is not here
 *
 * The rule for the boundary is one sentence: **a name is public when its shape is a decision we can
 * defend to a user; it is internal when its shape is dictated by how the CLI happens to work
 * today.** So the extractors that read Node-RED's registration HTML, the layout of the generated
 * type files, the id counter behind the lockfile, the `Builder` class itself, config resolution and
 * the whole deploy path (`plan`/`apply`/`rollback`, the lockfile, the receipts) live in
 * `src/internal.ts` and are **not reachable** from a consumer: `exports` in `package.json` names
 * only `.` and `./toolkit`, so importing `@kraionix/nodered-flowgen/internal` fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than appearing to work and then breaking.
 *
 * The deploy path deserves one extra sentence, because it looks like an omission. A programmatic
 * `plan`/`apply` is not part of this round's contract: `flowgen plan --json` and
 * `flowgen apply --json` are the supported machine-readable faces of it, and they are what a
 * pipeline should call. The plan's semantics — ownership, compare-and-swap on `rev`, receipts —
 * are the product, and they are cheaper to keep compatible behind a documented CLI contract than
 * behind a TypeScript signature.
 *
 * The tiers are enforced from a consumer's position, not by convention: `test/types/` holds one
 * fixture per tier that imports **only** this entry point, and
 * `test/integration/packaging.spec.ts` repeats the exercise against the packed and installed
 * tarball.
 */

// ---------------------------------------------------------------------------------------------
// 1. authoring — declare flows, then declare the project around them
// ---------------------------------------------------------------------------------------------

export { err, isErr, isOk, mapResult, ok, unwrapOrThrow, type Result } from './result.ts';

export { type EnvValue, type NodeEnvelope, type NodeRef, type PropsFor, type Ref } from './typing.ts';

export { defineConfig, type FlowgenConfig, type PaletteProfile, type TargetConfig } from './config/index.ts';

export {
  defineFlowSet,
  type BuildOptions,
  type BuildResult,
  type FlowSetDefinition,
} from './authoring/defineFlowSet.ts';

// The builder's *contract*. The class that implements it is internal: `Builder` has fields a
// fluent user never names, and publishing it would freeze them.
export {
  type BuilderOptions,
  type ConfigScopeOptions,
  type ContainerHandle,
  type FlowBuilder,
  type FlowHandle,
  type FlowOptions,
  type GroupHandle,
  type GroupOptions,
  type InstanceOptions,
  type ManifestOptions,
  type NodeHandle,
  type SubflowHandle,
  type SubflowOptions,
} from './authoring/builder.ts';

export {
  defineSubflowLibrary,
  subflows,
  type SubflowDefinition,
  type SubflowLibrary,
} from './authoring/library.ts';

export {
  layoutFlowSet,
  layoutFlowSetWithDiagnostics,
  type LayoutOptions,
  type LayoutResult,
} from './authoring/layout.ts';

export {
  P,
  toEnvOverrides,
  toEnvParams,
  type ParamDeclarations,
  type ParamSpec,
  type ParamType,
} from './authoring/params.ts';

export {
  dashboard,
  dashboardIn,
  DEFAULT_SITE_SIZES,
  WIDGETS,
  type Dashboard,
  type DashboardBase,
  type DashboardOptions,
  type DashboardSite,
  type DashboardSizes,
  type GroupProps,
  type TabProps,
  type WidgetName,
  type WidgetProps,
  type WidgetPropsFor,
  type WidgetType,
} from './authoring/helpers/dashboard.ts';

export {
  formatSkipped as formatSkippedExtensions,
  Toolkit,
  toolkit,
  type Disposer,
  type Extension,
  type SkippedExtension,
} from './toolkit/index.ts';

// ---------------------------------------------------------------------------------------------
// 2. palette — the schema, the snapshot, and the curated knowledge on top of it
// ---------------------------------------------------------------------------------------------

export {
  deriveRefSpec,
  getPaletteType,
  inputCount,
  isConfigCategory,
  isSubflowType,
  outputCount,
  paletteProperty,
  paletteType,
  PALETTE_SCHEMA_VERSION,
  propertyNames,
  refAccepts,
  referenceProperties,
  requiredPropertyNames,
  subflowDefinitionId,
  subflowTypeId,
  SUBFLOW_TYPE_PREFIX,
  type PaletteNodeSet,
  type PaletteParameter,
  type PaletteProperty,
  type PaletteProvenance,
  type PaletteSourceKind,
  type PaletteType,
  type RefSpec,
  type RefTargets,
  type TypeDynamics,
} from './palette/model.ts';

// The augmentation targets. The generated files under `palettes/<profile>.d/` declare
// `interface KnownTypes` and `interface PaletteTypes` *inside* this module, which only merges if
// these names come from here — renaming or moving them breaks every generated file.
export { type KnownType, type KnownTypes, type PaletteTypes } from './typing.ts';

export {
  createPaletteSnapshot,
  DEFAULT_GENERATOR,
  describePalette,
  diffPalette,
  hashPaletteContent,
  PaletteSnapshotError,
  parsePaletteSnapshot,
  recomputeContentHash,
  samePaletteContent,
  serializePaletteSnapshot,
  snapshotContent,
  type PaletteDiff,
  type PaletteNodeSetChange,
  type PaletteSnapshot,
  type PaletteSnapshotInput,
  type PaletteSnapshotIssue,
  type PaletteSnapshotIssueCode,
  type PaletteSummary,
  type PaletteTypeChange,
  type ParsePaletteOptions,
  type SerializeOptions,
} from './palette/snapshot.ts';

// Curated knowledge: how a project describes a node type the installation cannot show us, or
// corrects one it shows wrongly. Deliberately never written into the snapshot file, so
// `palette pull` cannot lose it.
export {
  applyPatch,
  overlay,
  toRefSpec,
  type OverlayDeclaration,
  type PaletteTypePatch,
  type RefDeclaration,
} from './palette/sources/overlay.ts';

export {
  applyOverlays,
  PaletteSourceError,
  rebuildPalette,
  withType,
  type PaletteOverlay,
  type PaletteSource,
  type PaletteSourceErrorCode,
  type RebuildOptions,
} from './palette/sources/source.ts';

export { INLINE_MODULE } from './palette/sources/subflow.ts';

// ---------------------------------------------------------------------------------------------
// 3. diagnostics — problems, validators, and what a validator may need from the world
// ---------------------------------------------------------------------------------------------

export {
  countBySeverity,
  exitCodeFor,
  hasErrors,
  type BuiltinProblemCode,
  type Problem,
  type ProblemCode,
  type Severity,
} from './diagnostics/index.ts';

export {
  formatProblems,
  formatSkipped,
  runValidators,
  type EnvironmentKey,
  type FormatOptions,
  type LiveInstance,
  type LiveInstanceClient,
  type NrlintPort,
  type RuntimeProbePort,
  type SkippedValidator,
  type ValidationContext,
  type ValidationReport,
  type ValidationRun,
  type Validator,
  type ValidatorEnvironment,
} from './validate/report.ts';

export {
  credentialChecks,
  defaultValidators,
  graphChecks,
  overlayRulesValidator,
  paletteChecks,
  targetChecks,
  type OverlayRule,
  type ValidatorSetOptions,
} from './validate/index.ts';

// ---------------------------------------------------------------------------------------------
// 4. testing — the oracle, from a consumer's own test runner and with no instance
// ---------------------------------------------------------------------------------------------

// The IR itself. A test reads it; `defineFlowSet` is how it is written.
export {
  allIds,
  eachConfig,
  eachGroup,
  eachNode,
  eachSubflow,
  EMPTY_FLOW_SET,
  emptyNodeProps,
  findConfig,
  findNode,
  INTERNAL_NODE_KEYS,
  STRUCTURAL_NODE_KEYS,
  wireArity,
  type ConfigNode,
  type Credentials,
  type EntityId,
  type EnvParam,
  type Flow,
  type FlowSet,
  type Geometry,
  type Group,
  type Node,
  type NodeProps,
  type SubflowDef,
  type SubflowPortLink,
  type SubflowPorts,
} from './model/entities.ts';

export {
  effectiveInputCount,
  effectiveOutputCount,
  normalizeConfig,
  normalizeFlowSet,
  normalizeFlowSetWithFixes,
  normalizeGroup,
  normalizeNode,
  type NormalizeContext,
} from './model/normalize.ts';

// What an editor export does not contain and a rebuild always does: the declared defaults. A test
// that compares generated output with a hand-written file needs this step, and the CLI's `import`
// is the same call.
export {
  materialiseDefaults,
  type MaterializeContext,
  type MaterializeResult,
} from './model/defaults.ts';

// Canonical emission is the property everything else rests on: same IR in, same bytes out.
export {
  emitConfig,
  emitEntries,
  emitFlow,
  emitFlowSet,
  emitGlobalConfig,
  emitGroup,
  emitNode,
  emitSubflow,
  type EmitOptions,
} from './emit/flowJson.ts';

export { parseFlowFile, parseFlowSetText, type ImportOptions } from './import/fromFlowJson.ts';

// ...and the same property in the other direction: a flow file back as the source that could have
// produced it (`flowgen import`). The printer is here rather than in `authoring` because it *reads*
// the IR, and a consumer's round-trip test is its most demanding caller after the CLI.
export {
  DEFAULT_MODULE,
  printFlowSet,
  type PrintNote,
  type PrintOptions,
  type PrintReport,
  type PrintResult,
} from './codegen/print.ts';

/**
 * `@kraionix/nodered-flowgen` — public surface.
 *
 * The package is layered: `model` and `palette` are pure data and depend on nothing,
 * `emit` and `validate` derive from them, and the I/O layers (`io`, `import`, `authoring`)
 * sit on top. Only this entry point decides what is public; deep imports are internal.
 */

export { err, isErr, isOk, mapResult, ok, unwrapOrThrow, type Result } from './result.ts';

export {
  type EnvValue,
  type KnownType,
  type KnownTypes,
  type NodeEnvelope,
  type NodeRef,
  type PaletteTypes,
  type PropsFor,
  type Ref,
} from './typing.ts';

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

export * from './validate/index.ts';
export {
  countBySeverity,
  exitCodeFor,
  hasErrors,
  type BuiltinProblemCode,
  type Problem,
  type ProblemCode,
  type Severity,
} from './validate/problem.ts';
export {
  formatProblems,
  formatSkipped,
  runValidators,
  type Capability,
  type FormatOptions,
  type SkippedValidator,
  type ValidationContext,
  type ValidationReport,
  type ValidationRun,
  type Validator,
} from './validate/report.ts';

export {
  parseFlowFile,
  parseFlowSetText,
  type ImportOptions,
} from './import/fromFlowJson.ts';

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

export { createIdAllocator, slugify, type IdAllocator, type IdPolicy } from './model/ids.ts';

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

export {
  formatSkipped as formatSkippedExtensions,
  Toolkit,
  toolkit,
  type Disposer,
  type Extension,
  type SkippedExtension,
} from './toolkit/index.ts';

export {
  Builder,
  type BuilderOptions,
  type ContainerHandle,
  type FlowBuilder,
  type FlowHandle,
  type FlowOptions,
  type GroupHandle,
  type GroupOptions,
  type InstanceOptions,
  type NodeHandle,
  type SubflowHandle,
  type SubflowOptions,
} from './authoring/builder.ts';

export {
  defineFlowSet,
  type BuildOptions,
  type BuildResult,
  type FlowSetDefinition,
} from './authoring/defineFlowSet.ts';

export { layoutFlowSet, type LayoutOptions } from './authoring/layout.ts';

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
  WIDGETS,
  type Dashboard,
  type DashboardBase,
  type DashboardOptions,
  type GroupProps,
  type TabProps,
  type WidgetName,
  type WidgetProps,
  type WidgetPropsFor,
  type WidgetType,
} from './authoring/helpers/dashboard.ts';

export {
  DEFAULT_PACKAGE_NAME,
  DEFAULT_TYPES_DIRECTORY,
  emitTypes,
  sanitize,
  type EmitTypesOptions,
  type GeneratedFile,
} from './palette/codegen/emitTypes.ts';

export {
  emitCheatSheet,
  emitPaletteModule,
  type CheatSheetOptions,
} from './palette/codegen/emitSnapshot.ts';

export {
  applyOverlays,
  PaletteSourceError,
  rebuildPalette,
  withType,
  type PaletteOverlay,
  type PaletteSource,
  type PaletteSourceErrorCode,
  type PaletteSource as PaletteSourcePort,
  type RebuildOptions,
} from './palette/sources/source.ts';

export {
  filesystemSource,
  type FilesystemSourceOptions,
} from './palette/sources/filesystem.ts';

export {
  liveHttpSource,
  type LiveHttpSourceOptions,
} from './palette/sources/liveHttp.ts';

export {
  fileSnapshotSource,
  parseSnapshotText,
  readSnapshotFile,
  snapshotSource,
  writeSnapshotFile,
  type SnapshotSourceOptions,
  type WriteResult,
} from './palette/sources/snapshot.ts';

export {
  INLINE_MODULE,
  subflowOverlay,
  subflowPaletteType,
  type SubflowDefinitionLike,
  type SubflowParameterLike,
} from './palette/sources/subflow.ts';

export {
  applyPatch,
  overlay,
  toRefSpec,
  type OverlayDeclaration,
  type PaletteTypePatch,
  type RefDeclaration,
} from './palette/sources/overlay.ts';

export {
  assembleNodeSets,
  extractFromMarkedHtml,
  parseNodeSets,
  splitHtmlByModuleMarker,
  type AttributionIssue,
  type AttributionIssueCode,
  type HtmlSection,
  type MarkedHtmlExtraction,
  type MarkedHtmlOptions,
} from './palette/extract/attribute.ts';

export {
  extractRegisteredTypes,
  type ExtractOptions,
  type ExtractionIssue,
  type HtmlExtraction,
  type RegisteredType,
} from './palette/extract/registerType.ts';

export { normalizeRegisteredType, synthesizeType } from './palette/extract/normalize.ts';

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

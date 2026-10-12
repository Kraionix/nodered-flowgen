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

export {
  normalizeRegisteredType,
  synthesizeType,
  type NormalizeContext,
} from './palette/extract/normalize.ts';

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

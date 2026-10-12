/**
 * `@kraionix/nodered-flowgen` — public surface.
 *
 * The package is layered: `model` and `palette` are pure data and depend on nothing,
 * `emit` and `validate` derive from them, and the I/O layers (`io`, `import`, `authoring`)
 * sit on top. Only this entry point decides what is public; deep imports are internal.
 */

export { err, isErr, isOk, mapResult, ok, unwrapOrThrow, type Result } from './result.ts';

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

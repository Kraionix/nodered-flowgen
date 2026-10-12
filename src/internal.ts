/**
 * The private barrel: everything the CLI, the tests and a future embedder share that is **not**
 * part of the published contract.
 *
 * It is deliberately not reachable from `@kraionix/nodered-flowgen`. `exports` in `package.json`
 * names `.`, `./toolkit` and `./package.json`, and nothing else, so a consumer that writes
 * `@kraionix/nodered-flowgen/internal` — or reaches for any deep path — gets
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than a promise nobody intends to keep. The published
 * `dist/internal.js` exists because the CLI is *inside* the same package; it is a build artifact of
 * our own decomposition, not an API.
 *
 * The split rule is one sentence: **a name is public when its shape is a decision we can defend to
 * a user, and internal when its shape is dictated by how the CLI happens to work today.** That is
 * why the palette *model*, the snapshot *format* and the overlay *declarations* are public while
 * the HTML attribution heuristics, the id counter, the generated-file layout and the file/network
 * sources are here: the first three are things a project author reasons about, the last four are
 * things `flowgen palette pull` needs and may change whenever Node-RED's editor does.
 *
 * Nothing in `src/index.ts` may import this file. If a name belongs in a tier, move it there —
 * re-exporting from here would make every mechanism public again through the back door, and
 * `test/unit/layers.test.ts` fails if that happens.
 */

// --- Model: the id counter and the slug spelling -------------------------------------------
// Keys become ids through `IdPolicy`, and the lockfile records the mapping. The policy is a CLI
// decision (it is what `--ids` and the lockfile are written against), not a user-facing knob.
export { createIdAllocator, slugify, type IdAllocator, type IdPolicy } from './model/ids.ts';

// --- Authoring: the builder class itself ----------------------------------------------------
// `FlowBuilder` and the handle types are the contract the user's callback is written against;
// `Builder` is one implementation of it. Publishing the class would freeze the fields a caller
// could reach for, so only the interface is public.
export { Builder } from './authoring/builder.ts';

// --- Palette: where a palette comes from ----------------------------------------------------
// Acquisition is the CLI's job (`palette pull`, `palette check`). The *artifact* it produces
// (`parsePaletteSnapshot`, the model, the hashes) and the way curated knowledge is expressed
// (`overlay`, `withType`, `applyOverlays`, `rebuildPalette`, the `PaletteSource` port) are public
// instead — they are what a project author reasons about, these are the mechanisms behind them.
export { filesystemSource, type FilesystemSourceOptions } from './palette/sources/filesystem.ts';

export { liveHttpSource, snapshotFromNodeList, type LiveHttpSourceOptions } from './palette/sources/liveHttp.ts';

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
  subflowOverlay,
  subflowPaletteType,
  type SubflowDefinitionLike,
  type SubflowParameterLike,
} from './palette/sources/subflow.ts';

// --- Palette: reading Node-RED's own registration HTML --------------------------------------
// The extractor sees what the editor sees at registration time. It is how a live instance's
// `/nodes` payload becomes types, and its output shape follows that payload — so it stays here
// while the result (`PaletteNodeSet`, `PaletteType`) is public.
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

// --- Palette: the generated files -----------------------------------------------------------
// `flowgen types gen` writes these. The *layout* of a generated directory (one file per module,
// the index with the reference list, the cheat sheet) is a CLI convention; the typing a consumer
// compiles against is `PaletteTypes`/`PropsFor`, which are public.
export {
  DEFAULT_PACKAGE_NAME,
  DEFAULT_TYPES_DIRECTORY,
  emitTypes,
  sanitize,
  type EmitTypesOptions,
  type GeneratedFile,
} from './palette/codegen/emitTypes.ts';

export { emitCheatSheet, emitPaletteModule, type CheatSheetOptions } from './palette/codegen/emitSnapshot.ts';

// --- Project configuration: resolving it ----------------------------------------------------
// The user writes `defineConfig({…})`; turning that into paths, profiles and a validator list is
// what the CLI does with the project root, and the defaults are its flags' defaults.
export {
  DEFAULT_CONFIG_FILE,
  DEFAULT_LOCKFILE,
  DEFAULT_PROFILE,
  DEFAULT_RECEIPTS_DIR,
  resolveConfig,
  resolveProfile,
  type ResolvedConfig,
  type ResolvedProfile,
} from './config/index.ts';

// --- I/O: the deploy path -------------------------------------------------------------------
// `plan`, `apply`, `rollback`, the lockfile and the receipts are the CLI's features. A
// programmatic deploy is not part of this round's contract: `plan --json` and `apply --json` are
// the machine-readable faces of them, and they are documented as such in the README.
export {
  adminApi,
  AdminApiClient,
  AdminApiError,
  type AdminApiErrorCode,
  type AdminApiOptions,
  type DeployResult,
  type FlowState,
} from './io/adminApi.ts';

export {
  applyDeployment,
  rollbackDeployment,
  type ApplyAbortReason,
  type ApplyOptions,
  type ApplyResult,
} from './io/apply.ts';

export {
  containerEntityIds,
  isNoop,
  MUTATION_KINDS,
  planMerge,
  summarizePlan,
  writtenContainers,
  type DeploymentPlan,
  type MergeRequest,
  type PlanNote,
  type PlanOperation,
  type PlanOperationKind,
  type PropertyChange,
} from './io/plan.ts';

export {
  EMIT_SCHEMA_VERSION,
  emptyLockfile,
  knownIds,
  lockfileIdMap,
  LOCKFILE_VERSION,
  ownedContainers,
  parseLockfile,
  releaseContainer,
  serializeLockfile,
  updateLockfile,
  type Lockfile,
  type LockfileIssue,
  type LockfileUpdate,
  type LockTarget,
} from './io/lockfile.ts';

export {
  createReceipt,
  parseReceipt,
  readReceiptFile,
  RECEIPT_VERSION,
  serializeReceipt,
  writeReceipt,
  type Receipt,
  type ReceiptIssue,
} from './io/receipt.ts';

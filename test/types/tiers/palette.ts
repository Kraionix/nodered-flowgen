/**
 * Tier 2 of 4 — **palette**, compiled from a consumer's position.
 *
 * The palette is the schema, and this fixture is what a project does with it *outside* the CLI:
 * inspect a committed snapshot, read what a type declares, hash and diff two snapshots, and
 * describe the node types the installation cannot show us — an overlay, applied in memory and
 * never written into the file, so `palette pull` cannot lose it.
 *
 * Note what is deliberately *not* here: `filesystemSource`, `liveHttpSource`, `emitTypes`. Those
 * are how the CLI acquires and generates; a consumer that wants them wants the command.
 */

import {
  applyOverlays,
  applyPatch,
  createPaletteSnapshot,
  deriveRefSpec,
  describePalette,
  diffPalette,
  getPaletteType,
  hashPaletteContent,
  INLINE_MODULE,
  inputCount,
  isConfigCategory,
  isSubflowType,
  outputCount,
  overlay,
  paletteProperty,
  paletteType,
  PALETTE_SCHEMA_VERSION,
  parsePaletteSnapshot,
  propertyNames,
  refAccepts,
  referenceProperties,
  recomputeContentHash,
  requiredPropertyNames,
  samePaletteContent,
  serializePaletteSnapshot,
  snapshotContent,
  subflowDefinitionId,
  subflowTypeId,
  SUBFLOW_TYPE_PREFIX,
  unwrapOrThrow,
  withType,
  type KnownType,
  type OverlayDeclaration,
  type PaletteDiff,
  type PaletteNodeSet,
  type PaletteOverlay,
  type PaletteProperty,
  type PaletteSource,
  type PaletteSummary,
  type PaletteType,
  type PaletteTypePatch,
  type PaletteTypes,
  type Ref,
  type RefDeclaration,
  type RefSpec,
  type SerializeOptions,
} from '@kraionix/nodered-flowgen';

// The generated files declare these two interfaces; a consumer's own augmentation may too. The
// type id is fixture-specific on purpose: `positive.ts` asserts that an *unknown* type gets an
// open property bag, and augmenting `inhouse-plc` here would take that case away from it.
declare module '@kraionix/nodered-flowgen' {
  interface KnownTypes {
    'tier-fixture-plc': true;
  }
  interface PaletteTypes {
    'tier-fixture-plc': { name?: string; register?: string; gateway: Ref<'tier-fixture-gateway'> };
  }
}

// --- describing a type the installation cannot show us ---------------------------------------

const gatewayRef: RefDeclaration = 'tier-fixture-gateway';
const manyRefs: RefDeclaration = ['gateway-a', 'gateway-b'];
const anyRef: RefDeclaration = '*[]';

const nameProperty: PaletteProperty = paletteProperty({ value: '', required: true });
const registerProperty: PaletteProperty = paletteProperty({ value: 'D100', label: 'register' });

const plcPatch: PaletteTypePatch = {
  module: 'inhouse',
  nodeSet: 'inhouse/plc',
  version: '1.0.0',
  category: 'inhouse',
  paletteLabel: 'PLC',
  color: '#aabbcc',
  icon: 'font-awesome/fa-microchip',
  align: 'left',
  inputs: 1,
  outputs: 2,
  showLabel: true,
  isConfig: false,
  synthetic: false,
  refs: { gateway: gatewayRef, peers: manyRefs, bus: anyRef },
  defaults: { name: nameProperty, register: registerProperty },
  credentials: { token: paletteProperty({ value: '' }) },
  // No `ui`: the snapshot format omits it when the editor declared none, so a hand-written
  // parameter list must not have to invent the field to compile.
  params: [{ name: 'factor', type: 'num', value: '2' }],
};

const declaration: OverlayDeclaration = {
  id: 'inhouse',
  types: { 'tier-fixture-plc': plcPatch, inject: { defaults: { payload: { value: '0' } } } },
};

const inhouse: PaletteOverlay = overlay(declaration);

// A type built by hand rather than patched into an existing one.
const handWritten: PaletteType = paletteType('tier-fixture-plc', {
  module: 'inhouse',
  nodeSet: 'inhouse/plc',
  version: '1.0.0',
  inputs: 1,
  outputs: 2,
  synthetic: true,
  refs: { gateway: deriveRefSpec('tier-fixture-gateway') },
  defaults: { name: nameProperty },
});

// ...and the same through the patch path, which is what an overlay does internally.
const patched: PaletteType = applyPatch(undefined, 'tier-fixture-gateway', { paletteLabel: 'Gateway', isConfig: true });

// --- a snapshot, its hash, and its text form -------------------------------------------------

const nodeSet: PaletteNodeSet = {
  id: 'inhouse/plc',
  name: 'plc',
  module: 'inhouse',
  version: '1.0.0',
  enabled: true,
  local: true,
  user: true,
  types: ['tier-fixture-gateway', 'tier-fixture-plc'],
};

export const snapshot = createPaletteSnapshot({
  nodeRedVersion: '5.0.8',
  nodeSets: [nodeSet],
  types: [handWritten, patched],
  provenance: { kind: 'overlay', url: null, userDir: null, nodeModulesDirs: null },
});

const options: SerializeOptions = { indent: 2 };
const text: string = serializePaletteSnapshot(snapshot, options);
const reread = unwrapOrThrow(parsePaletteSnapshot(text));
const curated = applyOverlays(snapshot, [inhouse]);
const extended = withType(curated, handWritten);

export const contentHash: string = hashPaletteContent(snapshotContent(extended));
export const recomputed: string = recomputeContentHash(extended);
export const unchanged: boolean = samePaletteContent(reread, snapshot);
export const summary: PaletteSummary = describePalette(extended);
export const changes: PaletteDiff = diffPalette(reread, extended);

// A source port is a contract a project can implement; the implementations ship in the CLI.
const inMemory: PaletteSource = { id: 'in-memory', load: async () => curated };

// --- reading what a type declares ------------------------------------------------------------

const fixtureType: PaletteType | null = getPaletteType(extended.types, 'tier-fixture-plc');
const inspected = fixtureType ?? handWritten;
const acceptSpec: RefSpec = deriveRefSpec('tier-fixture-gateway');

export const properties: readonly string[] = propertyNames(inspected);
export const required: readonly string[] = requiredPropertyNames(inspected);
export const references: readonly (readonly [string, RefSpec])[] = referenceProperties(inspected);
export const arity: readonly number[] = [inputCount(inspected), outputCount(inspected)];
export const accepts: boolean = refAccepts(acceptSpec, 'tier-fixture-gateway');

export const isConfig = isConfigCategory('config');
export const subflowType: string = subflowTypeId('scale');
export const definitionId: string | null = subflowDefinitionId(subflowType);
export const isSubflow: boolean = isSubflowType(subflowType);
export const constants: readonly unknown[] = [
  PALETTE_SCHEMA_VERSION,
  SUBFLOW_TYPE_PREFIX,
  INLINE_MODULE,
  inMemory.id,
  gatewayRef,
  anyRef,
];

// --- the augmentation contract ---------------------------------------------------------------

export const known: KnownType = 'tier-fixture-plc';
export type PlcProps = PaletteTypes['tier-fixture-plc'];

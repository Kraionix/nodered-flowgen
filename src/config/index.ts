/**
 * The project configuration contract: `flowgen.config.ts`.
 *
 * The config is TypeScript rather than JSON because everything in it benefits from types: the
 * flow-set definition, the validators mounted on top of the built-in ones, and the palette
 * profiles all have shapes the compiler can check. The file is imported by the CLI through
 * Node's type stripping, which is why it must be free of side effects — `--help` and
 * `flowgen plan --dry-run` import it without touching a network.
 *
 * ```ts
 * import { dashboardIn, defineConfig, defineFlowSet } from '@kraionix/nodered-flowgen';
 *
 * export default defineConfig({
 *   flowSet: defineFlowSet((f) => {
 *     const tab = f.flow('orders', { label: 'Orders' });
 *     tab.node('http in', { url: '/orders', method: 'get' });
 *   }),
 *   palette: { default: 'local', profiles: { local: { snapshot: 'palettes/local.json' } } },
 *   targets: { local: { url: 'http://127.0.0.1:1880' } },
 * });
 * ```
 *
 * A bare `defineFlowSet(...)` default export is also accepted: it means "one palette profile
 * called `local`, in the default location, and no targets", which is what `flowgen init`
 * scaffolds before an instance is known.
 */

import type { FlowSetDefinition } from '../authoring/defineFlowSet.ts';
import { DEFAULT_PACKAGE_NAME, DEFAULT_TYPES_DIRECTORY } from '../palette/codegen/emitTypes.ts';
import type { Validator } from '../validate/report.ts';

/** Where a palette comes from, and where its generated artifacts live. */
export interface PaletteProfile {
  /** Committed snapshot; defaults to `palettes/<profile>.json`. */
  readonly snapshot?: string;
  /** Generated augmentations; defaults to `palettes/<profile>.d`. */
  readonly typesDirectory?: string;
  /** Generated cheat sheet; defaults to `palettes/<profile>.md`. `false` disables it. */
  readonly cheatSheet?: string | false;
  /** Module specifier the generated files augment; defaults to this package. */
  readonly packageName?: string;
  /** Live instance to pull from (a profile without this can only be read from disk). */
  readonly url?: string;
  /** Environment variable holding the bearer token for `url`. */
  readonly tokenEnv?: string;
  /** Offline source: a Node-RED user directory (`<userDir>/node_modules` is scanned). */
  readonly userDir?: string;
  /** Offline source: `<install>/node_modules/@node-red/nodes`. */
  readonly coreNodesDir?: string;
  /** Offline source: extra directories scanned the way Node-RED's `nodesDir` is. */
  readonly nodeModulesDirs?: readonly string[];
}

/** A deploy target: one Node-RED instance and the policy for touching it. */
export interface TargetConfig {
  readonly url: string;
  /** Environment variable holding the bearer token; omit for an instance without `adminAuth`. */
  readonly tokenEnv?: string;
  /** Palette profile this target is pinned to; defaults to the project default. */
  readonly paletteProfile?: string;
  /** Default for `--prune` on this target. `apply --prune` still overrides it. */
  readonly prune?: boolean;
  /** Refuse to write to this target (`plan`/`validate` still work against it). */
  readonly readOnly?: boolean;
}

export interface FlowgenConfig {
  /** The authored flow set: the only required field. */
  readonly flowSet: FlowSetDefinition;
  readonly palette?: {
    /** Profile used when nothing else says otherwise; defaults to `local`. */
    readonly default?: string;
    readonly profiles?: Readonly<Record<string, PaletteProfile>>;
  };
  readonly targets?: Readonly<Record<string, TargetConfig>>;
  /** Ownership and id record; defaults to `.flowgen.lock.json`. */
  readonly lockfile?: string;
  /** Where receipts are written; defaults to `.flowgen/receipts`. */
  readonly receipts?: string;
  /** Extra validators, appended to the built-in ones. */
  readonly validators?: readonly Validator[];
  /** Layout options for the authoring pass, or `false` to keep authored coordinates. */
  readonly layout?: Parameters<FlowSetDefinition['build']>[0]['layout'];
}

/** Identity function that exists for its type: it checks the config at the definition site. */
export function defineConfig(config: FlowgenConfig): FlowgenConfig {
  return config;
}

/** Defaults a config may leave out, resolved against the project root. */
export interface ResolvedConfig {
  readonly flowSet: FlowSetDefinition;
  readonly defaultProfile: string;
  readonly profiles: Readonly<Record<string, PaletteProfile>>;
  readonly targets: Readonly<Record<string, TargetConfig>>;
  readonly lockfile: string;
  readonly receipts: string;
  readonly validators: readonly Validator[];
  readonly layout: FlowgenConfig['layout'];
  /** Path of the file the config came from, for diagnostics. */
  readonly configPath: string;
  /** Package the generated types augment. */
  readonly packageName: string;
}

export const DEFAULT_CONFIG_FILE = 'flowgen.config.ts';
export const DEFAULT_LOCKFILE = '.flowgen.lock.json';
export const DEFAULT_RECEIPTS_DIR = '.flowgen/receipts';
export const DEFAULT_PROFILE = 'local';

export function resolveConfig(config: FlowgenConfig, configPath: string): ResolvedConfig {
  const defaultProfile = config.palette?.default ?? DEFAULT_PROFILE;
  const profiles = config.palette?.profiles ?? {};
  const packageName = profiles[defaultProfile]?.packageName ?? DEFAULT_PACKAGE_NAME;

  return {
    flowSet: config.flowSet,
    defaultProfile,
    profiles,
    targets: config.targets ?? {},
    lockfile: config.lockfile ?? DEFAULT_LOCKFILE,
    receipts: config.receipts ?? DEFAULT_RECEIPTS_DIR,
    validators: config.validators ?? [],
    layout: config.layout,
    configPath,
    packageName,
  };
}

/** The palette profile with every path defaulted, as the commands want it. */
export interface ResolvedProfile extends PaletteProfile {
  readonly name: string;
  readonly snapshotPath: string;
  readonly typesPath: string;
  readonly cheatSheetPath: string | null;
  readonly packageName: string;
}

export function resolveProfile(config: ResolvedConfig, name: string): ResolvedProfile {
  const profile = config.profiles[name] ?? {};
  const cheatSheet = profile.cheatSheet ?? `palettes/${name}.md`;
  return {
    ...profile,
    name,
    snapshotPath: profile.snapshot ?? `palettes/${name}.json`,
    typesPath: profile.typesDirectory ?? (name === DEFAULT_PROFILE ? DEFAULT_TYPES_DIRECTORY : `palettes/${name}.d`),
    cheatSheetPath: cheatSheet === false ? null : cheatSheet,
    packageName: profile.packageName ?? config.packageName,
  };
}

/**
 * The lockfile: ownership and id stability, in git.
 *
 * It answers two questions the flow sources cannot answer by themselves:
 *
 * * **Which containers may this tool touch?** `apply` never modifies an unowned container, and
 *   `POST /flows` replaces the whole flow set — so ownership has to be enforced client-side, and
 *   the record of what we created is the lockfile.
 * * **What id does this authoring key have?** Without it, renaming a key would silently create a
 *   new container and orphan the old one; with it, ids survive renames, reorderings and
 *   refactorings, and a rename that *does* change an id shows up in the plan.
 *
 * The shape follows the spec (`lockVersion`, `emitSchemaVersion`, `targets`, `owned`, `ids`) and
 * contains no secrets: URLs and palette hashes only.
 */

import { err, ok, type Result } from '../result.ts';

export const LOCKFILE_VERSION = 1;
/** Version of the emitter contract; a mismatch means generated files must be regenerated. */
export const EMIT_SCHEMA_VERSION = 1;

export interface LockTarget {
  readonly url: string;
  readonly paletteProfile?: string;
  readonly paletteHash?: string;
}

export interface Lockfile {
  readonly lockVersion: number;
  readonly emitSchemaVersion: number;
  /** Target name → where it is and which palette it was planned against. */
  readonly targets: Readonly<Record<string, LockTarget>>;
  /** Target name → container ids this tool created there. */
  readonly owned: Readonly<Record<string, { readonly containers: readonly string[] }>>;
  /** Authoring key → emitted id (`tab:orders` → `orders`, `node:orders/start` → `start`). */
  readonly ids: Readonly<Record<string, string>>;
}

export interface LockfileIssue {
  readonly code: 'invalid-json' | 'not-an-object' | 'unsupported-version' | 'invalid-field';
  readonly path: string;
  readonly message: string;
}

export function emptyLockfile(): Lockfile {
  return { lockVersion: LOCKFILE_VERSION, emitSchemaVersion: EMIT_SCHEMA_VERSION, targets: {}, owned: {}, ids: {} };
}

export function serializeLockfile(lockfile: Lockfile): string {
  const document = {
    lockVersion: lockfile.lockVersion,
    emitSchemaVersion: lockfile.emitSchemaVersion,
    targets: sortRecord(lockfile.targets),
    owned: sortRecord(
      Object.fromEntries(Object.entries(lockfile.owned).map(([name, entry]) => [name, { containers: [...entry.containers].sort() }])),
    ),
    ids: sortRecord(lockfile.ids),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseLockfile(text: string): Result<Lockfile, readonly LockfileIssue[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err([{ code: 'invalid-json', path: '', message: cause instanceof Error ? cause.message : 'unparsable' }]);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err([{ code: 'not-an-object', path: '', message: 'a lockfile is a JSON object' }]);
  }

  const record = raw as Record<string, unknown>;
  const issues: LockfileIssue[] = [];
  const lockVersion = typeof record['lockVersion'] === 'number' ? record['lockVersion'] : LOCKFILE_VERSION;
  if (lockVersion !== LOCKFILE_VERSION) {
    issues.push({
      code: 'unsupported-version',
      path: 'lockVersion',
      message: `expected ${LOCKFILE_VERSION}, found ${lockVersion}`,
    });
  }

  return issues.length > 0 ? err(issues) : ok({
    lockVersion,
    emitSchemaVersion: typeof record['emitSchemaVersion'] === 'number' ? record['emitSchemaVersion'] : EMIT_SCHEMA_VERSION,
    targets: readTargets(record['targets']),
    owned: readOwned(record['owned']),
    ids: readIds(record['ids']),
  });
}

export interface LockfileUpdate {
  readonly target: string;
  readonly url: string;
  readonly paletteProfile?: string;
  readonly paletteHash?: string;
  /** Authoring key → id, as produced by the builder. */
  readonly keys: ReadonlyMap<string, string>;
  /** Containers (tabs and subflow definitions) this run created or updated. */
  readonly containers: readonly string[];
}

/**
 * Merges a build into the lockfile: ids are recorded, the target is updated, and ownership
 * grows. Ownership is never dropped implicitly — releasing a container is an explicit act, so a
 * mistake cannot silently orphan a tab on the instance.
 */
export function updateLockfile(lockfile: Lockfile, update: LockfileUpdate): Lockfile {
  const owned = new Set(lockfile.owned[update.target]?.containers ?? []);
  for (const container of update.containers) owned.add(container);

  return {
    lockVersion: LOCKFILE_VERSION,
    emitSchemaVersion: EMIT_SCHEMA_VERSION,
    targets: {
      ...lockfile.targets,
      [update.target]: {
        url: update.url,
        ...(update.paletteProfile === undefined ? {} : { paletteProfile: update.paletteProfile }),
        ...(update.paletteHash === undefined ? {} : { paletteHash: update.paletteHash }),
      },
    },
    owned: { ...lockfile.owned, [update.target]: { containers: [...owned].sort() } },
    ids: { ...lockfile.ids, ...Object.fromEntries(update.keys) },
  };
}

export function releaseContainer(lockfile: Lockfile, target: string, container: string): Lockfile {
  const owned = (lockfile.owned[target]?.containers ?? []).filter((id) => id !== container);
  return { ...lockfile, owned: { ...lockfile.owned, [target]: { containers: owned } } };
}

/** Key → id map for the builder, so a rebuild keeps the ids that are already deployed. */
export function lockfileIdMap(lockfile: Lockfile): ReadonlyMap<string, string> {
  return new Map(Object.entries(lockfile.ids));
}

export function ownedContainers(lockfile: Lockfile, target: string): ReadonlySet<string> {
  return new Set(lockfile.owned[target]?.containers ?? []);
}

/** Every id the lockfile knows about, whatever its kind: useful for collision detection. */
export function knownIds(lockfile: Lockfile): ReadonlySet<string> {
  return new Set(Object.values(lockfile.ids));
}

function readTargets(raw: unknown): Readonly<Record<string, LockTarget>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const targets: Record<string, LockTarget> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    targets[name] = {
      url: typeof record['url'] === 'string' ? record['url'] : '',
      ...(typeof record['paletteProfile'] === 'string' ? { paletteProfile: record['paletteProfile'] } : {}),
      ...(typeof record['paletteHash'] === 'string' ? { paletteHash: record['paletteHash'] } : {}),
    };
  }
  return targets;
}

function readOwned(raw: unknown): Readonly<Record<string, { containers: readonly string[] }>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const owned: Record<string, { containers: readonly string[] }> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const containers =
      value !== null && typeof value === 'object' && Array.isArray((value as { containers?: unknown }).containers)
        ? ((value as { containers: unknown[] }).containers.filter((entry) => typeof entry === 'string') as string[])
        : [];
    owned[name] = { containers };
  }
  return owned;
}

function readIds(raw: unknown): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') ids[key] = value;
  }
  return ids;
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Deterministic ids.
 *
 * The author writes *keys* (`f.node('inject', { key: 'start' })`); ids are derived from them.
 * Two properties matter:
 *
 * * **Determinism** — the same source must produce the same ids, byte for byte, so that a
 *   plan against an unchanged flow set is empty and a deploy is a no-op.
 * * **Readability** — an id like `inject_start` makes a deployed flow file, a diff and a
 *   `GET /flows` response readable without a lookup table, which random 16-hex ids are not.
 *
 * Collisions are resolved with an ordinal suffix. When a lockfile is present it wins: the
 * key → id mapping recorded there keeps ids stable across renames and reorderings, which is
 * what makes a container a stable identity for `plan` rather than a positional guess.
 */

/** Characters that are safe in ids and readable in a flow file. */
const UNSAFE = /[^A-Za-z0-9_-]+/g;

export interface IdPolicy {
  /** Upper bound for the slug part; ids stay short and readable. */
  readonly maxLength?: number;
  /** Separator between a key and its disambiguating ordinal. */
  readonly ordinalSeparator?: string;
}

const DEFAULT_POLICY: Required<IdPolicy> = { maxLength: 48, ordinalSeparator: '_' };

/**
 * Slugifies an authoring key. Unicode letters outside ASCII are transliterated away by
 * `normalize`, so a Cyrillic key still yields a stable (if ASCII) id rather than an empty one.
 */
export function slugify(key: string, policy: IdPolicy = {}): string {
  const { maxLength, ordinalSeparator } = { ...DEFAULT_POLICY, ...policy };
  const normalized = key
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(UNSAFE, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const trimmed = normalized.slice(0, maxLength).replace(/^_+|_+$/g, '');
  return trimmed === '' ? `node${ordinalSeparator}1` : trimmed;
}

export interface IdAllocator {
  /**
   * Returns a unique id for `key`; repeated calls with the same key return the same id.
   *
   * `options.slug` separates the *identity* from the *spelling*: the lockfile is keyed by a
   * namespaced key (`orders:start`) while the id is derived from the local part (`start`), so
   * renames stay stable and ids stay readable.
   */
  allocate(key: string, options?: { readonly slug?: string }): string;
  /** Claims an id that came from a lockfile or an imported flow set. */
  reserve(id: string): void;
  /** Maps a previously allocated key to the id that was used for it. */
  readonly assigned: ReadonlyMap<string, string>;
}

export interface IdAllocatorOptions extends IdPolicy {
  /** Ids already taken (an imported flow set, other containers in the project). */
  readonly existing?: Iterable<string>;
  /** Key → id mappings from the lockfile, which take precedence over derived ids. */
  readonly locked?: ReadonlyMap<string, string>;
}

export function createIdAllocator(options: IdAllocatorOptions = {}): IdAllocator {
  const policy: IdPolicy = options;
  const taken = new Set<string>(options.existing ?? []);
  const assigned = new Map<string, string>();
  const locked = options.locked ?? new Map<string, string>();
  const ordinals = new Map<string, number>();

  const separator = policy.ordinalSeparator ?? DEFAULT_POLICY.ordinalSeparator;

  function nextCandidate(base: string): string {
    const ordinal = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, ordinal);
    return ordinal === 1 ? base : `${base}${separator}${ordinal}`;
  }

  return {
    assigned,
    allocate(key: string, options?: { readonly slug?: string }): string {
      const existing = assigned.get(key);
      if (existing !== undefined) return existing;

      const lockedId = locked.get(key);
      if (lockedId !== undefined && !taken.has(lockedId)) {
        taken.add(lockedId);
        assigned.set(key, lockedId);
        return lockedId;
      }

      const base = slugify(options?.slug ?? key, policy);
      let candidate = nextCandidate(base);
      while (taken.has(candidate)) candidate = nextCandidate(base);
      taken.add(candidate);
      assigned.set(key, candidate);
      return candidate;
    },
    reserve(id: string): void {
      taken.add(id);
    },
  };
}

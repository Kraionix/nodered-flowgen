/**
 * The id registry: authoring key in, entity id out.
 *
 * Ids are the one thing that has to be *stable* across builds — a re-derived id is a rename, and a
 * rename on a live instance is a delete plus a create — so the rules live in one place rather than
 * being spread over the builder's entity-creating branches:
 *
 * * a key is allocated once; asking again returns the same id (that is what makes two calls to
 *   `f.flow('orders')` in different helper modules the same tab);
 * * the lockfile wins, because that is how an id survives a rename of the authoring key;
 * * a *repeated* key that is not the same entity gets its own id, with an ordinal, and the
 *   repetition is reported: silently returning the same id would merge two entities and silently
 *   renaming it would make the lockfile unstable.
 *
 * The spelling of the ordinal is `key#2`. It is part of the contract rather than an implementation
 * detail: `flowgen import` records the ids it printed, so it has to predict this spelling exactly
 * for a file that reuses a key.
 */

import { createIdAllocator, type IdAllocator } from '../model/ids.ts';
import type { EntityId } from '../model/entities.ts';

export interface IdRegistryOptions {
  /** Key → id from the lockfile; takes precedence over a derived id. */
  readonly lockfile?: ReadonlyMap<string, string> | undefined;
}

export class IdRegistry {
  readonly #allocator: IdAllocator;
  readonly #keys = new Map<string, EntityId>();
  readonly #duplicates: string[] = [];

  constructor(options: IdRegistryOptions = {}) {
    this.#allocator = createIdAllocator({
      ...(options.lockfile === undefined ? {} : { locked: options.lockfile }),
    });
  }

  /** Authoring key → id, in allocation order; this is what the lockfile records. */
  get keys(): ReadonlyMap<string, EntityId> {
    return this.#keys;
  }

  /** Keys that were used more than once, in the order they were reused. */
  get duplicateKeys(): readonly string[] {
    return this.#duplicates;
  }

  /**
   * The id for `lockKey`, allocated on first use.
   *
   * `localKey` is the *spelling* rather than the identity — `node:orders/start` is keyed by the
   * namespaced name while the id is derived from `start` — which is what keeps ids readable and
   * renames local.
   */
  allocate(lockKey: string, localKey: string): EntityId {
    const existing = this.#keys.get(lockKey);
    if (existing !== undefined) return existing;

    const id = this.#allocator.allocate(lockKey, { slug: localKey });
    this.#keys.set(lockKey, id);
    return id;
  }

  /** The id for a repeated key: same key, different entity, and therefore its own ordinal. */
  allocateDuplicate(lockKey: string, localKey: string): EntityId {
    this.#duplicates.push(lockKey);
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${lockKey}#${ordinal}`;
      if (this.#keys.has(candidate)) continue;
      const id = this.#allocator.allocate(candidate, { slug: `${localKey}_${ordinal}` });
      this.#keys.set(candidate, id);
      return id;
    }
  }

  /** Allocates, treating a repeated key as a second entity of the same name. */
  allocateOrDuplicate(lockKey: string, localKey: string): EntityId {
    return this.#keys.has(lockKey) ? this.allocateDuplicate(lockKey, localKey) : this.allocate(lockKey, localKey);
  }
}

/**
 * The composition helper — four ideas borrowed from cordis, none of its machinery.
 *
 * The framework verdict (architecture §12) was *borrow, do not adopt*: a long-lived host that
 * loads third-party code by name needs fibres, dependency-gated activation and interceptors; a
 * one-shot CLI whose extension points are chosen at compile time needs none of that. What is
 * worth keeping is:
 *
 * 1. **Reversible registration** — everything acquired can be released, in LIFO order.
 * 2. **Declared dependencies with gated activation, reported not silent** — an extension whose
 *    requirement is missing lands in `skipped`, with the missing pieces named.
 * 3. **Dispatch mode at the call site** — see the validator reducer; here it is the same idea
 *    applied to activation: `use()` decides, the caller says what happens on a skip.
 * 4. **Scope by key, not by module singleton** — one toolkit per target, never a global.
 *
 * That is the whole thing. `process.exit` remains a perfect disposer for everything else.
 */

export type Disposer = () => void | Promise<void>;

export interface Extension<T> {
  readonly name: string;
  /** Service keys that must be present before `apply` runs. */
  readonly requires?: readonly string[];
  apply(target: T): Disposer | void;
}

export interface SkippedExtension {
  readonly name: string;
  readonly missing: readonly string[];
}

export class Toolkit {
  readonly #services = new Map<string, unknown>();
  readonly #undo: Disposer[] = [];
  readonly #skipped: SkippedExtension[] = [];
  #disposed = false;

  /** Extensions that were not activated, and why. Never empty-by-accident. */
  get skipped(): readonly SkippedExtension[] {
    return this.#skipped;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  provide<T>(key: string, value: T): T {
    this.#assertLive();
    this.#services.set(key, value);
    return value;
  }

  get<T>(key: string): T | undefined {
    return this.#services.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.#services.has(key);
  }

  /**
   * Acquires a value and registers its inverse. The release runs in LIFO order on `dispose`,
   * which is what makes `plan` / `apply` / `rollback` one mechanism rather than three.
   */
  effect<T>(acquire: () => T, release: (value: T) => void | Promise<void>): T {
    this.#assertLive();
    const value = acquire();
    this.#undo.push(() => release(value));
    return value;
  }

  /** Registers a plain disposer (an effect with no value). */
  defer(undo: Disposer): void {
    this.#assertLive();
    this.#undo.push(undo);
  }

  /** Activates an extension if its declared dependencies are present. */
  use(extension: Extension<this>): boolean {
    this.#assertLive();
    const missing = (extension.requires ?? []).filter((key) => !this.#services.has(key));
    if (missing.length > 0) {
      this.#skipped.push({ name: extension.name, missing });
      return false;
    }
    const undo = extension.apply(this);
    if (undo !== undefined) this.#undo.push(undo);
    return true;
  }

  /** Runs every disposer in reverse order; a failing disposer does not stop the others. */
  async dispose(): Promise<readonly Error[]> {
    if (this.#disposed) return [];
    this.#disposed = true;
    const failures: Error[] = [];
    for (const undo of this.#undo.splice(0).reverse()) {
      try {
        await undo();
      } catch (cause) {
        failures.push(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    this.#services.clear();
    return failures;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('this toolkit has been disposed');
  }
}

export function toolkit(): Toolkit {
  return new Toolkit();
}

export function formatSkipped(skipped: readonly SkippedExtension[]): string {
  return skipped.map((entry) => `skipped ${entry.name}: needs ${entry.missing.join(', ')}`).join('\n');
}

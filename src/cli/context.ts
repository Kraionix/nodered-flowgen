/**
 * The CLI's process context: everything a command may touch that is not its arguments.
 *
 * Commands never reach for `process`, `console` or `fetch` directly — they receive this. That is
 * the whole reason `runCli(argv, io)` can be called from a test with a temporary directory, a
 * fake environment and captured output, which is how the CLI is tested without spawning a
 * subprocess for every assertion.
 */

export interface CliIo {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Injection point for tests; `undefined` means the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export interface CliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Spread into a source's options to keep the default when nothing was injected. */
  readonly fetchOption: { readonly fetch?: typeof globalThis.fetch };
  readonly now: () => Date;
}

export function createContext(io: CliIo = {}): CliContext {
  return {
    cwd: io.cwd ?? process.cwd(),
    env: io.env ?? process.env,
    stdout: io.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text: string) => process.stderr.write(text)),
    fetchOption: io.fetch === undefined ? {} : { fetch: io.fetch },
    now: io.now ?? (() => new Date()),
  };
}

/** Reads a token from the environment the way every command wants it: empty means absent. */
export function envToken(context: CliContext, name: string): string | undefined {
  const value = context.env[name];
  return value === undefined || value === '' ? undefined : value;
}

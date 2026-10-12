/**
 * Disposable Node-RED instances for tests.
 *
 * Rules that keep the suite honest:
 *
 * * never touch a developer's instance — every harness instance gets its own temporary user
 *   directory, its own `flows.json` and a free ephemeral port;
 * * always wait for the server to be listening *and* answer HTTP before returning, because
 *   "the process started" is not "the instance is usable";
 * * always shut down in a `finally`, and keep the log so a test can assert on it (the runtime
 *   prints `Waiting for missing types to be registered` and `Circular config node dependency`
 *   — both are exactly the failures a generator must not cause).
 *
 * The instance runs from this repository's own `node-red` devDependency, so the pinned
 * version under test is the version in `package.json`.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** `spawn` with `stdio: ['ignore', 'pipe', 'pipe']`. */
type Child = ChildProcessByStdio<null, Readable, Readable>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RED_JS = path.join(REPO_ROOT, 'node_modules', 'node-red', 'red.js');

export interface HarnessUser {
  readonly username: string;
  readonly password: string;
  /** `*` for full admin, `read` for a read-only token (a real boundary, verified in recon). */
  readonly permissions?: string;
}

export interface HarnessOptions {
  /**
   * `none` leaves the instance open; `password` protects it with `users` whose tokens can be
   * fetched from `/auth/token` (the configuration verified during reconnaissance: a `users`
   * lookup function *and* an `authenticate` hook, both required for token grants to work).
   */
  readonly auth?: 'none' | 'password';
  readonly users?: readonly HarnessUser[];
  readonly username?: string;
  readonly password?: string;
  /** Node modules to expose as user-installed (linked into `<userDir>/node_modules`). */
  readonly userModules?: readonly string[];
  readonly settings?: Record<string, unknown>;
}

export interface NodeRedInstance {
  readonly url: string;
  readonly port: number;
  readonly userDir: string;
  readonly flowFile: string;
  readonly log: () => string;
  /** Fetches a bearer token via the password grant. */
  token(username?: string, password?: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startNodeRed(options: HarnessOptions = {}): Promise<NodeRedInstance> {
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'flowgen-nr-'));
  const port = await freePort();
  const auth = options.auth ?? 'none';
  const users: readonly HarnessUser[] =
    options.users ?? [{ username: options.username ?? 'flowgen', password: options.password ?? 's3cret', permissions: '*' }];
  const flowFile = path.join(userDir, 'flows.json');

  await writeFile(flowFile, '[]\n', 'utf8');
  await writeFile(path.join(userDir, 'package.json'), JSON.stringify(userManifest(options.userModules ?? []), null, 2));

  if ((options.userModules ?? []).length > 0) {
    // Node-RED resolves user modules from `<userDir>/node_modules`; linking the repository's
    // own tree keeps the harness offline and pinned.
    await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(userDir, 'node_modules'), 'dir');
  } else {
    await mkdir(path.join(userDir, 'node_modules'), { recursive: true });
  }

  await writeFile(path.join(userDir, 'settings.js'), settingsSource({ port, userDir, flowFile, auth, users, extra: options.settings ?? {} }));

  const child = spawn(process.execPath, [RED_JS, '--userDir', userDir, '-s', path.join(userDir, 'settings.js')], {
    cwd: userDir,
    env: { ...process.env, NODE_RED_ENABLE_PROJECTS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const instance = new Instance(userDir, port, flowFile, child, auth, users);
  await instance.waitUntilReady();
  return instance;
}

class Instance implements NodeRedInstance {
  readonly #userDir: string;
  readonly #port: number;
  readonly #flowFile: string;
  readonly #child: Child;
  readonly #auth: 'none' | 'password';
  readonly #users: readonly HarnessUser[];
  #output = '';
  #stopped = false;
  readonly #tokens = new Map<string, string>();

  constructor(
    userDir: string,
    port: number,
    flowFile: string,
    child: Child,
    auth: 'none' | 'password',
    users: readonly HarnessUser[],
  ) {
    this.#userDir = userDir;
    this.#port = port;
    this.#flowFile = flowFile;
    this.#child = child;
    this.#auth = auth;
    this.#users = users;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      this.#output += chunk;
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get port(): number {
    return this.#port;
  }

  get userDir(): string {
    return this.#userDir;
  }

  get flowFile(): string {
    return this.#flowFile;
  }

  log(): string {
    return this.#output;
  }

  /**
   * Two conditions, both required: the process must have announced its port (starting the
   * listener and answering requests are different events) and the HTTP endpoint must answer.
   */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.#output.includes('Server now running at')) {
      this.#assertAlive();
      await delay(50);
    }

    let lastProblem = 'no response yet';
    while (Date.now() < deadline) {
      this.#assertAlive();
      try {
        const headers: Record<string, string> = {};
        if (this.#auth === 'password') headers['authorization'] = `Bearer ${await this.token()}`;
        const response = await fetch(`${this.url}/settings`, { headers });
        if (response.ok) return;
        lastProblem = `GET /settings answered ${response.status}`;
      } catch (cause) {
        lastProblem = cause instanceof Error ? cause.message : String(cause);
      }
      await delay(100);
    }
    throw new Error(`node-red did not become ready in ${timeoutMs}ms (${lastProblem})\n${this.#output}`);
  }

  #assertAlive(): void {
    if (this.#child.exitCode !== null) {
      throw new Error(`node-red exited with code ${this.#child.exitCode}\n${this.#output}`);
    }
  }

  async token(username?: string, password?: string): Promise<string> {
    const user = this.#resolveUser(username, password);
    const cached = this.#tokens.get(user.username);
    if (cached !== undefined) return cached;
    const response = await fetch(`${this.url}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        username: user.username,
        password: user.password,
        client_id: 'node-red-admin',
        // Node-RED refuses a scope wider than the user's permissions ("invalid_grant"),
        // so a read-only user is asked for exactly what it has.
        scope: user.permissions ?? '*',
      }),
    });
    if (!response.ok) {
      throw new Error(`token request failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (typeof body.access_token !== 'string') {
      throw new Error(`token response had no access_token: ${JSON.stringify(body)}`);
    }
    this.#tokens.set(user.username, body.access_token);
    return body.access_token;
  }

  #resolveUser(username?: string, password?: string): HarnessUser {
    if (username === undefined) {
      const first = this.#users[0];
      if (first === undefined) throw new Error('this instance has no users configured');
      return first;
    }
    const match = this.#users.find((user) => user.username === username && (password === undefined || user.password === password));
    if (match === undefined) throw new Error(`unknown test user "${username}"`);
    return match;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#child.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        this.#child.once('exit', () => resolve());
      });
      this.#child.kill('SIGTERM');
      await Promise.race([exited, delay(5_000).then(() => this.#child.kill('SIGKILL'))]);
    }
    await rm(this.#userDir, { recursive: true, force: true });
  }
}

function userManifest(modules: readonly string[]): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const name of modules) dependencies[name] = '*';
  return { name: 'flowgen-test-user', version: '1.0.0', private: true, dependencies };
}

function settingsSource(input: {
  port: number;
  userDir: string;
  flowFile: string;
  auth: 'none' | 'password';
  users: readonly HarnessUser[];
  extra: Record<string, unknown>;
}): string {
  const base: Record<string, unknown> = {
    uiPort: input.port,
    uiHost: '127.0.0.1',
    userDir: input.userDir,
    flowFile: input.flowFile,
    credentialSecret: 'flowgen-test-secret',
    editorTheme: { projects: { enabled: false }, tours: false },
    logging: { console: { level: 'info', metrics: false, audit: false } },
    ...input.extra,
  };

  const serialized = serialize(base);
  const auth = input.auth === 'password' ? adminAuthSource(input.users) : '';
  return `// Generated by test/integration/harness.ts — do not edit.\nmodule.exports = ${serialized};${auth}\n`;
}

/**
 * The adminAuth block is emitted as source text on purpose: `Function.prototype.toString()`
 * drops the closure, so a serialized function that refers to captured credentials would fail
 * every login. Both hooks are required for token grants, and both must be async — Node-RED 5.x
 * calls `.then()` on their result ("Users.authenticate(...).then is not a function").
 */
function adminAuthSource(users: readonly HarnessUser[]): string {
  const table = users
    .map((user) => `${JSON.stringify(user.username)}: ${JSON.stringify({ username: user.username, permissions: user.permissions ?? '*' })}`)
    .join(', ');
  const secrets = users
    .map((user) => `${JSON.stringify(user.username)}: ${JSON.stringify(user.password)}`)
    .join(', ');
  return [
    '',
    `const USERS = { ${table} };`,
    `const SECRETS = { ${secrets} };`,
    'module.exports.adminAuth = {',
    '  type: "credentials",',
    // Both hooks must be async: Node-RED 5.x calls `.then()` on their result.
    '  users: async (name) => USERS[name] || null,',
    '  authenticate: async (name, secret) => (SECRETS[name] === secret ? USERS[name] : null),',
    '};',
  ].join('\n');
}

/**
 * Serialises a settings object with function placeholders preserved. `authenticate` and
 * `users` above are the only functions, and they are injected verbatim.
 */
function serialize(value: unknown): string {
  if (typeof value === 'function') return (value as () => unknown).toString();
  if (Array.isArray(value)) return `[${value.map(serialize).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => `${JSON.stringify(key)}: ${serialize(entry)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

export async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `probe` returns true; used for runtime behaviour assertions. */
export async function waitFor(probe: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await delay(intervalMs);
  }
  return false;
}

/**
 * The Admin API client: the only place that talks to a Node-RED instance.
 *
 * Verified behaviours this leans on (reconnaissance, Node-RED 5.0.7/5.0.8):
 *
 * * `GET /flows` with `Node-RED-API-Version: v2` returns `{rev, flows}`; the readback preserves
 *   key order exactly as sent, which is what makes the round-trip oracle meaningful;
 * * `POST /flows` with a **stale `rev`** answers `409 version_mismatch`; omitting `rev` forces
 *   the write. A compare-and-swap is therefore possible, and `apply` is built on it;
 * * the payload **replaces the whole flow set** regardless of `Node-RED-Deployment-Type`, so
 *   merging is our job, not the server's;
 * * without a token an authenticated instance answers `401`, and a read-scope token is refused
 *   on write while `GET` still works.
 */

export type AdminApiErrorCode =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'version-mismatch'
  | 'not-found'
  | 'http-error'
  | 'invalid-response';

export class AdminApiError extends Error {
  readonly code: AdminApiErrorCode;
  readonly status: number | null;
  readonly body: string;

  constructor(code: AdminApiErrorCode, message: string, options: { status?: number; body?: string } = {}) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = options.status ?? null;
    this.body = options.body ?? '';
  }
}

export interface AdminApiOptions {
  /** Base URL, e.g. `http://127.0.0.1:1880` (with or without a trailing slash). */
  readonly url: string;
  /** Bearer token for an instance with `adminAuth`; omitted for an open instance. */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface FlowState {
  readonly rev: string;
  readonly flows: readonly unknown[];
}

export interface DeployResult {
  readonly rev: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class AdminApiClient {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #timeout: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AdminApiOptions) {
    this.#base = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = options.fetch ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new AdminApiError('unreachable', 'no fetch implementation available');
    this.#fetch = doFetch;
  }

  get url(): string {
    return this.#base;
  }

  async readFlows(): Promise<FlowState> {
    const response = await this.#request('/flows', { method: 'GET' });
    const body = await response.json().catch(() => null);

    // v2 wraps the flow set; older instances answer with a bare array, which is worth accepting
    // because the tool is also used against 1.x installations.
    if (Array.isArray(body)) return { rev: '', flows: body };
    if (body === null || typeof body !== 'object') {
      throw new AdminApiError('invalid-response', 'GET /flows did not return a flow set');
    }
    const record = body as Record<string, unknown>;
    return {
      rev: typeof record['rev'] === 'string' ? record['rev'] : '',
      flows: Array.isArray(record['flows']) ? (record['flows'] as unknown[]) : [],
    };
  }

  /**
   * Writes the whole flow set. Returns the new revision; a stale `rev` raises
   * `version-mismatch` so the caller can re-plan instead of clobbering someone else's deploy.
   */
  async writeFlows(flows: readonly unknown[], rev: string | null): Promise<DeployResult> {
    const payload: Record<string, unknown> = { flows };
    if (rev !== null && rev !== '') payload['rev'] = rev;

    const response = await this.#request('/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'node-red-deployment-type': 'full' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    const record = body === null || typeof body !== 'object' ? {} : (body as Record<string, unknown>);
    return { rev: typeof record['rev'] === 'string' ? record['rev'] : '' };
  }

  /** Exchanges credentials for a bearer token (the password grant). */
  async token(username: string, password: string, scope = '*'): Promise<string> {
    const response = await this.#post('/auth/token', {
      grant_type: 'password',
      username,
      password,
      client_id: 'node-red-admin',
      scope,
    });
    const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    if (body === null || typeof body.access_token !== 'string') {
      throw new AdminApiError('invalid-response', 'the token endpoint returned no access_token');
    }
    return body.access_token;
  }

  /** `GET /settings` — used as a cheap "is this instance alive and are we allowed in" probe. */
  async settings(): Promise<Record<string, unknown>> {
    const response = await this.#request('/settings', { method: 'GET' });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) throw new AdminApiError('invalid-response', 'GET /settings did not return JSON');
    return body;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('node-red-api-version', 'v2');
    if (this.#token !== undefined && this.#token !== '') headers.set('authorization', `Bearer ${this.#token}`);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.#timeout) });
    } catch (cause) {
      throw new AdminApiError('unreachable', `cannot reach ${this.#base}${path}`, {
        body: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    if (response.status === 401) throw new AdminApiError('unauthorized', `${path} refused the token (401)`, { status: 401, body: text });
    if (response.status === 403) throw new AdminApiError('forbidden', `${path} is not allowed for this token (403)`, { status: 403, body: text });
    if (response.status === 404) throw new AdminApiError('not-found', `${path} does not exist (404)`, { status: 404, body: text });
    if (response.status === 409) throw new AdminApiError('version-mismatch', `${path} rejected a stale revision (409)`, { status: 409, body: text });
    throw new AdminApiError('http-error', `${path} answered ${response.status}`, { status: response.status, body: text });
  }

  async #post(path: string, payload: unknown): Promise<Response> {
    return this.#request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

export function adminApi(options: AdminApiOptions): AdminApiClient {
  return new AdminApiClient(options);
}

/**
 * Extraction of `RED.nodes.registerType(...)` literals from a Node-RED editor HTML file.
 *
 * A node's editor metadata (`defaults`, `credentials`, `category`, `color`, `icon`, port
 * counts, `paletteLabel`, …) exists **only** in the editor HTML — the runtime registry and
 * `GET /nodes` expose the type name and nothing else. Reproducing the palette therefore
 * means running the registration scripts the way a browser would.
 *
 * The sandbox is deliberately hermetic: a fresh `node:vm` context with a stubbed `RED`,
 * no `require`, no `process`, no real timers, and a per-block time budget. Stub objects are
 * "fluid": any property access or call returns another stub that stringifies to a readable
 * tag, so an editor script that touches `RED.util` or the DOM records nothing and fails
 * nothing. Anything that does throw is reported as an issue instead of being swallowed.
 */

import { createContext, runInContext, type Context } from 'node:vm';

export interface RegisteredType {
  readonly type: string;
  readonly definition: Record<string, unknown>;
  /** File or synthetic label the registration came from, for diagnostics. */
  readonly source: string;
}

export interface ExtractionIssue {
  readonly source: string;
  readonly message: string;
}

export interface HtmlExtraction {
  readonly registered: readonly RegisteredType[];
  readonly issues: readonly ExtractionIssue[];
  /** Number of script blocks that were evaluated (registrations can be spread over several). */
  readonly blocks: number;
}

export interface ExtractOptions {
  /** Label used in diagnostics; defaults to `<inline>`. */
  readonly source?: string;
  /** Per-script-block evaluation budget in milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** `<script ...>body</script>`, tolerating attributes in any order and casing. */
const SCRIPT_BLOCK = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
/** `type="…"`, `type='…'` or `type=…` inside a tag's attribute list. */
const TYPE_ATTRIBUTE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** Node-RED writes either nothing, `text/javascript` or (for modules) `module`. */
const JAVASCRIPT_TYPE = /^(?:|text\/javascript|application\/javascript|module)$/i;
const IS_NODE_DEFINITION = /\bdata-(?:template|help)-name\b/i;

/**
 * Extracts every registration from one HTML document.
 *
 * Template and help blocks are skipped — they are jQuery templates and markdown, not code —
 * as are script blocks whose `type` is not JavaScript. A block that mentions `registerType`
 * is evaluated inside the shared per-document context, so definitions split across blocks
 * (`var X = {...}` in one, `registerType("x", X)` in the next) are still collected.
 */
export function extractRegisteredTypes(html: string, options: ExtractOptions = {}): HtmlExtraction {
  const source = options.source ?? '<inline>';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const registered: RegisteredType[] = [];
  const issues: ExtractionIssue[] = [];

  const blocks = collectDefinitionBlocks(html);
  if (blocks.length === 0) {
    return { registered, issues, blocks: 0 };
  }

  const sandbox = createSandbox(registered, source, issues);
  for (const block of blocks) {
    try {
      runInContext(block, sandbox, { filename: source, timeout });
    } catch (cause) {
      issues.push({ source, message: describeError(cause) });
    }
  }

  return { registered, issues, blocks: blocks.length };
}

function collectDefinitionBlocks(html: string): readonly string[] {
  const blocks: string[] = [];
  SCRIPT_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK.exec(html)) !== null) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (IS_NODE_DEFINITION.test(attributes)) continue;
    if (!JAVASCRIPT_TYPE.test(scriptType(attributes))) continue;
    if (!body.includes('registerType')) continue;
    blocks.push(body);
  }
  return blocks;
}

function scriptType(attributes: string): string {
  const match = TYPE_ATTRIBUTE.exec(attributes);
  if (match === null) return '';
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/**
 * Builds the sandbox context. Exported for tests that want to assert on the stub surface.
 */
export function createSandbox(
  registered: RegisteredType[],
  source: string,
  issues: ExtractionIssue[],
): Context {
  const record = (type: unknown, definition: unknown): void => {
    if (typeof type !== 'string') {
      issues.push({ source, message: `registerType called with a non-string type: ${String(type)}` });
      return;
    }
    registered.push({
      type,
      // Copy into the host realm: objects created inside the VM have the VM's prototype,
      // which makes every host-side structural check fail.
      definition: isRecord(definition) ? (toHostValue(definition) as Record<string, unknown>) : {},
      source,
    });
  };

  const red: Record<string, unknown> = {
    nodes: { registerType: record },
    // `RED._()` is i18n; returning the key keeps labels readable and deterministic.
    _: (key: unknown) => (typeof key === 'string' ? key : ''),
    util: stub('RED.util'),
    validators: stub('RED.validators'),
    settings: stub('RED.settings'),
    events: stub('RED.events'),
  };

  const sandbox: Record<string, unknown> = {
    RED: new Proxy(red, {
      get: (target, key) =>
        typeof key === 'string' && key in target ? target[key] : stub(`RED.${String(key)}`),
    }),
    $: jqueryStub(source, issues),
    jQuery: jqueryStub(source, issues),
    console: { log: noop, warn: noop, error: noop, debug: noop, info: noop },
    // Timers are inert on purpose: extraction must not schedule work that outlives it.
    setTimeout: inertTimer,
    setInterval: inertTimer,
    clearTimeout: noop,
    clearInterval: noop,
    window: stub('window'),
    document: stub('document'),
    navigator: stub('navigator'),
    localStorage: stub('localStorage'),
  };

  return createContext(sandbox);
}

/**
 * `$(fn)` in a node's HTML means "run at document ready" — the registration inside it is
 * real, so the stub invokes function arguments. Its DOM work hits fluid stubs and is
 * harmless; if it throws, the failure is reported rather than hidden.
 */
function jqueryStub(source: string, issues: ExtractionIssue[]): unknown {
  const callable = (tag: string): unknown => {
    const fn = function (...args: unknown[]): unknown {
      for (const arg of args) {
        if (typeof arg === 'function') {
          try {
            (arg as () => void)();
          } catch (cause) {
            issues.push({ source, message: `callback passed to ${tag} threw: ${describeError(cause)}` });
          }
        }
      }
      return callable(`${tag}()`);
    };
    return new Proxy(fn, {
      get: (_target, key) => {
        if (key === Symbol.toPrimitive) return () => `[${tag}]`;
        if (key === 'toString') return () => `[${tag}]`;
        if (key === 'length') return 0;
        return callable(`${tag}.${String(key)}`);
      },
      // Calling the stub runs the callback arguments (document-ready registration) and
      // returns another stub so chained calls stay inert.
      apply: (_target, _thisArg, args) => fn(...args),
    });
  };
  return callable('$');
}

/** A value that accepts any read, write or call and stringifies to a readable tag. */
function stub(tag: string): unknown {
  const fn = function (): unknown {
    return stub(`${tag}()`);
  };
  return new Proxy(fn, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => `[${tag}]`;
      if (key === 'toString') return () => `[${tag}]`;
      if (key === 'valueOf') return () => `[${tag}]`;
      if (key === 'length') return 0;
      return stub(`${tag}.${String(key)}`);
    },
    set: () => true,
    apply: () => stub(`${tag}()`),
  });
}

/**
 * Errors raised inside a VM context belong to another realm, so `instanceof Error` is false
 * for them; read the message structurally instead of stringifying the whole error.
 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause !== null && typeof cause === 'object') {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(cause);
}

function inertTimer(): number {
  return 0;
}

function noop(): void {
  // Intentionally empty.
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-copies a value out of the VM context, preserving functions (the normaliser needs to
 * recognise them as "computed") and cycles. Class instances become plain objects, which is
 * what the palette model requires anyway.
 */
function toHostValue(value: unknown, seen: Map<object, unknown> = new Map(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32) return undefined;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(toHostValue(item, seen, depth + 1));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = toHostValue((value as Record<string, unknown>)[key], seen, depth + 1);
  }
  return copy;
}

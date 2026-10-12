/**
 * Receipts: every mutation is reversible, so `apply` and `rollback` are one mechanism.
 *
 * A receipt holds the *inverse* of a deploy — the whole previous flow set and the revision it
 * was read at — which is what the server needs to be put back exactly as it was. It is written
 * next to the deployment (`.flowgen/receipt.json` by default) and is deliberately not part of
 * the lockfile: it is a runtime artifact, not a source of truth, and it must never be committed.
 *
 * Credentials never appear here: the receipt is a flow set, and flow sets carry no secrets.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { err, ok, type Result } from '../result.ts';

export const RECEIPT_VERSION = 1;

export interface Receipt {
  readonly receiptVersion: number;
  readonly target: string;
  readonly url: string;
  /** Revision the instance was at before the deploy. */
  readonly previousRev: string;
  /** The complete previous flow set: re-POSTing it restores the instance. */
  readonly previousFlows: readonly unknown[];
  /** Revision after the deploy, for the record. */
  readonly deployedRev: string;
  /** ISO timestamp; a receipt describes an event, so unlike generated files it may carry one. */
  readonly deployedAt: string;
  /** One line per operation that ran, for `flowgen rollback --explain`. */
  readonly summary: readonly string[];
}

export interface ReceiptIssue {
  readonly code: 'invalid-json' | 'not-an-object' | 'unsupported-version' | 'invalid-field';
  readonly path: string;
  readonly message: string;
}

export function createReceipt(init: Omit<Receipt, 'receiptVersion'>): Receipt {
  return { receiptVersion: RECEIPT_VERSION, ...init };
}

export function serializeReceipt(receipt: Receipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function parseReceipt(text: string): Result<Receipt, readonly ReceiptIssue[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err([{ code: 'invalid-json', path: '', message: cause instanceof Error ? cause.message : 'unparsable' }]);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err([{ code: 'not-an-object', path: '', message: 'a receipt is a JSON object' }]);
  }

  const record = raw as Record<string, unknown>;
  const version = typeof record['receiptVersion'] === 'number' ? record['receiptVersion'] : 0;
  if (version !== RECEIPT_VERSION) {
    return err([{ code: 'unsupported-version', path: 'receiptVersion', message: `expected ${RECEIPT_VERSION}, found ${version}` }]);
  }
  if (!Array.isArray(record['previousFlows'])) {
    return err([{ code: 'invalid-field', path: 'previousFlows', message: 'the previous flow set is required to roll back' }]);
  }

  return ok({
    receiptVersion: version,
    target: typeof record['target'] === 'string' ? record['target'] : '',
    url: typeof record['url'] === 'string' ? record['url'] : '',
    previousRev: typeof record['previousRev'] === 'string' ? record['previousRev'] : '',
    previousFlows: record['previousFlows'] as unknown[],
    deployedRev: typeof record['deployedRev'] === 'string' ? record['deployedRev'] : '',
    deployedAt: typeof record['deployedAt'] === 'string' ? record['deployedAt'] : '',
    summary: Array.isArray(record['summary']) ? record['summary'].filter((line): line is string => typeof line === 'string') : [],
  });
}

/** Writes the receipt, creating its directory: the default path lives under `.flowgen/`. */
export async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeReceipt(receipt), 'utf8');
}

export async function readReceiptFile(file: string): Promise<Receipt> {
  const text = await readFile(file, 'utf8');
  const parsed = parseReceipt(text);
  if (!parsed.ok) {
    throw new Error(
      `invalid receipt ${file}: ${parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
  }
  return parsed.value;
}

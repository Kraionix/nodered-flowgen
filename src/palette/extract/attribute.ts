/**
 * Attribution: which npm module and node set a type belongs to.
 *
 * Two sources of truth have to be reconciled:
 *
 * * `GET /nodes` (JSON) lists every node set with `{id, name, module, version, enabled,
 *   local, user, types}` — 60 sets / 75 types on the reference instance.
 * * `GET /nodes` (HTML) is a concatenation of the editor bundles, one per node set, each
 *   introduced by a `<!-- --- [red-module:<setId>] --- -->` marker.
 *
 * They disagree in exactly one interesting way: a node set can declare a type whose editor
 * HTML contains no `registerType` at all — `junction` is the built-in example, its HTML
 * exists only so the runtime loads it, and it is deliberately kept out of the palette. Such
 * types are *synthesised* (see `normalize.synthesizeType`) rather than dropped, which is
 * what keeps `import → emit` lossless for flows that use them.
 */

import type { PaletteNodeSet, PaletteType } from '../model.ts';

import { normalizeRegisteredType, synthesizeType } from './normalize.ts';
import { extractRegisteredTypes, type ExtractionIssue } from './registerType.ts';

/** Marker written by Node-RED's `/nodes` handler in front of every node set's HTML. */
const MODULE_MARKER = /<!--\s*---\s*\[red-module:([^\]]+)\]\s*---\s*-->/g;

export interface HtmlSection {
  /** Node set id from the marker, or `null` for content before the first marker. */
  readonly nodeSet: string | null;
  readonly html: string;
}

export type AttributionIssueCode =
  | 'invalid-node-set'
  | 'unknown-node-set'
  | 'unattributed-type'
  | 'undeclared-type'
  | 'missing-definition';

export interface AttributionIssue {
  readonly code: AttributionIssueCode;
  readonly path: string;
  readonly message: string;
}

export function splitHtmlByModuleMarker(html: string): readonly HtmlSection[] {
  const sections: HtmlSection[] = [];
  const pattern = new RegExp(MODULE_MARKER.source, 'g');
  let match: RegExpExecArray | null;
  let previousIndex = 0;
  let previousSet: string | null = null;

  while ((match = pattern.exec(html)) !== null) {
    if (match.index > previousIndex || previousSet !== null) {
      const body = html.slice(previousIndex, match.index);
      if (body.trim() !== '') sections.push({ nodeSet: previousSet, html: body });
    }
    previousSet = match[1] ?? null;
    previousIndex = match.index + match[0].length;
    if (previousSet === null) {
      // A malformed marker: keep going, the content is reported as unattributed.
      previousSet = null;
    }
  }

  const tail = html.slice(previousIndex);
  if (tail.trim() !== '') sections.push({ nodeSet: previousSet, html: tail });
  return sections;
}

/** Parses the `GET /nodes` JSON payload into node set records. */
export function parseNodeSets(json: unknown): { nodeSets: PaletteNodeSet[]; issues: AttributionIssue[] } {
  const issues: AttributionIssue[] = [];
  if (!Array.isArray(json)) {
    issues.push({ code: 'invalid-node-set', path: '', message: 'expected an array of node sets' });
    return { nodeSets: [], issues };
  }

  const nodeSets: PaletteNodeSet[] = [];
  json.forEach((entry, index) => {
    const path = `[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      issues.push({ code: 'invalid-node-set', path, message: 'expected an object' });
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    if (id === null) {
      issues.push({ code: 'invalid-node-set', path, message: 'node set has no id' });
      return;
    }
    const name = typeof record['name'] === 'string' ? record['name'] : id;
    const types = Array.isArray(record['types'])
      ? record['types'].filter((type): type is string => typeof type === 'string')
      : [];
    nodeSets.push({
      id,
      name,
      module: typeof record['module'] === 'string' ? record['module'] : (id.split('/')[0] ?? id),
      version: typeof record['version'] === 'string' ? record['version'] : '',
      enabled: record['enabled'] !== false,
      local: record['local'] === true,
      user: record['user'] === true,
      types,
    });
  });

  return { nodeSets, issues };
}

export interface MarkedHtmlExtraction {
  readonly types: readonly PaletteType[];
  readonly issues: readonly AttributionIssue[];
  /** Failures raised by the sandbox itself (a node script that threw). */
  readonly extractionIssues: readonly ExtractionIssue[];
}

export interface MarkedHtmlOptions {
  readonly timeoutMs?: number;
}

/**
 * Extracts every type from a `GET /nodes` HTML dump, attributing each one to its node set.
 *
 * Types declared by a node set but absent from its HTML are synthesised, and types found in
 * a section that `GET /nodes` does not declare are kept and reported — losing a type the
 * instance actually has would be worse than an unattributed one.
 */
export function extractFromMarkedHtml(
  html: string,
  nodeSets: readonly PaletteNodeSet[],
  options: MarkedHtmlOptions = {},
): MarkedHtmlExtraction {
  const types: PaletteType[] = [];
  const issues: AttributionIssue[] = [];
  const extractionIssues: ExtractionIssue[] = [];
  const declared = new Map(nodeSets.map((nodeSet) => [nodeSet.id, nodeSet]));
  const seen = new Set<string>();

  for (const section of splitHtmlByModuleMarker(html)) {
    if (section.nodeSet === null) {
      issues.push({
        code: 'unattributed-type',
        path: '',
        message: 'HTML content appears before the first module marker and cannot be attributed',
      });
      continue;
    }

    const nodeSet = declared.get(section.nodeSet);
    if (nodeSet === undefined) {
      issues.push({
        code: 'unknown-node-set',
        path: section.nodeSet,
        message: 'node set is present in the HTML but not in the node list',
      });
    }

    const context = {
      module: nodeSet?.module ?? (section.nodeSet.split('/')[0] as string),
      nodeSet: section.nodeSet,
      version: nodeSet?.version ?? '',
    };

    const extraction = extractRegisteredTypes(section.html, {
      source: section.nodeSet,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    extractionIssues.push(...extraction.issues);

    for (const registered of extraction.registered) {
      if (seen.has(registered.type)) {
        issues.push({
          code: 'unattributed-type',
          path: section.nodeSet,
          message: `type "${registered.type}" is registered more than once; keeping the first definition`,
        });
        continue;
      }
      seen.add(registered.type);
      if (nodeSet !== undefined && !nodeSet.types.includes(registered.type)) {
        issues.push({
          code: 'undeclared-type',
          path: section.nodeSet,
          message: `type "${registered.type}" is registered by the HTML but missing from the node list`,
        });
      }
      types.push(normalizeRegisteredType(registered, context));
    }
  }

  for (const nodeSet of nodeSets) {
    for (const typeId of nodeSet.types) {
      if (seen.has(typeId)) continue;
      seen.add(typeId);
      issues.push({
        code: 'missing-definition',
        path: nodeSet.id,
        message: `type "${typeId}" has no editor registration; synthesised from the runtime node list`,
      });
      types.push(
        synthesizeType(typeId, { module: nodeSet.module, nodeSet: nodeSet.id, version: nodeSet.version }),
      );
    }
  }

  return { types, issues, extractionIssues };
}

/**
 * Groups types back into node sets. Declared metadata (name, flags, version) is preserved;
 * a set that only exists because a type referenced it is synthesised from the type itself.
 */
export function assembleNodeSets(
  types: readonly PaletteType[],
  declared: readonly PaletteNodeSet[],
): readonly PaletteNodeSet[] {
  const grouped = new Map<string, PaletteType[]>();
  for (const type of types) {
    const group = grouped.get(type.nodeSet);
    if (group === undefined) grouped.set(type.nodeSet, [type]);
    else group.push(type);
  }

  const byId = new Map(declared.map((nodeSet) => [nodeSet.id, nodeSet]));
  const result: PaletteNodeSet[] = [];

  for (const [nodeSetId, group] of grouped) {
    const record = byId.get(nodeSetId);
    const first = group[0] as PaletteType;
    result.push({
      id: nodeSetId,
      name: record?.name ?? (nodeSetId.split('/').slice(1).join('/') || nodeSetId),
      module: record?.module ?? first.module,
      version: record?.version || first.version,
      enabled: record?.enabled ?? true,
      local: record?.local ?? false,
      user: record?.user ?? false,
      types: group.map((type) => type.id),
    });
  }

  return result;
}

/**
 * Tier 4 of 4 — **testing**, compiled from a consumer's position.
 *
 * The claim this tier makes is that a project can assert on its own flow set without an instance,
 * without the CLI and without `node-red` installed: build the IR, emit the canonical flow file,
 * read it back, fill the defaults an editor export never contained, and print it as source again.
 * The same property is what makes a review diff meaningful, so it belongs in a consumer's test
 * runner rather than only in this repository's.
 *
 * This fixture is compiled, not run (no instance, and `test/types/` has no fixtures to read), so it
 * walks the calls in the order a round-trip test would and annotates every step with its type.
 */

import {
  allIds,
  eachConfig,
  eachGroup,
  eachNode,
  eachSubflow,
  effectiveInputCount,
  effectiveOutputCount,
  emitConfig,
  emitEntries,
  emitFlow,
  emitFlowSet,
  emitGlobalConfig,
  emitGroup,
  emitNode,
  emitSubflow,
  EMPTY_FLOW_SET,
  emptyNodeProps,
  defineFlowSet,
  findConfig,
  findNode,
  INTERNAL_NODE_KEYS,
  materialiseDefaults,
  normalizeConfig,
  normalizeFlowSet,
  normalizeFlowSetWithFixes,
  normalizeGroup,
  normalizeNode,
  P,
  parseFlowFile,
  parseFlowSetText,
  printFlowSet,
  STRUCTURAL_NODE_KEYS,
  wireArity,
  DEFAULT_MODULE,
  type ConfigNode,
  type Credentials,
  type EmitOptions,
  type EntityId,
  type EnvParam,
  type Flow,
  type FlowSet,
  type Geometry,
  type Group,
  type ImportOptions,
  type MaterializeContext,
  type MaterializeResult,
  type Node,
  type NodeProps,
  type NormalizeContext,
  type Problem,
  type PrintNote,
  type PrintOptions,
  type PrintReport,
  type PrintResult,
  type SubflowDef,
  type SubflowPortLink,
  type SubflowPorts,
} from '@kraionix/nodered-flowgen';

export const definition = defineFlowSet((f) => {
  const scale = f.subflow('scale', { name: 'scale', params: { factor: P.num(2) }, ports: { in: ['value'], out: ['scaled'] } }, (s) => {
    const work = s.node('function', { key: 'work', func: 'return msg;', outputs: 1 });
    s.in(work);
    s.out(work, 0);
  });

  const tab = f.flow('main', { label: 'Main' });
  const start = tab.node('inject', { key: 'start', name: 'start' });
  const sink = tab.node('debug', { key: 'sink', name: 'sink' });
  tab.chain(start, sink);
  tab.instance(scale, { key: 'scale_1', env: { factor: 4 } });
  tab.group('box', { name: 'box' }).add(sink);
});

const palette = {};

// --- build -----------------------------------------------------------------------------------

const built = definition.build({ palette });
const flowSet: FlowSet = built.flowSet;

// --- emit: the property everything else rests on ---------------------------------------------

const emitOptions: EmitOptions = { palette };
const document: string = emitFlowSet(flowSet, emitOptions);
const entries = emitEntries(flowSet, emitOptions);

const firstFlow: Flow | undefined = flowSet.flows[0];
const firstNode: Node | undefined = firstFlow?.nodes[0];
const firstConfig: ConfigNode | undefined = flowSet.configs[0];
const firstSubflow: SubflowDef | undefined = flowSet.subflows[0];
const firstGroup: Group | undefined = firstFlow?.groups[0];

/** One entry per emitter, so a changed return type is a compile error rather than a surprise. */
export const pieces: readonly Record<string, unknown>[] = [
  ...(firstNode === undefined ? [] : [emitNode(firstNode, emitOptions)]),
  ...(firstConfig === undefined ? [] : [emitConfig(firstConfig, emitOptions)]),
  ...(firstSubflow === undefined ? [] : [emitSubflow(firstSubflow, emitOptions)]),
  ...(firstFlow === undefined ? [] : [emitFlow(firstFlow, emitOptions)]),
  ...(firstGroup === undefined || firstFlow === undefined
    ? []
    : [emitGroup(firstGroup, firstFlow.nodes, emitOptions)]),
];

/** `emitGlobalConfig` writes the entry only when there is something to write. */
export const manifestEntry: Record<string, unknown> | null = emitGlobalConfig(flowSet);
export const lines: readonly string[] = entries.map((entry) => `${String(entry['id'])}:${String(entry['type'])}`);

// --- read it back, and normalise what came from outside --------------------------------------

const importOptions: ImportOptions = { palette };
const reparsed: FlowSet = parseFlowSetText(document, importOptions);
const fromValue: FlowSet = parseFlowFile(JSON.parse(document), importOptions);

const normalizeContext: NormalizeContext = { palette };
const normalized: FlowSet = normalizeFlowSet(reparsed, normalizeContext);
const repaired = normalizeFlowSetWithFixes(fromValue, normalizeContext);
export const fixes: readonly Problem[] = repaired.fixes;

// --- defaults: what an editor export does not contain ----------------------------------------

const materializeContext: MaterializeContext = { palette };
const filled: MaterializeResult = materialiseDefaults(normalized, materializeContext);
export const defaultCount: number = filled.filled;
export const defaultEntities: readonly EntityId[] = filled.entities;
export const rebuilt: FlowSet = filled.flowSet;

// --- walking the IR, which is what an assertion does -----------------------------------------

export const ids: readonly EntityId[] = [...allIds(rebuilt)];
export const nodeCount: number = [...eachNode(rebuilt)].length;
export const configCount: number = [...eachConfig(rebuilt)].length;
export const groupCount: number = [...eachGroup(rebuilt)].length;
export const subflowCount: number = [...eachSubflow(rebuilt)].length;

const node: Node | null = findNode(rebuilt, ids[0] ?? 'nope');
const config: ConfigNode | null = findConfig(rebuilt, 'nope');
const nodeType = node === null ? null : (palette as Record<string, never>)[node.type] ?? null;
export const arity: readonly (number | null)[] =
  node === null
    ? []
    : [wireArity(node), effectiveInputCount(nodeType as never, node.props), effectiveOutputCount(nodeType as never, node.props)];
export const empty: FlowSet = EMPTY_FLOW_SET;
export const props: NodeProps = emptyNodeProps();
export const keys: readonly (readonly string[])[] = [STRUCTURAL_NODE_KEYS, INTERNAL_NODE_KEYS];

export const normalizedNode: Node | undefined = node === null ? undefined : normalizeNode(node, normalizeContext);
export const normalizedConfig: ConfigNode | undefined = config === null ? undefined : normalizeConfig(config);
export const normalizedGroup: Group | undefined = firstGroup === undefined ? undefined : normalizeGroup(firstGroup);

// --- and back to source ----------------------------------------------------------------------

const printOptions: PrintOptions = { moduleName: DEFAULT_MODULE, palette, source: 'test/types/tiers/testing.ts' };
const printed: PrintResult = printFlowSet(rebuilt, printOptions);
const report: PrintReport = printed.report;

export const source: string = printed.source;
export const idsByKey: ReadonlyMap<string, string> = printed.ids;
export const printedTypes: number = report.printed + report.untyped + report.dropped;
export const notes: readonly PrintNote[] = report.notes;

// --- the vocabulary the IR is written in ------------------------------------------------------

export const geometry: Geometry = { x: 100, y: 200 };
export const credentials: Credentials = { values: {} };
export const parameter: EnvParam = { name: 'factor', type: 'num', value: '2' };
export const portLink: SubflowPortLink = { node: 'work', port: 0 };
export const ports: SubflowPorts = { in: [[portLink]], out: [[portLink]], status: [] };

/**
 * Layout: advisory geometry, computed deterministically.
 *
 * Geometry is never a contract (the editor recomputes group boxes from DOM dimensions), but a
 * generated flow that opens as a pile of nodes at the origin is unusable. The strategy is
 * grid-by-depth: horizontal position follows the longest path from a root along the wires,
 * vertical position follows discovery order, and group boxes are the bounding box of their
 * members with the editor's own padding. The result is stable for a given flow set, which is
 * what makes geometry-insensitive diffs actually stay empty.
 *
 * Depth is computed on the **condensation** of the wire graph (Tarjan's strongly connected
 * components), because the obvious worklist — re-enqueue a node whenever a longer path to it is
 * found — does not terminate once a cycle is reachable from a root: the depth grows without
 * bound and the CLI never returns. Feedback loops are ordinary in Node-RED (retry loops,
 * `delay → function → back`, status loops), so this has to be acyclic *by construction*. On the
 * condensation the graph is a DAG, longest path is one linear pass in reverse topological order,
 * and every node inside a loop shares its component's column — which is also what looks right on
 * a canvas. Each loop is reported as `layout/cycle` (info): the geometry is degraded on purpose,
 * and saying so beats leaving the author to wonder why five nodes are stacked in one column.
 *
 * Subflow bodies and containerless nodes are laid out too. They used to keep `0,0`, so an
 * imported or generated flow opened with its subflow internals piled up at the origin.
 */

import type { FlowSet, Group, Node } from '../model/entities.ts';
import { outgoingTargets } from '../model/references.ts';
import type { PaletteType } from '../palette/model.ts';
import type { Problem } from '../diagnostics/index.ts';

export interface LayoutOptions {
  readonly originX?: number;
  readonly originY?: number;
  readonly columnWidth?: number;
  readonly rowHeight?: number;
  /** Editor padding around group members (`@node-red/nodes/core/ui/group.js`). */
  readonly groupPadding?: number;
  readonly groupHeader?: number;
  readonly defaultWidth?: number;
  readonly defaultHeight?: number;
  /**
   * The node palette, when the caller has one. It is what makes `link` references visible as
   * edges: `link out` has no wires at all, so without a palette a link-connected flow looks like a
   * pile of roots and lays out in one column. Geometry is advisory either way — passing the
   * palette only makes the picture match the flow the reader sees.
   */
  readonly palette?: Readonly<Record<string, PaletteType>> | undefined;
}

export interface LayoutResult {
  readonly flowSet: FlowSet;
  /** `layout/cycle` advice. Geometry is always produced; a loop is never an error. */
  readonly problems: readonly Problem[];
}

type LayoutConfig = Required<Omit<LayoutOptions, 'palette'>>;

const DEFAULTS: LayoutConfig = {
  originX: 120,
  originY: 80,
  columnWidth: 190,
  rowHeight: 80,
  groupPadding: 25,
  groupHeader: 30,
  defaultWidth: 200,
  defaultHeight: 100,
};

/** How one node reaches another: wires plus palette-declared references (see `model/references`). */
type EdgesOf = (node: Node) => readonly string[];

interface Container {
  readonly id: string;
  readonly nodes: readonly Node[];
  readonly groups: readonly Group[];
}

/** Assigns coordinates to nodes that have none, and boxes to every group. */
export function layoutFlowSet(flowSet: FlowSet, options: LayoutOptions = {}): FlowSet {
  return layoutFlowSetWithDiagnostics(flowSet, options).flowSet;
}

/** `layoutFlowSet`, plus the `layout/cycle` advice the layout pass is the first to know about. */
export function layoutFlowSetWithDiagnostics(flowSet: FlowSet, options: LayoutOptions = {}): LayoutResult {
  const { palette, ...rest } = options;
  const config: LayoutConfig = { ...DEFAULTS, ...rest };
  const problems: Problem[] = [];
  const edgesOf: EdgesOf =
    palette === undefined ? (node) => node.wires.flat() : (node) => outgoingTargets(node, palette);

  const container = <T extends Container>(value: T): T => {
    const nodes = placeNodes(value.nodes, config, problems, edgesOf);
    return { ...value, nodes, groups: value.groups.map((group) => boxGroup(group, nodes, config)) };
  };

  return {
    flowSet: {
      ...flowSet,
      subflows: flowSet.subflows.map(container),
      flows: flowSet.flows.map(container),
      loose: placeNodes(flowSet.loose, config, problems, edgesOf),
    },
    problems,
  };
}

/**
 * Places every node that has no coordinates: column = longest path from a root, row = discovery
 * order inside that column. A node that already has coordinates keeps them — the author may have
 * placed it on purpose, and layout must not fight a human.
 */
function placeNodes(
  nodes: readonly Node[],
  config: LayoutConfig,
  problems: Problem[],
  edgesOf: EdgesOf,
): readonly Node[] {
  const { depth, cycles } = wireDepths(nodes, edgesOf);

  for (const cycle of cycles) {
    problems.push({
      code: 'layout/cycle',
      severity: 'info',
      entity: cycle[0] ?? '(unknown)',
      path: 'wires',
      message:
        cycle.length === 1 ? `node wires to itself: ${cycle[0]}` : `nodes form a loop: ${cycle.join(' → ')}`,
      hint: 'geometry is advisory: a loop is placed in one column',
    });
  }

  const rows = new Map<number, number>();
  return nodes.map((node) => {
    if (node.geometry !== undefined) return node;
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      ...node,
      geometry: {
        x: config.originX + column * config.columnWidth,
        y: config.originY + row * config.rowHeight,
      },
    };
  });
}

interface Depths {
  readonly depth: ReadonlyMap<string, number>;
  /** Nodes that form a loop, one entry per loop, in the order the container lists them. */
  readonly cycles: readonly (readonly string[])[];
}

/**
 * Longest-path depth on the condensation of the wire graph.
 *
 * Edges are restricted to the container: a wire that leaves the tab is not this tab's business,
 * and counting it as an incoming edge would silently demote a node from its own root.
 */
function wireDepths(nodes: readonly Node[], edgesOf: EdgesOf): Depths {
  const scope = new Set(nodes.map((node) => node.id));
  const successors = new Map<string, readonly string[]>();

  for (const node of nodes) {
    const targets = new Set<string>();
    for (const target of edgesOf(node)) {
      if (scope.has(target)) targets.add(target);
    }
    successors.set(node.id, [...targets]);
  }

  const { components, componentOf } = stronglyConnected(nodes, successors);
  const depth = new Map<number, number>();

  // Tarjan emits a component only once everything it can reach is finished, so the array is in
  // reverse topological order: walking it backwards visits every predecessor before its
  // successors, and one pass is enough. Nothing here can iterate forever.
  for (let current = components.length - 1; current >= 0; current -= 1) {
    const here = depth.get(current) ?? 0;
    for (const id of components[current] ?? []) {
      for (const target of successors.get(id) ?? []) {
        const next = componentOf.get(target);
        if (next === undefined || next === current) continue;
        if (here + 1 > (depth.get(next) ?? 0)) depth.set(next, here + 1);
      }
    }
  }

  const looped = new Set<number>();
  for (const [id, component] of componentOf) {
    const targets = successors.get(id) ?? [];
    if ((components[component]?.length ?? 0) > 1 || targets.includes(id)) looped.add(component);
  }

  const byNode = new Map<string, number>();
  for (const node of nodes) byNode.set(node.id, depth.get(componentOf.get(node.id) ?? -1) ?? 0);

  const cycles: string[][] = [];
  for (let component = 0; component < components.length; component += 1) {
    if (!looped.has(component)) continue;
    // Container order rather than Tarjan order: the message should read the way the author
    // wrote the flow, and the report must not depend on DFS internals.
    cycles.push(nodes.filter((node) => componentOf.get(node.id) === component).map((node) => node.id));
  }

  return { depth: byNode, cycles };
}

/**
 * Tarjan's strongly connected components, iteratively.
 *
 * Iterative rather than recursive because the DFS depth is the longest chain in the flow: a
 * generated pipeline of a few thousand nodes in a row is a stack overflow waiting for the first
 * flow big enough to trigger it, and that failure would be far harder to diagnose than a cycle.
 *
 * Components come out in reverse topological order of the condensation — a component is pushed
 * only after every component it can reach.
 */
function stronglyConnected(
  nodes: readonly Node[],
  successors: ReadonlyMap<string, readonly string[]>,
): { readonly components: readonly (readonly string[])[]; readonly componentOf: ReadonlyMap<string, number> } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const componentOf = new Map<string, number>();
  let counter = 0;

  const open = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
  };

  for (const root of nodes) {
    if (index.has(root.id)) continue;

    open(root.id);
    const work: { readonly id: string; edge: number }[] = [{ id: root.id, edge: 0 }];

    while (work.length > 0) {
      const frame = work[work.length - 1] as { readonly id: string; edge: number };
      const targets = successors.get(frame.id) ?? [];

      if (frame.edge < targets.length) {
        const target = targets[frame.edge] as string;
        frame.edge += 1;
        if (!index.has(target)) {
          open(target);
          work.push({ id: target, edge: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(target) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
      }

      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        const number = components.length;
        components.push(component);
        for (const member of component) componentOf.set(member, number);
      }
    }
  }

  return { components, componentOf };
}

/**
 * Group box = bounding box of its members, padded the way the editor pads it. Members without
 * geometry (config nodes) are ignored.
 */
function boxGroup(group: Group, nodes: readonly Node[], config: LayoutConfig): Group {
  const members = nodes.filter((node) => node.g === group.id && node.geometry !== undefined);
  if (members.length === 0) return group;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const member of members) {
    const geometry = member.geometry as { x: number; y: number; w?: number; h?: number };
    const width = geometry.w ?? config.defaultWidth;
    const height = geometry.h ?? config.defaultHeight;
    minX = Math.min(minX, geometry.x - width / 2);
    minY = Math.min(minY, geometry.y - height / 2);
    maxX = Math.max(maxX, geometry.x + width / 2);
    maxY = Math.max(maxY, geometry.y + height / 2);
  }

  const x = minX - config.groupPadding;
  const y = minY - config.groupPadding - config.groupHeader;
  return {
    ...group,
    geometry: {
      x,
      y,
      w: maxX + config.groupPadding - x,
      h: maxY + config.groupPadding - y,
    },
  };
}

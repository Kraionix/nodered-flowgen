/**
 * Layout: advisory geometry, computed deterministically.
 *
 * Geometry is never a contract (the editor recomputes group boxes from DOM dimensions), but a
 * generated flow that opens as a pile of nodes at the origin is unusable. The strategy is
 * grid-by-depth: horizontal position follows the longest path from a root along the wires,
 * vertical position follows discovery order, and group boxes are the bounding box of their
 * members with the editor's own padding. The result is stable for a given flow set, which is
 * what makes geometry-insensitive diffs actually stay empty.
 */

import type { FlowSet, Group, Node } from '../model/entities.ts';

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
}

const DEFAULTS: Required<LayoutOptions> = {
  originX: 120,
  originY: 80,
  columnWidth: 190,
  rowHeight: 80,
  groupPadding: 25,
  groupHeader: 30,
  defaultWidth: 200,
  defaultHeight: 100,
};

/** Assigns coordinates to nodes that have none, and boxes to every group. */
export function layoutFlowSet(flowSet: FlowSet, options: LayoutOptions = {}): FlowSet {
  const config = { ...DEFAULTS, ...options };
  return { ...flowSet, flows: flowSet.flows.map((flow) => layoutContainer(flow, config, flowSet)) };
}

interface Container {
  readonly id: string;
  readonly nodes: readonly Node[];
  readonly groups: readonly Group[];
}

function layoutContainer<T extends Container>(container: T, config: Required<LayoutOptions>, flowSet: FlowSet): T {
  const scope = new Set(container.nodes.map((node) => node.id));
  const depth = depths(container.nodes, scope, flowSet);

  // Nodes that already have coordinates keep them: the author may have placed a node on
  // purpose, and layout must not fight a human.
  const groupsByDepth = new Map<number, number>();
  const nodes = container.nodes.map((node) => {
    if (node.geometry !== undefined) return node;
    const column = depth.get(node.id) ?? 0;
    const row = groupsByDepth.get(column) ?? 0;
    groupsByDepth.set(column, row + 1);
    return {
      ...node,
      geometry: {
        x: config.originX + column * config.columnWidth,
        y: config.originY + row * config.rowHeight,
      },
    };
  });

  return { ...container, nodes, groups: container.groups.map((group) => boxGroup(group, nodes, config)) };
}

/**
 * Longest-path depth from a root (a node nothing wires into). Unreachable nodes keep depth 0,
 * so they line up in the first column instead of floating off somewhere arbitrary.
 */
function depths(nodes: readonly Node[], scope: ReadonlySet<string>, flowSet: FlowSet): ReadonlyMap<string, number> {
  void flowSet;
  const incoming = new Map<string, number>();
  for (const node of nodes) {
    for (const wire of node.wires) {
      for (const target of wire) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((incoming.get(node.id) ?? 0) === 0) {
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (node === undefined) continue;
    for (const wire of node.wires) {
      for (const target of wire) {
        if (!scope.has(target)) continue;
        const candidate = (depth.get(id) ?? 0) + 1;
        if (candidate > (depth.get(target) ?? -1)) {
          depth.set(target, candidate);
          queue.push(target);
        }
      }
    }
  }

  return depth;
}

/**
 * Group box = bounding box of its members, padded the way the editor pads it. Members without
 * geometry (config nodes) are ignored.
 */
function boxGroup(group: Group, nodes: readonly Node[], config: Required<LayoutOptions>): Group {
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

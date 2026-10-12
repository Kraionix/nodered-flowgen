/**
 * One definition of "what points at what".
 *
 * Three parts of the tool need this and each used to compute it for itself, with different
 * answers:
 *
 * * the validator's reference check walked palette-declared references — but only over *nodes*,
 *   so a dangling `ui_group.tab` (a config node reference) was never checked;
 * * the validator's connectivity check counted wires — so a `link out`/`link in` pair, which is an
 *   edge with no wire in it, was reported as two isolated nodes;
 * * the layout counted wires — so a link-connected flow laid out in a single column.
 *
 * The three now share one walk. What each of them *does* with the result differs, which is why
 * there are three functions rather than one: "what does this node point at", "which property holds
 * a given reference", and "who points at this entity".
 */

import type { PaletteType } from '../palette/model.ts';

import { eachConfig, eachNode, type EntityId, type FlowSet, type Node, type NodeProps } from './entities.ts';

/** An entity that can hold references: a node or a config node. */
export interface Referrer {
  readonly type: string;
  readonly props: NodeProps;
}

/** A reference held in a property: which property holds it, and which entity it names. */
export interface ValueReference {
  readonly property: string;
  readonly id: EntityId;
}

export type ReferenceKind = 'wire' | 'reference' | 'subflow-port';

/** One entity pointing at another, and where the pointer lives. */
export interface Reference {
  readonly from: EntityId;
  readonly kind: ReferenceKind;
  /** Where the pointer lives: `wires[1][0]`, `props.broker`, `ports.out[0]`. */
  readonly path: string;
}

/**
 * Every entity-value reference of a node or config: one entry per id, with the property that
 * holds it.
 *
 * An empty string is *unset*, not dangling: the editor writes `"broker": ""` for every optional
 * config reference the author has not selected, and such flows are everywhere. Reporting them as
 * dangling would make the validator cry wolf on ordinary exports.
 */
export function referenceTargets(entity: Referrer, palette: Readonly<Record<string, PaletteType>>): readonly ValueReference[] {
  const type = palette[entity.type];
  if (type === undefined) return [];

  const found: ValueReference[] = [];
  for (const property of Object.keys(type.refs)) {
    for (const id of referenceIds(entity.props, property)) found.push({ property, id });
  }
  return found;
}

/** The ids a reference property holds, in written order, with unset values dropped. */
export function referenceIds(props: NodeProps, property: string): readonly EntityId[] {
  const value = Object.hasOwn(props.known, property) ? props.known[property] : props.extras[property];
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return [];
}

/**
 * Every entity a node points at: its wires, plus every palette-declared reference it holds.
 *
 * Config references count. `links` is what makes this interesting — `link out` declares
 * `outputs: 0` and holds a `links` reference to `link in` nodes, so a link pair is an edge with no
 * wire anywhere and a wire-only view calls both halves isolated — but `group` and `broker` are
 * pointers too, and a dashboard widget that hangs off a group is not a leftover, which is exactly
 * what the isolation check is trying to find.
 */
export function outgoingTargets(node: Node, palette: Readonly<Record<string, PaletteType>>): readonly EntityId[] {
  const targets = new Set<EntityId>();
  for (const wire of node.wires) {
    for (const target of wire) targets.add(target);
  }
  for (const reference of referenceTargets(node, palette)) targets.add(reference.id);
  return [...targets];
}

/**
 * Id → everyone pointing at it: wires, palette-declared references (from nodes *and* config
 * nodes), and subflow port links.
 *
 * Containment is deliberately not in here. `z` and `g` are membership, not reference, and they
 * have their own checks; mixing them in would make "is anything pointing at this?" answer yes for
 * every node in a tab, which is the opposite of useful.
 */
export function inboundReferences(
  flowSet: FlowSet,
  palette: Readonly<Record<string, PaletteType>>,
): ReadonlyMap<EntityId, readonly Reference[]> {
  const index = new Map<EntityId, Reference[]>();
  const add = (target: EntityId, reference: Reference): void => {
    const existing = index.get(target);
    if (existing === undefined) index.set(target, [reference]);
    else existing.push(reference);
  };

  for (const node of eachNode(flowSet)) {
    node.wires.forEach((wire, port) => {
      wire.forEach((target, position) => {
        add(target, { from: node.id, kind: 'wire', path: `wires[${port}][${position}]` });
      });
    });
    for (const reference of referenceTargets(node, palette)) {
      add(reference.id, { from: node.id, kind: 'reference', path: `props.${reference.property}` });
    }
  }

  for (const config of eachConfig(flowSet)) {
    for (const reference of referenceTargets(config, palette)) {
      add(reference.id, { from: config.id, kind: 'reference', path: `props.${reference.property}` });
    }
  }

  for (const subflow of flowSet.subflows) {
    for (const [port, links] of subflow.ports.in.entries()) {
      for (const [position, link] of links.entries()) {
        add(link.node, { from: subflow.id, kind: 'subflow-port', path: `ports.in[${port}][${position}]` });
      }
    }
    for (const [port, links] of subflow.ports.out.entries()) {
      for (const [position, link] of links.entries()) {
        add(link.node, { from: subflow.id, kind: 'subflow-port', path: `ports.out[${port}][${position}]` });
      }
    }
    for (const [position, link] of subflow.ports.status.entries()) {
      add(link.node, { from: subflow.id, kind: 'subflow-port', path: `ports.status[${position}]` });
    }
  }

  return index;
}

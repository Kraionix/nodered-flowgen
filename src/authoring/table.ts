/**
 * The node table: the authoritative node list, with the lookups the fluent surface needs.
 *
 * Three things need a node by id and each used to walk the whole array: wiring (`to`/`toPort`/
 * `chain`), relocation (`add`, i.e. moving a node into a group), and the container views at build
 * time. On a 5 000-node project that is ~25 M comparisons per build — invisible in a test, minutes
 * in a real project — so the table keeps an `id → index` map beside the array.
 *
 * The array stays the authority for *order* (it is the emission order), and nodes are replaced
 * rather than mutated: the IR is plain immutable data, and a shared node object that suddenly has
 * a wire nobody announced is exactly the kind of aliasing bug this design avoids.
 */

import type { EntityId, Node } from '../model/entities.ts';

export class NodeTable {
  readonly #nodes: Node[] = [];
  readonly #index = new Map<EntityId, number>();

  /** Appends a node; the order of this call is the order it is emitted in. */
  push(node: Node): Node {
    this.#index.set(node.id, this.#nodes.length);
    this.#nodes.push(node);
    return node;
  }

  get(id: EntityId): Node | null {
    const at = this.#index.get(id);
    return at === undefined ? null : (this.#nodes[at] as Node);
  }

  get size(): number {
    return this.#nodes.length;
  }

  /** Nodes in creation order. The caller must treat the result as read-only. */
  all(): readonly Node[] {
    return this.#nodes;
  }

  /** Nodes of one container, in creation order. `z` is the container id, `''` for the flow set. */
  containedIn(z: string): readonly Node[] {
    return this.#nodes.filter((node) => (node.z ?? '') === z);
  }

  /**
   * Wires output `port` of `fromId` to `toId`.
   *
   * Appends rather than replaces, because the emitter writes the target list in this order and a
   * second call for the same port is a second target, not a correction.
   */
  wire(fromId: EntityId, port: number, toId: EntityId): void {
    const at = this.#index.get(fromId);
    if (at === undefined) {
      throw new Error(`cannot wire from "${fromId}": it is not a node in this flow set (config nodes have no outputs)`);
    }
    const node = this.#nodes[at] as Node;
    const wires: string[][] = node.wires.map((wire) => [...wire]);
    while (wires.length <= port) wires.push([]);
    (wires[port] as string[]).push(toId);
    this.#nodes[at] = { ...node, wires };
  }

  /** Moves a node into a container (and optionally a group), keeping its position in the file. */
  relocate(id: EntityId, z: string, g: string | undefined): void {
    const at = this.#index.get(id);
    if (at === undefined) throw new Error(`cannot place unknown node "${id}"`);
    const node = this.#nodes[at] as Node;
    const { z: _previousZ, g: _previousG, ...rest } = node;
    this.#nodes[at] = {
      ...rest,
      ...(z === '' ? {} : { z }),
      ...(g === undefined ? {} : { g }),
    };
  }
}

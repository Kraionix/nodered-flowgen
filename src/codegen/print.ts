/**
 * The printer: IR → flow-set source.
 *
 * `import` reads a flow file into the IR; this writes the IR back out as the declarative
 * TypeScript that could have produced it. The acceptance bar is not "it looks plausible" but
 * `print → build → emit ≡ emit`: the generated source, built with the ids the import recorded,
 * reproduces the imported flow file byte for byte.
 *
 * Ids are the load-bearing part of that. The generated source contains no ids — that is the
 * whole point of the authoring surface — so the ids travel beside it as a `key → id` map
 * (`PrintResult.ids`) for the lockfile. Without it the file still builds, but every entity gets a
 * freshly derived id and a `plan` against the instance the flow came from would read as "delete
 * everything, create everything". With it, an import is adoptable.
 *
 * Three conventions make the round trip exact, and each is a consequence of how the builder works:
 *
 * * **Creation order is emission order.** The emitter writes containers and their contents in the
 *   order the flow set holds them, and the builder holds them in call order. So entities are
 *   printed in the IR's order, and something that needs a `const` gets it at its own position: a
 *   name is never hoisted, because hoisting would reorder the file.
 * * **Names only where something needs one.** A node nothing refers to is created inline inside a
 *   `chain()` call or as a bare statement, which keeps the generated file free of unused locals.
 * * **Keys are spelled the way the builder will spell them.** Every authoring key is derived with
 *   the same namespace the builder uses for its lockfile key (`node:<container id>/<key>`), so the
 *   `ids` map is found when the file is built.
 *
 * Where the authoring surface cannot express a fact exactly, the printer says so rather than
 * inventing one:
 *
 * * a type the palette does not know → the open `untyped`/`untypedConfig` surface;
 * * properties the palette does not declare → the `extras` bag, verbatim and in order;
 * * a **forward reference** in a property, or a wire into a container printed later → the id it
 *   already has, as a string literal: a handle would have to exist already, and reordering to make
 *   one exist would change the document;
 * * credentials → never printed (secrets do not belong in a repository), counted;
 * * a facet with no expression at all (port labels outnumbering ports, an instance of a subflow
 *   this flow set does not define) → a `// flowgen: review` comment, counted.
 */

import { isSubflowType, subflowDefinitionId, type PaletteType } from '../palette/model.ts';
import type {
  ConfigNode,
  EnvParam,
  EntityId,
  Flow,
  FlowSet,
  Group,
  Node,
  NodeProps,
  SubflowDef,
} from '../model/entities.ts';
import { slugify } from '../model/ids.ts';

export const DEFAULT_MODULE = '@kraionix/nodered-flowgen';

export interface PrintOptions {
  /** Module specifier the generated file imports from. */
  readonly moduleName?: string;
  /**
   * The palette, when the caller has one.
   *
   * It decides what a reader notices first: whether a type can be printed as `node()` (typed, its
   * property bag closed) or has to go through `untyped()`. Without it the printer is conservative
   * and prints every node through the open surface.
   */
  readonly palette?: Readonly<Record<string, PaletteType>> | undefined;
  /** Where the flow set came from, for the header comment. */
  readonly source?: string | undefined;
}

/** One thing the printer could not represent faithfully, and what it did instead. */
export interface PrintNote {
  readonly entity: EntityId;
  readonly reason: string;
  /** `dropped`, `literal`, `untyped`, `approximated`. */
  readonly action: string;
}

export interface PrintReport {
  /** Nodes, instances and config nodes printed. */
  readonly printed: number;
  /** Of those, how many went through the open (`untyped`) surface. */
  readonly untyped: number;
  /** `// flowgen: review` comments written into the file. */
  readonly comments: number;
  /** Facets that could not be represented at all. */
  readonly dropped: number;
  /** Every place fidelity was imperfect, in the order the printer met them. */
  readonly notes: readonly PrintNote[];
}

export interface PrintResult {
  readonly source: string;
  /** Lockfile-shaped authoring key → id, so a rebuild keeps the ids the flow file had. */
  readonly ids: ReadonlyMap<string, string>;
  readonly report: PrintReport;
}

export function printFlowSet(flowSet: FlowSet, options: PrintOptions = {}): PrintResult {
  return new Printer(flowSet, options).print();
}

/** A container: the flow-set root, a tab, a subflow body or a group. */
interface Scope {
  /** The container's IR id: the builder puts it into every key derived inside. `''` at the root. */
  readonly id: EntityId;
  /** The variable the container handle is bound to (`f` at the root). */
  readonly ref: string;
  /** Current indentation width, so multi-line literals line up. */
  readonly pad: number;
}

/** The authoring key of an entity, and the lockfile key the builder will look it up under. */
interface Keyed {
  readonly key: string;
  readonly lockKey: string;
}

interface Chained {
  readonly runs: readonly (readonly Node[])[];
  /** `<from>\0<to>` for every edge a `chain()` call already covers. */
  readonly consumed: ReadonlySet<string>;
}

class Printer {
  readonly #flowSet: FlowSet;
  readonly #options: PrintOptions;
  readonly #lines: string[] = [];
  readonly #ids = new Map<string, string>();
  readonly #notes: PrintNote[] = [];
  readonly #usedKeys = new Map<string, Set<string>>();
  readonly #usedNames = new Set<string>();
  /** Names whose `const` line has already been written — the only ones safe to reference. */
  readonly #declared = new Set<string>();
  /** Entity id → the variable its handle or node is bound to, for references and port links. */
  readonly #variables = new Map<EntityId, string>();
  /** Entities whose handle something else reads, so their creation needs a name. */
  #used: ReadonlySet<EntityId> = new Set();
  /** Subflow definition id → the variable its handle is bound to. */
  readonly #definitions = new Map<EntityId, string>();
  /** Group id → the variable its handle is bound to, so its members are created through it. */
  readonly #groups = new Map<EntityId, string>();
  #untyped = 0;
  #printed = 0;
  #comments = 0;
  #literals = 0;

  constructor(flowSet: FlowSet, options: PrintOptions) {
    this.#flowSet = flowSet;
    this.#options = options;
  }

  print(): PrintResult {
    this.#used = this.#usedIds();
    const root: Scope = { id: '', ref: 'f', pad: 2 };
    this.#lines.push(`import { defineFlowSet${this.#usesParams() ? ', P' : ''} } from '${this.#options.moduleName ?? DEFAULT_MODULE}';`);
    this.#lines.push('');
    this.#lines.push('export default defineFlowSet((f) => {');

    const body: string[] = [];
    this.#lines.push(...body);
    if (this.#flowSet.manifest !== undefined || Object.keys(this.#flowSet.modules).length > 0) {
      this.#manifest();
    }
    for (const subflow of this.#flowSet.subflows) this.#subflow(subflow);
    for (const config of this.#flowSet.configs) this.#config(config, root);
    for (const flow of this.#flowSet.flows) this.#flow(flow);
    if (this.#flowSet.loose.length > 0) {
      this.#lines.push('  // nodes without a container');
      this.#nodes(this.#flowSet.loose, root, new Set());
    }

    this.#lines.push('});');
    this.#lines.push('');

    if (this.#literals > 0) {
      this.#note('(references)', `${this.#literals} reference(s) printed as ids`, 'literal');
    }

    const header = this.#header();
    return {
      source: [...header, ...this.#lines].join('\n'),
      ids: this.#ids,
      report: {
        printed: this.#printed,
        untyped: this.#untyped,
        comments: this.#comments,
        dropped: this.#notes.filter((note) => note.action === 'dropped').length,
        notes: this.#notes,
      },
    };
  }

  // --------------------------------------------------------------------------------------
  // Prologue
  // --------------------------------------------------------------------------------------

  #header(): readonly string[] {
    const where = this.#options.source === undefined ? '' : ` from ${this.#options.source}`;
    const lines = [
      '/**',
      ` * Generated by \`flowgen import\`${where} — review before deploying.`,
      ' *',
      ' * Built with the ids recorded next to it, this source reproduces the imported flow file',
      ' * byte for byte: property order, geometry and the module manifest included. Built without',
      ' * them every entity is given a fresh id, which is a rename rather than a change.',
    ];
    if (this.#notes.length > 0) {
      lines.push(' *');
      lines.push(` * ${this.#notes.length} note(s) in the import report; the flagged lines are marked below.`);
    }
    lines.push(' */');
    return lines;
  }

  /** True when anything in the flow set declares `env` parameters, i.e. when `P` is needed. */
  #usesParams(): boolean {
    if (this.#flowSet.manifest !== undefined && this.#flowSet.manifest.env.length > 0) return true;
    if (this.#flowSet.flows.some((flow) => (flow.env?.length ?? 0) > 0)) return true;
    if (this.#flowSet.subflows.some((subflow) => subflow.env.length > 0)) return true;
    for (const group of this.#flowSet.flows.flatMap((flow) => flow.groups)) {
      if ((group.env?.length ?? 0) > 0) return true;
    }
    for (const group of this.#flowSet.subflows.flatMap((subflow) => subflow.groups)) {
      if ((group.env?.length ?? 0) > 0) return true;
    }
    return this.#allNodes().some((node) => (node.env?.length ?? 0) > 0);
  }

  /**
   * Which handles something else reads.
   *
   * A `const` nobody reads is a compile error in any project with `noUnusedLocals`, so a container
   * or config node whose handle is never used is created as a plain statement instead. What counts
   * as "used" is deliberately generous — any property value that happens to be an entity id counts
   * — because guessing the other way would leave a reference dangling.
   */
  #usedIds(): ReadonlySet<EntityId> {
    const known = new Set<EntityId>();
    for (const subflow of this.#flowSet.subflows) known.add(subflow.id);
    for (const flow of this.#flowSet.flows) known.add(flow.id);
    for (const group of this.#flowSet.subflows.flatMap((subflow) => subflow.groups)) known.add(group.id);
    for (const group of this.#flowSet.flows.flatMap((flow) => flow.groups)) known.add(group.id);
    for (const config of this.#flowSet.configs) known.add(config.id);
    for (const node of this.#allNodes()) known.add(node.id);

    const used = new Set<EntityId>();
    const containers: readonly { readonly id: EntityId; readonly nodes: readonly Node[]; readonly configs: readonly ConfigNode[]; readonly groups: readonly Group[] }[] = [
      ...this.#flowSet.flows,
      ...this.#flowSet.subflows,
    ];
    for (const container of containers) {
      // A container with contents is created through: its nodes, configs and groups are made with
      // its handle, so the name is read.
      if (container.nodes.length + container.configs.length + container.groups.length > 0) used.add(container.id);
    }
    for (const node of this.#allNodes()) {
      if (node.z !== undefined) used.add(node.z);
      if (node.g !== undefined) used.add(node.g);
      const definition = subflowDefinitionId(node.type);
      if (definition !== null) used.add(definition);
      for (const value of stringsIn(node.props)) if (known.has(value)) used.add(value);
    }
    for (const config of this.#configs()) {
      if (config.z !== undefined && config.z !== '') used.add(config.z);
      for (const value of stringsIn(config.props)) if (known.has(value)) used.add(value);
    }
    return used;
  }

  #configs(): readonly ConfigNode[] {
    return [
      ...this.#flowSet.configs,
      ...this.#flowSet.subflows.flatMap((subflow) => subflow.configs),
      ...this.#flowSet.flows.flatMap((flow) => flow.configs),
    ];
  }

  #allNodes(): readonly Node[] {
    return [
      ...this.#flowSet.subflows.flatMap((subflow) => subflow.nodes),
      ...this.#flowSet.flows.flatMap((flow) => flow.nodes),
      ...this.#flowSet.loose,
    ];
  }

  #manifest(): void {
    const manifest = this.#flowSet.manifest;
    this.#ids.set('global-config', manifest?.id ?? 'global-config');

    const fields: string[] = [];
    if (manifest !== undefined && manifest.env.length > 0) fields.push(`env: ${this.#paramsLiteral(manifest.env, 4)}`);
    const modules = Object.entries(this.#flowSet.modules);
    if (modules.length > 0) fields.push(`modules: ${this.#value(Object.fromEntries(modules), 4)}`);
    this.#lines.push(`  f.manifest(${this.#object(fields, 4)});`);
    this.#lines.push('');
  }

  // --------------------------------------------------------------------------------------
  // Containers
  // --------------------------------------------------------------------------------------

  #subflow(subflow: SubflowDef): void {
    this.#printed += 1;
    const keyed = this.#keyOf('subflow:', 'subflow:', subflow.name || 'subflow');
    const name = this.#used.has(subflow.id) ? this.#name(keyed.key) : null;
    this.#ids.set(keyed.lockKey, subflow.id);
    if (name !== null) this.#definitions.set(subflow.id, name);

    const options: string[] = [`name: ${this.#string(subflow.name)}`];
    if (subflow.info !== undefined) options.push(`info: ${this.#string(subflow.info)}`);
    if (subflow.category !== undefined) options.push(`category: ${this.#string(subflow.category)}`);
    if (subflow.color !== undefined) options.push(`color: ${this.#string(subflow.color)}`);
    if (subflow.icon !== undefined) options.push(`icon: ${this.#string(subflow.icon)}`);
    if (Object.keys(subflow.meta).length > 0) options.push(`meta: ${this.#value(subflow.meta, 4)}`);
    if (subflow.env.length > 0) options.push(`params: ${this.#paramsLiteral(subflow.env, 4)}`);
    const ports = this.#portsLiteral(subflow, 4);
    if (ports !== null) options.push(`ports: ${ports}`);
    if (subflow.credentials !== undefined) {
      this.#note(subflow.id, 'subflow credentials', 'dropped');
      this.#review('credentials are not printed: configure a credential provider instead', 1);
    }

    this.#lines.push(`  ${name === null ? '' : `const ${name} = `}f.subflow(${this.#string(keyed.key)},`);
    this.#lines.push(`    ${this.#object(options, 4)},`);
    this.#lines.push('    (s) => {');

    const body: Scope = { id: subflow.id, ref: 's', pad: 6 };
    for (const config of subflow.configs) this.#config(config, body);
    for (const group of subflow.groups) this.#group(group, body);
    this.#nodes(subflow.nodes, body, this.#portLinkIds(subflow));
    this.#portLinks(subflow, body.pad);

    this.#lines.push('    },');
    this.#lines.push('  );');
    this.#lines.push('');
  }

  #flow(flow: Flow): void {
    this.#printed += 1;
    const keyed = this.#keyOf('tab:', 'tab:', flow.label || flow.id);
    const name = this.#used.has(flow.id) ? this.#name(keyed.key) : null;
    this.#ids.set(keyed.lockKey, flow.id);
    if (name !== null) this.#bind(flow.id, name);

    const scope: Scope = { id: flow.id, ref: name ?? 'f', pad: 2 };
    const options: string[] = [];
    if (flow.label !== '') options.push(`label: ${this.#string(flow.label)}`);
    if (flow.info !== undefined) options.push(`info: ${this.#string(flow.info)}`);
    if (flow.disabled === true) options.push('disabled: true');
    if (flow.locked === true) options.push('locked: true');
    if (flow.env !== undefined && flow.env.length > 0) options.push(`env: ${this.#paramsLiteral(flow.env, 4)}`);

    const tail = options.length === 0 ? '' : `, ${this.#object(options, 2)}`;
    this.#lines.push(`  ${name === null ? '' : `const ${name} = `}f.flow(${this.#string(keyed.key)}${tail});`);

    for (const config of flow.configs) this.#config(config, scope);
    for (const group of flow.groups) this.#group(group, scope);
    this.#nodes(flow.nodes, scope, new Set());
    this.#lines.push('');
  }

  #group(group: Group, scope: Scope): void {
    this.#printed += 1;
    const keyed = this.#keyOf(`group:${scope.id}:`, `group:${scope.id}/`, group.name || 'group');
    const name = this.#used.has(group.id) ? this.#name(keyed.key) : null;
    this.#ids.set(keyed.lockKey, group.id);
    if (name !== null) this.#groups.set(group.id, name);

    const options: string[] = [`name: ${this.#string(group.name)}`];
    if (group.style !== undefined) options.push(`style: ${this.#value(group.style, scope.pad + 2)}`);
    if (group.env !== undefined && group.env.length > 0) {
      options.push(`env: ${this.#paramsLiteral(group.env, scope.pad + 2)}`);
    }
    const geometry = group.geometry;
    options.push(`x: ${geometry.x}`, `y: ${geometry.y}`);
    if (geometry.w !== undefined) options.push(`w: ${geometry.w}`);
    if (geometry.h !== undefined) options.push(`h: ${geometry.h}`);

    const pad = ' '.repeat(scope.pad);
    const head = name === null ? '' : `const ${name} = `;
    this.#lines.push(`${pad}${head}${scope.ref}.group(${this.#string(keyed.key)}, ${this.#object(options, scope.pad)});`);
    if (name !== null) this.#bind(group.id, name);
  }

  #config(config: ConfigNode, scope: Scope): void {
    this.#printed += 1;
    const known = this.#options.palette?.[config.type] !== undefined;
    if (!known) this.#untyped += 1;

    const scoped = config.z !== undefined && config.z !== '';
    const keyed = this.#keyOf(
      `config:${scoped ? config.z : ''}:`,
      scoped ? `config:${config.z}/` : 'config:',
      this.#nameSource({ props: config.props, type: config.type }),
    );
    const name = this.#used.has(config.id) ? this.#name(keyed.key) : null;
    this.#ids.set(keyed.lockKey, config.id);

    const method = known ? 'config' : 'untypedConfig';
    const tail = scoped ? ", { scope: 'container' }" : '';
    const keyField = this.#keyField(keyed, config.type);
    const fields = [
      ...(keyField === null ? [] : [keyField]),
      ...this.#propFields(config.props, scope.pad, config.type),
    ];
    const head = name === null ? '' : `const ${name} = `;
    this.#lines.push(
      `${' '.repeat(scope.pad)}${head}${scope.ref}.${method}(${this.#string(config.type)}, ${this.#object(fields, scope.pad)}${tail});`,
    );
    if (name !== null) this.#bind(config.id, name);
  }

  // --------------------------------------------------------------------------------------
  // Nodes
  // --------------------------------------------------------------------------------------

  /**
   * Prints a container's nodes in order, collapsing straight runs into `chain()` calls.
   *
   * `portLinks` is the set of nodes a subflow port refers to: those need a name, because
   * `s.in(node)` takes a handle rather than an id.
   */
  #nodes(nodes: readonly Node[], scope: Scope, portLinks: ReadonlySet<EntityId>): void {
    if (nodes.length === 0) return;

    // One key per node, allocated before anything is written: a second allocation would find the
    // namespace already used and hand out a disambiguated key.
    const keyed = new Map<EntityId, Keyed>(nodes.map((node) => [node.id, this.#nodeKey(node, scope)]));
    for (const [id, entry] of keyed) this.#ids.set(entry.lockKey, id);
    const { runs, consumed } = this.#chains(nodes, portLinks);

    const named = new Set<EntityId>(portLinks);
    for (const node of nodes) {
      for (const [port, targets] of node.wires.entries()) {
        for (const target of targets) {
          if (port === 0 && targets.length === 1 && consumed.has(edge(node.id, target))) continue;
          // Both ends of a wire the wiring pass has to write get a name: writing the target as an
          // id literal would tie the generated file to the lockfile for no gain.
          named.add(node.id);
          named.add(target);
        }
      }
    }

    const names = new Map<EntityId, string>();
    for (const node of nodes) {
      if (!named.has(node.id)) continue;
      const name = this.#name((keyed.get(node.id) as Keyed).key);
      names.set(node.id, name);
    }
    for (const [id, name] of names) this.#variables.set(id, name);

    const head = new Map<EntityId, readonly Node[]>(runs.map((run) => [(run[0] as Node).id, run]));

    for (const node of nodes) {
      const run = head.get(node.id);
      if (run === undefined) continue; // a chain continuation: printed with its head
      if (run.length === 1) {
        const creation = this.#creation(node, keyed.get(node.id) as Keyed, scope);
        this.#push(scope, node.id, names.get(node.id), creation);
        continue;
      }

      // A chain head that also needs a name — it has wires no `chain()` call covers — is created
      // first and passed in, which keeps both its position and the run's order.
      const own = names.get(node.id);
      if (own !== undefined) this.#push(scope, node.id, own, this.#creation(node, keyed.get(node.id) as Keyed, scope));

      const refs = run.map((member, index) => {
        if (index === 0 && own !== undefined) return own;
        const name = names.get(member.id);
        if (name !== undefined) return name;
        return this.#creation(member, keyed.get(member.id) as Keyed, scope);
      });
      this.#lines.push(`${' '.repeat(scope.pad)}${scope.ref}.chain(${refs.join(', ')});`);
    }

    this.#wiring(nodes, scope, consumed);
  }

  /** Records that a `const` line has been written for an entity, so references can use it. */
  #bind(id: EntityId, name: string): void {
    this.#declared.add(name);
    this.#variables.set(id, name);
  }

  #push(scope: Scope, id: EntityId, name: string | undefined, creation: string): void {
    const pad = ' '.repeat(scope.pad);
    if (name === undefined) {
      this.#lines.push(`${pad}${creation};`);
      return;
    }
    this.#lines.push(`${pad}const ${name} = ${creation};`);
    this.#bind(id, name);
  }

  /** The wiring pass: one call per source, after every node of the container exists. */
  #wiring(nodes: readonly Node[], scope: Scope, consumed: ReadonlySet<string>): void {
    const pad = ' '.repeat(scope.pad);
    for (const node of nodes) {
      const ports = node.wires
        .map((targets, port) => ({ port, targets }))
        .filter(({ port, targets }) => {
          if (targets.length === 0) return false;
          return !(port === 0 && targets.length === 1 && consumed.has(edge(node.id, targets[0] as string)));
        });
      if (ports.length === 0) continue;

      const from = this.#wireRef(node.id);
      for (const { port, targets } of ports) {
        const refs = targets.map((target) => this.#wireRef(target));
        if (ports.length === 1 && port === 0 && refs.length === 1) {
          this.#lines.push(`${pad}${from}.to(${refs[0] as string});`);
        } else {
          this.#lines.push(`${pad}${from}.toPort(${port}${refs.length === 0 ? '' : `, ${refs.join(', ')}`});`);
        }
      }
    }
  }

  /**
   * A wire target: its variable when one is already declared, its id otherwise.
   *
   * An id literal is only correct when the build uses the ids this printer returns — which is the
   * contract — so every one of them is counted, and the count tells a reader how much of the
   * generated file rests on that record.
   */
  #wireRef(id: EntityId): string {
    return this.#handleRef(id);
  }

  /**
   * Maximal runs a single `chain()` call reproduces exactly.
   *
   * `chain()` wires output 0 to input 0 for every pair, so a run has to be exactly that: one wire,
   * on port 0, to the next node in the file, which nothing else feeds. The run also stops before
   * any node that needs a declaration of its own, because a declaration cannot be hoisted without
   * moving the node in the emitted file — a run that is merely *usually* linear would silently
   * reorder wires the moment the file is not what it looked like.
   */
  #chains(nodes: readonly Node[], portLinks: ReadonlySet<EntityId>): Chained {
    const incoming = new Map<EntityId, number>();
    for (const node of nodes) {
      for (const target of node.wires.flat()) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }

    const runs: (readonly Node[])[] = [];
    const consumed = new Set<string>();
    let index = 0;

    while (index < nodes.length) {
      const run: Node[] = [nodes[index] as Node];
      while (index + 1 < nodes.length) {
        const from = run[run.length - 1] as Node;
        const to = nodes[index + 1] as Node;
        if (from.wires.filter((port) => port.length > 0).length !== 1) break;
        if (from.wires[0]?.length !== 1 || from.wires[0]?.[0] !== to.id) break;
        if ((incoming.get(to.id) ?? 0) !== 1) break;
        if (portLinks.has(to.id)) break;
        run.push(to);
        index += 1;
      }

      // A member needs no declaration only if every wire it has is one this run covers. That is
      // decided on the finished run: `a → b → c` cannot stop at `b` merely because `b` also
      // branches, but it must stop before a node whose branch leaves the run.
      const edges = run.slice(1).map((node, position) => edge((run[position] as Node).id, node.id));
      const probe = new Set([...consumed, ...edges]);
      const stop = run.findIndex((node, position) => position > 0 && namesNeeded(node, probe, portLinks));

      if (stop > 0) {
        const keep = run.slice(0, stop);
        for (let position = 0; position + 1 < keep.length; position += 1) {
          consumed.add(edge((keep[position] as Node).id, (keep[position + 1] as Node).id));
        }
        runs.push(keep);
        // The rest of the run is rebuilt from the node that stopped it: it becomes a run head,
        // which may carry a declaration of its own, at its own position in the file.
        index = nodes.indexOf(run[stop] as Node);
        continue;
      }

      for (const edgeKey of edges) consumed.add(edgeKey);
      runs.push(run);
      index += 1;
    }

    return { runs, consumed };
  }

  // --------------------------------------------------------------------------------------
  // Node creation
  // --------------------------------------------------------------------------------------

  #creation(node: Node, keyed: Keyed, scope: Scope): string {
    // Membership is expressed by *nesting*: `group.node(...)` is what sets `g`, and `g` is what
    // the emitter derives `nodes[]` from. The statement still stands at the node's own position,
    // which is what keeps the emitted node order the flow file's.
    const owner = node.g === undefined ? scope : { ...scope, ref: this.#groups.get(node.g) ?? scope.ref };
    const definitionId = subflowDefinitionId(node.type);
    if (definitionId !== null) return this.#instance(node, keyed, owner, definitionId);

    const palette = this.#options.palette?.[node.type] ?? null;
    const known = palette !== null;
    if (!known) this.#untyped += 1;
    this.#printed += 1;
    if (node.credentials !== undefined) {
      this.#note(node.id, 'credentials', 'dropped');
      this.#review('credentials are not printed: configure a credential provider instead', 0);
    }
    if (node.props.extras['key'] !== undefined) {
      this.#note(node.id, 'a property named `key`, which the palette does not declare', 'dropped');
    }
    // `disabled` is a palette property on `ui_tab`/`ui_group` and an envelope flag everywhere
    // else; on those two the envelope spelling is unavailable, so say which half is lost.
    const declaredDisabled = palette !== null && Object.hasOwn(palette.defaults, 'disabled');
    if (declaredDisabled && (node.props.known['disabled'] === true || node.disabled === true)) {
      this.#note(node.id, '`disabled` as a palette property and as the node flag', 'approximated');
    }

    const keyField = this.#keyField(keyed, node.type);
    const fields = [
      ...(keyField === null ? [] : [keyField]),
      ...this.#propFields(node.props, owner.pad, node.type),
    ];
    if (node.disabled === true) fields.push('disabled: true');
    const geometry = node.geometry;
    if (geometry !== undefined) {
      fields.push(`x: ${geometry.x}`, `y: ${geometry.y}`);
      if (geometry.w !== undefined) fields.push(`w: ${geometry.w}`);
      if (geometry.h !== undefined) fields.push(`h: ${geometry.h}`);
    }
    if (node.env !== undefined && node.env.length > 0) {
      fields.push(`env: ${this.#paramsLiteral(node.env, owner.pad + 2)}`);
    }
    const method = known ? 'node' : 'untyped';
    return `${owner.ref}.${method}(${this.#string(node.type)}, ${this.#object(fields, owner.pad)})`;
  }

  /** `container.instance(definition, {...})`: the surface a subflow instance is authored with. */
  #instance(node: Node, keyed: Keyed, scope: Scope, definitionId: EntityId): string {
    this.#printed += 1;
    const definition = this.#definitions.get(definitionId);
    const fields = [`key: ${this.#string(keyed.key)}`];
    // The instance type only exists once the definition does, so an import parsed against the
    // base palette keeps `name` among the extras; either bag is the same fact.
    const name = node.props.known['name'] ?? node.props.extras['name'];
    if (typeof name === 'string') fields.push(`name: ${this.#string(name)}`);
    if (node.disabled === true) fields.push('disabled: true');
    const geometry = node.geometry;
    if (geometry !== undefined) {
      fields.push(`x: ${geometry.x}`, `y: ${geometry.y}`);
      if (geometry.w !== undefined) fields.push(`w: ${geometry.w}`);
      if (geometry.h !== undefined) fields.push(`h: ${geometry.h}`);
    }
    if (node.env !== undefined && node.env.length > 0) {
      fields.push(`env: ${this.#overrides(node, definitionId, scope.pad + 2)}`);
    }
    const rest: Record<string, unknown> = { ...node.props.known, ...node.props.extras };
    if (typeof name === 'string') delete rest['name'];
    if (Object.keys(rest).length > 0) fields.push(`props: ${this.#value(rest, scope.pad + 2)}`);
    if (node.credentials !== undefined) this.#note(node.id, 'credentials', 'dropped');

    if (definition === undefined) {
      this.#untyped += 1;
      this.#note(node.id, `subflow instance of "${definitionId}", which this flow set does not define`, 'untyped');
      this.#review(`no definition for subflow ${definitionId}: printed through the open surface`, 0);
      return `${scope.ref}.untyped(${this.#string(node.type)}, ${this.#object(fields, scope.pad)})`;
    }
    return `${scope.ref}.instance(${definition}, ${this.#object(fields, scope.pad)})`;
  }

  /** Instance overrides: a record of values, converted back with the declared parameter types. */
  #overrides(node: Node, definitionId: EntityId, pad: number): string {
    const declared = new Map<string, EnvParam>();
    for (const definition of this.#flowSet.subflows) {
      if (definition.id !== definitionId) continue;
      for (const param of definition.env) declared.set(param.name, param);
    }

    const entries: Record<string, unknown> = {};
    for (const param of node.env ?? []) {
      const spec = declared.get(param.name);
      const inferred = typeof param.value === 'boolean' ? 'bool' : typeof param.value === 'number' ? 'num' : 'str';
      if ((spec?.type ?? inferred) !== param.type) {
        this.#note(node.id, `override of "${param.name}" is declared ${param.type}`, 'approximated');
      }
      entries[param.name] = param.value;
    }
    return this.#value(entries, pad);
  }

  #portLinkIds(subflow: SubflowDef): ReadonlySet<EntityId> {
    const ids = new Set<EntityId>();
    for (const port of subflow.ports.in) for (const link of port) ids.add(link.node);
    for (const port of subflow.ports.out) for (const link of port) ids.add(link.node);
    for (const link of subflow.ports.status) ids.add(link.node);
    return ids;
  }

  #portLinks(subflow: SubflowDef, pad: number): void {
    const calls: string[] = [];
    subflow.ports.in.forEach((links, port) => {
      for (const link of links) calls.push(`s.in(${this.#handle(link.node)}, ${port});`);
    });
    subflow.ports.out.forEach((links, port) => {
      for (const link of links) calls.push(`s.out(${this.#handle(link.node)}, ${link.port ?? 0}, ${port});`);
    });
    for (const link of subflow.ports.status) calls.push(`s.status(${this.#handle(link.node)}, ${link.port ?? 0});`);
    if (calls.length > 0) this.#lines.push(...calls.map((call) => `${' '.repeat(pad)}${call}`));
  }

  /** A subflow port's node handle; a port pointing outside the body is an invalid flow. */
  #handle(id: EntityId): string {
    const name = this.#variables.get(id);
    if (name !== undefined) return name;
    this.#literals += 1;
    this.#note(id, 'subflow port links a node outside its body', 'literal');
    return this.#string(id);
  }

  // --------------------------------------------------------------------------------------
  // Properties and values
  // --------------------------------------------------------------------------------------

  /**
   * Property fields, with declared references turned back into handles.
   *
   * A reference is the one place a hand-written flow set reads better with a handle than with an
   * id, and the palette says which properties those are (`links`, `broker`, `group`, `tab`). A
   * target with no variable yet — one created later in the file — keeps its id, and is counted:
   * that is the part of the generated source which depends on the recorded ids.
   */
  #propFields(props: NodeProps, pad: number, type: string | null): readonly string[] {
    const refs = type === null ? undefined : this.#options.palette?.[type]?.refs;
    const fields: string[] = [];
    for (const [name, value] of Object.entries(props.known)) {
      if (value === undefined) continue;
      const declared = refs !== undefined && Object.hasOwn(refs, name);
      fields.push(`${this.#property(name)}: ${this.#reference(value, declared, pad + 2)}`);
    }
    if (Object.keys(props.extras).length > 0) {
      fields.push(`extras: ${this.#value(props.extras, pad + 2)}`);
    }
    return fields;
  }

  /** A property value that may be a declared reference (a single id, or an array of them). */
  #reference(value: unknown, declared: boolean, pad: number): string {
    if (declared) {
      if (typeof value === 'string') return this.#handleRef(value);
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        const items = (value as readonly string[]).map((entry) => this.#handleRef(entry));
        return this.#wrap('[', items, ']', pad);
      }
    }
    return this.#value(value, pad);
  }

  #handleRef(id: EntityId): string {
    const name = this.#variables.get(id);
    if (name !== undefined && this.#declared.has(name)) return name;
    this.#literals += 1;
    return this.#string(id);
  }

  /** `env` parameters as the authoring surface spells them: `P.str('x')` where the type allows. */
  #paramsLiteral(params: readonly EnvParam[], pad: number): string {
    const fields = params.map((param) => {
      const call = param.ui === undefined && param.value !== undefined ? this.#paramCall(param.type, param.value) : null;
      const spec: Record<string, unknown> = { type: param.type, value: param.value };
      if (param.ui !== undefined) spec['ui'] = param.ui;
      return `${this.#property(param.name)}: ${call ?? this.#value(spec, pad)}`;
    });
    return this.#object(fields, pad);
  }

  #paramCall(type: string, value: unknown): string | null {
    if (type === 'num' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return `P.num(${value})`;
    }
    if (type === 'bool' && (value === 'true' || value === 'false')) return `P.bool(${value})`;
    if (type === 'str' && typeof value === 'string') return `P.str(${this.#string(value)})`;
    if (type === 'cred' && value === '') return 'P.cred()';
    if ((type === 'env' || type === 'flow' || type === 'global') && typeof value === 'string') {
      return `P.${type}(${this.#string(value)})`;
    }
    return null;
  }

  #portsLiteral(subflow: SubflowDef, pad: number): string | null {
    const fields: string[] = [];
    if (subflow.ports.in.length > 0) fields.push(`in: ${this.#value(this.#labelsFor(subflow, 'in'), pad)}`);
    if (subflow.ports.out.length > 0) fields.push(`out: ${this.#value(this.#labelsFor(subflow, 'out'), pad)}`);
    if (subflow.ports.inPosition !== undefined) fields.push(`inPosition: ${this.#value(subflow.ports.inPosition, pad)}`);
    if (subflow.ports.outPosition !== undefined) {
      fields.push(`outPosition: ${this.#value(subflow.ports.outPosition, pad)}`);
    }
    if (subflow.ports.statusPosition !== undefined) {
      fields.push(`statusPosition: ${this.#value(subflow.ports.statusPosition, pad)}`);
    }
    return fields.length === 0 ? null : this.#object(fields, pad);
  }

  /** Port labels, padded or trimmed to the port count: the count *is* the label array's length. */
  #labelsFor(subflow: SubflowDef, direction: 'in' | 'out'): readonly string[] {
    const labels = direction === 'in' ? subflow.inputLabels : subflow.outputLabels;
    const count = direction === 'in' ? subflow.ports.in.length : subflow.ports.out.length;
    if (labels === undefined) return Array.from({ length: count }, () => '');
    if (labels.length !== count) {
      this.#note(subflow.id, `${direction}putLabels has ${labels.length} entries for ${count} port(s)`, 'approximated');
    }
    return Array.from({ length: count }, (_, index) => labels[index] ?? '');
  }

  #object(fields: readonly string[], pad: number): string {
    if (fields.length === 0) return '{}';
    const inline = `{ ${fields.join(', ')} }`;
    if (inline.length + pad <= 110 && !inline.includes('\n')) return inline;
    const inner = ' '.repeat(pad + 2);
    const close = ' '.repeat(pad);
    return `{\n${fields.map((field) => `${inner}${field},`).join('\n')}\n${close}}`;
  }

  /** A value literal, inlined when it stays readable. */
  #value(value: unknown, pad: number): string {
    if (value === null || typeof value !== 'object') {
      if (value === undefined) return 'undefined';
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const fields = value.map((item) => this.#value(item, pad + 2));
      return this.#wrap('[', fields, ']', pad);
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    const fields = entries.map(([name, item]) => `${this.#property(name)}: ${this.#value(item, pad + 2)}`);
    return this.#wrap('{', fields, '}', pad);
  }

  #wrap(open: string, fields: readonly string[], close: string, pad: number): string {
    if (fields.length === 0) return `${open}${close}`;
    const inline = `${open} ${fields.join(', ')} ${close}`;
    if (inline.length + pad <= 100 && !inline.includes('\n')) return inline;
    const inner = ' '.repeat(pad + 2);
    const outer = ' '.repeat(pad);
    return `${open}\n${fields.map((field) => `${inner}${field},`).join('\n')}\n${outer}${close}`;
  }

  #string(value: string): string {
    return JSON.stringify(value);
  }

  /** An object key: bare when it is an identifier, quoted otherwise. */
  #property(value: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : this.#string(value);
  }

  // --------------------------------------------------------------------------------------
  // Keys and names
  // --------------------------------------------------------------------------------------

  #nodeKey(node: Node, scope: Scope): Keyed {
    const scoped = scope.id !== '';
    if (isSubflowType(node.type)) {
      return this.#keyOf(
        `instance:${scope.id}:`,
        scoped ? `instance:${scope.id}/` : 'instance:',
        this.#nameSource(node),
      );
    }
    return this.#keyOf(`node:${scope.id}:`, scoped ? `node:${scope.id}/` : 'node:', this.#nameSource(node));
  }

  /**
   * The authoring key field, unless the node carries a property of that name.
   *
   * `key` is both an envelope spelling and a palette property on a few types (`join`,
   * `tls-config`); emitting both would declare the property twice and, worse, let the property's
   * value decide the id. The property wins, and it is the key.
   */
  #keyField(keyed: Keyed, type: string): string | null {
    const declared = this.#options.palette?.[type];
    if (declared !== undefined && Object.hasOwn(declared.defaults, 'key')) return null;
    return `key: ${this.#string(keyed.key)}`;
  }

  /** The key a node is given: its name when it has one, its type or `instance` otherwise. */
  #nameSource(node: { readonly props: NodeProps; readonly type: string }): string {
    const declared = node.props.known['key'];
    if (typeof declared === 'string' && declared !== '') return declared;
    return nameSource(node.props, isSubflowType(node.type) ? 'instance' : node.type);
  }

  #keyOf(namespace: string, lockPrefix: string, preferred: string): Keyed {
    let used = this.#usedKeys.get(namespace);
    if (used === undefined) {
      used = new Set<string>();
      this.#usedKeys.set(namespace, used);
    }
    const base = slugify(preferred);
    let key = base;
    // The builder disambiguates a repeated key as `key#2`; mirroring that spelling is what keeps
    // the recorded ids found when two entities derive the same key.
    for (let ordinal = 2; used.has(key); ordinal += 1) key = `${base}#${ordinal}`;
    used.add(key);
    return { key, lockKey: `${lockPrefix}${key}` };
  }

  /** A fresh JavaScript identifier for the generated file. */
  #name(key: string): string {
    const base = identifier(key);
    let name = base;
    for (let ordinal = 2; this.#usedNames.has(name); ordinal += 1) name = `${base}_${ordinal}`;
    this.#usedNames.add(name);
    return name;
  }

  #note(entity: EntityId, reason: string, action: string): void {
    this.#notes.push({ entity, reason, action });
  }

  #review(reason: string, depth: number): void {
    this.#comments += 1;
    this.#lines.push(`${'  '.repeat(depth)}// flowgen: review — ${reason}`);
  }
}

/** A name to derive a key from: the entity's `name` when it has one, its type otherwise. */
function nameSource(props: NodeProps, fallback: string): string {
  const name = props.known['name'] ?? props.extras['name'];
  if (typeof name === 'string' && name.trim() !== '') return name;
  return fallback;
}

/** An identifier that reads like the key: `mqtt-broker` becomes `mqtt_broker`, `7` becomes `_7`. */
function identifier(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
  const prefixed = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
  if (prefixed === '' || RESERVED.has(prefixed)) return `${prefixed}_`;
  return prefixed;
}

/** True when a node needs a `const` of its own: it is wired, or a port refers to it. */
function namesNeeded(node: Node, consumed: ReadonlySet<string>, portLinks: ReadonlySet<EntityId>): boolean {
  if (portLinks.has(node.id)) return true;
  return node.wires.some((targets, port) =>
    targets.some((target) => !(port === 0 && targets.length === 1 && consumed.has(edge(node.id, target)))),
  );
}

/** Every string that appears in a property bag, at any depth. */
function stringsIn(props: NodeProps): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const entry of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
      walk(entry, depth + 1);
    }
  };
  for (const value of [...Object.values(props.known), ...Object.values(props.extras)]) walk(value, 0);
  return found;
}

/** A chain edge, as the printer keys them. */
function edge(from: EntityId, to: EntityId): string {
  return `${from}\u0000${to}`;
}

/** Words a generated `const` may not be called, plus the names the file itself binds. */
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'f', 's', 'P',
]);

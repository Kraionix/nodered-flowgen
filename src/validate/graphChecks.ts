/**
 * Graph checks: does the flow agree with itself?
 *
 * These are the defects that make a flow *load* and then misbehave, and the ones the Python
 * prior art produced reliably (see the prior-art review): wires pointing at ids that no longer
 * exist, wire arrays shorter than the port count, containers that were removed while their
 * members stayed, config references that form a cycle. The runtime's own symptoms for these are
 * "Waiting for missing types to be registered" and "Circular config node dependency" — after
 * a hundred retries, in the log, at deploy time.
 */

import { allIds, eachConfig, eachGroup, eachNode, type FlowSet } from '../model/entities.ts';
import { effectiveOutputCount } from '../model/normalize.ts';
import { isSubflowType, subflowDefinitionId } from '../palette/model.ts';

import type { Problem } from '../diagnostics/index.ts';
import type { ValidationContext, Validator } from './report.ts';

export const graphChecks: Validator = {
  name: 'graph',
  validate: (context) => [
    ...checkDuplicateIds(context.flowSet),
    ...checkContainers(context),
    ...checkWires(context),
    ...checkGroups(context.flowSet),
    ...checkConfigCycles(context),
    ...checkSubflowRecursion(context.flowSet),
    ...checkIsolatedNodes(context),
  ],
};

function checkDuplicateIds(flowSet: FlowSet): readonly Problem[] {
  const seen = new Map<string, number>();
  for (const id of allIds(flowSet)) seen.set(id, (seen.get(id) ?? 0) + 1);

  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({
      code: 'graph/duplicate-id' as const,
      severity: 'error' as const,
      entity: id,
      path: 'id',
      message: `id "${id}" is used by ${count} entities`,
      hint: 'ids must be unique: Node-RED silently drops or overwrites duplicates',
    }));
}

function checkContainers(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const containers = new Set<string>([
    ...context.flowSet.flows.map((flow) => flow.id),
    ...context.flowSet.subflows.map((subflow) => subflow.id),
  ]);

  for (const node of context.flowSet.loose) {
    problems.push({
      code: 'graph/container-missing',
      severity: 'warn',
      entity: node.id,
      path: 'z',
      message: 'node has no containing flow',
      hint: 'the editor recovers such nodes into a scratch tab; assign it to a flow',
    });
  }

  for (const node of eachNode(context.flowSet)) {
    if (node.z === undefined) continue;
    if (!containers.has(node.z)) {
      problems.push({
        code: 'graph/container-missing',
        severity: 'error',
        entity: node.id,
        path: 'z',
        message: `node belongs to "${node.z}", which is not a flow or subflow in this flow set`,
        hint: 'the node would be dropped as an orphan on import',
      });
    }
  }

  for (const config of eachConfig(context.flowSet)) {
    if (config.z !== undefined && !containers.has(config.z)) {
      problems.push({
        code: 'graph/container-missing',
        severity: 'error',
        entity: config.id,
        path: 'z',
        message: `config node is scoped to "${config.z}", which is not a flow or subflow in this flow set`,
      });
    }
  }

  return problems;
}

function checkWires(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const known = new Set<string>(allIds(context.flowSet));

  for (const node of eachNode(context.flowSet)) {
    node.wires.forEach((wire, port) => {
      wire.forEach((target, index) => {
        if (!known.has(target)) {
          problems.push({
            code: 'graph/wire-target-missing',
            severity: 'error',
            entity: node.id,
            path: `wires[${port}][${index}]`,
            message: `wire points at "${target}", which is not in this flow set`,
            hint: 'remove the wire or restore the node it pointed at',
          });
        }
      });
    });

    const declared = effectiveOutputCount(context.palette[node.type] ?? null, node.props);
    if (declared !== null && node.wires.length !== declared) {
      problems.push({
        code: 'graph/wire-arity',
        severity: 'error',
        entity: node.id,
        path: 'wires',
        message: `node has ${node.wires.length} wire arrays but declares ${declared} outputs`,
        hint: 'the editor always writes exactly one array per output; run normalise()',
      });
    }
  }

  return problems;
}

function checkGroups(flowSet: FlowSet): readonly Problem[] {
  const problems: Problem[] = [];
  const groups = new Map(eachGroup(flowSet).map((group) => [group.id, group]));

  for (const node of eachNode(flowSet)) {
    if (node.g === undefined) continue;
    const group = groups.get(node.g);
    if (group === undefined) {
      problems.push({
        code: 'graph/group-membership',
        severity: 'error',
        entity: node.id,
        path: 'g',
        message: `node is a member of group "${node.g}", which does not exist`,
        hint: 'remove the membership or restore the group',
      });
      continue;
    }
    if (group.z !== node.z) {
      problems.push({
        code: 'graph/group-membership',
        severity: 'error',
        entity: node.id,
        path: 'g',
        message: `node lives in "${node.z ?? '(none)'}" but its group lives in "${group.z}"`,
        hint: 'a group and its members must belong to the same flow',
      });
    }
  }

  for (const group of eachGroup(flowSet)) {
    const hasMembers = eachNode(flowSet).some((node) => node.g === group.id);
    if (!hasMembers) {
      problems.push({
        code: 'graph/group-membership',
        severity: 'info',
        entity: group.id,
        path: 'nodes',
        message: 'group has no members',
        hint: 'an empty group stays in the flow file but is invisible in the editor',
      });
    }
  }

  return problems;
}

/**
 * Cycles in the config-reference graph. The runtime retries a hundred times and then throws
 * `Circular config node dependency`, after the deploy has already been accepted.
 */
function checkConfigCycles(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const edges = new Map<string, string[]>();

  for (const config of eachConfig(context.flowSet)) {
    const type = context.palette[config.type];
    if (type === undefined) continue;
    const targets: string[] = [];
    for (const [name, spec] of Object.entries(type.refs)) {
      if (spec.targets !== '*' && !spec.targets.some((target) => context.palette[target]?.isConfig === true)) continue;
      const value = Object.hasOwn(config.props.known, name) ? config.props.known[name] : config.props.extras[name];
      if (typeof value === 'string') targets.push(value);
      else if (Array.isArray(value)) targets.push(...value.filter((entry): entry is string => typeof entry === 'string'));
    }
    edges.set(config.id, targets);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();

  const visit = (id: string, trail: readonly string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(id)), id];
      const key = [...cycle].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        problems.push({
          code: 'graph/config-cycle',
          severity: 'error',
          entity: id,
          path: 'props',
          message: `circular config node dependency: ${cycle.join(' → ')}`,
          hint: 'the runtime refuses to start such a configuration',
        });
      }
      return;
    }

    state.set(id, 'visiting');
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) visit(next, [...trail, id]);
    }
    state.set(id, 'done');
  };

  for (const id of edges.keys()) visit(id, []);

  return problems;
}

/** A subflow that contains an instance of itself can never be instantiated. */
function checkSubflowRecursion(flowSet: FlowSet): readonly Problem[] {
  const problems: Problem[] = [];
  const edges = new Map<string, string[]>();

  for (const subflow of flowSet.subflows) {
    const nested = subflow.nodes
      .filter((node) => isSubflowType(node.type))
      .map((node) => subflowDefinitionId(node.type) as string);
    edges.set(subflow.id, nested);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: readonly string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      problems.push({
        code: 'graph/subflow-recursion',
        severity: 'error',
        entity: id,
        path: 'nodes',
        message: `subflow "${id}" contains itself: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`,
        hint: 'the editor forbids recursive subflows',
      });
      return;
    }
    state.set(id, 'visiting');
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) visit(next, [...trail, id]);
    }
    state.set(id, 'done');
  };

  for (const id of edges.keys()) visit(id, []);

  return problems;
}

/**
 * Completely isolated nodes — no incoming and no outgoing wires anywhere in the flow set.
 * Reported as info only: a node with a trigger of its own (an `inject`, a `link out`) is
 * perfectly fine unwired, but one with no wires at all is usually a leftover.
 */
function checkIsolatedNodes(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const referenced = new Set<string>();

  for (const node of eachNode(context.flowSet)) {
    for (const wire of node.wires) {
      for (const target of wire) referenced.add(target);
    }
  }
  for (const subflow of context.flowSet.subflows) {
    for (const link of subflow.ports.status) referenced.add(link.node);
    for (const links of subflow.ports.in) for (const link of links) referenced.add(link.node);
    for (const links of subflow.ports.out) for (const link of links) referenced.add(link.node);
  }

  for (const node of eachNode(context.flowSet)) {
    const hasOutgoing = node.wires.some((wire) => wire.length > 0);
    if (hasOutgoing || referenced.has(node.id)) continue;
    const type = context.palette[node.type];
    if (type !== undefined && type.isConfig) continue;
    problems.push({
      code: 'graph/unreachable',
      severity: 'info',
      entity: node.id,
      path: 'wires',
      message: 'node has no wires in either direction',
      hint: 'a trigger-only node (inject, link out, mqtt in) is fine; otherwise this is a leftover',
    });
  }

  return problems;
}

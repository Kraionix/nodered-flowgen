/**
 * Curated project rules: the things no palette can express.
 *
 * "A dashboard needs exactly one `ui_base`", "this flow must contain an error handler" — such
 * facts live in the project, not in the node definitions, so they are declared next to the flow
 * set and compiled into a validator. Rules are declarative on purpose: a rule that needed a
 * callback would be a validator, and a validator needs a name, a place in the pipeline and a
 * test (which is exactly what this file is for).
 *
 * Codes are namespaced `overlay/<rule>` so that a CI allowlist can name one rule precisely.
 */

import type { FlowSet } from '../model/entities.ts';
import { eachConfig, eachNode } from '../model/entities.ts';

import type { Problem, Severity } from './problem.ts';
import type { ValidationContext, Validator } from './report.ts';

export type RuleScope = 'flow-set' | 'flow' | 'subflow';

export interface OverlayRule {
  /** Rule name; the reported code is `overlay/<code>`. */
  readonly code: string;
  readonly severity?: Severity;
  /** Node or config-node type the rule counts (a rule about `ui_base` counts config nodes). */
  readonly type: string;
  /** Where the count applies: the whole flow set (default), each tab, or each subflow. */
  readonly scope?: RuleScope;
  readonly exactly?: number;
  readonly atLeast?: number;
  readonly atMost?: number;
  readonly message: string;
  readonly hint?: string;
}

export function overlayRulesValidator(rules: readonly OverlayRule[]): Validator {
  return {
    name: 'overlay-rules',
    validate: (context) => rules.flatMap((rule) => applyRule(rule, context.flowSet, context.palette)),
  };
}

function applyRule(
  rule: OverlayRule,
  flowSet: FlowSet,
  palette: ValidationContext['palette'],
): readonly Problem[] {
  void palette;
  const problems: Problem[] = [];
  const severity = rule.severity ?? 'error';
  const scope = rule.scope ?? 'flow-set';

  for (const [entity, count] of counts(rule.type, scope, flowSet)) {
    const violation = describeViolation(rule, count);
    if (violation === null) continue;
    problems.push({
      code: `overlay/${rule.code}`,
      severity,
      entity,
      path: 'nodes',
      message: `${rule.message} (found ${count}${violation})`,
      ...(rule.hint === undefined ? {} : { hint: rule.hint }),
    });
  }

  return problems;
}

function describeViolation(rule: OverlayRule, count: number): string | null {
  if (rule.exactly !== undefined && count !== rule.exactly) return `, expected exactly ${rule.exactly}`;
  if (rule.atLeast !== undefined && count < rule.atLeast) return `, expected at least ${rule.atLeast}`;
  if (rule.atMost !== undefined && count > rule.atMost) return `, expected at most ${rule.atMost}`;
  return null;
}

/**
 * Counts entities of a type per scope. Config nodes count too: the rules worth writing are
 * about config nodes (`ui_base`, `mqtt-broker`), which are not nodes in the IR.
 */
function counts(type: string, scope: RuleScope, flowSet: FlowSet): readonly (readonly [string, number])[] {
  if (scope === 'flow-set') {
    const entity = flowSet.flows.length === 1 ? (flowSet.flows[0]?.id ?? 'flow-set') : 'flow-set';
    return [[entity, countIn([...eachNode(flowSet), ...eachConfig(flowSet)], type)]];
  }

  const containers =
    scope === 'flow'
      ? flowSet.flows.map((flow) => ({ id: flow.id, nodes: [...flow.nodes, ...flow.configs] }))
      : flowSet.subflows.map((subflow) => ({ id: subflow.id, nodes: [...subflow.nodes, ...subflow.configs] }));

  return containers.map((container) => [container.id, countIn(container.nodes, type)]);
}

function countIn(nodes: readonly { readonly type: string }[], type: string): number {
  return nodes.filter((node) => node.type === type).length;
}

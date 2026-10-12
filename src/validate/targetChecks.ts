/**
 * Target checks: does the instance this flow set is going to actually have the nodes it uses?
 *
 * `palette/unknown-type` answers a different question — "is this type in the palette the sources
 * were written against?" — and it can only be answered offline, against the committed snapshot.
 * The question that decides whether a deploy *works* is the target's: a node type the instance
 * cannot register deploys fine and then sits there as an "unknown" node waiting for a module
 * nobody installed. Only the instance can answer it, which is why this check needs a live palette
 * and why it could not exist under a capability set that carried no data.
 *
 * Subflow instance types are exempt: they are defined by the flow set itself and never appear in
 * `GET /nodes` (verified during reconnaissance — 75 types on the reference instance, none of them
 * `subflow:*`).
 */

import { eachConfig, eachNode } from '../model/entities.ts';
import { isSubflowType, subflowDefinitionId } from '../palette/model.ts';

import type { Problem } from '../diagnostics/index.ts';
import type { ValidationContext, Validator, ValidatorEnvironment } from './report.ts';

export const targetChecks: Validator = {
  name: 'target',
  requires: ['liveInstance'],
  validate: (context, env) => checkMissingTypes(context, env),
};

/**
 * Node and config types the target cannot provide.
 *
 * One problem per *type*, not per entity: a target without a dashboard module would otherwise
 * report every widget, and a list of twenty identical errors is a list nobody reads. The count is
 * in the message, and the module the offline palette attributes the type to is the actionable part
 * — `npm install node-red-dashboard` on the instance is the fix, and "unknown type" on its own
 * sends the reader looking in the wrong place.
 */
function checkMissingTypes(context: ValidationContext, env: ValidatorEnvironment): readonly Problem[] {
  const instance = env.liveInstance;
  if (instance === undefined) return [];

  const missing = new Map<string, { readonly type: string; readonly kind: 'node' | 'config'; count: number }>();
  const note = (type: string, kind: 'node' | 'config'): void => {
    const key = `${kind}:${type}`;
    const entry = missing.get(key);
    if (entry === undefined) missing.set(key, { type, kind, count: 1 });
    else missing.set(key, { ...entry, count: entry.count + 1 });
  };

  for (const node of eachNode(context.flowSet)) {
    if (isSubflowType(node.type)) {
      // An instance of a definition this flow set does not have is `palette/unknown-type`'s
      // business. A definition it does have is never in `GET /nodes`, on any instance.
      const definitionId = subflowDefinitionId(node.type) as string;
      if (context.flowSet.subflows.some((subflow) => subflow.id === definitionId)) continue;
    }
    if (instance.palette[node.type] === undefined) note(node.type, 'node');
  }

  for (const config of eachConfig(context.flowSet)) {
    if (instance.palette[config.type] === undefined) note(config.type, 'config');
  }

  const types = Object.keys(instance.palette).length;
  return [...missing.values()].map((entry) => {
    const module = context.palette[entry.type]?.module;
    return {
      code: 'deploy/missing-types' as const,
      severity: 'error' as const,
      entity: entry.type,
      path: 'type',
      message:
        `target cannot provide ${entry.kind} type "${entry.type}"` +
        (module === undefined ? '' : ` (from ${module})`) +
        `; used by ${entry.count} entit${entry.count === 1 ? 'y' : 'ies'}, target has ${types} types`,
      hint:
        module === undefined
          ? 'install the module that provides it on the target, or remove the node'
          : `install ${module} on the target, then re-run \`flowgen palette check\``,
    };
  });
}

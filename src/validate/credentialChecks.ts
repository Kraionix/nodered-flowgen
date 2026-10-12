/**
 * Credentials: what a flow set declares, and whether anything can supply it.
 *
 * Node-RED separates credentials from the flow file on purpose — values live in
 * `flows_cred.json` on the instance, keyed by node id — and this tool takes the same position from
 * the other side: `import` never prints credential values, and the emitter writes them only when a
 * provider hands them over (`EmitOptions.credentials`). A placeholder that has nowhere to come
 * from is therefore *dropped*, which is the right default for a repository and the wrong thing to
 * discover after a deploy. Hence this check: it says so, once, for the whole flow set.
 *
 * What it does **not** do is demand a provider for every node type whose palette entry declares
 * credentials (`mqtt-broker` has a user and a password). An instance keeps the credentials it
 * already stored for a node it already has, so a flow set that says nothing about them is a flow
 * set that leaves them alone — reporting that as a problem would train the reader to ignore the
 * level. The check fires when the *flow set itself* carries values, because those are the ones
 * that will not be written.
 *
 * Severity is `warn`: the deploy succeeds, and the values simply do not travel.
 */

import { eachConfig, eachNode, eachSubflow, type FlowSet } from '../model/entities.ts';

import type { Problem } from '../diagnostics/index.ts';
import type { Validator, ValidatorEnvironment } from './report.ts';

export const credentialChecks: Validator = {
  name: 'credentials',
  validate: (context, env) => checkCredentials(context.flowSet, env),
};

function checkCredentials(flowSet: FlowSet, env: ValidatorEnvironment): readonly Problem[] {
  const provided = env.credentials;

  /** Credential names this entity carries, in declaration order. */
  const names = (values: Readonly<Record<string, unknown>> | undefined): readonly string[] =>
    values === undefined ? [] : Object.keys(values);

  const entities: { readonly id: string; readonly names: readonly string[]; readonly path: string }[] = [];
  for (const node of eachNode(flowSet)) {
    const declared = names(node.credentials?.values);
    if (declared.length > 0) entities.push({ id: node.id, names: declared, path: 'credentials' });
  }
  for (const config of eachConfig(flowSet)) {
    const declared = names(config.credentials?.values);
    if (declared.length > 0) entities.push({ id: config.id, names: declared, path: 'credentials' });
  }
  for (const subflow of eachSubflow(flowSet)) {
    const declared = names(subflow.credentials?.values);
    if (declared.length > 0) entities.push({ id: subflow.id, names: declared, path: 'credentials' });
  }
  if (entities.length === 0) return [];

  // One problem per entity: a warning that repeats itself twenty times is a warning that gets
  // filtered out, and the interesting fact is which credentials will not travel. An entity whose
  // credentials the provider supplies is not a problem at all.
  const problems: Problem[] = [];
  for (const entity of entities) {
    const missing = entity.names.filter((name) => provided?.[name] === undefined);
    if (missing.length === 0) continue;
    problems.push({
        code: 'credentials/no-provider' as const,
        severity: 'warn' as const,
        entity: entity.id,
        path: entity.path,
        message:
          missing.length === entity.names.length
            ? `declares credential(s) ${entity.names.join(', ')}, and no provider supplies them; they will not be written`
            : `declares credential(s) ${entity.names.join(', ')}; no provider supplies ${missing.join(', ')}, so those will not be written`,
      hint: provided === undefined
        ? 'set the values on the instance once (Node-RED keeps them there), or supply a provider'
        : 'add the missing names to the provider, or set them on the instance',
    });
  }
  return problems;
}

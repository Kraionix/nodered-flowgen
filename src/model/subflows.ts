/**
 * Bridge between the IR's subflow definitions and the palette's view of them.
 *
 * The palette layer knows nothing about the IR (it is the *data* layer), so the projection lives
 * here: `subflowOverlay` needs the flow-file shape (`in[]`, `out[]`) while the IR models ports as
 * links to internal nodes. One converter, used by the CLI for typing and validation and by the
 * builder for materialising instance defaults.
 */

import type { SubflowDefinitionLike } from '../palette/sources/subflow.ts';

import type { SubflowDef } from './entities.ts';

/** Projects an IR subflow definition into the shape the palette overlay consumes. */
export function subflowDefinitionLike(subflow: SubflowDef): SubflowDefinitionLike {
  return {
    id: subflow.id,
    name: subflow.name,
    ...(subflow.category === undefined ? {} : { category: subflow.category }),
    ...(subflow.color === undefined ? {} : { color: subflow.color }),
    ...(subflow.icon === undefined ? {} : { icon: subflow.icon }),
    env: subflow.env,
    // Only the port *count* matters to the palette; the links belong to the IR.
    in: subflow.ports.in.map(() => ({})),
    out: subflow.ports.out.map(() => ({})),
  };
}

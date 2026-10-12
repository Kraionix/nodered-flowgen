/**
 * Palette defaults, filled in the way the runtime fills them on load.
 *
 * A flow file an editor wrote already carries every declared default — `convertNode` writes each
 * one it knows — but a hand-written or programmatically generated file often does not: an `inject`
 * entry with just `payload` is perfectly valid, and Node-RED fills in `repeat`, `crontab`, `once`
 * and the rest when it loads it. The editor then shows those filled values, and re-exporting the
 * flow writes them.
 *
 * That difference matters for exactly one thing: `import`. The generated source materialises
 * defaults (the builder cannot *not* do it — it is how `node('inject', {topic: 'x'})` produces a
 * complete node), so comparing a rebuilt flow set against an untouched hand-written one would
 * report a difference that is not one: the rebuild produces the document the editor would have
 * exported. Filling the defaults before printing makes the two sides comparable and makes the
 * promise honest — *the generated project deploys what the editor would show you*.
 *
 * Only **literal** defaults are filled. A computed default (`paletteProperty({dynamic: true})`) is
 * the node's own business: `switch.outputs` follows the rule list, and inventing a value for it
 * would turn a valid node into a wrong one.
 */

import type { PaletteType } from '../palette/model.ts';
import type { ConfigNode, FlowSet, Node, NodeProps } from './entities.ts';

export interface MaterializeContext {
  readonly palette: Readonly<Record<string, PaletteType>>;
}

export interface MaterializeResult {
  readonly flowSet: FlowSet;
  /** How many properties were filled in, across every node and config node. */
  readonly filled: number;
  /** Entity ids whose properties changed; useful for a report that names names. */
  readonly entities: readonly string[];
}

export function materialiseDefaults(flowSet: FlowSet, context: MaterializeContext): MaterializeResult {
  const entities: string[] = [];
  let filled = 0;

  const node = (value: Node): Node => {
    const props = fill(value.props, context.palette[value.type] ?? null);
    if (props.added === 0) return value;
    filled += props.added;
    entities.push(value.id);
    return { ...value, props: props.props };
  };

  const config = (value: ConfigNode): ConfigNode => {
    const props = fill(value.props, context.palette[value.type] ?? null);
    if (props.added === 0) return value;
    filled += props.added;
    entities.push(value.id);
    return { ...value, props: props.props };
  };

  return {
    flowSet: {
      ...flowSet,
      subflows: flowSet.subflows.map((subflow) => ({
        ...subflow,
        nodes: subflow.nodes.map(node),
        configs: subflow.configs.map(config),
      })),
      flows: flowSet.flows.map((flow) => ({
        ...flow,
        nodes: flow.nodes.map(node),
        configs: flow.configs.map(config),
      })),
      loose: flowSet.loose.map(node),
      configs: flowSet.configs.map(config),
    },
    filled,
    entities,
  };
}

/** Adds the literal defaults the props are missing; `env` parameters are not properties. */
function fill(props: NodeProps, type: PaletteType | null): { props: NodeProps; added: number } {
  if (type === null) return { props, added: 0 };

  const known: Record<string, unknown> = { ...props.known };
  let added = 0;
  for (const [name, property] of Object.entries(type.defaults)) {
    if (Object.hasOwn(known, name) || Object.hasOwn(props.extras, name)) continue;
    if (property.dynamic || property.value === undefined) continue;
    known[name] = property.value;
    added += 1;
  }

  return added === 0 ? { props, added: 0 } : { props: { known, extras: props.extras }, added };
}

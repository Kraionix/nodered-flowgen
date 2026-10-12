/**
 * Palette-level checks: does the flow agree with the nodes that will run it?
 *
 * These are the checks the server does *not* do. The Admin API accepts a flow file whose wires
 * are short, whose types do not exist and whose references dangle (all verified during
 * reconnaissance), and the failure surfaces much later as a node stuck on "Waiting for missing
 * types to be registered". Every problem here is therefore something a deploy would not catch.
 */

import { effectiveInputCount, effectiveOutputCount } from '../model/normalize.ts';
import { eachConfig, eachNode, type FlowSet, type NodeProps } from '../model/entities.ts';
import { isSubflowType, subflowDefinitionId, type PaletteType, type RefSpec } from '../palette/model.ts';

import type { Problem } from '../diagnostics/index.ts';
import type { ValidationContext, Validator } from './report.ts';

/** Node types that are structural rather than palette-declared. */
const STRUCTURAL_TYPES = new Set(['tab', 'group', 'subflow']);

export const paletteChecks: Validator = {
  name: 'palette',
  validate: (context) => [
    ...checkTypes(context),
    ...checkProperties(context),
    ...checkReferences(context),
    ...checkModuleDrift(context),
  ],
};

function checkTypes(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];

  for (const node of eachNode(context.flowSet)) {
    if (STRUCTURAL_TYPES.has(node.type)) continue;
    if (isSubflowType(node.type)) {
      const definitionId = subflowDefinitionId(node.type) as string;
      if (!context.flowSet.subflows.some((subflow) => subflow.id === definitionId)) {
        problems.push({
          code: 'palette/unknown-type',
          severity: 'error',
          entity: node.id,
          path: 'type',
          message: `node is an instance of subflow "${definitionId}", which this flow set does not define`,
          hint: 'define the subflow, or remove the instance',
        });
      }
      continue;
    }
    if (context.palette[node.type] === undefined) {
      problems.push({
        code: 'palette/unknown-type',
        severity: 'error',
        entity: node.id,
        path: 'type',
        message: `node type "${node.type}" is not in the palette`,
        hint: 'install the module that provides it, refresh the palette, or declare it with untyped() plus an overlay',
      });
    }
  }

  for (const config of eachConfig(context.flowSet)) {
    if (context.palette[config.type] === undefined) {
      problems.push({
        code: 'palette/unknown-type',
        severity: 'error',
        entity: config.id,
        path: 'type',
        message: `config node type "${config.type}" is not in the palette`,
        hint: 'install the module that provides it or refresh the palette',
      });
    }
  }

  return problems;
}

function checkProperties(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];

  for (const node of eachNode(context.flowSet)) {
    const type = context.palette[node.type] ?? null;
    if (type === null) continue;

    for (const [name, property] of Object.entries(type.defaults)) {
      const present = Object.hasOwn(node.props.known, name);
      const authored = present ? node.props.known[name] : node.props.extras[name];
      const value = authored === undefined ? property.value : authored;

      if (property.required && value === undefined && !property.dynamic) {
        problems.push({
          code: 'palette/missing-required',
          severity: 'error',
          entity: node.id,
          path: `props.${name}`,
          message: `required property "${name}" is missing`,
          hint: 'set it in the flow definition',
        });
      }
    }

    // Nothing the palette does not declare: the emitter preserves such keys, but the editor
    // drops them, so they are almost always a typo or a version mismatch.
    if (!type.synthetic) {
      for (const name of Object.keys(node.props.extras)) {
        if (isStructuralExtra(name)) continue;
        problems.push({
          code: 'palette/unknown-property',
          severity: 'warn',
          entity: node.id,
          path: `props.${name}`,
          message: `property "${name}" is not declared by node type "${node.type}"`,
          hint: 'the editor drops undeclared properties on export; declare it in an overlay if it is real',
        });
      }
    }

    problems.push(...checkPropertyTypes(node.id, type, node.props));
  }

  return problems;
}

/** Properties the IR keeps verbatim although the palette does not declare them. */
function isStructuralExtra(name: string): boolean {
  return name === 'name' || name === 'info';
}

function checkPropertyTypes(entity: string, type: PaletteType, props: NodeProps): readonly Problem[] {
  const problems: Problem[] = [];

  for (const [name, property] of Object.entries(type.defaults)) {
    if (property.type !== null || property.dynamic) continue;
    const authored = Object.hasOwn(props.known, name) ? props.known[name] : props.extras[name];
    if (authored === undefined) continue;

    const expected = expectedKind(property.value);
    if (expected === null) continue;
    if (kindOf(authored) !== expected) {
      problems.push({
        code: 'palette/type-mismatch',
        severity: 'error',
        entity,
        path: `props.${name}`,
        message: `property "${name}" should be ${expected}, got ${kindOf(authored)}`,
        hint: `the node declares "${name}" with a ${expected} default`,
      });
    }
  }

  return problems;
}

type ValueKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

function expectedKind(value: unknown): ValueKind | null {
  if (value === undefined || value === null) return null;
  const kind = kindOf(value);
  // An empty array is the palette's way of saying "a list of something"; the element type is
  // not declared anywhere, so only the container is checked.
  return kind;
}

function kindOf(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function checkReferences(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const typesById = new Map<string, string>();
  for (const node of eachNode(context.flowSet)) typesById.set(node.id, node.type);
  for (const config of eachConfig(context.flowSet)) typesById.set(config.id, config.type);

  for (const node of eachNode(context.flowSet)) {
    const type = context.palette[node.type] ?? null;
    if (type === null) continue;

    for (const [name, spec] of Object.entries(type.refs)) {
      const authored = Object.hasOwn(node.props.known, name) ? node.props.known[name] : node.props.extras[name];
      if (authored === undefined || authored === null) continue;
      const ids = toIdList(authored);

      for (const id of ids) {
        const targetType = typesById.get(id);
        if (targetType === undefined) {
          problems.push({
            code: 'palette/ref-missing',
            severity: 'error',
            entity: node.id,
            path: `props.${name}`,
            message: `reference "${name}" points at "${id}", which is not in this flow set`,
            hint: 'wire the reference to a node you define, or remove it',
          });
          continue;
        }
        if (!accepts(spec, targetType)) {
          problems.push({
            code: 'palette/ref-wrong-type',
            severity: 'error',
            entity: node.id,
            path: `props.${name}`,
            message: `reference "${name}" points at a "${targetType}", but ${describeTargets(spec)} is expected`,
            hint: 'point the reference at the right kind of node',
          });
        }
      }
    }
  }

  return problems;
}

/**
 * A reference property as a list of target ids.
 *
 * An empty string is *unset*, not dangling: the editor writes `"broker": ""` for every optional
 * config reference the author has not selected, and such flows are everywhere. Reporting them as
 * `palette/ref-missing` would make the validator cry wolf on ordinary exports.
 */
function toIdList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return [];
}

function accepts(spec: RefSpec, typeId: string): boolean {
  return spec.targets === '*' || spec.targets.includes(typeId);
}

function describeTargets(spec: RefSpec): string {
  return spec.targets === '*' ? 'any node type' : spec.targets.map((target) => `"${target}"`).join(' or ');
}

/**
 * Module drift: the flow asks for a version the target does not have.
 *
 * The manifest is Node-RED's own mechanism (`global-config.modules`), so the check is simply
 * "does the palette I validate against provide the module and version the flow declares".
 */
function checkModuleDrift(context: ValidationContext): readonly Problem[] {
  const problems: Problem[] = [];
  const available = new Map<string, string>();
  for (const type of Object.values(context.palette)) {
    if (!available.has(type.module)) available.set(type.module, type.version);
  }

  for (const [module, version] of Object.entries(context.flowSet.modules)) {
    const installed = available.get(module);
    if (installed === undefined) {
      problems.push({
        code: 'palette/module-version-drift',
        severity: 'error',
        entity: module,
        path: 'modules',
        message: `the flow needs module "${module}@${version}", which the target does not provide`,
        hint: 'install the module on the target, or refresh the palette from it',
      });
    } else if (installed !== version) {
      problems.push({
        code: 'palette/module-version-drift',
        severity: 'warn',
        entity: module,
        path: 'modules',
        message: `the flow declares ${module}@${version} but the target has ${installed}`,
        hint: 'refresh the palette snapshot and re-generate the flow manifest',
      });
    }
  }

  return problems;
}

/** Exposed for tests and for the plan diff: the ports a node is expected to have. */
export function declaredPorts(
  type: PaletteType | null,
  props: NodeProps,
): { readonly inputs: number | null; readonly outputs: number | null } {
  return { inputs: effectiveInputCount(type, props), outputs: effectiveOutputCount(type, props) };
}

/** Convenience for callers that only need the flow set. */
export function validatePalette(context: ValidationContext): readonly Problem[] {
  return paletteChecks.validate(context);
}

export type { FlowSet };

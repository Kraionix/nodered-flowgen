import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRefSpec,
  getPaletteType,
  isConfigCategory,
  isSubflowType,
  outputCount,
  paletteProperty,
  paletteType,
  propertyNames,
  refAccepts,
  requiredPropertyNames,
  subflowDefinitionId,
  subflowTypeId,
} from '../../src/palette/model.ts';

test('deriveRefSpec follows the palette encoding', () => {
  // Table verified against the core and dashboard palettes; every observed value is here.
  const cases: readonly (readonly [string, 'one' | 'many', readonly string[] | '*'])[] = [
    ['mqtt-broker', 'one', ['mqtt-broker']],
    ['tls-config', 'one', ['tls-config']],
    ['http proxy', 'one', ['http proxy']],
    ['websocket-listener', 'one', ['websocket-listener']],
    ['swagger-doc', 'one', ['swagger-doc']],
    ['ui_group', 'one', ['ui_group']],
    ['link out[]', 'many', ['link out']],
    ['link in[]', 'many', ['link in']],
    ['*[]', 'many', '*'],
    ['*', 'one', '*'],
    ['[]', 'many', '*'],
  ];

  for (const [declared, kind, targets] of cases) {
    const spec = deriveRefSpec(declared);
    assert.equal(spec.kind, kind, `${declared} arity`);
    assert.deepEqual(spec.targets, targets, `${declared} targets`);
  }
});

test('refAccepts honours explicit target lists and the wildcard', () => {
  assert.equal(refAccepts(deriveRefSpec('mqtt-broker'), 'mqtt-broker'), true);
  assert.equal(refAccepts(deriveRefSpec('mqtt-broker'), 'tls-config'), false);
  assert.equal(refAccepts(deriveRefSpec('*[]'), 'anything at all'), true);
});

test('subflow type ids round-trip', () => {
  assert.equal(isSubflowType('subflow:abc123'), true);
  assert.equal(isSubflowType('function'), false);
  assert.equal(subflowTypeId('abc123'), 'subflow:abc123');
  assert.equal(subflowDefinitionId('subflow:abc123'), 'abc123');
  assert.equal(subflowDefinitionId('function'), null);
});

test('config nodes are recognised by category and report no ports', () => {
  const config = paletteType('mqtt-broker', { category: 'config' });
  assert.equal(config.isConfig, true);
  assert.equal(isConfigCategory(config.category), true);
  assert.equal(outputCount(config), 0);
  assert.equal(isConfigCategory('function'), false);
});

test('property and required-property lists keep declaration order', () => {
  const type = paletteType('switch', {
    outputs: 1,
    defaults: {
      name: paletteProperty({ value: '' }),
      property: paletteProperty({ value: 'payload', required: true }),
      rules: paletteProperty({ value: [] }),
    },
    category: 'function',
  });

  assert.deepEqual(propertyNames(type), ['name', 'property', 'rules']);
  assert.deepEqual(requiredPropertyNames(type), ['property']);
});

test('getPaletteType does not answer for inherited object keys', () => {
  const types = { inject: paletteType('inject') };
  assert.equal(getPaletteType(types, 'inject')?.id, 'inject');
  assert.equal(getPaletteType(types, 'constructor'), null);
  assert.equal(getPaletteType(types, 'toString'), null);
});

/**
 * Compile-time fixture: every line here must type-check.
 *
 * The palette augmentations in `palettes/local.d/` are generated from the pinned Node-RED
 * installation and **committed**, because the repository's own `tsc --noEmit` needs them; this
 * file asserts that the generated surface is usable — references, optionality of defaults, and the
 * deliberate escape hatches. `types.spec.ts` regenerates them into a scratch directory and fails
 * if they have drifted, so `npm run types:regen` is the only way this directory may change.
 */

import type { EnvValue, NodeRef, PropsFor, Ref } from '@kraionix/nodered-flowgen';

/** Defaults with declared values are optional: the builder materialises them. */
export const inject: PropsFor<'inject'> = { name: 'Start', topic: 'orders' };
export const injectWithExtras: PropsFor<'inject'> = { once: true, onceDelay: 0.5 };

/** Config references accept a typed handle or a raw id. */
export const mqttIn: PropsFor<'mqtt in'> = {
  name: 'MQTT in',
  broker: { id: 'broker_1', type: 'mqtt-broker' },
  qos: '2',
};
export const mqttInByString: PropsFor<'mqtt in'> = { broker: 'broker_1' };

/** Required-and-defaultless properties are demanded: `group` is a dashboard config node. */
export const gauge: PropsFor<'ui_gauge'> = {
  name: 'Gauge',
  group: { id: 'group_1', type: 'ui_group' },
  min: 0,
  max: 100,
};

/** Reference handles are assignable both ways. */
export const groupRef: Ref<'ui_group'> = { id: 'group_1', type: 'ui_group' };
export const groupRefById: Ref<'ui_group'> = 'group_1';
export const handle: NodeRef<'ui_gauge'> = { id: 'gauge_1', type: 'ui_gauge' };

/** Envelope fields are always available. */
export const positioned: PropsFor<'inject'> = { x: 100, y: 200, disabled: true, key: 'start' };

/** An unknown type falls back to an open bag: that is what `untyped()` is for. */
export const inhouse: PropsFor<'inhouse-plc'> = { register: 'D100', count: 4 };

/** Subflow parameters are typed from the definition's `env` entries. */
export const envValue: EnvValue = 'value';

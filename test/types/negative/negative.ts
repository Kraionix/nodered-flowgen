/**
 * Compile-time fixture: every line below must fail, with the diagnostic the spec asserts.
 *
 * This is the half of E3 that makes the typing real. A generator whose output "compiles" but
 * accepts typos would be worse than no types at all.
 */

import type { EnvValue, KnownType, PropsFor, Ref } from '@kraionix/nodered-flowgen';

// A property the node does not declare.
export const unknownProperty: PropsFor<'inject'> = { minX: 1 };

// A property with the wrong value type.
export const wrongValueType: PropsFor<'inject'> = { once: 'yes' };

// A config reference pointing at the wrong node type.
export const wrongRefType: Ref<'ui_group'> = { id: 'tab_1', type: 'ui_tab' };

// A required, defaultless reference that was not supplied.
export const missingRequiredRef: PropsFor<'ui_gauge'> = { name: 'Gauge' };

// A node type the palette does not know: `KnownType` is a closed union, so this is the
// diagnostic that `node('ui_gaug', …)` reports.
export const unknownTypeName: KnownType = 'ui_gaug';

// An environment value that cannot be stored in a flow file.
export const wrongEnvValue: EnvValue = { nested: true };

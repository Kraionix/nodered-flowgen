/**
 * The dashboard helper — a concrete answer to "how do node families scale?".
 *
 * It is a plain function of the builder: `f.use(dashboard())` returns typed wrappers. There is
 * no registry, no lifecycle, no plugin manifest — a node family is a file.
 *
 * ```ts
 * const dash = f.use(dashboard());
 * const tab = dash.tab('main', { label: 'Main' });
 * const group = dash.group('kpi', tab, { name: 'KPIs', width: 6 });
 * dash.gauge(group, { min: 0, max: 100 });
 * ```
 *
 * Two shapes are provided:
 *
 * * **named widgets** — `dash.gauge(group, props)` — generated from one table, so adding a widget
 *   type is adding a string to an array while the types stay exact (`WidgetType<'gauge'>` is
 *   `'ui_gauge'`);
 * * **the generic form** — `dash.widget(type, group, props)` — for anything the table does not
 *   cover, including widgets added by a plugin build.
 *
 * The `group` property is not repeated by the author: creating a node inside a group fills in a
 * declared `group` reference automatically (see the builder), which is the same information
 * expressed once.
 */

import type { KnownType, PropsFor, Ref } from '../../typing.ts';

import type { ContainerHandle, NodeHandle } from '../builder.ts';

/** Widget names, derived from the `ui_` types Node-RED Dashboard registers. */
export const WIDGETS = [
  'audio',
  'button',
  'chart',
  'colour_picker',
  'date_picker',
  'dropdown',
  'form',
  'gauge',
  'link',
  'numeric',
  'slider',
  'switch',
  'template',
  'text',
  'text_input',
] as const;

export type WidgetName = (typeof WIDGETS)[number];
export type WidgetType<W extends WidgetName> = W extends string ? `ui_${W}` : never;

/**
 * Props the author supplies: everything except the facts the helper already knows — the
 * authoring key, the parent tab and the group reference.
 */
export type TabProps = Omit<PropsFor<'ui_tab'>, 'key'>;
export type GroupProps = Omit<PropsFor<'ui_group'>, 'key' | 'tab'>;
export type WidgetPropsFor<T extends string> = Omit<PropsFor<T>, 'key' | 'group'>;
export type WidgetProps<W extends WidgetName> = WidgetPropsFor<WidgetType<W>>;

export interface DashboardOptions {
  readonly baseName?: string;
  readonly basePath?: string;
  readonly theme?: string;
}

export interface DashboardBase {
  /** The `ui_base` config node every dashboard tree hangs off. */
  readonly base: NodeHandle<'ui_base'>;
  /** Creates a `ui_tab` (a dashboard page). `key` is the authoring key, not a node property. */
  tab(key: string, props?: TabProps): NodeHandle<'ui_tab'>;
  /**
   * Creates a `ui_group` (a dashboard panel) inside a tab. Note that this is a *config node*,
   * not a canvas group: widgets reference it through their `group` property.
   */
  group(key: string, tab: Ref<'ui_tab'>, props?: GroupProps): NodeHandle<'ui_group'>;
  /** Generic widget factory, for types the table does not know. */
  widget<T extends string>(type: T, group: Ref<'ui_group'>, props?: WidgetPropsFor<T>): NodeHandle<T>;
}

export type Dashboard = DashboardBase & {
  readonly [W in WidgetName]: (group: Ref<'ui_group'>, props?: WidgetProps<W>) => NodeHandle<WidgetType<W>>;
};

export function dashboard(options: DashboardOptions = {}): (builder: ContainerHandle<string>) => Dashboard {
  return (builder) => {
    const base = builder.config('ui_base' as KnownType, {
      // A stable authoring key: the id must not change when the display name does.
      key: 'base',
      name: options.baseName ?? 'Dashboard',
      ...(options.basePath === undefined ? {} : { path: options.basePath }),
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    } as PropsFor<'ui_base'>) as unknown as NodeHandle<'ui_base'>;

    // The cast is confined to this one line: the palette's property bags are open interfaces,
    // and the helper adds the one property (`group`) the author does not repeat.
    const create = <T extends string>(type: T, group: Ref<'ui_group'>, props?: WidgetPropsFor<T>): NodeHandle<T> =>
      builder.node(type as KnownType, { ...(props ?? {}), group } as unknown as PropsFor<'ui_tab'>) as unknown as NodeHandle<T>;

    const api: Record<string, unknown> = {
      base,
      tab: (key: string, props?: TabProps): NodeHandle<'ui_tab'> =>
        builder.node('ui_tab' as KnownType, { key, ...(props ?? {}) } as PropsFor<'ui_tab'>) as unknown as NodeHandle<'ui_tab'>,
      group: (key: string, tab: Ref<'ui_tab'>, props?: GroupProps): NodeHandle<'ui_group'> =>
        builder.node('ui_group' as KnownType, { key, tab, ...(props ?? {}) } as PropsFor<'ui_group'>) as unknown as NodeHandle<'ui_group'>,
      widget: create,
    };

    // The runtime keys mirror the mapped type by construction: both are driven by WIDGETS.
    for (const widget of WIDGETS) {
      api[widget] = (group: Ref<'ui_group'>, props?: WidgetPropsFor<string>) =>
        create(`ui_${widget}`, group, props);
    }

    return api as unknown as Dashboard;
  };
}

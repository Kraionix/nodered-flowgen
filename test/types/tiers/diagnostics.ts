/**
 * Tier 3 of 4 — **diagnostics**, compiled from a consumer's position.
 *
 * This is what a project does when it wants to *check* rather than deploy: mount its own rules on
 * top of the built-in ones, run them against a flow set with whatever environment it can supply,
 * and render the result. The point of the tier is that a validator is a value — `{ name, requires,
 * validate }` — so a project can write one in its own repository without forking anything.
 *
 * The fixture deliberately supplies *no* environment for the built-in checks that need one: the
 * report then has to name them as skipped, which is the behaviour the tier exists to make visible.
 */

import {
  countBySeverity,
  credentialChecks,
  defaultValidators,
  defineConfig,
  defineFlowSet,
  exitCodeFor,
  formatProblems,
  formatSkipped,
  graphChecks,
  hasErrors,
  overlayRulesValidator,
  paletteChecks,
  runValidators,
  targetChecks,
  type FormatOptions,
  type LiveInstance,
  type LiveInstanceClient,
  type NrlintPort,
  type Problem,
  type RuntimeProbePort,
  type SkippedValidator,
  type ValidationContext,
  type ValidationReport,
  type Validator,
  type ValidatorEnvironment,
  type ValidatorSetOptions,
} from '@kraionix/nodered-flowgen';

const definition = defineFlowSet((f) => {
  const tab = f.flow('main', { label: 'Main' });
  const start = tab.node('inject', { key: 'start', name: 'start' });
  const sink = tab.node('debug', { key: 'sink', name: 'sink' });
  tab.chain(start, sink);
});

const built = definition.build({ palette: {} });

// --- a project rule --------------------------------------------------------------------------

/**
 * A validator is a value with a declared dependency: `requires: ['liveInstance']` makes `plan`
 * skip it, by name, when no target was reached — "nothing was checked" must never look like
 * "everything passed".
 */
const noDebugLeftBehind: Validator = {
  name: 'project/no-debug',
  requires: ['liveInstance'],
  validate: (context: ValidationContext, env: ValidatorEnvironment): readonly Problem[] => {
    const installed = Object.keys(env.liveInstance?.palette ?? {});
    return context.flowSet.flows.flatMap((flow) =>
      flow.nodes
        .filter((node) => node.type === 'debug' && !installed.includes('debug'))
        .map((node) => ({
          code: 'overlay/no-debug' as const,
          severity: 'warn' as const,
          entity: node.id,
          path: 'type',
          message: 'a debug node in a flow set this target cannot run',
          hint: 'remove it, or install the core nodes',
        })),
    );
  },
};

/** An async rule, because the ports are: a probe sends a request and a linter runs a process. */
const probesAnswer: Validator = {
  name: 'project/probe',
  requires: ['runtimeProbe'],
  validate: async (context, env): Promise<readonly Problem[]> => env.runtimeProbe?.probe(context.flowSet) ?? [],
};

// --- the environment -------------------------------------------------------------------------

const settings: LiveInstanceClient = {
  settings: async (): Promise<Record<string, unknown>> => ({ version: '5.0.8' }),
};

const live: LiveInstance = {
  client: settings,
  palette: {},
  version: '5.0.8',
};

const lint: NrlintPort = {
  lint: async (): Promise<readonly Problem[]> => [],
};

const probe: RuntimeProbePort = {
  probe: async (): Promise<readonly Problem[]> => [],
};

const environment: ValidatorEnvironment = {
  liveInstance: live,
  nrlint: lint,
  runtimeProbe: probe,
  credentials: { SECRET: 'from-somewhere' },
};

// --- running them ----------------------------------------------------------------------------

const rules: ValidatorSetOptions = {
  rules: [{ code: 'no-base', type: 'ui_base', exactly: 1, severity: 'warn', message: 'one dashboard base per flow set' }],
  extra: [noDebugLeftBehind, probesAnswer],
};

const validators: readonly Validator[] = [
  paletteChecks,
  graphChecks,
  targetChecks,
  credentialChecks,
  overlayRulesValidator(rules.rules ?? []),
  ...defaultValidators(rules),
];

const context: ValidationContext = { flowSet: built.flowSet, palette: {}, targetVersion: '5.0.8' };

export const report: ValidationReport = await runValidators(validators, context, {
  mode: 'collect',
  environment,
  priorProblems: built.problems,
});

export const collected: readonly Problem[] = report.problems;
export const skipped: readonly SkippedValidator[] = report.skipped;
export const ran: readonly string[] = report.ran;
export const failed: boolean = report.hasErrors;
export const errored: boolean = hasErrors(collected);
export const counts: Readonly<Record<'error' | 'warn' | 'info', number>> = countBySeverity(collected);
export const exitCode: 0 | 1 = exitCodeFor(collected);

const formatOptions: FormatOptions = { includeInfo: true, includeHints: true };
export const text: string = formatProblems(collected, formatOptions);
export const skippedText: string = formatSkipped(skipped);

// ...and the same set mounted on the project, which is where a user actually puts it.
export const config = defineConfig({ flowSet: definition, validators: [noDebugLeftBehind], layout: false });

# @kraionix/nodered-flowgen

Declarative, type-checked Node-RED flow generation. You write TypeScript; the tool writes the flow
file.

* **The palette is the schema.** Node types, their properties, their required-ness and their
  references are read from a running instance (or an installation on disk), committed as a
  snapshot, and projected into TypeScript augmentations — so `node('ui_gaug', …)` fails to compile
  with `Did you mean 'ui_gauge'?`, and `repeat: 5` fails where `repeat: '5'` is expected.
* **The emitter is canonical.** Output is what the editor's own serializer would write: same key
  order, same array order, `wires` exactly as long as the node's port count. A deploy that reads
  the flow back gets the same bytes, which is what makes reviews and diffs meaningful.
* **Deploys are rev-checked and reversible.** `POST /flows` replaces the whole flow set, so
  ownership is enforced client-side: containers you do not own are copied through untouched, the
  write is a compare-and-swap on the instance revision, and every `apply` writes a receipt that
  `rollback` can put back.

Node ≥ 22.18.0, ESM, **zero runtime dependencies**. The published package is compiled JavaScript
with declarations: `tsc` → `dist`, and only `dist` is in the tarball. (Node refuses to strip types
for any file under a `node_modules` path, so a package that shipped its `.ts` sources could be
imported by nobody — see `test/integration/packaging.spec.ts`, which installs the tarball into a
consumer on every test run.)

Inside this repository the sources are the entry point: `node src/cli/bin.ts` runs without a
build, and the `paths` mapping in `tsconfig.json` keeps `@kraionix/nodered-flowgen` resolving to
`src/index.ts` so the generated palette augmentations attach to the sources. The two worlds meet
only at `npm run build`, which `npm test` runs first and `npm pack` runs through `prepack`.

## Quick start

```sh
npm install @kraionix/nodered-flowgen
npx flowgen init --url http://127.0.0.1:1880     # flowgen.config.ts + .gitignore entries
npx flowgen palette pull                          # instance → palettes/local.json
npx flowgen types gen                             # snapshot → palettes/local.d/*.d.ts
npx flowgen validate                              # no instance needed from here on
npx flowgen plan                                  # review before touching anything
npx flowgen apply
```

Two runnable examples, both of them executed by `test/integration/acceptance.spec.ts` against a
disposable instance:

* [`examples/acceptance/`](examples/acceptance/README.md) — the milestone-1 flow set: a subflow with
  typed parameters and an instance override, a shared config node, a three-output switch, a group, a
  dashboard page, and a runtime probe that only answers if the override arrived;
* [`examples/dashboard/`](examples/dashboard/README.md) — the shape a real project has: two
  dashboard pages with an explicit `order`, a `ui_template` whose body must survive byte for byte,
  `ui_base` theme and site, an endpoint next to it, and **two targets**, one of which can never be
  reached.

### Coming from an instance somebody else built

```sh
npx flowgen import --url http://127.0.0.1:1880 --out src/flowset.ts   # sources, ids included
npx flowgen plan --adopt orders                                      # take ownership of a tab
npx flowgen diff --from @last --to @target:local                     # what changed since
```

`import` writes the sources and records the ids the instance used, so a rebuild reproduces the
deployed flow set instead of renaming everything. It claims no ownership: that is `--adopt`, which
takes over a container that already exists without redeploying it.

## The config is code

```ts
import { dashboardIn, defineConfig, defineFlowSet, P } from '@kraionix/nodered-flowgen';

export default defineConfig({
  flowSet: defineFlowSet((f) => {
    const scale = f.subflow(
      'scale',
      { name: 'scale × factor', params: { factor: P.num(2) }, ports: { in: ['value'], out: ['scaled'] } },
      (s) => {
        const work = s.node('function', { key: 'work', func: 'msg.payload *= env.get("factor");\nreturn msg;', outputs: 1 });
        s.in(work);
        s.out(work, 0);
      },
    );

    const tab = f.flow('orders', { label: 'Orders API' });
    const httpIn = tab.node('http in', { url: '/orders', method: 'get' });
    const reply = tab.node('http response', {});
    tab.chain(httpIn, tab.instance(scale, { env: { factor: 3 } }), reply);

    const dash = dashboardIn(tab, { baseName: 'Ops' });
    dash.gauge(dash.group('panel', dash.tab('page', { name: 'KPIs' }), { name: 'KPIs' }), { name: 'load', min: 0, max: 100 });
  }),

  palette: { default: 'local', profiles: { local: { url: 'http://127.0.0.1:1880', tokenEnv: 'FLOWGEN_TOKEN' } } },
  targets: { local: { url: 'http://127.0.0.1:1880', tokenEnv: 'FLOWGEN_TOKEN' } },
});
```

Ids are never hand-written. An authoring **key** (`key: 'work'`, `'orders'`) is mapped to an
emitted id through the lockfile, so renaming a key keeps the deployed id; a key that is genuinely
new is reported in the plan, and `--prune` is what removes the container it replaced.

`flowgen.config.ts` may also declare `lockfile`, `receipts`, `validators` (appended to the
built-in ones) and `layout`. Validators are ordinary functions: `{ name, requires?, validate }`.

## Commands

| Command | What it does |
|---|---|
| `flowgen init` | scaffolds `flowgen.config.ts`, ignore entries, optionally the first snapshot |
| `flowgen palette pull` | instance (or installation) → `palettes/<profile>.json`; `unchanged` when nothing moved |
| `flowgen palette check` | compares the pinned snapshot with the instance; exits `1` on drift, with reasons per type |
| `flowgen types gen` | snapshot → `<profile>.d/*.d.ts` + cheat sheet; `--check` verifies the committed files are current |
| `flowgen import` | a flow file or a live instance → the TypeScript that could have produced it, with the ids it used |
| `flowgen diff` | two flow sets compared semantically: `--from`/`--to`, each a file, `@target:<name>`, `@receipt:<file>` or `@last` |
| `flowgen validate` | palette + graph + project rules over the built flow set; never touches an instance |
| `flowgen plan` | what `apply` would change, and which containers it would leave alone |
| `flowgen apply` | validate → plan → compare-and-swap write → receipt → lockfile |
| `flowgen rollback` | restores the flow set a receipt recorded (`--receipt <file>` or `--last`) |

Useful flags: `--target <name>`, `--url`, `--token`, `--token-env <VAR>`, `--profile`, `--palette
<file>`, `--prune` / `--no-prune`, `--dry-run`, `--expect-rev <rev>`, `--diff-geometry`,
`--no-palette-check`, `--adopt <id>` (repeatable), `--all-targets`, `--geometry`, `--check`,
`--json`, `--quiet`, `--cwd`, `--config`. `flowgen --version` prints the package version;
`--version` after a command does the same without running the command.

`flowgen diff` is a report: it exits `0` whether or not there are differences, and `--check` turns
it into a gate (`1`). Geometry is ignored unless `--geometry` is passed, because the editor
recomputes `x`/`y`/`w`/`h` and a report full of moved nodes hides the one changed `func`. A removal
names the entities that are still pointing at it, so "one node went away" and "three surviving
nodes now point at nothing" are different lines.

`--all-targets` (on `plan` and `apply`) runs every configured target in name order, reports each
one, and exits with the **highest** code of the run — a failure is never hidden behind a success,
and nothing aborts early: a deploy that stopped at the first unreachable instance would leave every
later one stale. A target marked `readOnly` is skipped instead of failing the fan-out.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | the check said no: validation problems, or `diff --check` found a difference — the target was never touched |
| `2` | usage or configuration error |
| `3` | deploy conflict: the revision moved and re-planning did not settle it |
| `4` | the target is unreachable or refuses the token |
| `5` | internal error — a bug in this tool, not in your project |

`--json` prints `{command, exitCode, outcome, diagnostics[], …}` on **stdout even when the command
fails**, so a pipeline can parse the outcome without caring about the exit code. The payload of a
command is spread into the same object (`plan` puts its operations there, `diff` its entities,
`apply` its receipt), which is what makes one parser enough for every command.

`Problem.code` is stable and namespaced, because CI is expected to allowlist by code and a rename
would silently turn an error into a warning. Allowlist by code, never by message:

| Namespace | Codes | Who can fix it |
|---|---|---|
| `palette/*` | `unknown-type`, `unknown-property`, `missing-required`, `type-mismatch`, `ref-missing`, `ref-wrong-type`, `module-version-drift`, `generated-stale` | the palette: install the module, pull again, or declare the type in an overlay |
| `graph/*` | `wire-target-missing`, `wire-arity`, `container-missing`, `group-membership`, `config-cycle`, `duplicate-id`, `subflow-recursion`, `unreachable` | the sources: a wire or a reference points at something that is not there |
| `layout/*`, `normalize/*` | `layout/cycle`, `normalize/wire-arity` | nobody — the build repaired or annotated what it was given |
| `overlay/*`, and any code you choose | `overlay/<your-rule>` | your project's own rules (`validators` in the config) |
| `plan/*` | `unowned-target` (the id exists on the target and is not ours: `--adopt` it, rename it, or `--reassign`), `id-collision` (a config node or loose node with that id), `adopt-unused` (warn: `--adopt` named something the target does not have) | the invocation or the lockfile |
| `deploy/*` | `missing-types` (the target cannot register a type the flow set uses), `version-mismatch`, `unreachable`, `receipt-failed` | the target: install the module, re-plan, fix the token |
| `credentials/*` | `no-provider` (warn: the flow set carries credential values and nothing supplies them) | the deploy environment |

## Ownership, pruning and safety

A `POST /flows` replaces the whole flow set, so ownership is enforced here: a container the
lockfile does not list is copied through byte for byte and the plan prints `leave` for it. A config
node or a containerless node we created is kept when it stops being declared — deleting it takes
`--prune` *and* nothing outside our containers referencing it, and the plan says which
(`keep-config … still referenced by a1 (props.broker)`). Declaring a container whose id already
exists on the target and is not ours is refused (`plan/unowned-target`) — and refusing is the whole
point: the payload would otherwise be the instance's version of your tab, and the deploy would
report success while never writing yours. Three answers, in order of preference:

* **`--adopt <id>`** — that container is mine now. The plan treats it as ours from then on, so a
  source that already matches the instance is a deploy with no changes at all, and the lockfile
  records the ownership even then. It is the other half of `flowgen import`, and it is idempotent.
* **rename it** in the sources, so it gets a different id and theirs stays where it is.
* **`--reassign`** — deploy your version under a fresh id (`orders` → `orders_2`), leaving theirs
  untouched. A second tab rather than a takeover; sometimes that is what you want.

Adoption takes the container's *contents* with it: the config nodes scoped inside an adopted tab
become ours in the same step, because they came from the same import.

The server cannot help with ownership: `POST /flows` replaces the entire flow set regardless of the
deployment type (verified against 5.0.7 and 5.0.8). So:

* **Ownership is a client-side record.** `.flowgen.lock.json` is committed and lists, per target,
  the containers this tool created. A container that is not in it is never merged into, never
  rewritten and never deleted — the plan says `leave-alien` and the payload carries it through
  byte-for-byte.
* **Deletion is explicit.** A container of yours that disappeared from the sources is kept unless
  `--prune` is passed (or the target sets `prune: true`). `--no-prune` always wins.
* **Writes are compare-and-swap.** The revision read during planning is sent back with the payload;
  a concurrent deploy makes the server answer `409 version_mismatch`, and `apply` re-reads,
  re-plans and retries a bounded number of times rather than clobbering someone else's work.
  `--expect-rev <rev>` turns "on top of exactly that revision" into a precondition and exits `3`
  when it does not hold.
* **Every apply is reversible.** The receipt holds the previous flow set and revision; `rollback`
  writes it back. Receipts are runtime artifacts under `.flowgen/receipts/` and are never committed.
* **Read-scope tokens are enough to review.** `plan`, `validate`, `palette check`, `palette pull`
  and `diff` never write; only `apply` and `rollback` need write permission.
* **Ownership is per target, and so is everything else.** The lockfile keeps a separate owned
  list for every target name, so `--all-targets` plans each instance against its own record: the
  same tab can be ours on `local` and still somebody else's on `staging` until you `--adopt` it
  there too.

## The palette lifecycle

```
flowgen.config.ts
palettes/local.json                    # snapshot: node sets + types + content hash
palettes/local.d/<module>@<version>.d.ts  # generated augmentations + index
palettes/local.md                      # human/agent-readable cheat sheet
```

* **Both are committed.** A fresh clone type-checks and validates without a reachable Node-RED.
  Generation is deterministic and `types gen` is idempotent — `types gen --check` fails CI when the
  generated files are stale.
* **Drift is a first-class check.** `palette check` compares the instance's `GET /nodes` (both the
  JSON node list and the editor bundles) with the snapshot and exits `1` with per-type reasons. The
  plan also warns when the target's palette differs from the pinned one, because deploying against
  a stale palette is how "works on my machine" happens.
* **Profiles** let one project target several instances (`palette.profiles.<name>`), each with its
  own snapshot, generated types, URL and token environment variable.
* **Overlays are the escape hatch for what an installation cannot show.** The extractor sees what
  the editor sees at registration time, which is not everything: a typed-input value list lives in
  `oneditprepare`, and a node registered by a script is not extracted at all. `overlay({types: {…}})`
  patches or defines such a type in memory, and `withType` / `applyOverlays` / `rebuildPalette` are
  the same thing as functions — so the curated knowledge never enters the generated snapshot and
  `palette pull` cannot lose it. This is a library API (the palette tier of the public surface);
  the CLI has no overlay *file* yet, so a project that needs one writes a short script.

## The public surface

One entry point, four tiers. What you import says which question you are answering:

| Tier | The question | Names |
|---|---|---|
| **authoring** | "How do I declare my flows and my project?" | `defineConfig`, `defineFlowSet`, the builder's handles and options, `P`, `dashboard`/`dashboardIn`, `layoutFlowSet`, `defineSubflowLibrary`/`subflows` |
| **palette** | "What does my Node-RED know, and how do I describe the rest?" | the palette model (`PaletteType`, `paletteProperty`, `propertyNames`, `referenceProperties`), the snapshot (`parsePaletteSnapshot`, `serializePaletteSnapshot`, `hashPaletteContent`, `diffPalette`, `describePalette`), and curated knowledge (`overlay`, `withType`, `applyPatch`, `applyOverlays`, `rebuildPalette`) |
| **diagnostics** | "Is what I built acceptable?" | `Problem` and its codes, the `Validator` contract, `defaultValidators` and the built-in checks, `runValidators` with a `ValidatorEnvironment`, `formatProblems` |
| **testing** | "How do I assert on the result without an instance?" | the IR (`FlowSet`, `eachNode`, `findNode`, `allIds`), canonical emission (`emitFlowSet`), `parseFlowFile`/`parseFlowSetText`, `normalizeFlowSet`, `materialiseDefaults`, `printFlowSet` |

The rule for the boundary is one sentence: **a name is public when its shape is a decision we can
defend to a user; it is internal when its shape is dictated by how the CLI works today.** The
extractors that read Node-RED's registration HTML, the layout of the generated type files, the id
counter behind the lockfile, the `Builder` class itself, config resolution and the whole deploy path
(`plan`/`apply`/`rollback`, the lockfile, the receipts) are therefore in `src/internal.ts` — which
ships, because the CLI is inside the same package, and is **not** reachable:

```ts
import { planMerge } from '@kraionix/nodered-flowgen/internal';
// ERR_PACKAGE_PATH_NOT_EXPORTED — `exports` names only `.` and `./toolkit`
```

A programmatic deploy is deliberately not part of this contract. `flowgen plan --json` and
`flowgen apply --json` are the machine-readable faces of it, and they are what a pipeline should
call: ownership, compare-and-swap on `rev` and receipts are the product, and they are cheaper to
keep compatible behind a documented CLI contract than behind a TypeScript signature.

The tiers are enforced, not documented: `test/types/tiers/` holds one fixture per tier that imports
*only* the entry point, `test/integration/packaging.spec.ts` compiles all four against the packed
and installed tarball, and `test/types/negative/negative.ts` fails if an internal name becomes
reachable. `test/unit/layers.test.ts` keeps the two barrels disjoint.

## Development (`.ts`) versus installed (`dist`)

The repository and a consumer run the same code through different doors, and the difference is
worth knowing before debugging a build:

|  | In this repository | Installed |
|---|---|---|
| Entry point | `src/index.ts` (TypeScript) | `dist/index.js` (compiled, `tsc -p tsconfig.build.json`) |
| How Node runs it | type stripping, built into Node ≥ 22.18 | ordinary ESM |
| `@kraionix/nodered-flowgen` resolves to | `src/index.ts`, through `paths` in `tsconfig.json` | `dist/`, through `exports` in `package.json` |
| Relative imports | `./foo.ts` | rewritten to `./foo.js` at build time |
| Generated palette files | attach to `src/typing.ts`, through the same `paths` mapping | attach to `dist/index.d.ts` |
| Build | `npm test` builds first; `npm run typecheck` does not | `prepack` builds, so `npm publish`/`npm pack` cannot ship a stale `dist` |

Two consequences that have bitten this repository already:

* **A package cannot ship its `.ts` sources.** Node refuses to strip types for any file under a
  `node_modules` path (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `files` lists `dist` and
  nothing else. 180 tests stayed green while the published package was unimportable because every
  test imported `../../src/…`; `test/integration/packaging.spec.ts` exists to see what a consumer
  sees.
* **`paths` is why the augmentations work in-repo.** A generated `palettes/<profile>.d/*.d.ts` does
  `declare module '@kraionix/nodered-flowgen'`; if that name resolved to `dist/`, the sources would
  type-check against an empty palette. If you add an entry point, add it to `paths` too.

## What is deliberately not here

* **No dependency-injection container.** Extensions are plain values and a ~120-line `Toolkit`
  (`@kraionix/nodered-flowgen/toolkit`) offers LIFO disposal, declared dependencies and honest
  `skipped` reporting. That is the whole extension story.
* **No MCP server.** The CLI with `--json` is the machine interface; an MCP wrapper would be a thin
  adapter over the same commands and can be added without touching this package.
* **No browser-based oracle.** Canonical emission is verified statically (the rules were read out
  of the installed editor) and by a runtime round-trip: deploy, read back, re-parse, re-emit, and
  require a fixed point. A headless-editor oracle buys little over that and costs a lot of CI.
* **No JSON config, no hand-written flow JSON.** The config is TypeScript because that is where the
  type checking happens.
* **No programmatic `plan`/`apply` in the public API.** `flowgen plan --json` and
  `flowgen apply --json` are the machine-readable faces of the deploy path: ownership,
  compare-and-swap on `rev` and receipts are the product, and they are cheaper to keep compatible
  behind a documented CLI contract than behind a TypeScript signature. The rest — the palette, the
  validators, the emitter, the importer, the printer — is public in four documented tiers.

## Layout

```
src/result     the Ok/Err result type;  src/typing  the surface generated types attach to
src/diagnostics the Problem contract every layer reports in
src/palette    palette model, snapshot, extractors, sources, codegen
src/model      IR, ids, normalisation (the editor's own fix-ups, applied to data)
src/emit       the canonical emitter;  src/import  the inverse
src/validate   palette / graph / project rules, and the report
src/authoring  builder, defineFlowSet, layout, dashboard helper
src/io         admin API client, lockfile, plan/merge, apply, receipts
src/config     flowgen.config.ts: profiles, targets, layout
src/toolkit    the composition helper (reversible registration, gated activation)
src/cli        the flowgen binary
src/internal   the private barrel: everything above that a consumer must not reach
```

Dependencies point inward only, in that order: `result`, `typing`, `diagnostics` and `toolkit`
depend on nothing, `palette` only on `result`, `model` on `palette` and `diagnostics`,
`emit`/`import`/`validate` on those, `authoring`/`io` above them, then `config`, then `cli`.
`test/unit/layers.test.ts` reads every relative import under `src/` and fails when one points
outward, because an import is the only thing that can create a cycle.

## Tests

```sh
npm test                                       # builds, then unit + integration
npm run typecheck                              # tsc --noEmit, strict + exactOptionalPropertyTypes
npm run test:unit                              # ~0.9 s, no Node-RED, no build needed
npm run test:integration                       # builds, then starts disposable Node-RED instances
```

* `test/fixtures/palettes/` — the raw `GET /nodes` pair from Node-RED 5.0.7 and 5.0.8, re-assembled
  offline by the same code a live pull runs; regenerate with `test/fixtures/palettes/capture.ts`.
* `test/fixtures/negative/` — the seven measured defects of the prior art, each asserted to be
  caught (see that directory's README).
* `test/fixtures/flows-*.json` — flow files a *user* would have: an editor export, a hand-written
  file with no defaults, and one with facets this build cannot represent. `flowgen import` has to
  round-trip the first two byte for byte (`test/integration/import-roundtrip.spec.ts`).
* `test/integration/acceptance.spec.ts` — **both examples**, run through the CLI the way a user
  would: the milestone-1 acceptance flow (including a runtime probe that only passes if a subflow
  parameter override reached the instance) and the dashboard project (two pages, a template body,
  a probe, and a `--all-targets` fan-out with one unreachable target).
* `test/types/tiers/` — one compile fixture per public tier, written the way a consumer writes:
  a single import root. `test/types/negative/negative.ts` is the other half (typos must not
  compile, and neither must an internal name).
* `test/integration/packaging.spec.ts` — packs the tarball, installs it into a throwaway
  `node_modules`, runs the bin, imports the entry point, proves `/internal` is not exported, and
  type-checks a consumer file plus all four tier fixtures. It is the only test that can see a
  package a consumer cannot install.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

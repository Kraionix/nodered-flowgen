# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

The first complete slice: author a flow set in TypeScript, type-check it against a real palette,
validate it without an instance, and deploy it with ownership, compare-and-swap and rollback.

### Added

* **Palette** — a snapshot model with canonical serialisation and a content hash; an extractor that
  evaluates `RED.nodes.registerType` literals out of the editor bundles (in `node:vm`, with a
  fluid stub, because real definitions call helpers); five sources (live instance over the admin
  API, an installation on disk, a committed snapshot, inline subflows, curated overlays) that agree
  on the same content hash for the same Node-RED.
* **Type codegen** — per-module module augmentations plus an index and a Markdown cheat sheet.
  Unknown node types fail to compile with a suggestion; unregistered-but-real types are still
  accepted through a documented escape hatch.
* **IR and emitter** — a flow-set model with deterministic ids, normalisation that applies the
  editor's own fix-ups *and reports them*, a canonical emitter (key order and array order taken
  from the installed editor), and a lossless importer.
* **Validation** — palette, graph and project-rule validators with namespaced, stable codes; a
  `collect`/`bail` runner that reports validators it could not run instead of quietly checking less.
* **Authoring** — a builder that never asks for an id, `defineFlowSet`, a deterministic layout pass,
  typed subflow parameters and a dashboard helper.
* **Deploy** — an admin API client with compare-and-swap on the revision, a lockfile that records
  ownership and id stability, plan/merge that copies unowned containers through untouched, apply
  with receipts, and rollback.
* **CLI** — `init`, `palette pull|check`, `types gen`, `validate`, `plan`, `apply`, `rollback`;
  documented exit codes `0`–`5`; `--json` output built from the same value the human rendering
  formats.
* **Tests** — the round-trip oracle (deploy → read back byte-identical → re-parse → re-emit to a
  fixed point), a runtime probe through a real Node-RED, pinned palette fixtures for 5.0.7 and
  5.0.8, and the seven prior-art defects as negative fixtures.
* **`flowgen import`** — read a flow file (`--from`) or a live instance and print the TypeScript
  that could have produced it, with the authoring keys and the ids it used. The printer is held to
  the round-trip rule mechanically: `emit(build(print(ir), { lockfile: ids }))` has to equal
  `emit(ir)` byte for byte, and the acceptance fixtures pass it (an editor export, a hand-written
  file, the project's own example).
* **Subflow libraries** — `defineSubflowLibrary`, `subflows` and `f.subflowFrom(library)` define a
  reusable subflow without a builder attached, for a second module or a shared package. Each
  declaration goes through the ordinary `subflow()` path, so ids, lockfile keys and the palette
  overlay are unchanged.
* **A validator environment instead of a capability set.** `ValidatorEnvironment` carries the
  *ports* (`liveInstance`, `nrlint`, `runtimeProbe`, `credentials`) and `requires` names the keys a
  validator must have, so the skip list is a derivation rather than a second declaration that can
  disagree with reality. Two checks landed on it: `deploy/missing-types` (a node type the target
  cannot register — one problem per type, not per widget) and `credentials/no-provider` (a warning,
  and only when the flow set actually carries credential values).
* **`materialiseDefaults`** — fills palette defaults that are declared literals, which is what makes
  a rebuild comparable with a hand-written flow file that never contained them. A computed default
  (`switch.outputs`) is never invented.
* **`flowgen diff`** — two flow sets compared semantically: `--from`/`--to`, each a file,
  `@target:<name>`, `@receipt:<file>` or `@last`. Both sides go through the same pipeline (parse,
  normalise, fill declared defaults) and the same emitter, so reordered keys, omitted defaults and
  a missing `wires` array are not differences; geometry is ignored unless `--geometry` is passed.
  A removal names the surviving entities still pointing at it, from the same reference walk the
  validator and the layout use. `0` as a report, `1` with `--check`.
* **Adoption (`--adopt <id>`)** — take ownership of a container that already exists on the target.
  It is the other half of `import`: without it an id collision could only be answered with
  `--reassign` (a second copy) or by editing the lockfile by hand. Adoption plans the container like
  one of ours, so sources that already match the instance are a deploy with no changes, and the
  ownership is recorded even then. `plan/unowned-target` carries the hint; `plan/adopt-unused`
  warns when the named container is not there; adopting what is already ours is silent.
* **`--all-targets`** on `plan` and `apply`: every configured target in name order, each with its
  own outcome, receipt and lockfile update. The exit code is the highest of the run, so a failure is
  never hidden behind a success, and nothing aborts early. A target marked `readOnly` is skipped
  rather than failing the fan-out.
* **A second example**, `examples/dashboard/`: two dashboard pages with an explicit `order`, a
  `ui_template` whose multi-line body has to survive byte for byte, `ui_base` theme and site, an
  endpoint the acceptance run probes, and two targets — one of them deliberately unresolvable, so
  the fan-out is exercised by CI rather than by hand. `ui_base.site` and a `key` on a dashboard
  widget are new (`WidgetPropsFor` no longer hides it); without a key a widget is named after its
  type.
* **A tiered public surface.** One entry point, four tiers — authoring, palette, diagnostics,
  testing — documented in the README and enforced from a consumer's position: one compile fixture
  per tier under `test/types/tiers/`, compiled again against the packed tarball by
  `test/integration/packaging.spec.ts`. What the CLI needs and a consumer must not reach
  (`Builder`, the HTML extractors, the generated-file layout, the id counter, config resolution, the
  whole deploy path) moved to `src/internal.ts`, which is not in `exports`: importing
  `@kraionix/nodered-flowgen/internal` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and a negative
  type fixture asserts it. `test/unit/layers.test.ts` keeps the two barrels disjoint.

### Changed

* **The plan is now a product of the merge.** `planDeployment` and `mergeFlowSets` were two
  implementations of one decision, and they disagreed: the plan diffed `desired` while the payload
  was merged from `current`, so it described writes that were not going to happen and stayed silent
  about ones that were. One `planMerge` returns the `payload` *and* the operations, derived by
  diffing the payload against the instance — "every operation is a real difference, and every
  difference is reported" is asserted over a matrix of twelve situations in `io-plan.test.ts`.
  Container operations no longer carry a `'(entity)'` placeholder or the never-produced
  `update-entities`: they name the properties that changed. An update that changes nothing is no
  longer emitted at all.
* **Owning a config node is now a decision with a reason (D20).** Config nodes are collected from
  every scope — top level, tab-scoped, subflow-scoped — and one rule applies: ours and declared is
  written; ours and undeclared is kept unless `--prune` is given *and* nothing outside our
  containers references it, in which case it is deleted, and either way the plan says which
  (`keep-config` with `still referenced by a1 (props.broker)`, or `delete-config`). A config
  scoped to one of our tabs survives that tab being rewritten instead of dying with it (P1-5).
  Containerless nodes follow the same rule, and a config node we do not declare is copied through
  rather than dropped.
* **An id that belongs to somebody else is refused (D21).** Declaring a container with an id that
  already exists on the target and is not ours used to overwrite it silently; it is now
  `plan/id-collision`, an error, with `--reassign` on `plan`/`apply` to deploy under a fresh id
  (`orders` → `orders_2`) instead. The reassigned id is what the lockfile records, and the alien
  container it collided with is left exactly where it was.

* **One definition of "what points at what".** `src/model/references.ts` holds
  `referenceTargets`/`outgoingTargets`/`inboundReferences`, so the validator, the layout and (next)
  the diff cannot disagree about what an edge is. The layout only sees `link` edges when it is given
  a palette — `layoutFlowSet(flowSet, { palette })` — which `defineFlowSet` now passes; geometry
  stays advisory either way.
* **The diagnostics contract moved to `src/diagnostics/`.** It used to live in `validate/`, and
  `model/normalize.ts` imported `Problem` from there while every file in `validate/` imported
  `model/entities.ts` — a directory cycle that made the README's "dependencies point inward only"
  false. `Problem`, `Severity`, `ProblemCode`, `problem()`, `hasErrors()`, `countBySeverity()` and
  `exitCodeFor()` are unchanged and still exported from the package root; only the import path
  inside the repository moved. `test/unit/layers.test.ts` now reads every relative import under
  `src/` and fails when one points at a higher layer, so the story cannot drift again.
* **The builder was split, and wiring stopped being quadratic.** `Builder` kept one array and did a
  `findIndex` over every node per wire, copying the whole `wires` array on each connection. `NodeTable`
  now owns the array (still the authority for emission order) plus an `id → index` map, and
  `IdRegistry` owns key → id, lockfile precedence and the `key#2` spelling `flowgen import` has to
  predict. Measured on one flow set of 20 000 nodes / 40 000 wires: **528 ms** now, **4 693 ms**
  before, against a 2 000 ms budget in `test/unit/builder-perf.test.ts`.
* **`global-config` is a facet, not a config node.** The entry carries the manifest (`env` hints and
  the module list) and an id that an editor export may have chosen, so `FlowSet.manifest = { id, env }`
  with one writer (`emitGlobalConfig`) replaced a `ConfigNode` that lost its `env` and could be
  emitted twice.
* **`--all-targets` renamed the exit-code meaning of `1` in words, not in number.** The code was
  already "validation problems"; it is now also what `diff --check` returns, so the description
  reads "the check said no (validation problems, or --check found a difference)". One code for "a
  check failed" beats a sixth code that CI would have to learn.
* **Adoption is per target, and so is ownership.** The lockfile keeps a separate owned list per
  target name, which `--all-targets` makes visible: the same tab can be yours on `local` and still
  somebody else's on `staging` until you `--adopt` it there too.
* **`PaletteParameter.ui` is optional.** The snapshot format omits it when the editor declared none,
  so requiring it made a hand-written overlay's parameter list uncompilable.

### Fixed

* **A config node's references are validated.** The reference check walked nodes only, and in
  node-red-dashboard 3.x every interesting reference *is* a config node: `ui_base`, `ui_tab`,
  `ui_group` and `ui_link` are all `isConfig: true`. `ui_group.tab → ui_tab` is exactly the
  reference that dangles when somebody deletes a dashboard page, and it was the one reference
  nothing checked.
* **A `link out` / `link in` pair counts as connected.** `link out` declares `outputs: 0` and keeps
  its edge in a `links` reference, so `graph/unreachable` reported both halves of every link pair as
  isolated — and the layout, which also only counted wires, put link-connected flows in a single
  column. `src/model/references.ts` is now the one definition of "what points at what"
  (`referenceTargets`, `outgoingTargets`, `inboundReferences`), used by the reference check, the
  connectivity check and the layout. A reference to a config node counts as a connection too, so a
  dashboard widget hanging off a group is no longer reported as a leftover; the acceptance example
  now validates with zero diagnostics of any severity.
* **Only the containers we write are recorded as ours.** Recording every container in the payload
  claimed the ones that are merely copied through, so a later `apply --prune` would have deleted
  somebody else's tab. The acceptance run caught it.
* **`flowgen --version` works.** It exited `2`, "unknown command": there was no version option at
  all. The version is now read from the manifest next to the module (`src/cli/` and `dist/cli/` are
  both two levels below the package root), and `--version` is a global option, so
  `flowgen validate --version` prints the version without running the validator. The packaging test
  asserts it against the *installed* tarball, which is where the relative path has to hold.
* **How output is rendered is decided by the parsed options, not by scanning `argv`.** A raw
  `argv.includes('--json')` cannot tell a flag from a value: `flowgen validate --config --json`
  printed its failure as JSON on stdout, and `flowgen validate -- --json` did too, because the token
  after the terminator is a positional. Parsing now happens in one place, before the command runs,
  so a command that throws is still rendered the way it was asked for; the argv scan survives only
  for invocations that never parsed (an unknown command), where it also honours `--no-<flag>` and
  stops at `--`.
* **`validate` counts every node.** The summary counted `flows[].nodes` only, so subflow bodies and
  containerless nodes were invisible in a line whose whole job is to say how much was checked.
* **A subflow instance is built with one wire array per declared output.** `#createInstance` wrote
  `wires: []`, and normalisation cannot repair it: a subflow defined inline is not in `GET /nodes`,
  and `defineFlowSet` normalises against the base palette before the subflow overlay exists. An
  instance with nothing wired to it was therefore emitted as `"wires": []` and then failed
  `flowgen validate` with `graph/wire-arity` — the build producing a flow set that its own
  validation rejects.
* **The CLI no longer exits 0 in silence when it is run through a symlink.** The entry point lived
  at the bottom of `src/cli/index.ts` behind `import.meta.url === pathToFileURL(process.argv[1]).href`.
  `argv[1]` keeps the path the interpreter was given while `import.meta.url` is the resolved real
  path, and `node_modules/.bin/flowgen` **is a symlink** — npm, npx and pnpm all run a bin through
  one. So on every real installation the guard was false and `flowgen` printed nothing and exited
  `0`. Invoking the CLI is now `src/cli/bin.ts`, a file whose only job is to call `main()`, and
  `index.ts` has no import side effects: there is no condition left to get wrong.
* **The package can be installed again.** The tarball shipped `.ts` sources and pointed `exports`
  and `bin` at them, on the premise that consumers run the package through Node's type stripping.
  Node refuses exactly that, by design: "Node.js refuses to handle TypeScript files inside folders
  under a `node_modules` path". Every consumer hit
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — while 180 tests stayed green, because they all
  import `../../src/…` directly. `tsc` now emits `dist` (JS + declarations), `exports`/`bin`
  point at it, `files` ships `dist` and the documents, `engines` says `>=22.18.0` (the version
  where type stripping became the default), and `exports["./testing"]` is gone: it pointed at
  `test/integration/harness.ts`, which was never in the tarball and would drag `node-red` into a
  consumer's runtime. `test/integration/packaging.spec.ts` packs, installs, runs and type-checks
  the tarball on every test run, so this cannot come back silently.
* **The library compiles without a consumer's generated palette.** `KnownType` is `keyof
  KnownTypes`, which is `never` until some palette has been generated, and `PropsFor<never>`
  distributed to `never` — so building `src/` alone failed with four errors in the dashboard
  helper. `PropsFor` now guards the empty case with a tuple-wrapped `[T] extends [never]`, and the
  dashboard helper creates its node family through the palette-agnostic `untyped()` /
  `untypedConfig()` path instead of routing through `KnownType`.
* **Layout no longer hangs on a flow with a feedback loop.** Depth was computed with a worklist
  that re-enqueued a node every time a longer path to it was found, so one loop reachable from a
  root — `inject → f1 → f2 → f1` — made the depth grow without bound and the queue never drain.
  `validate`, `plan` and `apply` returned nothing at all: no output, no exit code, because the work
  is synchronous and blocks the event loop. Depth is now the longest path over the *condensation*
  of the wire graph (Tarjan's strongly connected components, iterative), which is acyclic by
  construction, and a loop is reported once as `layout/cycle` (info) naming its nodes.
* **Layout covers subflow bodies and containerless nodes.** `layoutFlowSet` mapped `flowSet.flows`
  only, so a subflow's interior kept `0,0` and every node piled up at the origin; the acceptance
  example's `work` node was one of them.
* The type-fixture harness dropped every indented continuation line of a TypeScript diagnostic, so
  the half of the message that names the property to add was never asserted. It is parsed now.
* **Subflow credentials survived an import.** `parseSubflow` dropped the definition's
  `credentials` bag, so importing a subflow that declares one lost it on the way back out.
* **The printer recorded the ids it used, wrote every config's `key`, kept group membership and kept
  chains in order.** Found while building the round-trip oracle, which is the only reason it exists:
  node ids were never recorded (so a re-import renamed everything), a config without an explicit
  `key` drifted, group membership was lost unless members were created through `group.node(...)`,
  and a chain that needed a name for one member reordered wires or referred to an undeclared one.
  Unused `const`s broke `noUnusedLocals` in the compile gate, so a container or config nothing reads
  is now a statement rather than a declaration.
* **`validate --live` resolved its target through `resolveTarget`.** It hand-built one, so
  `--token-env` and a profile's `tokenEnv` were ignored and a live check against an instance with
  `adminAuth` silently degraded to a skip — which the new `deploy/missing-types` made visible.
* **`flowgen import --from` resolves against the project directory**, not `process.cwd()`.
* **A plan with errors is refused instead of silently deployed.** `plan` computed
  `plan/id-collision` and then reported it nowhere, so a container the sources defined but the
  instance already held printed "no changes" and exited `0` — and `apply` wrote a payload the
  sources had not asked for, minus the tab the user cared about. The plan's problems are now the
  command's diagnostics, `applyDeployment` refuses to write at all when the plan has errors (before
  the dry-run exit, so a review sees it too), and the report says `plan refused: 1 error(s) must be
  fixed before apply`. Two tests in `test/integration/deploy.spec.ts` were passing *because* of the
  silent behaviour: they deployed twice with no record of owning the config nodes the first run
  created, which is exactly the collision the check exists to catch.
* **`--all-targets` no longer loses the first target's ownership.** The lockfile was read once at
  startup and written per target, so the second target's write dropped the first one's containers.
* **`plan/id-collision` split in two**: `plan/unowned-target` for a *container* — the situation
  `--adopt` answers, and the hint says so — and `plan/id-collision` for a config node or a loose
  node whose id is already taken, which only a rename in the sources can fix.

### Notes

* Node ≥ 22.18.0. The published package is compiled to `dist/` (`npm run build`, run by `npm pack`
  through `prepack`); inside the repository the `.ts` sources stay the entry point, and `paths` in
  `tsconfig.json` keeps the package name resolving to `src/` so the generated palette
  augmentations attach to the sources.
* The public surface is four tiers of one entry point (`src/index.ts`), plus the pre-existing
  `@kraionix/nodered-flowgen/toolkit` subpath for the composition helper. `src/internal.ts` is
  shipped because the CLI imports it; it is not in `exports` and is not part of the contract.
* A programmatic `plan`/`apply` is deliberately not public: `flowgen plan --json` and
  `flowgen apply --json` are the machine-readable faces of the deploy path.
* `flowgen diff` is one of the two commands that never write (the other is `validate`); it needs
  no more than a read token, and `@last` reads the newest receipt in `.flowgen/receipts/`.
* Overlays (`overlay`, `withType`, `applyOverlays`, `rebuildPalette`) are a library API: the CLI has
  no overlay *file* yet, so a project that needs curated knowledge the installation cannot show
  writes a short script. The palette tier of the public surface is where they live.
* `nrlint` is not wired into the validation gate: its library API runs no rules without a resolved
  plugin set (verified — a syntactically broken function body lints clean), so a smoke test would
  have asserted nothing.

[0.1.0]: https://github.com/kraionix/nodered-flowgen/releases/tag/v0.1.0

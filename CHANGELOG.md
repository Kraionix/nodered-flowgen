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

### Fixed

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

### Notes

* Node ≥ 22.18.0. The published package is compiled to `dist/` (`npm run build`, run by `npm pack`
  through `prepack`); inside the repository the `.ts` sources stay the entry point, and `paths` in
  `tsconfig.json` keeps the package name resolving to `src/` so the generated palette
  augmentations attach to the sources.
* `nrlint` is not wired into the validation gate: its library API runs no rules without a resolved
  plugin set (verified — a syntactically broken function body lints clean), so a smoke test would
  have asserted nothing.

[0.1.0]: https://github.com/kraionix/nodered-flowgen/releases/tag/v0.1.0

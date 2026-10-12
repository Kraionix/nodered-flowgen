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

### Notes

* No build step and no runtime dependencies: the package is ESM TypeScript run through Node's type
  stripping, so Node ≥ 22.9 is required.
* `nrlint` is not wired into the validation gate: its library API runs no rules without a resolved
  plugin set (verified — a syntactically broken function body lints clean), so a smoke test would
  have asserted nothing.

[0.1.0]: https://github.com/kraionix/nodered-flowgen/releases/tag/v0.1.0

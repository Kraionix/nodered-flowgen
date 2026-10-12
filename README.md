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

The acceptance example — a subflow with parameter overrides, a shared config node, a group and a
dashboard page — is in [`examples/acceptance/`](examples/acceptance/README.md), and the same
project is what `test/integration/acceptance.spec.ts` deploys.

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
| `flowgen validate` | palette + graph + project rules over the built flow set; never touches an instance |
| `flowgen plan` | what `apply` would change, and which containers it would leave alone |
| `flowgen apply` | validate → plan → compare-and-swap write → receipt → lockfile |
| `flowgen rollback` | restores the flow set a receipt recorded (`--receipt <file>` or `--last`) |

Useful flags: `--target <name>`, `--url`, `--token`, `--token-env <VAR>`, `--profile`, `--palette
<file>`, `--prune` / `--no-prune`, `--dry-run`, `--expect-rev <rev>`, `--diff-geometry`,
`--no-palette-check`, `--json`, `--quiet`, `--cwd`, `--config`. `flowgen --version` prints the
package version; `--version` after a command does the same without running the command.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | validation problems — the sources are wrong, the target was never touched |
| `2` | usage or configuration error |
| `3` | deploy conflict: the revision moved and re-planning did not settle it |
| `4` | the target is unreachable or refuses the token |
| `5` | internal error — a bug in this tool, not in your project |

`--json` prints `{command, exitCode, outcome, diagnostics[], …}` on **stdout even when the command
fails**, so a pipeline can parse the outcome without caring about the exit code. `Problem.code` is
stable and namespaced (`palette/*`, `graph/*`, `layout/*`, `normalize/*`, `overlay/*`, `plan/*`
— including `plan/id-collision` — and `deploy/*`) — allowlist by code, never by message.

## Ownership, pruning and safety

A `POST /flows` replaces the whole flow set, so ownership is enforced here: a container the
lockfile does not list is copied through byte for byte and the plan prints `leave` for it. A config
node or a containerless node we created is kept when it stops being declared — deleting it takes
`--prune` *and* nothing outside our containers referencing it, and the plan says which
(`keep-config … still referenced by a1 (props.broker)`). Declaring a container whose id already
exists on the target and is not ours is refused (`plan/id-collision`); `--reassign` deploys it
under a fresh id instead, leaving theirs untouched.

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
* **Read-scope tokens are enough to review.** `plan`, `validate`, `palette check` and
  `palette pull` never write; only `apply` and `rollback` need write permission.

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
npm run test:unit                              # ~0.7 s, no Node-RED, no build needed
npm run test:integration                       # builds, then starts disposable Node-RED instances
```

* `test/fixtures/palettes/` — the raw `GET /nodes` pair from Node-RED 5.0.7 and 5.0.8, re-assembled
  offline by the same code a live pull runs; regenerate with `test/fixtures/palettes/capture.ts`.
* `test/fixtures/negative/` — the seven measured defects of the prior art, each asserted to be
  caught (see that directory's README).
* `test/integration/acceptance.spec.ts` — the milestone-1 acceptance run through the CLI, including
  a runtime probe that only passes if a subflow parameter override reached the instance.
* `test/integration/packaging.spec.ts` — packs the tarball, installs it into a throwaway
  `node_modules`, runs the bin, imports the entry point and type-checks a consumer file. It is the
  only test that can see a package a consumer cannot install.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

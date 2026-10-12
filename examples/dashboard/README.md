# Dashboard example

A second runnable project, and the one that looks most like a real one: the dashboard *is* the
product, there is an endpoint next to it, and there is more than one place to deploy to.

`test/integration/acceptance.spec.ts` runs this project the way a user would, against a disposable
Node-RED with `node-red-dashboard` installed, so everything documented here is executed in CI.

## What it proves

| Feature | Where it shows up |
|---|---|
| two dashboard **pages** with an explicit `order` | `Ops → Overview`, `Ops → Detail` |
| a **`ui_template`** with a multi-line HTML body | the `report` widget; the test asserts the body arrived byte for byte |
| `ui_base` **theme** and **site** | `ui_base` config node (`dark`, `Ops console`) |
| a **named** widget whose id survives a rename | `key: 'history'` on the chart |
| an endpoint that can be **probed** | `GET /flowgen/report` → the rendered rows |
| **two targets**, one of them unreachable | `plan --all-targets` plans `local`, reports `staging`, exits `4` |

## Running it

```sh
export FLOWGEN_TARGET_URL=http://127.0.0.1:1880      # or leave it; this is the default
export FLOWGEN_TARGET_TOKEN=…                        # only when adminAuth is enabled

flowgen palette pull            # instance → palettes/local.json
flowgen types gen               # snapshot → palettes/local.d/*.d.ts + palettes/local.md
flowgen validate                # offline: palette + graph + project rules
flowgen plan                    # what apply would change on the default target
flowgen plan --all-targets      # …and on every configured target, reported one by one
flowgen apply                   # validate → merge → compare-and-swap write → receipt
curl 'http://127.0.0.1:1880/flowgen/report'          # the rendered rows
flowgen diff --from @last --to @target:local         # what that deploy replaced
flowgen rollback --last         # put the instance back the way the receipt found it
```

`staging` points at `http://staging.example.invalid:1880` on purpose: `.invalid` never resolves
(RFC 2606), so `plan --all-targets` always has one target it cannot reach. That is the case the
fan-out has to survive — it reports the unreachable target, plans the reachable ones, and exits
with the worst code rather than stopping at the first failure.

`palettes/`, `.flowgen/` and `.flowgen.lock.json` are produced by those commands and ignored by git
here; in a real project the snapshot, the generated types and the lockfile are committed, and only
the receipts are ignored. See the repository README.

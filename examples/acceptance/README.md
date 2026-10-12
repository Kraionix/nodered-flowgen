# Acceptance example

The milestone-1 acceptance flow from the spec (`recon/V1-SPEC-flowgen.md` §3) as a runnable
project. It is also the fixture `test/integration/acceptance.spec.ts` drives, so what is
documented here is what CI runs — with one difference: CI points it at a disposable instance
through the environment.

## What the flow set proves

| Feature | Where it shows up |
|---|---|
| subflow with typed parameters, ports and an **instance override** | `scale` + `scale x3` (`factor: 3`) |
| a probe that only passes if the override reached the instance | `GET /flowgen/scale?x=7` → `21` |
| shared **config node** referenced from a tab | `mqtt-broker` → `mqtt out.broker` |
| a node whose own `outputs` disagrees with the palette | `switch` with three outputs |
| a **group** and a **dashboard** page | `classifier`, `Ops → KPIs` |

## Running it

```sh
export FLOWGEN_TARGET_URL=http://127.0.0.1:1880      # or leave it; this is the default
export FLOWGEN_TARGET_TOKEN=…                        # only when adminAuth is enabled

flowgen palette pull     # instance → palettes/local.json (committed in a real project)
flowgen types gen        # snapshot → palettes/local.d/*.d.ts + palettes/local.md
flowgen validate         # offline: palette + graph + project rules, no instance needed
flowgen plan             # what apply would change, and what it would leave alone
flowgen apply            # validate → merge → compare-and-swap write → receipt
curl 'http://127.0.0.1:1880/flowgen/scale?x=7'       # 21
flowgen palette check    # has the instance drifted from the snapshot?
flowgen rollback --last  # put the instance back the way the receipt found it
```

`palettes/`, `.flowgen/` and `.flowgen.lock.json` are produced by those commands and ignored by
git here — in a real project the snapshot, the generated types and the lockfile are **committed**,
and only the receipts and the cache are ignored. See the repository README for the rationale.

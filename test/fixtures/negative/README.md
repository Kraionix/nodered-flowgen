# Negative fixtures

Each file here is a flow file that a competing generator produced (or would have produced), taken
from the measured defect table in `recon/PRIOR-ART-2026-10.md` §2. They are *inputs*, not
expected outputs: `test/unit/negative-fixtures.test.ts` runs each one through the real pipeline
(import → normalise → validate → emit) and asserts the invariant that makes the defect
impossible.

"Caught" means one of two things, and each test says which:

* an **error** diagnostic — the pipeline refuses to treat the flow set as valid;
* a **reported fix** plus a complete document — the editor would repair this silently; we repair
  it and report it as an info-level problem, because a silent repair hides an authoring bug.

| Fixture | Defect it reproduces | What happens here |
|---|---|---|
| `function-partial-wires.json` | `wires` as long as the author used the ports, not as long as the node declares them | padded to `outputs` arrays, reported as `normalize/wire-arity` |
| `change-without-wires.json` | `wires` key absent when a node has no outgoing connection | `wires` is always present; the padding is reported |
| `node-without-coordinates.json` | a node added without a `column` gets no `x`/`y` at all | the emitter always writes both; `layoutFlowSet` places a node that has no geometry and leaves one that has |
| `group-without-bounds.json` | a group with no `x`/`y`/`w`/`h` | all four are always written; the layout pass makes them the bounding box of the members |
| `dangling-wire.json` | deleting a node left its inbound wire behind (the cleanup loop compared a list to a string) | `graph/wire-target-missing` (error) |
| `config-node-inside-tab.json` | config-ness decided by a hardcoded list of two type names, so a `tls-config` got a bogus container | config-ness comes from palette metadata (`category: 'config'`); a global config node has no container, no coordinates and no wires, and an empty reference (`"broker": ""`) is *unset*, not dangling |
| `bare-subflow-instance.json` | a subflow instance emitted bare: no `env` overrides, wires only as long as used | overrides survive the round trip; `wires` matches the subflow's port count |

Two things worth knowing when reading the fixtures:

* the port links inside `bare-subflow-instance.json` follow the editor's own convention — `in[]`/`out[]`
  point *at* internal nodes, internal nodes never wire to a port id (verified against a real
  editor export in `test/fixtures/flows-recon-demo.json`);
* a config node *may* carry a container: Node-RED itself classifies a node as a config node by the
  absence of `x`/`y` (`@node-red/runtime/lib/flows/util.js`) and keeps it in whichever container
  `z` names. What must never happen is inventing a container that the file did not have.

# modelshift

**Change control for the AI model in your production application.**

You already have an application calling a model. You want to move it to a different model.
The hard part was never the API call. It is knowing that the new model was actually
measured, that someone authorised the change, that the switch really took effect, and that
you can prove all three afterwards.

modelshift makes a model change a **governed operation with a state machine**, not a config
edit that happened to work out.

```
$ modelshift activate --actor sam

ERROR: IllegalTransitionError
Cannot "activate" from state ACCEPTED.
  required state : APPROVED
  current state  : ACCEPTED
```

---

## 1. What problem does this solve?

Swapping a model touches four separate concerns, and the tools you already use each own
one of them:

| Concern | Handled well by |
|---|---|
| Is the candidate any good? | Promptfoo, DeepEval, your own evals |
| What is serving right now? | LiteLLM, your config store, a feature flag |
| What happened afterwards? | Langfuse, OpenTelemetry, your logs |
| **Was this change earned, and can you prove it?** | **nothing, usually** |

That last row is the gap. An evaluation produces a score and stops. A flag lets anyone flip
the model whether or not the score was ever looked at. Observability tells you what
happened after the fact. Nothing connects the evidence to the authority to act on it.

**modelshift owns the seam.** It makes "you may activate" a derived, policy-checked,
recorded fact instead of a belief someone holds, and it emits the record that a code
reviewer, an incident responder or an auditor will ask for.

## 2. When should I use it?

Use it when a model change in your system is a **deliberate event** that somebody should be
able to reconstruct later: a production application, a regulated or audited environment, a
team where the person who evaluates is not always the person who deploys, or any system
where "who changed the model and why" is a question you would rather be able to answer.

**Do not use it** to route traffic, gateway providers, run large eval suites, or serve a
dashboard. It integrates with the tools that do those things.

## 3. Five-minute demonstration

Requires **Node 22.6 or newer**. No API key, no `.env`, no account, no network.
The demo runs entirely on local deterministic stand-in models.

```bash
git clone <this repo> && cd modelshift
mkdir /tmp/demo

alias ms="node --experimental-strip-types src/cli/index.ts --root /tmp/demo"

ms init
ms register demo-candidate
ms activate --actor you      # refused: nothing has been evaluated or approved
ms evaluate                  # measures both models, then applies your policy
ms approve --actor you
ms activate --actor you
ms verify                    # bounded traffic, then asserts from telemetry
ms report
```

Try breaking it. Every one of these is refused, not warned about:

```bash
ms approve --actor you       # before evaluate
ms activate --actor you      # before approve
echo "garbage" >> /tmp/demo/.modelshift/ledger.jsonl && ms status
```

## 4. The migration lifecycle

```
                register        evaluate         policy          approve
   (nothing)  ──────────▶ REGISTERED ─────▶ EVALUATED ─────▶ ACCEPTED ─────▶ APPROVED
                                                  │                              │
                                                  │ policy fails                 │ activate
                                                  ▼                              ▼
                                              REJECTED                      ACTIVATED
                                                                                 │
                                                          telemetry confirms ────┼──── telemetry does not
                                                                    ▼            │            ▼
                                                                VERIFIED         │    FAILED_VERIFICATION
                                                                    │            │            │
                                                              close │            │            │
                                                                    ▼            │            │
                                                                 STABLE          │            │
                                                                    │            │            │
                                                                    └────────────┴────────────┘
                                                                                 │  rollback
                                                                                 ▼
                                                                          ROLLING_BACK ──▶ ROLLED_BACK
```

**Fail closed on promotion, fail open on rollback.** Every step toward serving traffic is an
allow-list entry: not listed means refused. Rollback is reachable from every state where
something could be live, including `STABLE`, because blocking a promotion costs five
minutes and blocking a rollback costs an outage.

Run `modelshift states` to print the full table.

## 5. CLI

| Command | What it does |
|---|---|
| `init` | Write `modelshift.config.json` and an empty ledger |
| `register <candidate>` | Begin a migration |
| `evaluate` | Measure baseline vs candidate, then apply the acceptance policy |
| `status` | Show current state. Read only, never writes |
| `approve --actor <name>` | Human authorisation. Legal only from `ACCEPTED` |
| `activate --actor <name>` | Switch the serving model. Legal only from `APPROVED` |
| `verify` | Bounded traffic, then assert the serving model from telemetry |
| `close --actor <name>` | Close the migration. State becomes `STABLE` |
| `rollback --actor <name>` | Revert to the configured rollback model |
| `report` | The full audit record |
| `states` | Print the transition table |

Every command takes `--root <dir>`. An approval or activation without `--actor` is refused:
an approval with no named actor is not an approval.

The same operations are available as a library; the CLI is a thin shell over `src/engine.ts`.

## 6. Configuration

`modelshift.config.json`, written by `init`:

```json
{
  "baselineModel": "demo-baseline",
  "rollbackModel": "demo-baseline",
  "acceptance": {
    "minScore": 0.8,
    "maxRegression": 0.05,
    "requiredCases": ["case-critical-negation"],
    "allowCriticalFailures": false
  },
  "verification": {
    "maxRequests": 5,
    "minObservations": 3
  }
}
```

Every field is either something the framework must know about your system, or a rule it
will enforce **against you** later. There are no tuning knobs and no provider settings:
those belong to adapters.

The acceptance policy is hashed when the verdict is recorded and hashed again at approval.
**Edit the policy after seeing the score and the report says so**, in the report, at the
approval step.

## 7. State-machine semantics

- **The ledger is the state.** `.modelshift/ledger.jsonl` is append-only, and current state
  is a fold over it. There is no separate state field, which is what makes it structurally
  impossible for a report to describe a transition that was never recorded.
- **Reads are strict.** Sequence numbers must be contiguous and each event's `from` must
  match the previous event's `to`. An edited or spliced ledger **fails to load** rather than
  rendering a plausible history.
- **A corrupt ledger never degrades into a default.** It does not read as `REGISTERED`.
  Forward motion stops entirely. **Rollback still works**: `modelshift rollback` detects the
  unreadable ledger and falls back to an emergency path that reverts to the model declared in
  configuration, because you do not need a readable history to know what you declared safe.
  That action is written to `.modelshift/recovery.jsonl`, never appended to the ledger that
  just failed its integrity check, and the ledger is left untouched for investigation.
- **Machine verdict and human permission are different events.** `ACCEPTED` means the
  evidence satisfied the declared rules. `APPROVED` means a named person authorised the
  change. Keeping them apart is the point of the framework.

## 8. Adapters

modelshift owns the lifecycle, the policy decision and the record. It owns nothing else.
Four small interfaces (`src/ports/index.ts`):

| Port | You point it at | Contract |
|---|---|---|
| `ModelAdapter` | your provider SDK, LiteLLM, anything | `complete(input) => string` |
| `Evaluator` | Promptfoo, DeepEval, a judge, your own metric | `evaluate(adapter, cases) => result` |
| `ActivationTarget` | env var, config service, feature flag, DB row | `read()` and `write(model)` |
| `TelemetrySource` | your logs, OpenTelemetry, Langfuse | `observations(since) => [{requestId, servedBy}]` |

`ActivationTarget.read()` is not decoration. Activation is not "we wrote the config", it is
"the target reports the new value back". A write that silently no-ops is exactly what it
catches.

To govern your own system, drop a `modelshift.ports.ts` beside your config exporting
`createPorts(root)`. The CLI picks it up automatically. Nothing else changes.

## 9. Safety invariants

Each is enforced in code and covered by a test that **fails when the implementation is
deliberately broken** (see `docs/mutation-testing.md`):

1. An unevaluated candidate cannot be approved.
2. A candidate that failed the policy cannot be approved.
3. An unapproved candidate cannot be activated.
4. Invalid state cannot silently recover into an unsafe state.
5. Verification cannot exceed its configured ceiling.
6. An empty telemetry set never confirms activation.
7. A mismatched serving model cannot produce `VERIFIED`.
8. Rollback targets the declared safe model.
9. Audit records cannot claim a transition that did not occur.
10. Re-running `status` does not mutate state.

Two are worth spelling out.

**The verification ceiling is enforced by the loop.** The full input is iterated and the
bound is tested before every request. Slicing the input to the ceiling first looks
equivalent and is not: it makes the guard unreachable and moves the guarantee into the
caller, where no test can reach it.

**An empty telemetry set is not confirmation.** A broken telemetry pipeline and a model that
served nothing produce the same empty set, and the safe reading of both is "unconfirmed".

## 10. Limitations

This is **v0.1.0** and deliberately narrow.

- **Single migration per project root.** No concurrent or per-tenant migrations yet.
- **No partial rollout.** Activation is all-or-nothing. Percentage rollouts and per-segment
  targeting are not implemented; today a flag platform does that better.
- **The bundled evaluator is exact-match**, which is intentionally the weakest useful
  metric. Real evaluation belongs behind the `Evaluator` port.
- **The bundled adapters are local stand-ins.** No provider integration ships in v0.
- **The ledger is a local file.** No shared or remote backend, so it governs one operator or
  one CI job, not a distributed team.
- **No authentication.** `--actor` is an assertion, not an identity. It records who said
  they did it; it does not prove it.
- **Node 22.6+**, because the source runs through native type stripping with no build step.

## 11. Roadmap

Integration first, features second. The point is to be the governance layer over tools you
already run, not to reimplement them.

- Adapters for Promptfoo and DeepEval result formats
- OpenTelemetry and Langfuse telemetry sources
- LiteLLM and feature-flag activation targets
- Progressive activation (percentage, per-segment) with the same gates
- A signed or append-only-verified ledger for tamper evidence
- Machine-readable report output for CI and evidence pipelines

## License

**Not yet chosen.** This repository is unpublished and currently carries no open-source
grant. Apache-2.0 is the recommendation, with the reasoning in
[LICENSE-RECOMMENDATION.md](LICENSE-RECOMMENDATION.md); the decision belongs to the project
owner and has not been made. Until it is, treat this as all rights reserved.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The invariants in section 9 are the contract: a
change that weakens one needs a very good argument and a replacement test.

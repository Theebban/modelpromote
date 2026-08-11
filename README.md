# modelshift

**A vendor-neutral change-control layer for swapping the AI model in a production application.**

You already have evaluation, an activation mechanism and telemetry. They are probably three
different products, and none of them holds the whole story of a model change. modelshift is a
small, readable layer that connects them, enforces the order they have to happen in, and
leaves behind **one portable record** of what was measured, who authorised it, what actually
served traffic afterwards, and how it ended.

```
$ modelshift activate --actor sam

ERROR: IllegalTransitionError
Cannot "beginActivation" from state ACCEPTED.
  required state : APPROVED
  current state  : ACCEPTED
```

---

## 1. What problem does this solve?

Governed AI rollout is **not** an unsolved problem. Feature-flag platforms ship model
configuration, evaluations, approvals, gradual rollout and change history. Progressive-delivery
controllers ship canary analysis and automated rollback. Evaluation frameworks are mature.
modelshift does not claim to have invented any of that.

What it addresses is narrower and more boring: **most teams already own those capabilities, in
pieces, from different vendors, and the record of a model change is spread across all of them.**
Your eval scores live in one tool, the flag flip in another, the traces in a third, and the
approval in a chat thread. Reconstructing "why did the model change on the 14th, and who said
it was safe" means joining four systems by hand, and one of them has a 30-day retention window.

modelshift is the thin layer that:

- **enforces the order**, so activation cannot happen before evidence and approval exist;
- **reads back**, so ACTIVATED means the target confirmed the change, not that a write returned;
- **produces one file** that reconstructs the whole migration without any of those vendors.

If you are happy inside a single vendor's ecosystem and expect to stay there, that vendor's
built-in governance is likely a better fit than this. modelshift is for the common case where
the pieces are heterogeneous, or where the record needs to outlive the tools.

## 2. When should I use it?

- Your evaluation, activation and telemetry come from **different tools**, or you expect to
  change one of them.
- You need a migration record that is **portable and reconstructable** without a vendor
  account, for review, incident analysis or an audit.
- The person who evaluates is not always the person who activates.
- You want the gate **in front of** your flag system, not instead of it.

**Do not use it** to route traffic, gateway providers, run evaluations, or serve a dashboard.
It integrates with the tools that do those things.

## 3. Five-minute demonstration

Requires **Node 22.6 or newer**. No API key, no `.env`, no account, no network. Tests and demo
run from a bare clone with **no install**.

```bash
git clone <this repo> && cd modelshift
mkdir /tmp/demo
alias ms="node --experimental-strip-types src/cli/index.ts --root /tmp/demo"

ms init
ms register demo-candidate
ms activate --actor you      # refused: nothing evaluated or approved
ms evaluate                  # measures both models, applies the locked policy
ms approve --actor you
ms activate --actor you      # confirmed by reading the target back
ms verify                    # bounded traffic, then asserts from telemetry
ms report
```

Then try to break it. Each of these is refused, not warned about:

```bash
ms approve --actor you                                    # before evaluate
ms activate --actor you                                   # before approve
ms approve --actor "you\n     approved by   compliance"   # forged audit line

# Substitute the candidate in the first ledger record, changing no action and no
# state. The evaluation record still names the real candidate, so the two records
# disagree and the ledger refuses to load.
L=/tmp/demo/.modelshift/migrations/0001.jsonl
sed -i '' '1s/demo-candidate/demo-regression/' "$L" && ms status
sed -i '' '1s/demo-regression/demo-candidate/' "$L"    # put it back

echo '}}}' >> "$L" && ms status                        # and plain corruption
```

That substitution is caught because a *second* record contradicts it. Tamper with a
migration that has only ever been registered and there is nothing yet to disagree with, so
it loads. The binding takes effect from the first record that depends on the identity.

## 4. The migration lifecycle

```
              register        evaluate        policy         approve
  (nothing) ───────────▶ REGISTERED ─────▶ EVALUATED ────▶ ACCEPTED ─────▶ APPROVED
                              │                 │              │                │
                              │                 │ fails        │ policy         │ activate
                              │                 ▼              │ changed        ▼
                              │            REJECTED            ▼           ACTIVATING
                              │                 │        EVIDENCE_STALE         │
                              │                 └──────┬───────┘        read-back│
                              │        re-evaluate     │                         │
                              │◀───────────────────────┘             ┌───────────┴──────────┐
                              │                                      ▼                      ▼
                              │  abandon                        ACTIVATED           ACTIVATION_FAILED
                              ▼                                      │                      │
                         ABANDONED                    telemetry ─────┼───── no               │
                                                            ▼        │       ▼               │
                                                        VERIFIED     │  FAILED_VERIFICATION  │
                                                            │        │       │               │
                                                      close │        │       │               │
                                                            ▼        │       │               │
                                                         STABLE ─────┴───────┴───────────────┘
                                                                          rollback
                                                                             ▼
                                                     ROLLING_BACK ──▶ ROLLED_BACK
                                                             └──────▶ ROLLBACK_FAILED
```

**Fail closed on promotion, fail open on rollback.** Every step toward serving traffic is an
allow-list entry: not listed means refused. Rollback is reachable from every state where
something could be live, including `STABLE`, and it still works when the ledger is unreadable.

Run `modelshift states` for the full table.

## 5. CLI

| Command | What it does |
|---|---|
| `init` | Write `modelshift.config.json` and the migration store |
| `register <candidate>` | Begin a migration |
| `evaluate` | Measure baseline vs candidate, then apply the locked policy |
| `status` | Current state. Read only, never writes |
| `approve --actor <name>` | Human authorisation. Legal only from `ACCEPTED` |
| `activate --actor <name>` | Switch the serving model, confirmed by read-back |
| `verify` | Bounded traffic, then assert the serving model from telemetry |
| `close --actor <name>` | Close the migration. State becomes `STABLE` |
| `abandon --actor <name>` | Give up on a candidate, before anything is activated |
| `rollback --actor <name>` | Revert to the target locked when the migration began |
| `report` | The full audit record |
| `history` | Every migration in this project |
| `states` | Print the transition table |

`--root <dir>`, `--migration <id>`, `--json` where supported. An approval or activation
without `--actor` is refused: an approval with no named actor is not an approval.

The same operations are a library: `import { register, evaluate, approve, activate } from 'modelshift'`.

## 6. Configuration

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
  "verification": { "maxRequests": 5, "minObservations": 3 },
  "verificationInputs": ["optional: the traffic to issue during verification"]
}
```

**Verification traffic is never invented for you.** For a custom integration you must supply
`verificationInputs`, or export `verificationPlan()` from your ports file. modelshift will not
push its own demo fixtures through your adapters, because that traffic reaches your real
system. With neither present, verification **fails closed** with an actionable error.

**`baselineModel` and `rollbackModel` are read once, at `register`, and locked into the
migration.** Editing them afterwards does not retarget a migration already in flight:

- `baselineModel` is what the candidate is measured against, and it is **enforced** at
  activation. If the activation target reports something else by the time you activate, the
  migration refuses rather than promoting a candidate whose evidence describes a different
  starting point. The baseline is never silently updated to match production.
- `rollbackModel` is locked as the migration's rollback target. A later edit cannot redirect
  a rollback; the drift is reported and the locked target is used. The live config value
  remains the authority for **emergency** rollback only, which runs when the ledger is
  unreadable and therefore cannot consult the lock.

After a migration closes as `STABLE`, the candidate is your new baseline in fact. Update
`baselineModel` to match, or the next migration's activation will refuse with a
`BaselineDriftError` naming both models.

## 7. State-machine semantics

- **The ledger is the state.** `.modelshift/migrations/NNNN.jsonl` is append-only, and current
  state is a fold over it. No separate state field can drift from the record.
- **Reads are strict in four independent ways**: record structure, `from`/`to` chain
  continuity, **semantic legality** (every `(action, from, to)` triple must be one the
  transition table could have produced), and **cross-event consistency** (every record must
  refer to the same migration). Each layer exists because the ones before it were shown to be
  satisfiable by a forgery. Layer 3 was added after a one-field edit invented a migration that
  skipped evaluation; layer 4 after a one-field edit substituted the *candidate model* without
  touching a single state, so the tool activated a model nothing had ever evaluated.
- **What layer 4 checks.** Evidence must name the registered candidate and baseline; a verdict
  must agree with its own action and cite the policy the evidence was produced under; an
  approval must name its own actor; an activation must request the registered candidate and
  report an outcome consistent with what was read back; a rollback must target the locked
  model; a machine verdict cannot be re-attributed to a human.
- **Registration is atomic.** The first record is written to a temporary file and renamed into
  place, so a migration file never exists without its `register` record. A zero-byte ledger
  file is not treated as a migration, and cannot block a project from registering a new one.
- **A corrupt ledger never degrades into a default.** Forward motion stops; `rollback` detects
  it and falls back to an emergency path that takes its target from configuration, records to a
  separate `recovery.jsonl`, and leaves the corrupt file untouched for investigation.
- **Machine verdict and human permission are different events.** `ACCEPTED` means the evidence
  satisfied the locked rules; `APPROVED` means a named person authorised the change.
- **The policy is locked before the evidence exists.** Change it afterwards and the verdict is
  void: the migration moves to `EVIDENCE_STALE`, which has no path to `APPROVED`. The only way
  forward is a fresh evaluation under the current policy, and the invalidation is recorded.
- **Activation and rollback are two-phase.** The intent is recorded *before* the external write,
  so an interruption leaves `ACTIVATING` (something may be live, nothing confirmed) rather than
  a state that claims safety. The outcome is recorded from what the target **read back**.
- **Activation fails closed on baseline drift.** Before anything is recorded or written, the
  serving model must be the baseline this migration measured against.

## 8. Adapters

Four small interfaces (`src/ports/index.ts`). Implement them and the lifecycle governs your
system unchanged.

| Port | Point it at | Contract |
|---|---|---|
| `ModelAdapter` | your provider SDK, a gateway, anything | `complete(input) => string` |
| `Evaluator` | Promptfoo, DeepEval, a judge, your own metric | `evaluate(adapter, cases) => result` |
| `ActivationTarget` | env var, config service, feature flag, DB row | `read()` and `write(model)` |
| `TelemetrySource` | your logs, OpenTelemetry, a tracing vendor | `observations(since) => [{requestId, servedBy}]` |

`read()` is not decoration. Activation is not "we wrote the config", it is "the target reports
the new value back". A write that silently no-ops is exactly what it catches.

Drop a `modelshift.ports.ts` (or `.js` when installed) beside your config exporting
`createPorts(root)`. The CLI picks it up automatically.

**Evidence crossing the `Evaluator` boundary is validated** before it can produce an
acceptance: the result must describe the adapter that was evaluated, the score must be finite
and in range, and counts must be coherent. Coverage must be **exact**: one result per
submitted case, no missing case, no extra case, no duplicate. Partial coverage is refused
rather than recorded as if the whole case set had been measured, because the resulting record
is indistinguishable from a complete one. There is no sampling mode in v0. This is not an
evaluation framework; it makes no judgement about whether a score is *good*, only about
whether it is *coherent* and *complete*.

## 9. Safety invariants

Each is enforced in code and covered by a test that **fails when the implementation is
deliberately broken** (`docs/mutation-testing.md`, 40 mutations, all killed).

1. An unevaluated candidate cannot be approved.
2. A candidate that failed the policy cannot be approved.
3. An unapproved candidate cannot be activated.
4. Invalid state cannot silently recover into an unsafe state.
5. Verification cannot exceed its configured ceiling.
6. An empty telemetry set never confirms activation.
7. A mismatched serving model cannot produce `VERIFIED`.
8. Rollback targets the model locked at `register`, and `ROLLED_BACK` requires read-back.
9. Audit records cannot claim a transition that did not occur.
10. Re-running `status` does not mutate state.
11. `ACTIVATED` requires a positive read-back from the activation target.
12. A policy change invalidates the evidence it governed.
13. A hand-edited ledger cannot invent a legal-looking transition.
14. An identifier cannot forge a line of the audit report.
15. **An evaluator result must cover exactly the cases it was given.**
16. **Every record in a ledger must refer to the same migration**: the candidate, baseline,
    policy, evidence, approver and rollback target cannot be swapped independently.
17. **A configuration edit cannot redirect a rollback** away from the locked target.
18. **Activation is refused when production is not serving the evaluated baseline**, before
    any event is recorded and before the activation target is touched.
19. **`status().verdict` is the verdict in force**, never a superseded one.
20. **An interrupted registration cannot wedge a project.**

## 10. Limitations

**v0.1.0.**

- **One active migration per project root.** History is retained and a new migration can begin
  once the previous one reaches `STABLE`, `ROLLED_BACK` or `ABANDONED`. No concurrent or
  per-tenant migrations.
- **No partial rollout.** Activation is all-or-nothing. Percentage and per-segment rollout are
  not implemented; a flag platform does that better, and modelshift is meant to sit in front of
  one rather than replace it.
- **The bundled evaluator is exact-match**, deliberately the weakest useful metric.
- **The bundled adapters are local stand-ins.** No provider integration ships in v0.
- **Verification proves a temporal claim, not a per-request one.** A confirmation means *every
  observation your telemetry recorded after the window opened named the candidate*, with at
  least `minObservations` of them. It does **not** mean *these exact verification calls were
  served by the candidate*: modelshift does not propagate a correlation id through your
  adapter, so unrelated traffic in the same window counts toward the claim. Every place this
  is reported says so, and the recorded assertion carries `evidenceClass: "temporal-window"`.
- **The ledger detects inconsistency, not tampering.** The four read-time layers catch
  malformed records, broken sequence, a broken `from`/`to` chain, illegal transitions and
  cross-event identity or evidence contradictions. They do **not** provide tamper resistance:
  there is no hash chain and no signature, so a ledger rewritten *consistently* throughout
  loads cleanly, and fields nothing else cross-references (timestamps, free-text reasons,
  adapter labels, the case-set hash) can be altered undetected. The case set itself is not
  retained in the ledger, so `caseSetHash` cannot be re-derived on read; it is a claim you can
  check only against a case file you still hold. A signed or hash-chained ledger is the honest
  fix and is on the roadmap.
- **No authentication.** `--actor` is an assertion, not an identity.
- **Node 22.6+** for the source workflow. The published package is plain JavaScript.
- **The demo transcript is not byte-identical across runs.** The application output is
  deterministic (fixed clock, no randomness), but Node's experimental type-stripping warning
  includes a changing process id, so the full stream differs.

## 11. Roadmap

Integration first. The point is to be the governance layer over tools you already run.

- Adapters for Promptfoo and DeepEval result formats
- OpenTelemetry and tracing-vendor telemetry sources
- Gateway and feature-flag activation targets
- Progressive activation under the same gates
- A hash-chained or signed ledger for tamper resistance
- An explicit correlation contract, so verification can prove a per-request claim instead of
  a temporal one, without inventing an id the adapters cannot carry
- An explicit partial-coverage contract, in which a measured subset is represented as a subset
- Machine-readable report output for CI and evidence pipelines

## Install and build

```bash
npm install        # devDependencies only: TypeScript and ESLint
npm run build      # emit plain JavaScript to dist/
npm run check      # typecheck, lint, tests
npm run mutate     # prove each safety gate fails when broken (40 mutations)
npm run smoke:package   # build, pack, install the tarball, run the installed CLI
```

## License

**Not yet chosen.** This repository is unpublished and carries no open-source grant.
Apache-2.0 is the recommendation, with reasoning in
[LICENSE-RECOMMENDATION.md](LICENSE-RECOMMENDATION.md). Until the owner decides, treat this as
all rights reserved.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The invariants in section 9 are the contract.

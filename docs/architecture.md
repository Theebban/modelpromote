# Architecture

## The shape

```
                    CLI  (src/cli)              your code
                      │                             │
                      └──────────┬──────────────────┘
                                 ▼
                          ENGINE  (src/engine.ts)
                   the only writer. validates, then records.
                                 │
        ┌────────────────┬───────┴────────┬──────────────────┐
        ▼                ▼                ▼                  ▼
   machine.ts       acceptance.ts     verify/            ledger.jsonl
   transition       pure policy       bounded run +      append-only,
   allow-list       decision          telemetry assert   IS the state
                                 │
                                 ▼
                          PORTS  (src/ports)
        ModelAdapter · Evaluator · ActivationTarget · TelemetrySource
                                 │
                                 ▼
                    your provider, evals, config store, logs
```

Nothing in the core imports an adapter. Wiring happens once, at the edge, in a
`modelshift.ports.ts` you write.

## Four decisions worth explaining

### The ledger is the state

There is no `state` field anywhere. Current state is `foldState(events)`, a fold over the
append-only ledger.

The alternative, a `state.json` updated alongside an audit log, has a failure mode this
design does not have: the two can disagree, and when they do the audit log is the one that
is wrong, silently, in the direction of looking better than reality. Deriving both the state
and the report from one append-only source makes "the report claims something that did not
happen" structurally impossible rather than merely tested.

Reads are strict in three independent ways: sequence continuity, `from`/`to` chain continuity,
and **semantic legality**.

The third was added after an independent review demonstrated the first two were insufficient.
Changing a single field of a valid record, the first event's `to` from `REGISTERED` to
`APPROVED`, left the sequence contiguous and the chain intact (its `from` is `null` either
way), loaded cleanly, and allowed activation with no evaluation and no approval. Structure and
chain describe the SHAPE of a history; only the transition table describes which histories
were possible. Every record is now validated against it.

### The policy is locked before the evidence exists

The governing policy is hashed at `register` and re-hashed at each `evaluate`, which is the
moment evidence is produced. `decide` and `approve` then refuse outright if the current policy
no longer matches.

The first implementation *warned* and continued. That is not change control: it let an
operator see a score, relax the rule the score failed, and proceed on evidence earned under
rules that no longer existed, with nothing but a line of console output to show for it.

The mechanism is a state, not a runtime condition. Changing the policy moves the migration to
`EVIDENCE_STALE`, which has no path to `APPROVED`; the only exit is a fresh evaluation. The
tempting alternative was "allow re-evaluation from ACCEPTED only when the policy moved", and
it is disqualified: it makes legality depend on runtime configuration, so `isLegalEvent` could
no longer judge a ledger record from the record alone. That is exactly the hole the semantic
validator closes, and reopening it to save one state would have been a bad trade.

### Machine verdict and human permission are separate events

`ACCEPTED` is a statement about evidence: the declared policy passed. `APPROVED` is a
statement about authority: a named person said go.

Collapsing them is the most tempting simplification and the one that destroys the product.
An evaluation score is not permission, and a tool that treats a passing score as permission
has automated exactly the decision a human should be making.

This is also why `approve` is unreachable from `EVALUATED`: you cannot approve past a verdict
that was never applied, and you cannot approve past one that failed.

### Fail closed on promotion, fail open on rollback

The transition table is an allow-list for everything that moves a candidate toward serving
traffic. `beginRollback` is deliberately the exception: it is legal from `ACTIVATED`,
`VERIFIED`, `FAILED_VERIFICATION` and `STABLE`.

Blocking a promotion costs an operator five minutes. Blocking a rollback costs an outage. The
two directions do not get symmetric caution.

The same reasoning applies to a corrupt ledger. Forward motion stops entirely, but rollback
still works, because the rollback target comes from configuration rather than from history.
You do not need a readable ledger to know what you declared safe.

This one is worth calling out because the first implementation got it wrong. The error
message told the operator that rollback remained available, and it did not: every transition
begins by reading the ledger, so `rollback` threw the same corruption error as everything
else. A message promising recovery next to code that cannot recover is worse than no message.
The fix is `emergencyRollback`, which reads no ledger, takes its target from configuration,
and records to a separate `recovery.jsonl` rather than appending to a file that just failed
verification. The CLI falls back to it automatically, and a test enforces the promise.

### Activation is confirmed by reading back, in two phases

`ActivationTarget` has `read()` as well as `write()`. Activation records what the target
reports **after** the write, not what was requested, and it does so in two recorded phases:

```
record ACTIVATING  ->  write to target  ->  read target back  ->  record the OUTCOME
```

The ordering is load-bearing. Writing the ledger after the side effect cannot express the
middle case: a crash between the write and the confirmation would leave the ledger saying
APPROVED while the candidate was already serving. With the intent recorded first, that
interruption leaves ACTIVATING, which reads as "something may be live and nothing is
confirmed". That is unsafe, and it is *readable* as unsafe, which is the point.

The first implementation recorded ACTIVATED whenever the write returned. An activation target
whose `write()` silently did nothing produced `serving = baseline, state = ACTIVATED`: the
worst possible combination, because every downstream reader believed the migration had
happened. Rollback had the identical defect. Both now require a positive read-back, and both
have a distinct failure state (`ACTIVATION_FAILED`, `ROLLBACK_FAILED`) rather than borrowing
the success one.

Then verification asks a different question entirely: not "did the config change" but "which
model actually answered". Those come from different ports on purpose. A config write that
silently no-ops, a cached client, a deployment that did not roll: all of them look like
success to a writer and like failure to a telemetry check.

## Determinism

Time enters through `Ports.now`. Tests inject a fixed clock, so audit output is
byte-deterministic. Nothing else in the core reads the clock, and nothing uses randomness.

## What is deliberately absent

No plugin loader, no dependency-injection container, no event bus, no config layering, no
database. The core has zero runtime dependencies and the whole lifecycle is a few hundred
lines. For a tool whose entire value is that you can trust its refusals, being small enough
to read in one sitting is a feature.

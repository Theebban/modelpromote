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

Reads are strict in four independent ways: sequence continuity, `from`/`to` chain continuity,
**semantic legality**, and **cross-event consistency**. Each layer exists because the ones
before it were demonstrated insufficient, by review, on this code.

The third was added after the first review changed a single field of a valid record, the first
event's `to` from `REGISTERED` to `APPROVED`. The sequence stayed contiguous, the chain stayed
intact (its `from` is `null` either way), the ledger loaded, and activation was permitted with
no evaluation and no approval. Structure and chain describe the SHAPE of a history; only the
transition table describes which histories were possible.

The fourth was added after the second review changed a different single field: `detail.candidate`
on the register record, from `demo-candidate` to `demo-regression`. No action, no `from`, no `to`.
All three earlier layers passed, `status()` reported the substituted model, and `activate()` put
it into production and recorded `ACTIVATED`. The lesson is one level up from the first:

> A legal sequence of states is not enough. The candidate, baseline, policy, evidence and
> rollback target that those states refer to must describe the same migration.

So the identity is fixed by the `register` record and every later record is checked against it
and against the records it depends on: evidence must name the registered models, a verdict must
agree with its own action and cite the policy its evidence was produced under, an approval must
name its own actor, an activation must request the registered candidate, a rollback must target
the locked model. Type-correctness of a field proves nothing here. The check is relational.

Be exact about what this buys. It is inconsistency detection, not tamper resistance. There is
no hash chain and no signature, so a ledger rewritten coherently throughout still loads, and a
test in `tests/cross-event.test.ts` asserts that it does, so the limitation cannot quietly stop
being true. Fields nothing else cross-references remain undetectable. The word "tamper-evident"
was withdrawn from this project for that reason, and it should not come back until a mechanism
supports it.

There is one more boundary worth naming, because it is easy to assume away: this layer compares
records to **each other**. A migration holding only its `register` record has no second record
to disagree with, so a substitution there is internally consistent and loads. The binding takes
effect from the first record that depends on the identity, which is the first `evaluate`. That
is not a gap that can be closed by more comparison; closing it needs a signature over the
record, which is the same future work as the row above. A test asserts the boundary explicitly
rather than leaving it to be discovered as a surprise.

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
still works, because the EMERGENCY path takes its target from configuration rather than from
history. You do not need a readable ledger to know what you declared safe.

That is a deliberate split in authority, and the two halves are not interchangeable:

| | Normal rollback | Emergency rollback |
|---|---|---|
| Target from | the value locked into the migration at `register` | `config.rollbackModel`, live |
| Available when | the ledger reads | always, including when the ledger does not |
| Config edits | cannot redirect it; drift is reported | are the authority |

The second review made the case for the lock by editing `rollbackModel` to name a regressing
model mid-migration and invoking rollback. The tool reverted production onto the regression and
recorded `ROLLED_BACK`. A safe target that any later config edit can redirect is not a safe
target; it is a variable with a reassuring name.

Refusing on drift was the other option and it was rejected: blocking a rollback over a
configuration disagreement is exactly the failure this file spends a section arguing against.
The lock wins, the drift is reported in the outcome, on the CLI and in the ledger, and the
emergency path stays as the escape hatch for the case where configuration really is the better
authority. Claiming both paths derive authority the same way would be tidier and false.

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

### Activation refuses when the baseline has moved

The read before the write is not only there to capture `previousModel`. If the target reports
anything other than the baseline this migration measured against, activation stops before
recording an intent and before touching the target.

The second review built the case: evaluate a candidate against A, let production quietly move
to B, then activate. The evidence is not *wrong*, it simply answers a question nobody is asking
any more, and nothing downstream can tell the difference between "measured against what is
running" and "measured against what used to be running". Updating the baseline to match would
be the obvious convenience and it is the wrong move: it would rewrite the premise of the
evidence to fit whatever happened to be true at activation time. Re-measuring is the only
honest repair, so the error says so and names both models.

## What the telemetry claim actually is

A confirmation from `assertServingModelInWindow` proves:

> every observation the telemetry source reported after the window opened named the candidate,
> and there were at least `minObservations` of them.

It does not prove that the specific calls `runBoundedVerification` issued were those
observations. modelshift does not propagate a correlation id through `ModelAdapter`, so it
cannot pair one with the other. The second review demonstrated the gap directly: bounded calls,
then unrelated ambient candidate telemetry after the mark, and verification confirmed.

Two ways out were available. Building a correlation contract would mean pushing an id through
the adapter boundary and requiring every telemetry source to echo it back, which is a
distributed-tracing feature wearing a small interface, and an id the adapters cannot really
carry would move the same gap somewhere less visible. Keeping the temporal claim and naming it
exactly costs nothing and lies about nothing. V0 does the second: the assertion carries
`evidenceClass: 'temporal-window'`, the type is named for the window, the reason strings say
"not a per-request correlation", and the report prints the limitation next to the result. The
run's own ids are `issuedCallLabels`, not `requestIds`, because they are labels for a local
report and nothing outside the function has ever seen them.

## Determinism

Time enters through `Ports.now`. Tests inject a fixed clock, so audit output is
byte-deterministic. Nothing else in the core reads the clock, and nothing uses randomness.

The **application** output of `npm run demo` is therefore identical run to run. The full
terminal stream is not: Node's experimental type-stripping warning carries the process id.
Suppressing a runtime diagnostic to make a claim come true would be the wrong repair, so the
claim is worded to match what is actually deterministic.

## What is deliberately absent

No plugin loader, no dependency-injection container, no event bus, no config layering, no
database. The core has zero runtime dependencies and the whole lifecycle is a few hundred
lines. For a tool whose entire value is that you can trust its refusals, being small enough
to read in one sitting is a feature.

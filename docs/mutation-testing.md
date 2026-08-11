# Mutation testing

A passing test suite proves nothing on its own. It has to be shown failing when the thing it
guards is broken.

Every safety invariant in this project has been checked by deliberately breaking the
implementation and confirming that a specific test notices. The script is
`scripts/mutate.sh`; run it any time you touch the state machine, the verification bounds or
the ledger reader.

```bash
bash scripts/mutate.sh
```

## Current results

40 mutations, all killed. 0 survived, 0 invalid, 0 skipped.

The table below lists the originals. The first independent review added mutations for
read-back gating on activation and rollback, two-phase ordering, semantic ledger validation,
policy locking, fixture leakage, evidence validation, identifier rejection, report escaping
and the abandon boundary. The second added the `S`-prefixed set: evaluator coverage, the
cross-event identity bindings, the locked rollback target, baseline-drift refusal, the verdict
projection, registration atomicity and the recorded telemetry evidence class.
`scripts/mutate.sh` is the authoritative list.

| Mutation | Guarantee removed | Result |
|---|---|---|
| `runBoundedVerification` pre-slices its input to `maxRequests` | The in-loop ceiling guard becomes unreachable | **killed**, 2 tests |
| `activate` made legal from `ACCEPTED` | Activation without approval | **killed**, 3 tests |
| `approve` made legal from `EVALUATED` | Approval without a policy verdict | **killed**, 1 test |
| `approve` made legal from `REJECTED` | Approval of a failed candidate | **killed**, 2 tests |
| Empty telemetry sets `confirmed = true` | An empty observation set confirms | **killed**, 2 tests |
| Ledger chain check disabled | Edited history loads as valid | **killed**, 1 test |
| Emergency rollback appends to the corrupt ledger | Recovery pollutes the artifact under investigation | **killed**, 1 test |

## Three findings from the second review's runs

**An interrupted run left a deliberate break in the working tree.** The suite grew slower when
the CLI tests began spawning child processes, a run hit a timeout and was killed mid-mutation,
and the `if (false && ...)` it had just written to `src/store/consistency.ts` stayed there. The
next run reported `BASELINE IS RED` for a reason that had nothing to do with the code. The
`trap ... EXIT` made it worse: it deleted the work directory, and the backup inside it, so the
only remaining recovery was `git checkout`.

The general shape: **a tool that deliberately breaks your source owes you an interrupt path.**
The harness now records the file it is currently mutating, restores it before removing the work
directory, and installs the same handler on `INT` and `TERM`.


**A skipped mutation reads exactly like a passing one.** Renaming a variable and rewording a
message moved the text two mutations searched for. Both reported `SKIP`, the run still ended
`survived: 0`, and two guarantees, rollback read-back gating and duplicate result case ids,
quietly stopped being exercised. Nothing in the summary line said so.

The general shape: **a check whose target resolves to nothing still prints a clean verdict.**
The harness now counts skips and exits non-zero on any of them, and on any `INVALID`, so a
run cannot report success while proving less than it did yesterday.

**One survivor was a redundancy, not a gap.** Removing the null-state guard in
`activeMigrationId` killed no test, because `listMigrations` already excludes empty ledger
files and the branch is unreachable behind it. That is a real result and it is recorded here
rather than resolved by deleting the guard or by quietly dropping the mutation: the guard is
deliberate defence in depth, the mutation now targets the live enforcement in
`listMigrations`, and the redundancy is documented at the guard itself.

The general shape: **a surviving mutant on defensive code is a documentation obligation.**
Either make it reachable and test it, or say plainly that it is redundant and why it stays.

## Three findings from the first review's runs

They are the reason this file exists.

**The chain check was not actually tested.** The original tampering test deleted an event
from the ledger, which also broke the sequence numbering, so the sequence check caught it and
the chain check was never exercised. Disabling the chain check left the suite green. The fix
was a test that rewrites one event's `from` field while leaving `seq` contiguous, which
nothing but the chain check can detect.

The general shape: **when two guards can catch the same test case, only the first one is
tested.** Give each guard a case that only it can catch.

**One "surviving" mutation was a broken mutation.** The edit appended a trailing space and
changed no behaviour, so of course nothing failed. A mutation that does not alter behaviour
is not evidence of a test gap.

The general shape: **a surviving mutant is a hypothesis, not a finding.** Confirm the mutation
actually changed behaviour before concluding the tests are weak. The script now exits with
`INVALID` when a mutation changes no bytes, so this cannot be misread again.

**An error message made a promise the code did not keep.** The corrupt-ledger error told the
operator that rollback was still available. It was not: every transition begins by reading
the ledger, so `rollback` threw the same corruption error as everything else. This was found
by running the documented recovery step during a clean-clone walkthrough, not by any test,
because no test existed for a behaviour that only the prose claimed.

The general shape: **a claim in user-facing output is part of the contract.** If an error
message tells someone what they can still do, that sentence needs a test as much as any
function does.

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

19 mutations, all killed. The table below lists the originals; the corrections from the
independent review add mutations for read-back gating on activation and rollback, two-phase
ordering, semantic ledger validation, policy locking, fixture leakage, evidence validation,
identifier rejection, report escaping and the abandon boundary. `scripts/mutate.sh` is the
authoritative list.

| Mutation | Guarantee removed | Result |
|---|---|---|
| `runBoundedVerification` pre-slices its input to `maxRequests` | The in-loop ceiling guard becomes unreachable | **killed**, 2 tests |
| `activate` made legal from `ACCEPTED` | Activation without approval | **killed**, 3 tests |
| `approve` made legal from `EVALUATED` | Approval without a policy verdict | **killed**, 1 test |
| `approve` made legal from `REJECTED` | Approval of a failed candidate | **killed**, 2 tests |
| Empty telemetry sets `confirmed = true` | An empty observation set confirms | **killed**, 2 tests |
| Ledger chain check disabled | Edited history loads as valid | **killed**, 1 test |
| Emergency rollback appends to the corrupt ledger | Recovery pollutes the artifact under investigation | **killed**, 1 test |

## Three findings from these runs

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

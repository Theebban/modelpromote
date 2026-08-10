# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things are treated as public API and therefore as breaking changes:
**the transition table** and **the ledger record format**. A change to either gets a major
version once 1.0.0 is out, because both are things users build process around.

## [Unreleased]

### Corrected after independent release review
An independent review of the 0.1.0 build reproduced several defects against the actual
repository. All are fixed; the review itself is preserved in the project history rather than
edited out.

- **`ACTIVATED` now requires a positive read-back.** An activation target whose `write()` did
  nothing produced `serving = baseline, state = ACTIVATED`. Activation is now two-phase, with
  the intent recorded BEFORE the external write, and the outcome recorded from what the target
  reported back. New states `ACTIVATING` and `ACTIVATION_FAILED`.
- **`ROLLED_BACK` now requires a positive read-back**, with `ROLLING_BACK` and
  `ROLLBACK_FAILED`. Emergency rollback is gated the same way and no longer reports success
  when the target still serves the candidate.
- **Ledger reads validate SEMANTIC legality**, not only structure and chain continuity.
  Editing one field of a valid record could previously invent a migration that skipped
  evaluation and approval.
- **A policy change now invalidates the evidence it governed** instead of warning. New state
  `EVIDENCE_STALE`, reached by an explicit recorded `invalidateEvidence` transition, with no
  path to `APPROVED`.
- **Verification inputs must be declared for a custom integration.** The bundled demo fixtures
  can no longer be issued through adapters modelshift did not write. Fails closed.
- **Evidence crossing the `Evaluator` boundary is validated** for model identity, score range,
  count coherence, duplicate case ids and unsubmitted case ids.
- **Identifiers are rejected, and adapter-supplied strings escaped**, so an actor or model name
  cannot forge a line of the audit report.
- **Many migrations per project**, retained as `.modelshift/migrations/NNNN.jsonl` with a new
  `history` command. A new migration may begin once the previous reaches a terminal state.
- **`abandon`**, so a rejected candidate no longer wedges the project. Legal only before
  anything is activated. Found by walking the CLI as a new user.
- **A real build.** `bin` pointed at a `.ts` file and could not execute when installed. The
  package now ships built JavaScript with a public library entry point, and a package smoke
  test installs the tarball and runs the installed binary.
- Public positioning corrected: modelshift does not claim to have invented governed AI
  rollout. See the README.

## [0.1.0] - unreleased, local only

First working end-to-end lifecycle. Not published, no remote, no package registry entry.

### Added
- Migration state machine with an allow-list transition table: `REGISTERED`, `EVALUATED`,
  `ACCEPTED`, `APPROVED`, `ACTIVATED`, `VERIFIED`, `STABLE`, plus `REJECTED`,
  `FAILED_VERIFICATION`, `ROLLING_BACK`, `ROLLED_BACK`.
- Append-only ledger as the single source of state, with sequence and chain verification on
  read.
- Declarative acceptance policy: minimum score, maximum regression, required cases, critical
  failures. Hashed at verdict and re-hashed at approval so a policy edited in between is
  reported.
- Separation of machine verdict (`ACCEPTED`) from human authorisation (`APPROVED`).
- Bounded post-activation verification with the ceiling enforced by the loop.
- Telemetry assertion in which an empty observation set never confirms.
- Rollback to a configuration-declared target, available from every state where something
  could be live, and recorded as begin plus complete.
- Emergency rollback for an unreadable ledger: reverts to the configuration-declared model
  without reading history, records to a separate `recovery.jsonl`, and leaves the corrupt
  ledger untouched. The CLI falls back to it automatically.
- Audit report rendered entirely from the ledger.
- Four ports: `ModelAdapter`, `Evaluator`, `ActivationTarget`, `TelemetrySource`, with local
  deterministic reference adapters.
- CLI: `init`, `register`, `evaluate`, `status`, `approve`, `activate`, `verify`, `close`,
  `rollback`, `report`, `states`.
- 50 tests and a mutation-testing script covering seven safety guarantees.

### Known limitations
See the Limitations section of the README. The significant ones: one migration per project
root, no partial rollout, exact-match reference evaluator only, local-file ledger, and
`--actor` is an assertion rather than an authenticated identity.

## Release strategy (proposed, not adopted)

- **0.x** while the transition table and ledger format are still moving. Breaking changes
  allowed in minor versions, called out here.
- **1.0.0** once the ledger format has survived a real integration unchanged.
- Publish as a scoped npm package with `npx` as the primary entry point.
- A build step producing plain JavaScript should precede any publish, so the package does not
  require the consumer to be on a Node version with type stripping.

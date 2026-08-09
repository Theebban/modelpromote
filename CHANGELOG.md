# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things are treated as public API and therefore as breaking changes:
**the transition table** and **the ledger record format**. A change to either gets a major
version once 1.0.0 is out, because both are things users build process around.

## [Unreleased]

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

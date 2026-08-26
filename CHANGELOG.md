# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things are treated as public API and therefore as breaking changes:
**the transition table** and **the ledger record format**. A change to either gets a major
version once 1.0.0 is out, because both are things users build process around.

## [0.1.1] - 2026-08-26

Completes the public open-source surface. No behaviour changed, and no feature was added.

### Added
- **`NOTICE`**, so attribution survives redistribution. Apache-2.0 requires downstream
  redistributors to pass on a NOTICE file if one exists; without it, attribution travels only
  in the licence header. Three lines, no extra conditions.
- **README section 2, "What can you do with it?"** The lifecycle was documented; the concrete
  operations it enables were not.
- **README section 3, "What does it work with?"** A compatibility table for the evaluation,
  activation, telemetry and generation layers, with the truthful status recorded against every
  named system: **architecture-compatible, adapter required**. No official or community adapter
  ships for any of them, none of those vendors is affiliated with this project, and the README
  says so in as many words.
- **README section 4, "Bringing your own stack."** The bring-your-own path existed and was
  reachable only by reading `src/ports/index.ts`. It is now a worked `createPorts` snippet, with
  the one hard requirement stated plainly: an activation target must be readable, not only
  writable.
- **README section 5, "What it deliberately does not replace."**

### Changed
- README sections renumbered to make room; the invariants are now section 13. Two paragraphs
  that the new sections duplicated were removed from sections 1 and 6, so each point is stated
  once.

## [0.1.0] - 2026-08-26

First public release. https://github.com/Theebban/modelpromote/releases/tag/v0.1.0

Governed change control for swapping the AI model in a production application: evaluate, accept
against a locked policy, approve, activate with read-back confirmation, verify from telemetry,
roll back, and keep one portable migration record. Zero runtime dependencies. Apache-2.0.

The subsections below record how this build reached that point, including two review cycles it
failed and the corrections that followed. All of it shipped in 0.1.0.

### Renamed for first public release

The project was developed under the working name **modelshift** and is released as
**modelpromote**. Nothing was ever published under the old name, so there is no compatibility
shim and no deprecated package: `modelpromote` is the only name this tool has ever had in
public. Commits made before the rename still say `modelshift`, and are left alone rather than
rewritten, because the history is a truthful record of how the tool was built.

The rename changed the package name, the CLI binary, the config file
(`modelpromote.config.json`), the ports file (`modelpromote.ports.ts`), the state directory
(`.modelpromote/`) and the `ModelPromoteConfig` type. It changed no behaviour.


### Corrected after a SECOND independent release review

The second review confirmed every correction below from the first review, then found a class
the first had not reached: the state transitions were all legal, but the identities and
evidence those states referred to were not bound to each other. Both reviews are recorded.
The progression is the useful part and is not edited out.

**Ledger record format changed.** `register` now records `rollbackTarget`, and the run detail
of `verify` renames `requestIds` to `issuedCallLabels`. Ledgers written by the previous build
will not load. Nothing is published, so nothing is migrated.

- **Cross-event consistency is validated on every read**, as a fourth layer beside structure,
  chain and semantic legality. Editing `detail.candidate` on the register record changed no
  action and no state, passed all three earlier layers, and let the tool activate a model that
  had never been evaluated. Evidence must now name the registered models, a verdict must agree
  with its own action and cite the policy its evidence was produced under, an approval must
  name its own actor, an activation must request the registered candidate, a rollback must
  target the locked model, and a machine verdict cannot be re-attributed to a human.
- **An evaluator result must cover exactly the cases it was given.** Five submitted cases and
  one returned result was accepted, on a record whose `caseSetHash` represented all five.
  Missing, extra and duplicate case ids are now all refused, and the submitted case set is
  itself validated before anything is measured. No sampling mode in v0.
- **The rollback target is locked at `register`.** Editing `rollbackModel` mid-migration
  previously redirected a rollback onto a regressing model, which the tool then recorded as
  `ROLLED_BACK`. The locked target now wins and the drift is reported. Emergency rollback
  continues to take the live configured value, and is documented as a different trust
  authority rather than the same one.
- **Activation fails closed on production baseline drift.** A candidate evaluated against A
  could be activated while production was already serving B. Activation now refuses with
  `BaselineDriftError` before any event is recorded and before the target is written. The
  baseline is never silently updated to match.
- **`status().verdict` is the verdict in force.** The projection searched for the latest
  `accept` and the latest `reject` independently and preferred `accept`, so a migration sitting
  in `REJECTED` reported `verdict.accepted === true`. It now takes the most recent verdict
  event, and returns null when a re-evaluation or an invalidation has superseded it.
- **Registration is atomic.** The first record is written to a temporary file and renamed into
  place, so no migration file can exist without its `register` record. An empty ledger file is
  no longer treated as an active migration, and its id is reclaimed rather than wedging the
  project.
- **The telemetry claim is stated exactly.** Verification proves that everything observed after
  the window opened was served by the candidate, not that the specific calls issued were those
  observations. The assertion carries `evidenceClass: "temporal-window"`, `requestIds` became
  `issuedCallLabels`, and the README, architecture doc, CLI output and report all describe the
  same strength of evidence. Per-request correlation is deferred to an explicit future
  contract.
- **"Tamper-evident" withdrawn.** The ledger detects inconsistency; it does not resist
  tampering. A consistently rewritten ledger loads, and a test asserts that it does so the
  limitation cannot quietly stop being true. Fields nothing cross-references, including
  `caseSetHash`, remain undetectable.
- **The mutation harness fails on skipped mutations.** Two mutations silently stopped finding
  their target text during this work and reported neither killed nor survived while the run
  still summarised as clean. 40 mutations, all killed, 0 survived, 0 invalid, 0 skipped.
- **The CLI accepts its options before the subcommand.** `argv[0]` was read as the command, so
  the README's own quickstart, which wraps the CLI in an alias carrying `--root`, failed at
  every documented step with a confusing configuration error. Pre-existing and missed by two
  reviews, because both drove the library and every hand-run put the command first. Found by
  running the README verbatim from a clean clone. A new `tests/cli.test.ts` spawns the real
  entry point and walks the documented five minutes end to end.
- **The mutation harness restores the working tree on an interrupt.** A run killed by a timeout
  left a deliberate break in a source file, and the old `EXIT` trap deleted the backup before
  anything could be restored.
- Demo determinism claim corrected: the application output is deterministic, the full terminal
  stream is not, because Node's type-stripping warning carries the process id.

### Corrected after the first independent release review
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
  can no longer be issued through adapters modelpromote did not write. Fails closed.
- **Evidence crossing the `Evaluator` boundary is validated** for model identity, score range,
  count coherence, duplicate case ids and unsubmitted case ids.
- **Identifiers are rejected, and adapter-supplied strings escaped**, so an actor or model name
  cannot forge a line of the audit report.
- **Many migrations per project**, retained as `.modelpromote/migrations/NNNN.jsonl` with a new
  `history` command. A new migration may begin once the previous reaches a terminal state.
- **`abandon`**, so a rejected candidate no longer wedges the project. Legal only before
  anything is activated. Found by walking the CLI as a new user.
- **A real build.** `bin` pointed at a `.ts` file and could not execute when installed. The
  package now ships built JavaScript with a public library entry point, and a package smoke
  test installs the tarball and runs the installed binary.
- Public positioning corrected: modelpromote does not claim to have invented governed AI
  rollout. See the README.

## Pre-release build history (never published)

The first working end-to-end lifecycle, built locally under the working name modelshift. It
carried the version string 0.1.0 while it had no remote and no registry entry, and it is NOT
the 0.1.0 that was released: two independent reviews failed this build, and the corrections
above are what the public 0.1.0 actually contains. Kept because "this is what shipped first and
it was wrong in these ways" is part of the record.

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

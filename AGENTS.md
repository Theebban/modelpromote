# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should read `README.md`
first; this file exists so an agent does not have to infer the conventions from the code.

## What this project is

A vendor-neutral change-control layer for changing the AI model in a production application.
It governs the switch itself: evaluate a candidate against a policy locked in advance, require
a named human approval, activate with read-back confirmation, verify from telemetry, roll back
to a locked target, and leave one portable record of all of it.

It is **not** an evaluation framework, a model gateway, a prompt manager or a serving layer.
It connects the tools that do those jobs. If a request would turn it into one of them, say so
rather than building it.

## Setup and commands

Node `>=22.0.0`, no runtime dependencies.

```bash
npm ci
npm run check        # typecheck + lint + tests. THE gate. Must pass before any commit
npm test             # node:test, TypeScript run directly via type stripping
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src tests
npm run demo         # end to end lifecycle against in-memory adapters
npm run build        # tsc -p tsconfig.build.json, output in dist/
npm run mutate       # mutation testing. Slow. Exits non-zero on a skipped or no-op mutation
npm run smoke:package # builds, packs, installs the tarball, runs the installed CLI
```

`npm run check` is the gate. Do not report work as done without it passing, and do not pipe it
into `tail` or `grep`, because the exit status you get back is then the pipe's, not the gate's.

## Architecture

Read `docs/architecture.md` before changing anything structural.

- `src/domain/` state machine, types, errors. The legal transitions live in `machine.ts`
- `src/store/` the append-only JSONL ledger and its four read-time validation layers
- `src/policy/` acceptance policy and evidence validation
- `src/engine.ts` the lifecycle operations
- `src/ports/` the interfaces an adopter implements. Adapters are the adopter's code, not ours
- `src/cli/` the command surface
- `src/verify/` bounded verification traffic and the telemetry assertion

## Rules that are not negotiable

1. **The ledger is append-only.** Never edit, rewrite or delete a past event. Correction
   happens by appending a new event.
2. **Validation has four layers** (structure, chain, semantic legality, cross-event
   consistency) and they are not interchangeable. A forgery can satisfy the first three. If
   you add a field that two events must agree on, it belongs in `store/consistency.ts`.
3. **Fail closed on promotion, fail open on rollback.** Uncertainty must never block getting
   back to a known-good model.
4. **A machine verdict is not permission.** Evidence and approval are recorded separately and
   approval is never inferred from a passing score.
5. **Read back after writing.** `ACTIVATED` means the target confirmed the model is serving,
   not that a write returned without error.
6. **Claims must be true.** The README says every integration is "architecture-compatible,
   adapter required" because no adapter ships. Do not upgrade that wording, do not add a
   compatibility badge, and do not describe the telemetry check as per-request correlation:
   it is a temporal-window claim and `src/verify/index.ts` explains why.
7. **No runtime dependencies.** Dev dependencies need a reason.
8. **No em-dashes** anywhere in this repository, including comments and commit messages.

## Testing conventions

Tests are `node:test` in `tests/*.test.ts` and run the real code, not mocks of it. A test that
asserts a refusal must assert the specific error type and the state it refused from, because
"it threw" passes for the wrong reason. New lifecycle rules need a mutation that proves the
rule is actually load-bearing; `npm run mutate` fails if a mutation changes nothing.

## Commits and pull requests

Conventional commit prefixes (`feat`, `fix`, `docs`, `ci`, `chore`, `test`). Explain WHY in
the body, not what the diff already shows. No AI co-author or attribution trailers. Run
`npm run check` first.

Releases are tag-triggered and publish through npm trusted publishing with no stored token;
`.github/workflows/release.yml` can only STAGE a version and a human approves it on npm. Do
not add a publish token, and do not change the workflow to publish directly.

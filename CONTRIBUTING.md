# Contributing

Early-stage project. The shape is still moving, so an issue describing the problem is more
useful than a large unannounced pull request.

## Setup

```bash
npm install        # devDependencies only: TypeScript and ESLint
npm run check      # typecheck, lint, tests
```

The demonstration and the tests need **no install at all**. There are zero runtime
dependencies, so `npm test` and the CLI run straight from a clone on Node 22.6 or newer.
`npm install` is only for the two development checks.

## The bar

**The ten invariants in the README are the contract.** A change that weakens one needs an
argument and a replacement test, not just a passing suite.

- **No vacuous tests.** A test must assert on something the system under test produced. If
  the expected value is constructed inside the test body, the test proves only that the test
  is self-consistent. In particular, never raise the exception you are asserting on.
- **Run `bash scripts/mutate.sh`** if you touch `domain/machine.ts`, `verify/` or
  `store/ledger.ts`. Every mutation must be killed. If you add a guard, add a mutation for
  it, and make sure only your new test catches it: when two guards can catch the same case,
  only the first one is really tested.
- **Keep the core dependency-free.** New capability belongs behind a port, in an adapter
  package, not in the core.
- **Errors are interface.** An error should say what was refused, what state the system is
  actually in, and what would make the action legal.
- **Tests clean up per test**, not in a single `after` hook. One hook only ever sees the last
  temporary directory and leaks all the others.

## Scope

modelpromote governs the transition from one already-integrated model to another. It is not a
gateway, an eval framework, an observability platform or an agent runtime. Proposals that
reimplement one of those will get pushed toward a port instead.

Good contributions right now: adapters for real evaluators, telemetry sources and activation
targets; better error messages; documentation from the perspective of someone integrating it
for the first time.

## Style

Code comments explain **why**, not what. Prose uses no em-dashes.

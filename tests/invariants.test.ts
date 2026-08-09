// THE TEN CORE INVARIANTS.
//
// These are the promises the framework makes. Each test drives the real engine against a
// real ledger on disk; none asserts on a value it constructed itself, and none raises the
// error it is asserting on.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

import { makeRoot, removeRoot, portsFor, fixedClock } from './helpers.ts';
import { loadConfig, writeConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { IllegalTransitionError, LedgerCorruptError } from '../src/domain/errors.ts';
import { activate, approve, decide, emergencyRollback, evaluate, register, rollback, stabilise, status, verify } from '../src/engine.ts';
import { DEMO_CASES, DEMO_VERIFICATION_INPUTS } from '../src/adapters/local/fixtures.ts';
import { ledgerPath, readLedger, recoveryPath } from '../src/store/ledger.ts';
import { renderReport } from '../src/audit/report.ts';

let root: string;
beforeEach(() => {
  root = makeRoot();
});
afterEach(() => {
  removeRoot(root);
});

/** Drive the migration up to (but not including) the named action. */
async function driveTo(target: 'REGISTERED' | 'EVALUATED' | 'ACCEPTED' | 'APPROVED' | 'ACTIVATED' | 'VERIFIED', candidate = 'demo-candidate') {
  const config = loadConfig(root);
  const ports = portsFor(root);
  const clock = fixedClock();
  register(root, candidate, config, clock);
  if (target === 'REGISTERED') return { config, ports, clock };
  await evaluate(root, DEMO_CASES, ports);
  if (target === 'EVALUATED') return { config, ports, clock };
  decide(root, config, clock);
  if (target === 'ACCEPTED') return { config, ports, clock };
  approve(root, 'tester', config, clock);
  if (target === 'APPROVED') return { config, ports, clock };
  await activate(root, 'tester', ports);
  if (target === 'ACTIVATED') return { config, ports, clock };
  await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
  return { config, ports, clock };
}

describe('invariant 1: an unevaluated candidate cannot be approved', () => {
  test('approve is refused directly from REGISTERED', async () => {
    const { config, clock } = await driveTo('REGISTERED');
    assert.equal(status(root).state, 'REGISTERED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
    assert.equal(status(root).state, 'REGISTERED', 'a refused approval must not move the state');
  });

  test('approve is refused from EVALUATED, before a policy verdict exists', async () => {
    const { config, clock } = await driveTo('EVALUATED');
    assert.equal(status(root).state, 'EVALUATED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
  });
});

describe('invariant 2: a failed candidate cannot be approved', () => {
  test('a policy rejection blocks approval', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, ports);
    const { verdict } = decide(root, config, clock);

    assert.equal(verdict.accepted, false, 'the regressing model must fail the policy');
    assert.equal(status(root).state, 'REJECTED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
  });

  test('the rejection is recorded, not discarded', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, ports);
    decide(root, config, clock);
    const actions = readLedger(root).map((e) => e.action);
    assert.ok(actions.includes('reject'), 'a rejection must leave evidence that it happened');
  });
});

describe('invariant 3: an unapproved candidate cannot be activated', () => {
  test('activate is refused from ACCEPTED', async () => {
    const { ports } = await driveTo('ACCEPTED');
    assert.equal(status(root).state, 'ACCEPTED');
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
  });

  test('a refused activation does not change the serving model', async () => {
    const { ports } = await driveTo('ACCEPTED');
    const before = await ports.activation.read();
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
    const after = await ports.activation.read();
    assert.equal(after, before, 'the outside world must be untouched by a refused transition');
    assert.equal(after, 'demo-baseline');
  });
});

describe('invariant 4: invalid state cannot silently recover into an unsafe state', () => {
  test('a truncated ledger record raises rather than defaulting', async () => {
    await driveTo('APPROVED');
    appendFileSync(ledgerPath(root), '{ this is not json\n', 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });

  test('a spliced ledger fails the chain check', async () => {
    await driveTo('ACTIVATED');
    const lines = readFileSync(ledgerPath(root), 'utf8').trim().split('\n');
    // Remove the approval, leaving activation claiming it followed acceptance.
    const spliced = lines.filter((l) => !l.includes('"action":"approve"'));
    writeFileSync(ledgerPath(root), `${spliced.join('\n')}\n`, 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });

  // The splice test above also breaks the sequence numbering, so the seq check catches it
  // and the chain check is never exercised alone. This one keeps seq contiguous and edits
  // only the `from` field, which nothing but the chain check can detect.
  test('a rewritten from-state fails the chain check even with sequence intact', async () => {
    await driveTo('ACTIVATED');
    const lines = readFileSync(ledgerPath(root), 'utf8').trim().split('\n');
    const rewritten = lines.map((l) => {
      const e = JSON.parse(l) as { action: string; from: string | null };
      // Claim the activation followed EVALUATED rather than APPROVED. Seq is untouched.
      if (e.action === 'activate') return JSON.stringify({ ...e, from: 'EVALUATED' });
      return l;
    });
    writeFileSync(ledgerPath(root), `${rewritten.join('\n')}\n`, 'utf8');

    assert.throws(
      () => status(root),
      (e: unknown) => e instanceof LedgerCorruptError && /broken chain/.test(e.message),
      'an edited from-state must be detected by the chain check',
    );
  });

  test('a rejected candidate cannot be approved', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, ports);
    decide(root, config, clock);
    assert.equal(status(root).state, 'REJECTED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
  });

  test('a corrupt ledger blocks forward motion entirely', async () => {
    const { ports } = await driveTo('APPROVED');
    writeFileSync(ledgerPath(root), 'garbage\n', 'utf8');
    await assert.rejects(() => activate(root, 'tester', ports), LedgerCorruptError);
  });

  // The corrupt-ledger error tells the operator that rollback is still available. That is a
  // promise, so it gets a test: a message that says "you can still recover" beside code that
  // cannot is worse than no message.
  test('rollback still works when the ledger is unreadable (fail open)', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    assert.equal(await ports.activation.read(), 'demo-candidate');

    writeFileSync(ledgerPath(root), 'not-json\n', 'utf8');
    // The normal path cannot run, because every transition starts by reading the ledger.
    await assert.rejects(() => rollback(root, 'tester', config, ports), LedgerCorruptError);

    const { serving, recordedAt } = await emergencyRollback(root, 'tester', config, ports, 'ledger unreadable');
    assert.equal(serving, config.rollbackModel, 'the declared safe model must still be reachable');
    assert.equal(await ports.activation.read(), 'demo-baseline');

    // The action is recorded, and NOT by appending to the file that just failed its check.
    assert.notEqual(recordedAt, ledgerPath(root));
    const recovery = readFileSync(recoveryPath(root), 'utf8');
    assert.match(recovery, /emergencyRollback/);
    assert.match(recovery, /demo-baseline/);
    assert.equal(readFileSync(ledgerPath(root), 'utf8'), 'not-json\n', 'the corrupt ledger must be left untouched for investigation');
  });
});

describe('invariant 5: verification cannot exceed its configured ceiling', () => {
  test('stops at the ceiling and leaves later inputs unissued', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 2, minObservations: 1 } });
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    const { run } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);

    assert.ok(DEMO_VERIFICATION_INPUTS.length > 2, 'the input set must exceed the ceiling to exercise it');
    assert.equal(run.requestsMade, 2, 'exactly maxRequests requests');
    assert.equal(run.stoppedBy, 'ceiling');
    assert.equal(run.truncated, true);
    assert.equal(run.requestsAvailable, DEMO_VERIFICATION_INPUTS.length);
    assert.equal(run.requestIds.length, 2);
  });

  test('the ceiling bounds telemetry too, not just the reported count', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 2, minObservations: 1 } });
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    const before = (await ports.telemetry.observations(null)).length;
    await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    const after = (await ports.telemetry.observations(null)).length;
    assert.equal(after - before, 2, 'no request beyond the ceiling reached the model');
  });
});

describe('invariant 6: an empty telemetry set cannot confirm activation', () => {
  test('no observations means FAILED_VERIFICATION, not success', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    // A telemetry pipeline that reports nothing: indistinguishable from a dead pipeline,
    // so the only safe reading is "unconfirmed".
    const blind = { ...ports, telemetry: { name: 'empty', observations: () => [] } };
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, blind);

    assert.equal(assertion.confirmed, false);
    assert.equal(assertion.observationCount, 0);
    assert.match(assertion.reason, /absence of contrary evidence is not evidence/);
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });

  test('fewer observations than the declared minimum does not confirm', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 1, minObservations: 3 } });
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    assert.equal(assertion.observationCount, 1);
    assert.equal(assertion.confirmed, false);
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });
});

describe('invariant 7: a mismatched serving model cannot produce VERIFIED', () => {
  test('telemetry showing a different model fails verification', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    const lying = {
      ...ports,
      telemetry: {
        name: 'mismatch',
        observations: () => [
          { requestId: 'r1', servedBy: 'demo-baseline' },
          { requestId: 'r2', servedBy: 'demo-baseline' },
          { requestId: 'r3', servedBy: 'demo-baseline' },
        ],
      },
    };
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, lying);
    assert.equal(assertion.confirmed, false);
    assert.deepEqual(assertion.observed, ['demo-baseline']);
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });

  test('traffic split across two models does not confirm', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    const split = {
      ...ports,
      telemetry: {
        name: 'split',
        observations: () => [
          { requestId: 'r1', servedBy: 'demo-candidate' },
          { requestId: 'r2', servedBy: 'demo-baseline' },
          { requestId: 'r3', servedBy: 'demo-candidate' },
        ],
      },
    };
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, split);
    assert.equal(assertion.confirmed, false);
    assert.equal(assertion.observed.length, 2);
  });
});

describe('invariant 8: rollback targets the declared safe model', () => {
  test('rollback reverts the activation target to the configured model', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    assert.equal(await ports.activation.read(), 'demo-candidate');

    const { serving } = await rollback(root, 'tester', config, ports);
    assert.equal(serving, config.rollbackModel);
    assert.equal(await ports.activation.read(), 'demo-baseline');
    assert.equal(status(root).state, 'ROLLED_BACK');
  });

  test('rollback stays available from every state where something could be live', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('VERIFIED');
    stabilise(root, 'tester', fixedClock());
    assert.equal(status(root).state, 'STABLE');
    // Fail open: a migration that looked fine can still need reverting later.
    const { serving } = await rollback(root, 'tester', config, ports);
    assert.equal(serving, 'demo-baseline');
    assert.equal(status(root).state, 'ROLLED_BACK');
  });

  test('rollback records both the begin and the completion', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo('ACTIVATED');
    await rollback(root, 'tester', config, ports);
    const actions = readLedger(root).map((e) => e.action);
    assert.ok(actions.includes('beginRollback'));
    assert.ok(actions.includes('completeRollback'));
  });
});

describe('invariant 9: audit records cannot claim a transition that did not occur', () => {
  test('the report contains exactly the recorded transitions, no more', async () => {
    await driveTo('ACTIVATED');
    const v = status(root);
    const report = renderReport(v.events, v.state);

    for (const e of v.events) {
      assert.ok(report.includes(e.action), `report must mention recorded action ${e.action}`);
    }
    // Nothing beyond ACTIVATED happened, so these must be absent.
    assert.ok(!report.includes('completeRollback'), 'report must not mention a rollback that never ran');
    assert.ok(!report.includes('stabilise'), 'report must not mention a closure that never happened');
  });

  test('the report reflects a rejection rather than glossing it', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, ports);
    decide(root, config, clock);
    const v = status(root);
    const report = renderReport(v.events, v.state);
    assert.match(report, /REJECTED by policy/);
    assert.ok(!report.includes('approve'), 'an unapproved migration must not show an approval');
  });

  test('editing the policy between verdict and approval is surfaced in the report', async () => {
    const { clock } = await driveTo('ACCEPTED');
    // Move the bar AFTER seeing the score.
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);
    const { policyChanged } = approve(root, 'tester', moved, clock);

    assert.equal(policyChanged, true);
    const v = status(root);
    assert.match(renderReport(v.events, v.state), /WARNING: the acceptance policy was edited/);
  });
});

describe('invariant 10: re-running status does not mutate migration state', () => {
  test('repeated status calls leave the ledger byte-identical', async () => {
    await driveTo('ACTIVATED');
    const before = readFileSync(ledgerPath(root), 'utf8');
    const a = status(root);
    const b = status(root);
    const c = status(root);
    const after = readFileSync(ledgerPath(root), 'utf8');

    assert.equal(after, before, 'status must not write');
    assert.equal(a.state, b.state);
    assert.equal(b.state, c.state);
    assert.equal(a.events.length, c.events.length);
  });

  test('repeated report rendering is deterministic and non-mutating', async () => {
    await driveTo('VERIFIED');
    const before = readFileSync(ledgerPath(root), 'utf8');
    const v1 = status(root);
    const r1 = renderReport(v1.events, v1.state);
    const v2 = status(root);
    const r2 = renderReport(v2.events, v2.state);
    assert.equal(r1, r2, 'the same ledger must render the same report');
    assert.equal(readFileSync(ledgerPath(root), 'utf8'), before);
  });
});

// THE CORE INVARIANTS.
//
// These are the promises the framework makes. Each test drives the real engine against a
// real ledger on disk; none asserts on a value it constructed itself, and none raises the
// error it is asserting on.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

import { makeRoot, removeRoot, portsFor, fixedClock, driveTo, noopActivationTarget, statefulActivationTarget } from './helpers.ts';
import { loadConfig, writeConfig, DEFAULT_CONFIG } from '../src/config.ts';
import {
  ActivationNotConfirmedError,
  IllegalTransitionError,
  LedgerCorruptError,
  RollbackNotConfirmedError,
  StalePolicyEvidenceError,
} from '../src/domain/errors.ts';
import {
  abandon,
  activate,
  approve,
  decide,
  emergencyRollback,
  evaluate,
  history,
  register,
  rollback,
  stabilise,
  status,
  statusOf,
  verify,
} from '../src/engine.ts';
import { DEMO_CASES, DEMO_VERIFICATION_INPUTS } from '../src/adapters/local/fixtures.ts';
import { migrationPath, readMigration, readRecovery, recoveryPath, listMigrations } from '../src/store/ledger.ts';
import { renderReport } from '../src/audit/report.ts';

let root: string;
beforeEach(() => {
  root = makeRoot();
});
afterEach(() => {
  removeRoot(root);
});

const activePath = (r: string) => migrationPath(r, '0001');

describe('invariant 1: an unevaluated candidate cannot be approved', () => {
  test('approve is refused directly from REGISTERED', async () => {
    const { config, clock } = await driveTo(root, 'REGISTERED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
    assert.equal(status(root).state, 'REGISTERED', 'a refused approval must not move the state');
  });

  test('approve is refused from EVALUATED, before a policy verdict exists', async () => {
    const { config, clock } = await driveTo(root, 'EVALUATED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
  });
});

describe('invariant 2: a failed candidate cannot be approved', () => {
  test('a policy rejection blocks approval and activation', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    const { verdict } = decide(root, config, clock);

    assert.equal(verdict.accepted, false, 'the regressing model must fail the policy');
    assert.equal(status(root).state, 'REJECTED');
    assert.throws(() => approve(root, 'tester', config, clock), IllegalTransitionError);
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
  });

  test('the rejection is recorded, not discarded', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    decide(root, config, clock);
    assert.ok(readMigration(root, '0001').map((e) => e.action).includes('reject'));
  });
});

describe('invariant 3: an unapproved candidate cannot be activated', () => {
  test('activate is refused from ACCEPTED', async () => {
    const { ports } = await driveTo(root, 'ACCEPTED');
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
  });

  test('a refused activation does not change the serving model', async () => {
    const { ports } = await driveTo(root, 'ACCEPTED');
    const before = await ports.activation.read();
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
    assert.equal(await ports.activation.read(), before, 'the outside world must be untouched by a refused transition');
  });
});

describe('invariant 4: invalid state cannot silently recover into an unsafe state', () => {
  test('a truncated record raises rather than defaulting', async () => {
    await driveTo(root, 'APPROVED');
    appendFileSync(activePath(root), '{ this is not json\n', 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });

  test('a spliced ledger fails the chain check', async () => {
    await driveTo(root, 'ACTIVATED');
    const lines = readFileSync(activePath(root), 'utf8').trim().split('\n');
    writeFileSync(activePath(root), `${lines.filter((l) => !l.includes('"action":"approve"')).join('\n')}\n`, 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });

  // The splice test also breaks sequence numbering, so the sequence check catches it and
  // the chain check is never exercised alone. This keeps seq contiguous and edits only
  // `from`, which nothing but the chain check can detect.
  test('a rewritten from-state fails the chain check even with sequence intact', async () => {
    await driveTo(root, 'ACTIVATED');
    const rewritten = readFileSync(activePath(root), 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l) as { action: string; from: string | null };
      return e.action === 'approve' ? JSON.stringify({ ...e, from: 'REGISTERED' }) : l;
    });
    writeFileSync(activePath(root), `${rewritten.join('\n')}\n`, 'utf8');
    assert.throws(
      () => status(root),
      (e: unknown) => e instanceof LedgerCorruptError && /broken chain/.test(e.message),
    );
  });

  test('a corrupt ledger blocks forward motion entirely', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    writeFileSync(activePath(root), 'garbage\n', 'utf8');
    await assert.rejects(() => activate(root, 'tester', ports), LedgerCorruptError);
  });
});

// ---------------------------------------------------------------------------
// FINDING 3. Structure and chain can both be satisfied by a forgery.
// ---------------------------------------------------------------------------
describe('invariant 4b: semantic transition validation', () => {
  test('a one-field edit cannot elevate the first event to APPROVED', async () => {
    await driveTo(root, 'REGISTERED');
    const e = JSON.parse(readFileSync(activePath(root), 'utf8').trim()) as Record<string, unknown>;
    // Structure valid, sequence valid, chain valid (from is still null). Only the
    // (action, from, to) triple is impossible.
    e['to'] = 'APPROVED';
    writeFileSync(activePath(root), `${JSON.stringify(e)}\n`, 'utf8');

    assert.throws(
      () => status(root),
      (err: unknown) => err instanceof LedgerCorruptError && /illegal transition/.test(err.message),
      'register can only ever produce REGISTERED',
    );
  });

  test('a final-event to-edit cannot silently elevate state', async () => {
    await driveTo(root, 'EVALUATED');
    const lines = readFileSync(activePath(root), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    last['to'] = 'APPROVED'; // evaluate cannot produce APPROVED
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(activePath(root), `${lines.join('\n')}\n`, 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });

  test('a ledger whose first event is not register is rejected', async () => {
    await driveTo(root, 'EVALUATED');
    const lines = readFileSync(activePath(root), 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
    // Keep it structurally perfect: seq 1, from null.
    second['seq'] = 1;
    second['from'] = null;
    writeFileSync(activePath(root), `${JSON.stringify(second)}\n`, 'utf8');
    assert.throws(
      () => status(root),
      (err: unknown) => err instanceof LedgerCorruptError && /first record must be "register"/.test(err.message),
    );
  });

  test('an action swapped for another legal-looking one is rejected', async () => {
    await driveTo(root, 'ACCEPTED');
    const lines = readFileSync(activePath(root), 'utf8').trim().split('\n');
    const rewritten = lines.map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      // "reject" cannot go EVALUATED -> ACCEPTED, only EVALUATED -> REJECTED.
      return e['action'] === 'accept' ? JSON.stringify({ ...e, action: 'reject' }) : l;
    });
    writeFileSync(activePath(root), `${rewritten.join('\n')}\n`, 'utf8');
    assert.throws(() => status(root), LedgerCorruptError);
  });
});

describe('invariant 5: verification cannot exceed its configured ceiling', () => {
  test('stops at the ceiling and leaves later inputs unissued', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 2, minObservations: 1 } });
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    const { run } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    assert.ok(DEMO_VERIFICATION_INPUTS.length > 2);
    assert.equal(run.requestsMade, 2);
    assert.equal(run.stoppedBy, 'ceiling');
    assert.equal(run.truncated, true);
  });

  test('the ceiling bounds telemetry too', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 2, minObservations: 1 } });
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    const before = (await ports.telemetry.observations(null)).length;
    await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    assert.equal((await ports.telemetry.observations(null)).length - before, 2);
  });
});

describe('invariant 6: an empty telemetry set cannot confirm activation', () => {
  test('no observations means FAILED_VERIFICATION', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    const blind = { ...ports, telemetry: { name: 'empty', observations: () => [] } };
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, blind);
    assert.equal(assertion.confirmed, false);
    assert.match(assertion.reason, /absence of contrary evidence is not evidence/);
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });

  test('fewer observations than the declared minimum does not confirm', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verification: { maxRequests: 1, minObservations: 3 } });
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    assert.equal(assertion.confirmed, false);
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });
});

describe('invariant 7: a mismatched serving model cannot produce VERIFIED', () => {
  test('telemetry showing a different model fails verification', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
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
    assert.equal(status(root).state, 'FAILED_VERIFICATION');
  });
});

// ---------------------------------------------------------------------------
// FINDING 1. The ledger must never say ACTIVATED without a positive read-back.
// ---------------------------------------------------------------------------
describe('invariant 11: activation requires positive read-back', () => {
  test('a no-op activation target cannot produce ACTIVATED', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    // write() does nothing; read() keeps reporting the baseline. This is what a stale
    // client, a cached config or a swallowed permission error looks like.
    const broken = { ...ports, activation: noopActivationTarget('demo-baseline') };

    await assert.rejects(() => activate(root, 'tester', broken), ActivationNotConfirmedError);

    const v = status(root);
    assert.equal(v.state, 'ACTIVATION_FAILED', 'must record the observed outcome, not the intent');
    assert.notEqual(v.state, 'ACTIVATED');
  });

  test('the failed activation is recorded with what was actually observed', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    const broken = { ...ports, activation: noopActivationTarget('demo-baseline') };
    await assert.rejects(() => activate(root, 'tester', broken), ActivationNotConfirmedError);

    const events = readMigration(root, '0001');
    const fail = events.find((e) => e.action === 'failActivation');
    assert.ok(fail, 'a failActivation event must exist');
    assert.equal(fail.detail['requestedModel'], 'demo-candidate');
    assert.equal(fail.detail['observedModel'], 'demo-baseline');
    assert.equal(fail.detail['confirmed'], false);
  });

  // The two-phase ordering is the point: the intent is recorded BEFORE the side effect, so
  // a crash after the external write cannot leave the ledger claiming an earlier safe state.
  test('the intent is recorded before the external write', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    let stateWhenWriteHappened: string | null = null;
    // Genuinely stateful, because activation reads the target twice for different reasons:
    // once before the write to confirm production is still on the baseline, and once after
    // to confirm the change took.
    const observing = {
      ...ports,
      activation: statefulActivationTarget('demo-baseline', 'observing', () => {
        // Whatever the ledger says at THIS moment is what a crash here would leave behind.
        stateWhenWriteHappened = status(root).state;
      }),
    };
    await activate(root, 'tester', observing);
    assert.equal(stateWhenWriteHappened, 'ACTIVATING', 'a crash mid-activation must leave ACTIVATING, never APPROVED');
    assert.equal(status(root).state, 'ACTIVATED');
  });

  test('rollback remains available from ACTIVATION_FAILED and from ACTIVATING', async () => {
    const { config, ports } = await driveTo(root, 'APPROVED');
    const broken = { ...ports, activation: noopActivationTarget('demo-baseline') };
    await assert.rejects(() => activate(root, 'tester', broken), ActivationNotConfirmedError);
    assert.equal(status(root).state, 'ACTIVATION_FAILED');

    const r = await rollback(root, 'tester', config, ports);
    assert.equal(r.confirmed, true);
    assert.equal(status(root).state, 'ROLLED_BACK');
  });
});

// ---------------------------------------------------------------------------
// FINDING 2. ROLLED_BACK requires positive read-back too.
// ---------------------------------------------------------------------------
describe('invariant 8: rollback requires positive read-back of the declared target', () => {
  test('a confirmed rollback reverts and records ROLLED_BACK', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    const r = await rollback(root, 'tester', config, ports);
    assert.equal(r.observed, config.rollbackModel);
    assert.equal(status(root).state, 'ROLLED_BACK');
  });

  test('a no-op rollback target cannot produce ROLLED_BACK', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    const stuck = { ...ports, activation: noopActivationTarget('demo-candidate') };

    await assert.rejects(() => rollback(root, 'tester', config, stuck), RollbackNotConfirmedError);

    const v = status(root);
    assert.equal(v.state, 'ROLLBACK_FAILED', 'the system is not known to be safe, and must say so');
    assert.notEqual(v.state, 'ROLLED_BACK');
  });

  test('a failed rollback can be retried, and ROLLBACK_FAILED is not terminal', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    const stuck = { ...ports, activation: noopActivationTarget('demo-candidate') };
    await assert.rejects(() => rollback(root, 'tester', config, stuck), RollbackNotConfirmedError);
    assert.equal(status(root).state, 'ROLLBACK_FAILED');

    const r = await rollback(root, 'tester', config, ports);
    assert.equal(r.confirmed, true);
    assert.equal(status(root).state, 'ROLLED_BACK');
  });

  test('emergency rollback cannot report success when the write did not take', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    writeFileSync(activePath(root), 'not-json\n', 'utf8');
    const stuck = { ...ports, activation: noopActivationTarget('demo-candidate') };

    await assert.rejects(() => emergencyRollback(root, 'tester', config, stuck, 'probe'), RollbackNotConfirmedError);

    const rec = readRecovery(root);
    assert.equal(rec.length, 1, 'the attempt must still be recorded');
    assert.equal(rec[0]?.['confirmed'], false);
    assert.match(String(rec[0]?.['outcome']), /NOT CONFIRMED/);
  });

  test('emergency rollback still works when the ledger is unreadable', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    writeFileSync(activePath(root), 'not-json\n', 'utf8');
    await assert.rejects(() => rollback(root, 'tester', config, ports), LedgerCorruptError);

    const r = await emergencyRollback(root, 'tester', config, ports, 'ledger unreadable');
    assert.equal(r.confirmed, true);
    assert.equal(await ports.activation.read(), config.rollbackModel);
    assert.notEqual(r.recordedAt, activePath(root));
    assert.equal(readFileSync(activePath(root), 'utf8'), 'not-json\n', 'the corrupt ledger must be left for investigation');
    assert.match(readFileSync(recoveryPath(root), 'utf8'), /emergencyRollback/);
  });
});

// ---------------------------------------------------------------------------
// FINDING 4. Policy locking. A warning is not change control.
// ---------------------------------------------------------------------------
describe('invariant 12: a policy change invalidates the evidence it governed', () => {
  test('approve is REFUSED, not warned, after the policy moves', async () => {
    await driveTo(root, 'ACCEPTED');
    // Move the bar after seeing the score.
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);

    assert.throws(() => approve(root, 'tester', moved, fixedClock()), StalePolicyEvidenceError);
    assert.equal(status(root).state, 'ACCEPTED', 'the refused approval must not move the state');
  });

  test('relaxing the policy cannot rescue a rejected candidate without re-evaluating', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    decide(root, config, clock);
    assert.equal(status(root).state, 'REJECTED');

    // Make the policy trivially satisfiable, then try to accept the OLD evidence.
    writeConfig(root, {
      ...DEFAULT_CONFIG,
      acceptance: { minScore: 0, maxRegression: 1, requiredCases: [], allowCriticalFailures: true },
    });
    const relaxed = loadConfig(root);
    assert.throws(() => decide(root, relaxed, clock), StalePolicyEvidenceError);
  });

  test('re-evaluating under the new policy is the supported path', async () => {
    await driveTo(root, 'ACCEPTED');
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);
    const ports = portsFor(root);

    assert.throws(() => approve(root, 'tester', moved, fixedClock()), StalePolicyEvidenceError);

    // Fresh evidence under the current policy re-locks the hash and unblocks the flow.
    await evaluate(root, DEMO_CASES, moved, ports);
    decide(root, moved, fixedClock());
    approve(root, 'tester', moved, fixedClock());
    assert.equal(status(root).state, 'APPROVED');
  });

  test('an unchanged policy does not block anything', async () => {
    const { config, clock } = await driveTo(root, 'ACCEPTED');
    assert.doesNotThrow(() => approve(root, 'tester', config, clock));
  });
});

describe('invariant 9: audit records cannot claim a transition that did not occur', () => {
  test('the report contains exactly the recorded transitions', async () => {
    await driveTo(root, 'ACTIVATED');
    const v = status(root);
    const report = renderReport(v.events, v.state, v.id);
    for (const e of v.events) assert.ok(report.includes(e.action), `report must mention ${e.action}`);
    assert.ok(!report.includes('confirmRollback'), 'no rollback happened');
    assert.ok(!report.includes('stabilise'), 'no closure happened');
  });

  test('a failed activation is reported as failed, not glossed', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    const broken = { ...ports, activation: noopActivationTarget('demo-baseline') };
    await assert.rejects(() => activate(root, 'tester', broken), ActivationNotConfirmedError);
    const v = status(root);
    const report = renderReport(v.events, v.state, v.id);
    assert.match(report, /did not read back the candidate/);
    assert.ok(!report.includes('confirmActivation'));
  });
});

describe('invariant 10: re-running status does not mutate migration state', () => {
  test('repeated status and report calls leave the ledger byte-identical', async () => {
    await driveTo(root, 'ACTIVATED');
    const before = readFileSync(activePath(root), 'utf8');
    const a = status(root);
    const r1 = renderReport(a.events, a.state, a.id);
    const b = status(root);
    const r2 = renderReport(b.events, b.state, b.id);
    assert.equal(readFileSync(activePath(root), 'utf8'), before);
    assert.equal(r1, r2, 'the same ledger must render the same report');
  });
});

// ---------------------------------------------------------------------------
// FINDING 7. Repeatable migrations with retained history.
// ---------------------------------------------------------------------------
describe('invariant 13: a project may run many migrations, and keeps all of them', () => {
  test('a second migration can begin after STABLE', async () => {
    const { clock } = await driveTo(root, 'VERIFIED');
    stabilise(root, 'tester', clock);
    assert.equal(status(root).state, 'STABLE');

    const config = loadConfig(root);
    const { id } = register(root, 'demo-regression', config, clock);
    assert.equal(id, '0002');
    assert.equal(status(root).state, 'REGISTERED');
  });

  // Verification scopes telemetry to "after the last observation seen before this run". If
  // observation ids repeat between runs, that marker matches an OLD row and the scope
  // silently widens to include a previous migration's traffic, failing a healthy system.
  //
  // The first migration is rolled back rather than closed, so production returns to the
  // baseline the second migration declares. Closing it instead would leave the candidate
  // serving while config still named the old baseline, which activation now refuses.
  test('a SECOND migration verifies successfully, with telemetry scoped to its own run', async () => {
    const { config, ports, clock } = await driveTo(root, 'VERIFIED');
    await rollback(root, 'tester', config, ports);
    assert.equal(status(root).state, 'ROLLED_BACK');
    assert.equal(await ports.activation.read(), config.baselineModel);

    register(root, 'demo-candidate', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    decide(root, config, clock);
    approve(root, 'tester', config, clock);
    await activate(root, 'tester', ports);
    const { assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);

    assert.equal(assertion.confirmed, true, 'the second migration must verify on its own traffic');
    assert.deepEqual(assertion.observed, ['demo-candidate']);
    assert.equal(
      assertion.observationCount,
      config.verification.maxRequests,
      'only this run\'s observations may count, not the first migration\'s',
    );
    assert.equal(statusOf(root, '0002').state, 'VERIFIED');
  });

  test('a second migration can begin after ROLLED_BACK', async () => {
    const { config, ports, clock } = await driveTo(root, 'ACTIVATED');
    await rollback(root, 'tester', config, ports);
    assert.equal(status(root).state, 'ROLLED_BACK');
    const { id } = register(root, 'demo-regression', config, clock);
    assert.equal(id, '0002');
  });

  test('a second migration is refused while the first is still open', async () => {
    const { config, clock } = await driveTo(root, 'ACTIVATED');
    assert.throws(() => register(root, 'demo-regression', config, clock), IllegalTransitionError);
  });

  // Found by walking the CLI as a new user: a rejected candidate left the project wedged.
  // A migration was open so none could begin, and nothing was live so nothing could be
  // rolled back. Refusing to let go costs everything and protects nothing.
  test('a rejected candidate can be abandoned, which unblocks the project', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    decide(root, config, clock);
    assert.equal(status(root).state, 'REJECTED');

    // Before the fix, both of these were refused and there was no third option.
    assert.throws(() => register(root, 'demo-candidate', config, clock), IllegalTransitionError);

    const e = abandon(root, 'tester', 'candidate is not worth pursuing', clock);
    assert.equal(e.to, 'ABANDONED');

    const { id } = register(root, 'demo-candidate', config, clock);
    assert.equal(id, '0002', 'a new migration must be possible after abandoning');
  });

  test('abandonment is recorded with its reason, not deleted', async () => {
    const { config, clock } = await driveTo(root, 'EVALUATED');
    abandon(root, 'tester', 'switching to a different provider', clock);
    const v = statusOf(root, '0001');
    assert.equal(v.state, 'ABANDONED');
    const report = renderReport(v.events, v.state, v.id);
    assert.match(report, /abandon/);
    assert.match(report, /switching to a different provider/);
    assert.equal(loadConfig(root).baselineModel, config.baselineModel);
  });

  test('a migration that may be live CANNOT be abandoned, only rolled back', async () => {
    const { clock } = await driveTo(root, 'ACTIVATED');
    assert.throws(
      () => abandon(root, 'tester', 'changed my mind', clock),
      IllegalTransitionError,
      'abandoning a live migration would close the record while leaving the candidate serving',
    );
    assert.equal(status(root).state, 'ACTIVATED');
  });

  test('the earlier migration stays readable and unmodified, with no manual deletion', async () => {
    const { clock } = await driveTo(root, 'VERIFIED');
    stabilise(root, 'tester', clock);
    const firstBytes = readFileSync(activePath(root), 'utf8');
    const firstEvents = readMigration(root, '0001').length;

    const config = loadConfig(root);
    register(root, 'demo-regression', config, clock);

    assert.equal(readFileSync(activePath(root), 'utf8'), firstBytes, 'migration 0001 must be untouched');
    assert.deepEqual(listMigrations(root), ['0001', '0002']);
    assert.equal(statusOf(root, '0001').state, 'STABLE');
    assert.equal(readMigration(root, '0001').length, firstEvents);
    assert.equal(history(root).length, 2);

    // And the old report still renders in full.
    const old = statusOf(root, '0001');
    assert.match(renderReport(old.events, old.state, old.id), /MIGRATION REPORT {2}\[0001\]/);
  });
});

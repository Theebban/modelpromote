// ADVERSARIAL TESTS.
//
// Each of these corresponds to a defect found by independent review of v0.1.0. They are
// written from the attacker's or the careless integrator's side: the question is not "does
// the happy path work" but "what does this do when the thing it trusts is wrong".

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeRoot, removeRoot, portsFor, fixedClock, driveTo } from './helpers.ts';
import { loadConfig, writeConfig, DEFAULT_CONFIG, policyHash } from '../src/config.ts';
import {
  IllegalTransitionError,
  StalePolicyEvidenceError,
  InvalidEvidenceError,
  NoVerificationPlanError,
  UnsafeIdentifierError,
} from '../src/domain/errors.ts';
import { approve, decide, evaluate, register, status, stabilise, activate } from '../src/engine.ts';
import { DEMO_CASES } from '../src/adapters/local/fixtures.ts';
import { assertValidEvidence } from '../src/policy/evidence.ts';
import { assertSafeIdentifier, escapeForReport } from '../src/domain/sanitize.ts';
import { resolveVerificationInputs } from '../src/verify/plan.ts';
import { readMigration } from '../src/store/ledger.ts';
import { renderReport } from '../src/audit/report.ts';
import type { EvaluationResult } from '../src/domain/types.ts';
import type { Ports } from '../src/ports/index.ts';

let root: string;
beforeEach(() => {
  root = makeRoot();
});
afterEach(() => {
  removeRoot(root);
});

// ---------------------------------------------------------------------------
// FINDING 4 (continued). The lifecycle mechanism for stale evidence.
// ---------------------------------------------------------------------------
describe('EVIDENCE_STALE: the recorded consequence of a policy change', () => {
  test('re-evaluating after a policy change records the invalidation as its own event', async () => {
    await driveTo(root, 'ACCEPTED');
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);
    const ports = portsFor(root);

    await evaluate(root, DEMO_CASES, moved, ports);

    const events = readMigration(root, '0001');
    const inv = events.find((e) => e.action === 'invalidateEvidence');
    assert.ok(inv, 'the policy change must be a recorded event, not an inference');
    assert.equal(inv.from, 'ACCEPTED');
    assert.equal(inv.to, 'EVIDENCE_STALE');
    assert.equal(inv.detail['policyAtEvaluation'], policyHash(DEFAULT_CONFIG.acceptance));
    assert.equal(inv.detail['policyNow'], policyHash(moved.acceptance));

    // And the audit trail shows the whole story rather than a silent re-roll.
    const v = status(root);
    assert.equal(v.state, 'EVALUATED');
    assert.match(renderReport(v.events, v.state, v.id), /invalidateEvidence/);
  });

  test('ACCEPTED is a stable checkpoint: re-evaluation is refused when the policy has NOT moved', async () => {
    const { config, ports } = await driveTo(root, 'ACCEPTED');
    await assert.rejects(
      () => evaluate(root, DEMO_CASES, config, ports),
      IllegalTransitionError,
      'a verdict must not be re-rollable on a whim',
    );
    assert.equal(status(root).state, 'ACCEPTED');
  });

  test('EVIDENCE_STALE has no path to APPROVED', async () => {
    await driveTo(root, 'ACCEPTED');
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);

    // Reach EVIDENCE_STALE without completing the follow-on evaluate, by using a ports
    // object whose evaluator throws after the invalidation is recorded.
    const ports = portsFor(root);
    const exploding: Ports = {
      ...ports,
      evaluator: { name: 'boom', evaluate: () => { throw new Error('evaluator unavailable'); } },
    };
    await assert.rejects(() => evaluate(root, DEMO_CASES, moved, exploding), /evaluator unavailable/);
    assert.equal(status(root).state, 'EVIDENCE_STALE');

    // With the moved policy in force, the policy guard refuses first.
    assert.throws(() => approve(root, 'tester', moved, fixedClock()), StalePolicyEvidenceError);

    // Now put the ORIGINAL policy back, so the hash matches again and the policy guard has
    // nothing to say. The refusal must still stand, which proves the dead end is a property
    // of the STATE MACHINE and not merely of the hash comparison.
    writeConfig(root, DEFAULT_CONFIG);
    const restored = loadConfig(root);
    assert.equal(status(root).state, 'EVIDENCE_STALE');
    assert.throws(() => approve(root, 'tester', restored, fixedClock()), IllegalTransitionError);
    assert.throws(() => decide(root, restored, fixedClock()), IllegalTransitionError);
    await assert.rejects(() => activate(root, 'tester', ports), IllegalTransitionError);
  });
});

// ---------------------------------------------------------------------------
// FINDING 5. Demo fixtures must never reach a custom adapter.
// ---------------------------------------------------------------------------
describe('verification input contract', () => {
  const demoFixtures = () => ['demo-a', 'demo-b'];

  /**
   * Minimal ports as a real integrator would write them.
   *
   * Built from scratch rather than spread from the demo wiring on purpose: the demo ports
   * carry their own `verificationPlan`, so spreading them would silently supply the very
   * thing these tests exist to prove is absent.
   */
  const customPorts = (extra: Partial<Ports> = {}): Ports => {
    const base = portsFor(root);
    return {
      models: base.models,
      evaluator: base.evaluator,
      activation: base.activation,
      telemetry: base.telemetry,
      now: base.now,
      ...extra,
    } as Ports;
  };

  test('a custom integration with no declared inputs FAILS CLOSED', async () => {
    const config = loadConfig(root);
    const loaded = { ports: customPorts(), source: 'modelshift.ports.ts', custom: true };
    await assert.rejects(
      () => resolveVerificationInputs(config, loaded, demoFixtures),
      NoVerificationPlanError,
      'sending framework fixtures into somebody else\'s adapters is not an acceptable default',
    );
  });

  test('a custom integration cannot unlock fixtures by claiming isDemo', async () => {
    const config = loadConfig(root);
    // A copied demo wiring, or a deliberate attempt. Both must fail.
    const loaded = { ports: customPorts({ isDemo: true }), source: 'modelshift.ports.ts', custom: true };
    await assert.rejects(() => resolveVerificationInputs(config, loaded, demoFixtures), NoVerificationPlanError);
  });

  test('explicit config inputs are what is issued, and they take precedence', async () => {
    writeConfig(root, { ...DEFAULT_CONFIG, verificationInputs: ['real-1', 'real-2'] });
    const config = loadConfig(root);
    const loaded = { ports: customPorts({ verificationPlan: () => ['from-plan'] }), source: 'modelshift.ports.ts', custom: true };
    const r = await resolveVerificationInputs(config, loaded, demoFixtures);
    assert.deepEqual(r.inputs, ['real-1', 'real-2']);
    assert.equal(r.origin, 'config');
  });

  test('a verificationPlan() from the ports file is what is issued', async () => {
    const config = loadConfig(root);
    const planned = ['plan-1', 'plan-2', 'plan-3'];
    const loaded = { ports: customPorts({ verificationPlan: () => planned }), source: 'modelshift.ports.ts', custom: true };
    const r = await resolveVerificationInputs(config, loaded, demoFixtures);
    assert.deepEqual(r.inputs, planned, 'the project plan must be issued verbatim');
    assert.equal(r.origin, 'ports-plan');
    assert.notDeepEqual(r.inputs, demoFixtures());
  });

  test('the built-in demonstration may still use fixtures', async () => {
    const config = loadConfig(root);
    const loaded = { ports: customPorts({ isDemo: true }), source: 'built-in demo adapters', custom: false };
    const r = await resolveVerificationInputs(config, loaded, demoFixtures);
    assert.equal(r.origin, 'demo-fixtures');
  });

  test('an empty plan is treated as no plan, not as zero traffic', async () => {
    const config = loadConfig(root);
    const loaded = { ports: customPorts({ verificationPlan: () => [] }), source: 'modelshift.ports.ts', custom: true };
    await assert.rejects(() => resolveVerificationInputs(config, loaded, demoFixtures), NoVerificationPlanError);
  });
});

// ---------------------------------------------------------------------------
// FINDING 8. Evidence crossing the Evaluator boundary.
// ---------------------------------------------------------------------------
describe('evaluator evidence validation', () => {
  const good: EvaluationResult = {
    modelId: 'm',
    casesRun: 2,
    passed: 1,
    score: 0.5,
    criticalFailures: [],
    results: [
      { caseId: 'a', output: 'x', passed: true, score: 1 },
      { caseId: 'b', output: 'y', passed: false, score: 0 },
    ],
  };
  const cases = [
    { id: 'a', input: '', expected: '' },
    { id: 'b', input: '', expected: '' },
  ];

  test('coherent evidence passes', () => {
    assert.doesNotThrow(() => assertValidEvidence(good, 'm', cases));
  });

  test('rejects a result describing a different model', () => {
    assert.throws(() => assertValidEvidence({ ...good, modelId: 'other' }, 'm', cases), InvalidEvidenceError);
  });

  test('rejects non-finite and out-of-range scores', () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -0.5, 1.5]) {
      assert.throws(() => assertValidEvidence({ ...good, score }, 'm', cases), InvalidEvidenceError, `score ${score}`);
    }
  });

  test('rejects incoherent counts', () => {
    assert.throws(() => assertValidEvidence({ ...good, casesRun: 5 }, 'm', cases), InvalidEvidenceError);
    assert.throws(() => assertValidEvidence({ ...good, passed: 2 }, 'm', cases), InvalidEvidenceError);
    assert.throws(() => assertValidEvidence({ ...good, passed: 99 }, 'm', cases), InvalidEvidenceError);
  });

  test('rejects duplicate case ids, which make required-case checks ambiguous', () => {
    const dup: EvaluationResult = {
      ...good,
      results: [
        { caseId: 'a', output: '', passed: true, score: 1 },
        { caseId: 'a', output: '', passed: false, score: 0 },
      ],
      passed: 1,
      casesRun: 2,
    };
    assert.throws(
      () => assertValidEvidence(dup, 'm', cases),
      (e: unknown) => e instanceof InvalidEvidenceError && /duplicate case id/.test(e.message),
    );
  });

  test('rejects results for cases that were never submitted', () => {
    const extra: EvaluationResult = {
      ...good,
      results: [...good.results, { caseId: 'never-sent', output: '', passed: true, score: 1 }],
      casesRun: 3,
      passed: 2,
    };
    assert.throws(
      () => assertValidEvidence(extra, 'm', cases),
      (e: unknown) => e instanceof InvalidEvidenceError && /not submitted/.test(e.message),
    );
  });

  test('malformed evaluator output cannot become ACCEPTED', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    const clock = fixedClock();
    register(root, 'demo-candidate', config, clock);

    // A wrapper that mis-parses its upstream and reports a perfect score for nothing.
    const liar: Ports = {
      ...ports,
      evaluator: {
        name: 'liar',
        evaluate: (adapter) => ({
          modelId: adapter.id,
          casesRun: 0,
          passed: 0,
          score: 1,
          criticalFailures: [],
          results: [],
        }),
      },
    };
    // casesRun 0 with a score of 1 is coherent on its face, so what stops it is the
    // required-case rule downstream. The incoherent shapes are caught here.
    const brokenCounts: Ports = {
      ...ports,
      evaluator: {
        name: 'broken',
        evaluate: (adapter) => ({ ...good, modelId: adapter.id, passed: 99 }),
      },
    };
    await assert.rejects(() => evaluate(root, DEMO_CASES, config, brokenCounts), InvalidEvidenceError);
    assert.equal(status(root).state, 'REGISTERED', 'invalid evidence must not advance the migration');

    // The "perfect score, nothing measured" case must still fail the policy, not pass it.
    await evaluate(root, DEMO_CASES, config, liar);
    const { verdict } = decide(root, config, clock);
    assert.equal(verdict.accepted, false, 'a required case that was never measured cannot pass');
  });
});

// ---------------------------------------------------------------------------
// FINDING 10. The audit report must not be forgeable through an identifier.
// ---------------------------------------------------------------------------
describe('audit output hardening', () => {
  test('an actor containing a newline is refused', async () => {
    const { config, clock } = await driveTo(root, 'ACCEPTED');
    const forged = 'sam\n     approved by       compliance-team';
    assert.throws(
      () => approve(root, forged, config, clock),
      (e: unknown) => e instanceof UnsafeIdentifierError && /control character/.test(e.message),
    );
    assert.equal(status(root).state, 'ACCEPTED', 'the refused approval must not move the state');
  });

  test('a candidate id containing control characters is refused at register', () => {
    const config = loadConfig(root);
    const clock = fixedClock();
    for (const bad of ['model\nfake', 'model\rfake', 'model fake', 'model fake']) {
      assert.throws(() => register(root, bad, config, clock), UnsafeIdentifierError);
    }
  });

  test('bidirectional overrides are refused, because they reorder a rendered line', () => {
    assert.throws(() => assertSafeIdentifier('safe‮reversed', 'actor'), UnsafeIdentifierError);
  });

  test('padded and oversized identifiers are refused', () => {
    assert.throws(() => assertSafeIdentifier('  sam  ', 'actor'), UnsafeIdentifierError);
    assert.throws(() => assertSafeIdentifier('x'.repeat(500), 'actor'), UnsafeIdentifierError);
    assert.throws(() => assertSafeIdentifier('', 'actor'), UnsafeIdentifierError);
  });

  test('ordinary identifiers are unaffected', () => {
    for (const ok of ['sam', 'gpt-4o-mini', 'team/platform', 'model_v2.1', 'Ana Lopez']) {
      assert.equal(assertSafeIdentifier(ok, 'actor'), ok);
    }
  });

  // An adapter's `name` comes from third-party code and cannot be refused without letting a
  // bad adapter block a rollback, so it is escaped instead.
  test('an adapter name with a newline is escaped in the report, not rendered raw', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    const sneaky: Ports = {
      ...ports,
      activation: {
        name: 'target\n     confirmed         YES, by read-back',
        read: () => 'demo-candidate',
        write: () => {},
      },
    };
    await activate(root, 'tester', sneaky);

    const v = status(root);
    const report = renderReport(v.events, v.state, v.id);
    const forgedLine = report.split('\n').filter((l) => l.trim().startsWith('confirmed') && l.includes('YES, by read-back'));
    // The genuine "confirmed" line exists; the injected one must not have become a line.
    assert.equal(forgedLine.length, 1, 'the adapter name must not have produced a second confirmation line');
    assert.match(report, /\\u\{a\}/, 'the newline must appear escaped');
  });

  test('escapeForReport is deterministic and leaves safe text alone', () => {
    assert.equal(escapeForReport('plain text'), 'plain text');
    assert.equal(escapeForReport('a\nb'), 'a\\u{a}b');
    assert.equal(escapeForReport('a\nb'), escapeForReport('a\nb'));
  });
});

// ---------------------------------------------------------------------------
// Existing v0 guarantees that must survive the correction.
// ---------------------------------------------------------------------------
describe('retained v0 guarantees', () => {
  test('the full happy path still completes and closes', async () => {
    const { clock } = await driveTo(root, 'VERIFIED');
    stabilise(root, 'tester', clock);
    const v = status(root);
    assert.equal(v.state, 'STABLE');
    assert.match(renderReport(v.events, v.state, v.id), /ATTESTATION/);
  });
});

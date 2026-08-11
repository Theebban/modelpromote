// Unit-level tests for the pieces the invariant suite exercises only indirectly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeRoot, removeRoot, portsFor } from './helpers.ts';
import { MIGRATION_ACTIONS, MIGRATION_STATES, type MigrationState } from '../src/domain/types.ts';
import { TRANSITIONS, nextState, foldState, statesPermitting } from '../src/domain/machine.ts';
import { IllegalTransitionError, ConfigError, VerificationBoundsError } from '../src/domain/errors.ts';
import { parseConfig, policyHash, DEFAULT_CONFIG } from '../src/config.ts';
import { evaluateAcceptance } from '../src/policy/acceptance.ts';
import { runBoundedVerification, assertServingModelInWindow } from '../src/verify/index.ts';
import { demoBaseline, exactMatchEvaluator } from '../src/adapters/local/index.ts';
import type { ComparativeEvaluation } from '../src/domain/types.ts';

let root: string;
beforeEach(() => {
  root = makeRoot();
});
afterEach(() => {
  removeRoot(root);
});

describe('state machine', () => {
  test('every action in the table maps only to declared states', () => {
    for (const action of MIGRATION_ACTIONS) {
      for (const [from, to] of Object.entries(TRANSITIONS[action])) {
        assert.ok(MIGRATION_STATES.includes(from as MigrationState), `unknown from-state ${from}`);
        assert.ok(MIGRATION_STATES.includes(to as MigrationState), `unknown to-state ${to}`);
      }
    }
  });

  test('every state is reachable as a transition target, or is the entry state', () => {
    const targets = new Set<string>(['REGISTERED']);
    for (const action of MIGRATION_ACTIONS) {
      for (const to of Object.values(TRANSITIONS[action])) targets.add(to);
    }
    for (const s of MIGRATION_STATES) {
      assert.ok(targets.has(s), `state ${s} is declared but no transition produces it`);
    }
  });

  test('the table is an allow-list: unlisted pairs are refused', () => {
    let refused = 0;
    let allowed = 0;
    for (const state of MIGRATION_STATES) {
      for (const action of MIGRATION_ACTIONS) {
        if (action === 'register') continue;
        const legal = TRANSITIONS[action][state] !== undefined;
        if (legal) {
          allowed += 1;
          assert.doesNotThrow(() => nextState(state, action));
        } else {
          refused += 1;
          assert.throws(() => nextState(state, action), IllegalTransitionError);
        }
      }
    }
    // A non-empty denominator in both directions: the table must actually discriminate.
    assert.ok(allowed > 0, 'no legal transitions found, the table is empty');
    assert.ok(refused > allowed, 'an allow-list should refuse far more pairs than it permits');
  });

  test('terminal states permit no forward action', () => {
    for (const action of ['evaluate', 'accept', 'approve', 'beginActivation', 'verify'] as const) {
      assert.throws(() => nextState('ROLLED_BACK', action), IllegalTransitionError);
      assert.throws(() => nextState('STABLE', action), IllegalTransitionError);
    }
  });

  test('rollback fails OPEN from every state where something could be live', () => {
    for (const s of ['ACTIVATED', 'VERIFIED', 'FAILED_VERIFICATION', 'STABLE'] as const) {
      assert.equal(nextState(s, 'beginRollback'), 'ROLLING_BACK', `rollback must stay available from ${s}`);
    }
  });

  test('rollback is NOT available before anything is live', () => {
    for (const s of ['REGISTERED', 'EVALUATED', 'ACCEPTED', 'APPROVED'] as const) {
      assert.throws(() => nextState(s, 'beginRollback'), IllegalTransitionError);
    }
  });

  test('an empty ledger folds to null, never to a usable default', () => {
    assert.equal(foldState([]), null);
  });

  test('the error names the states that would make the action legal', () => {
    try {
      nextState('REGISTERED', 'beginActivation');
      assert.fail('expected a refusal');
    } catch (e) {
      assert.ok(e instanceof IllegalTransitionError);
      assert.deepEqual(e.requiredStates, ['APPROVED']);
      assert.deepEqual(statesPermitting('beginActivation'), ['APPROVED']);
    }
  });
});

describe('configuration', () => {
  test('rejects a missing acceptance policy', () => {
    assert.throws(() => parseConfig({ baselineModel: 'a', rollbackModel: 'a', verification: {} }), ConfigError);
  });

  test('rejects out-of-range and non-integer values', () => {
    const base = { baselineModel: 'a', rollbackModel: 'a', acceptance: { minScore: 0.8, maxRegression: 0.1 }, verification: { maxRequests: 1, minObservations: 1 } };
    assert.throws(() => parseConfig({ ...base, acceptance: { minScore: 1.5, maxRegression: 0.1 } }), ConfigError);
    assert.throws(() => parseConfig({ ...base, acceptance: { minScore: -1, maxRegression: 0.1 } }), ConfigError);
    assert.throws(() => parseConfig({ ...base, verification: { maxRequests: 0, minObservations: 1 } }), ConfigError);
    assert.throws(() => parseConfig({ ...base, verification: { maxRequests: 2.5, minObservations: 1 } }), ConfigError);
    assert.throws(() => parseConfig({ ...base, baselineModel: '' }), ConfigError);
  });

  test('accepts the default configuration it ships', () => {
    assert.doesNotThrow(() => parseConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG))));
  });

  test('the policy hash changes when any rule moves, and is order-independent', () => {
    const a = DEFAULT_CONFIG.acceptance;
    assert.notEqual(policyHash(a), policyHash({ ...a, minScore: 0.81 }));
    assert.notEqual(policyHash(a), policyHash({ ...a, maxRegression: 0.06 }));
    assert.notEqual(policyHash(a), policyHash({ ...a, allowCriticalFailures: true }));
    assert.equal(
      policyHash({ ...a, requiredCases: ['x', 'y'] }),
      policyHash({ ...a, requiredCases: ['y', 'x'] }),
      'reordering the same rules must not look like a policy change',
    );
  });
});

describe('acceptance policy', () => {
  const evaluation = (score: number, delta: number, results: { caseId: string; passed: boolean }[] = [], critical: string[] = []): ComparativeEvaluation => ({
    baseline: { modelId: 'b', casesRun: 1, passed: 1, score: score - delta, criticalFailures: [], results: [] },
    candidate: {
      modelId: 'c',
      casesRun: results.length || 1,
      passed: results.filter((r) => r.passed).length,
      score,
      criticalFailures: critical,
      results: results.map((r) => ({ caseId: r.caseId, output: '', passed: r.passed, score: r.passed ? 1 : 0 })),
    },
    delta,
    caseSetHash: 'test',
    governingPolicyHash: 'test-policy',
  });

  test('lists every failing rule, not only the first', () => {
    const v = evaluateAcceptance(evaluation(0.1, -0.5, [{ caseId: 'req', passed: false }], ['boom']), {
      minScore: 0.9,
      maxRegression: 0.01,
      requiredCases: ['req'],
      allowCriticalFailures: false,
    });
    assert.equal(v.accepted, false);
    assert.equal(v.reasons.length, 4, 'all four rules failed and all four should be reported');
  });

  test('a required case missing from the case set counts as a failure', () => {
    const v = evaluateAcceptance(evaluation(1, 0.1, [{ caseId: 'other', passed: true }]), {
      minScore: 0,
      maxRegression: 1,
      requiredCases: ['never-measured'],
      allowCriticalFailures: true,
    });
    assert.equal(v.accepted, false, '"not measured" must not read as "passed"');
    assert.match(v.reasons.join(' '), /never-measured/);
  });

  test('an improvement is not treated as a regression', () => {
    const v = evaluateAcceptance(evaluation(1, 0.5), { minScore: 0.5, maxRegression: 0, requiredCases: [], allowCriticalFailures: true });
    assert.equal(v.accepted, true, 'a positive delta must not consume the regression budget');
  });

  test('records every check that ran, passing or failing', () => {
    const v = evaluateAcceptance(evaluation(1, 0), DEFAULT_CONFIG.acceptance);
    assert.equal(v.checks.length, 4, 'the record must show what was checked, not only what failed');
  });
});

describe('bounded verification', () => {
  test('rejects invalid bounds itself, before issuing any request', async () => {
    let calls = 0;
    const counting = { id: 'x', complete: () => { calls += 1; return 'y'; } };
    await assert.rejects(
      () => runBoundedVerification(['a', 'b'], counting, { maxRequests: 0, minObservations: 1 }),
      VerificationBoundsError,
    );
    await assert.rejects(
      () => runBoundedVerification(['a', 'b'], counting, { maxRequests: 2.5, minObservations: 1 }),
      VerificationBoundsError,
    );
    await assert.rejects(
      () => runBoundedVerification(['a', 'b'], counting, { maxRequests: 2, minObservations: 0 }),
      VerificationBoundsError,
    );
    assert.equal(calls, 0, 'invalid bounds must produce no model calls at all');
  });

  test('completes the plan when the ceiling exceeds the input count', async () => {
    const r = await runBoundedVerification(['a', 'b'], demoBaseline, { maxRequests: 10, minObservations: 1 });
    assert.equal(r.stoppedBy, 'plan-complete');
    assert.equal(r.requestsMade, 2);
    assert.equal(r.truncated, false);
  });

  test('the ceiling is counted by the loop, proven by counting real calls', async () => {
    let calls = 0;
    const counting = { id: 'x', complete: () => { calls += 1; return 'y'; } };
    const r = await runBoundedVerification(['a', 'b', 'c', 'd', 'e'], counting, { maxRequests: 2, minObservations: 1 });
    assert.equal(calls, 2, 'the adapter must be called exactly maxRequests times');
    assert.equal(r.stoppedBy, 'ceiling');
    assert.equal(r.truncated, true);
    assert.equal(r.requestsAvailable, 5);
  });
});

describe('telemetry assertion', () => {
  const bounds = { maxRequests: 5, minObservations: 2 };
  const src = (rows: { requestId: string; servedBy: string }[]) => ({ name: 't', observations: () => rows });

  test('confirms only when every observation is the expected model', async () => {
    const a = await assertServingModelInWindow(src([{ requestId: '1', servedBy: 'm' }, { requestId: '2', servedBy: 'm' }]), 'm', bounds);
    assert.equal(a.confirmed, true);
  });

  test('an empty set is not confirmation', async () => {
    const a = await assertServingModelInWindow(src([]), 'm', bounds);
    assert.equal(a.confirmed, false);
    assert.equal(a.observationCount, 0);
  });

  test('scopes to observations after the marker', async () => {
    const rows = [
      { requestId: 'old', servedBy: 'other-model' },
      { requestId: 'n1', servedBy: 'm' },
      { requestId: 'n2', servedBy: 'm' },
    ];
    const scoped = { name: 't', observations: (since: string | null) => {
      if (since === null) return rows;
      const i = rows.findIndex((r) => r.requestId === since);
      return i === -1 ? rows : rows.slice(i + 1);
    } };
    const unscoped = await assertServingModelInWindow(scoped, 'm', bounds, null);
    assert.equal(unscoped.confirmed, false, 'stale observations must not be counted');
    const marked = await assertServingModelInWindow(scoped, 'm', bounds, 'old');
    assert.equal(marked.confirmed, true);
  });
});

describe('reference evaluator', () => {
  test('an empty case set scores 0, never 1', async () => {
    const r = await exactMatchEvaluator.evaluate(demoBaseline, []);
    assert.equal(r.score, 0, '"nothing measured" must not read as "perfect"');
    assert.equal(r.casesRun, 0);
  });

  test('ports wiring resolves the demo models', () => {
    const ports = portsFor(root);
    assert.ok(ports.models.has('demo-baseline'));
    assert.ok(ports.models.has('demo-candidate'));
  });
});

// CROSS-EVENT INTEGRITY.
//
// Each of these corresponds to a defect found by the SECOND independent review. The first
// review proved every state transition had to be legal; this suite proves that the evidence
// and the identities carried across those transitions describe the same migration.
//
// Every tampering test below changes exactly ONE field and leaves the sequence, the chain
// and the (action, from, to) triple untouched, because that is precisely the shape the
// earlier three layers cannot see.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import {
  makeRoot,
  removeRoot,
  portsFor,
  fixedClock,
  driveTo,
  editDetail,
  editLedger,
} from './helpers.ts';
import { loadConfig, writeConfig, DEFAULT_CONFIG } from '../src/config.ts';
import {
  BaselineDriftError,
  InvalidEvidenceError,
  LedgerCorruptError,
} from '../src/domain/errors.ts';
import { activate, approve, decide, evaluate, register, rollback, status, statusOf, verify } from '../src/engine.ts';
import { DEMO_CASES, DEMO_VERIFICATION_INPUTS } from '../src/adapters/local/fixtures.ts';
import { migrationPath, migrationsDir, listMigrations, readMigration } from '../src/store/ledger.ts';
import { assertValidCaseSet, assertValidEvidence, caseSetProblems } from '../src/policy/evidence.ts';
import { assertServingModelInWindow } from '../src/verify/index.ts';
import type { EvaluationCase, EvaluationResult } from '../src/domain/types.ts';
import type { Ports } from '../src/ports/index.ts';

let root: string;
beforeEach(() => {
  root = makeRoot();
});
afterEach(() => {
  removeRoot(root);
});

const activePath = (r: string) => migrationPath(r, '0001');

/** Every tampering test asserts this exact shape: a cross-event refusal, on a named record. */
function isCrossEventRefusal(e: unknown): boolean {
  return e instanceof LedgerCorruptError && /cross-event inconsistency/.test(e.message);
}

// ---------------------------------------------------------------------------
// FINDING 1. Partial evaluator coverage must not pass as full coverage.
// ---------------------------------------------------------------------------
describe('evaluator completeness: exactly one result per submitted case', () => {
  const five: readonly EvaluationCase[] = [
    { id: 'c1', input: 'a', expected: 'a' },
    { id: 'c2', input: 'b', expected: 'b' },
    { id: 'c3', input: 'c', expected: 'c' },
    { id: 'c4', input: 'd', expected: 'd' },
    { id: 'c5', input: 'e', expected: 'e' },
  ];

  const resultFor = (ids: readonly string[]): EvaluationResult => ({
    modelId: 'm',
    casesRun: ids.length,
    passed: ids.length,
    score: 1,
    criticalFailures: [],
    results: ids.map((id) => ({ caseId: id, output: 'x', passed: true, score: 1 })),
  });

  test('five submitted cases and ONE coherent returned result is refused', () => {
    // The exact shape the review submitted: internally coherent, perfectly scored, and
    // describing a fifth of the case set the record would claim.
    const partial = resultFor(['c1']);
    assert.throws(
      () => assertValidEvidence(partial, 'm', five),
      (e: unknown) => e instanceof InvalidEvidenceError && /no result for 4 of 5 submitted case/.test(e.message),
    );
  });

  test('a single missing case is refused, not rounded off', () => {
    assert.throws(
      () => assertValidEvidence(resultFor(['c1', 'c2', 'c3', 'c4']), 'm', five),
      (e: unknown) => e instanceof InvalidEvidenceError && /no result for 1 of 5 submitted case\(s\): c5/.test(e.message),
    );
  });

  test('exact coverage passes, so the rule is not simply refusing everything', () => {
    assert.doesNotThrow(() => assertValidEvidence(resultFor(['c1', 'c2', 'c3', 'c4', 'c5']), 'm', five));
  });

  test('a duplicate SUBMITTED case id is refused before anything is measured', () => {
    const dup = [...five, { id: 'c3', input: 'z', expected: 'z' }];
    assert.throws(
      () => assertValidCaseSet(dup),
      (e: unknown) => e instanceof InvalidEvidenceError && /duplicate submitted case id\(s\).*c3/s.test(e.message),
    );
  });

  test('submitted cases must have non-empty string ids, inputs and expected values', () => {
    assert.ok(caseSetProblems([{ id: '', input: 'a', expected: 'b' }]).some((p) => /missing or empty id/.test(p)));
    assert.ok(caseSetProblems([{ id: 'x', input: 1 as unknown as string, expected: 'b' }]).some((p) => /non-string input/.test(p)));
    assert.ok(caseSetProblems([{ id: 'x', input: 'a', expected: null as unknown as string }]).some((p) => /non-string expected/.test(p)));
    assert.ok(caseSetProblems([]).some((p) => /empty/.test(p)));
    assert.deepEqual(caseSetProblems(five), [], 'a well-formed case set must produce no problems');
  });

  test('a partial evaluator cannot drive a migration to ACCEPTED', async () => {
    const config = loadConfig(root);
    const ports = portsFor(root);
    register(root, 'demo-candidate', config, fixedClock());

    // Measures the first case only, and reports a coherent perfect result for it.
    const lazy: Ports = {
      ...ports,
      evaluator: {
        name: 'measures-one',
        evaluate: (adapter) => ({
          modelId: adapter.id,
          casesRun: 1,
          passed: 1,
          score: 1,
          criticalFailures: [],
          results: [{ caseId: DEMO_CASES[0]!.id, output: 'x', passed: true, score: 1 }],
        }),
      },
    };

    await assert.rejects(() => evaluate(root, DEMO_CASES, config, lazy), InvalidEvidenceError);
    assert.equal(status(root).state, 'REGISTERED', 'partial coverage must not advance the migration');
  });

  test('a duplicate submitted case id is refused end to end, before the evaluator runs', async () => {
    const config = loadConfig(root);
    let evaluatorCalls = 0;
    const counting: Ports = {
      ...portsFor(root),
      evaluator: {
        name: 'counting',
        evaluate: (adapter) => {
          evaluatorCalls += 1;
          return { modelId: adapter.id, casesRun: 0, passed: 0, score: 0, criticalFailures: [], results: [] };
        },
      },
    };
    register(root, 'demo-candidate', config, fixedClock());
    await assert.rejects(
      () => evaluate(root, [...DEMO_CASES, DEMO_CASES[0]!], config, counting),
      InvalidEvidenceError,
    );
    assert.equal(evaluatorCalls, 0, 'an ambiguous case set must be refused before anything is measured');
  });
});

// ---------------------------------------------------------------------------
// FINDING 2. Candidate identity must be bound across events.
// ---------------------------------------------------------------------------
describe('migration identity is bound across every event', () => {
  test('THE PROBE: a one-field candidate edit on the register record is refused', async () => {
    await driveTo(root, 'APPROVED');
    // Exactly the review's edit. No action, no from, no to, no sequence change.
    assert.equal(editDetail(activePath(root), 'register', 'candidate', 'demo-regression'), 1);

    assert.throws(() => status(root), isCrossEventRefusal);
  });

  test('the substituted candidate cannot be activated, and nothing is written', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    editDetail(activePath(root), 'register', 'candidate', 'demo-regression');
    // Snapshot AFTER the tampering: the question is whether the refused activation adds
    // anything, not whether the file changed at all.
    const before = readFileSync(activePath(root), 'utf8');
    const servingBefore = await ports.activation.read();

    await assert.rejects(() => activate(root, 'tester', ports), LedgerCorruptError);

    assert.equal(await ports.activation.read(), servingBefore, 'the outside world must be untouched');
    assert.equal(readFileSync(activePath(root), 'utf8'), before, 'the ledger must gain no record');
  });

  test('a one-field baseline edit on the register record is refused', async () => {
    await driveTo(root, 'APPROVED');
    editDetail(activePath(root), 'register', 'baseline', 'demo-regression');
    assert.throws(() => status(root), isCrossEventRefusal);
  });

  test('an evaluation naming a different candidate than the register record is refused', async () => {
    await driveTo(root, 'ACCEPTED');
    editLedger(
      activePath(root),
      (e) => e['action'] === 'evaluate',
      (e) => {
        const detail = e['detail'] as Record<string, unknown>;
        const evaluation = detail['evaluation'] as Record<string, unknown>;
        const candidate = evaluation['candidate'] as Record<string, unknown>;
        return { ...e, detail: { ...detail, evaluation: { ...evaluation, candidate: { ...candidate, modelId: 'demo-regression' } } } };
      },
    );
    assert.throws(
      () => status(root),
      (e: unknown) => isCrossEventRefusal(e) && /demo-regression.*registered "demo-candidate"/s.test((e as Error).message),
    );
  });

  test('an evaluation naming a different baseline than the register record is refused', async () => {
    await driveTo(root, 'ACCEPTED');
    editLedger(
      activePath(root),
      (e) => e['action'] === 'evaluate',
      (e) => {
        const detail = e['detail'] as Record<string, unknown>;
        const evaluation = detail['evaluation'] as Record<string, unknown>;
        const baseline = evaluation['baseline'] as Record<string, unknown>;
        return { ...e, detail: { ...detail, evaluation: { ...evaluation, baseline: { ...baseline, modelId: 'demo-regression' } } } };
      },
    );
    assert.throws(() => status(root), isCrossEventRefusal);
  });

  test('an activation intent naming a model other than the registered candidate is refused', async () => {
    await driveTo(root, 'ACTIVATED');
    editDetail(activePath(root), 'beginActivation', 'requestedModel', 'demo-regression');
    assert.throws(() => statusOf(root, '0001'), isCrossEventRefusal);
  });

  test('a confirmed activation whose observed model was edited is refused', async () => {
    await driveTo(root, 'ACTIVATED');
    editDetail(activePath(root), 'confirmActivation', 'observedModel', 'demo-regression');
    assert.throws(() => statusOf(root, '0001'), isCrossEventRefusal);
  });

  test('a verdict whose accepted flag contradicts its own action is refused', async () => {
    await driveTo(root, 'ACCEPTED');
    editLedger(
      activePath(root),
      (e) => e['action'] === 'accept',
      (e) => {
        const detail = e['detail'] as Record<string, unknown>;
        const verdict = detail['verdict'] as Record<string, unknown>;
        return { ...e, detail: { ...detail, verdict: { ...verdict, accepted: false } } };
      },
    );
    assert.throws(() => status(root), isCrossEventRefusal);
  });

  test('a verdict applied under a policy the evidence never named is refused', async () => {
    await driveTo(root, 'ACCEPTED');
    editDetail(activePath(root), 'accept', 'policyHash', 'ffffffffffffffff');
    assert.throws(
      () => status(root),
      (e: unknown) => isCrossEventRefusal(e) && /applied policy/.test((e as Error).message),
    );
  });

  test('an approval whose recorded approver does not match its actor is refused', async () => {
    await driveTo(root, 'APPROVED');
    editDetail(activePath(root), 'approve', 'approvedBy', 'compliance-team');
    assert.throws(
      () => status(root),
      (e: unknown) => isCrossEventRefusal(e) && /records approval by "compliance-team" under actor "operator:tester"/.test((e as Error).message),
    );
  });

  test('a machine verdict cannot be re-attributed to a human', async () => {
    await driveTo(root, 'ACCEPTED');
    editLedger(activePath(root), (e) => e['action'] === 'accept', (e) => ({ ...e, actor: 'operator:sam' }));
    assert.throws(
      () => status(root),
      (e: unknown) => isCrossEventRefusal(e) && /machine action recorded with actor/.test((e as Error).message),
    );
  });

  test('a doctored evaluation delta is refused', async () => {
    await driveTo(root, 'ACCEPTED');
    editLedger(
      activePath(root),
      (e) => e['action'] === 'evaluate',
      (e) => {
        const detail = e['detail'] as Record<string, unknown>;
        const evaluation = detail['evaluation'] as Record<string, unknown>;
        return { ...e, detail: { ...detail, evaluation: { ...evaluation, delta: 0.9 } } };
      },
    );
    assert.throws(() => status(root), isCrossEventRefusal);
  });

  test('an untampered ledger passes every cross-event check at each stage', async () => {
    // The positive control. Without it a validator that refused everything would look
    // identical to a validator that works.
    for (const stage of ['REGISTERED', 'EVALUATED', 'ACCEPTED', 'APPROVED', 'ACTIVATED', 'VERIFIED'] as const) {
      const r = makeRoot();
      try {
        await driveTo(r, stage);
        assert.doesNotThrow(() => statusOf(r, '0001'), `a clean ledger at ${stage} must load`);
        assert.equal(statusOf(r, '0001').state, stage);
      } finally {
        removeRoot(r);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FINDING 3. The rollback target is locked when the migration begins.
// ---------------------------------------------------------------------------
describe('rollback target authority', () => {
  test('a config edit cannot redirect a rollback onto another model', async () => {
    const { ports } = await driveTo(root, 'ACTIVATED');

    // The review's exact move: point rollbackModel at a regressing model, then roll back.
    writeConfig(root, { ...DEFAULT_CONFIG, rollbackModel: 'demo-regression' });
    const drifted = loadConfig(root);

    const r = await rollback(root, 'tester', drifted, ports);

    assert.equal(r.target, 'demo-baseline', 'the LOCKED target must win');
    assert.equal(r.observed, 'demo-baseline');
    assert.equal(await ports.activation.read(), 'demo-baseline', 'production must not be redirected');
    assert.equal(status(root).state, 'ROLLED_BACK');
  });

  test('the drift is reported, not silently absorbed', async () => {
    const { ports } = await driveTo(root, 'ACTIVATED');
    writeConfig(root, { ...DEFAULT_CONFIG, rollbackModel: 'demo-regression' });
    const r = await rollback(root, 'tester', loadConfig(root), ports);

    assert.equal(r.configDrift, true);
    assert.equal(r.configuredTarget, 'demo-regression');

    const begin = readMigration(root, '0001').find((e) => e.action === 'beginRollback');
    assert.equal(begin?.detail['configuredRollbackModel'], 'demo-regression', 'both values belong in the record');
    assert.equal(begin?.detail['target'], 'demo-baseline');
  });

  test('no drift is reported when configuration still agrees', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    const r = await rollback(root, 'tester', config, ports);
    assert.equal(r.configDrift, false, 'the drift flag must discriminate, not always fire');
    const begin = readMigration(root, '0001').find((e) => e.action === 'beginRollback');
    assert.equal(begin?.detail['configDrift'], undefined);
  });

  test('a hand-edited rollback target in the ledger is refused', async () => {
    const { config, ports } = await driveTo(root, 'ACTIVATED');
    await rollback(root, 'tester', config, ports);
    editDetail(activePath(root), 'beginRollback', 'target', 'demo-regression');
    assert.throws(() => statusOf(root, '0001'), isCrossEventRefusal);
  });

  test('the locked target is what the report shows, and it is labelled as locked', async () => {
    await driveTo(root, 'REGISTERED');
    const v = status(root);
    assert.equal(v.rollbackTarget, 'demo-baseline');
    assert.equal(v.events[0]?.detail['rollbackTarget'], 'demo-baseline');
  });
});

// ---------------------------------------------------------------------------
// FINDING 4. Production baseline drift blocks activation, before any side effect.
// ---------------------------------------------------------------------------
describe('production baseline drift fails closed', () => {
  test('activation is refused when production is not serving the evaluated baseline', async () => {
    const { ports } = await driveTo(root, 'APPROVED');

    // Production moved underneath the migration. The evidence still describes a change
    // FROM demo-baseline, which is no longer the change that would be made.
    await ports.activation.write('demo-regression');

    await assert.rejects(
      () => activate(root, 'tester', ports),
      (e: unknown) =>
        e instanceof BaselineDriftError &&
        e.migrationBaseline === 'demo-baseline' &&
        e.observedServing === 'demo-regression' &&
        e.candidate === 'demo-candidate' &&
        /Safe next action/.test(e.message),
    );
  });

  test('NOTHING is written: no activation event and no external write', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    await ports.activation.write('demo-regression');

    const eventsBefore = readMigration(root, '0001').length;
    const bytesBefore = readFileSync(activePath(root), 'utf8');

    let writes = 0;
    const counting = {
      ...ports,
      activation: {
        name: 'counting',
        read: () => 'demo-regression',
        write: () => {
          writes += 1;
        },
      },
    };

    await assert.rejects(() => activate(root, 'tester', counting), BaselineDriftError);

    assert.equal(writes, 0, 'the activation target must not be written to');
    assert.equal(readMigration(root, '0001').length, eventsBefore, 'no intent event may be recorded');
    assert.equal(readFileSync(activePath(root), 'utf8'), bytesBefore);
    assert.equal(status(root).state, 'APPROVED', 'the migration must stay exactly where it was');
  });

  test('the baseline is never silently updated to match production', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    await ports.activation.write('demo-regression');
    await assert.rejects(() => activate(root, 'tester', ports), BaselineDriftError);
    assert.equal(status(root).baseline, 'demo-baseline', 'the recorded baseline must not move');
    assert.equal(loadConfig(root).baselineModel, 'demo-baseline');
  });

  test('activation proceeds normally when production IS serving the baseline', async () => {
    const { ports } = await driveTo(root, 'APPROVED');
    const r = await activate(root, 'tester', ports);
    assert.equal(r.confirmed, true, 'the gate must discriminate, not block everything');
    assert.equal(status(root).state, 'ACTIVATED');
  });

  test('closing a migration without updating baselineModel blocks the NEXT activation', async () => {
    // The realistic case. After STABLE the candidate is the new baseline in fact, but the
    // config still names the old one, and the next migration would be measured against a
    // model that is not running. Refusing is the honest outcome.
    const { config, ports, clock } = await driveTo(root, 'VERIFIED');
    const { stabilise } = await import('../src/engine.ts');
    stabilise(root, 'tester', clock);

    register(root, 'demo-candidate', config, clock);
    await evaluate(root, DEMO_CASES, config, ports);
    decide(root, config, clock);
    approve(root, 'tester', config, clock);

    await assert.rejects(
      () => activate(root, 'tester', ports),
      (e: unknown) => e instanceof BaselineDriftError && e.observedServing === 'demo-candidate',
    );
  });
});

// ---------------------------------------------------------------------------
// FINDING 5. The public verdict projection must mean the CURRENT verdict.
// ---------------------------------------------------------------------------
describe('MigrationView.verdict is the verdict in force', () => {
  test('a rejection after an acceptance is not masked by the earlier acceptance', async () => {
    // The review's reproduction, through the public library surface.
    await driveTo(root, 'ACCEPTED');
    assert.equal(status(root).verdict?.accepted, true);

    // Move the policy so the candidate can no longer pass. A required case that is not in
    // the case set fails by design: "not measured" must never read as "passed".
    writeConfig(root, {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, requiredCases: ['a-case-nobody-measured'] },
    });
    const strict = loadConfig(root);
    const ports = portsFor(root);
    await evaluate(root, DEMO_CASES, strict, ports);
    const { verdict } = decide(root, strict, fixedClock());

    assert.equal(verdict.accepted, false, 'the fixture must actually produce a rejection');
    assert.equal(status(root).state, 'REJECTED');
    assert.equal(status(root).verdict?.accepted, false, 'the projection must follow the record, not prefer acceptance');
  });

  test('a re-evaluation clears the verdict rather than leaving a superseded one standing', async () => {
    await driveTo(root, 'ACCEPTED');
    writeConfig(root, { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, minScore: 0.1 } });
    const moved = loadConfig(root);
    await evaluate(root, DEMO_CASES, moved, portsFor(root));

    assert.equal(status(root).state, 'EVALUATED');
    assert.equal(status(root).verdict, null, 'evidence that has been replaced carries no verdict');
  });

  test('the acceptance is still projected while it is the verdict in force', async () => {
    await driveTo(root, 'APPROVED');
    assert.equal(status(root).verdict?.accepted, true, 'the projection must not simply return null');
  });

  test('a rejection is projected as a rejection with no acceptance anywhere in the history', async () => {
    const config = loadConfig(root);
    const clock = fixedClock();
    register(root, 'demo-regression', config, clock);
    await evaluate(root, DEMO_CASES, config, portsFor(root));
    decide(root, config, clock);
    assert.equal(status(root).verdict?.accepted, false);
  });
});

// ---------------------------------------------------------------------------
// FINDING 6. Registration is atomic, and an interrupted one cannot wedge a project.
// ---------------------------------------------------------------------------
describe('registration atomicity', () => {
  test('an empty migration file, the interrupted-creation state, does not wedge register', async () => {
    // Exactly the state the review produced: the file exists, no record was ever appended.
    mkdirSync(migrationsDir(root), { recursive: true });
    writeFileSync(activePath(root), '', 'utf8');

    const config = loadConfig(root);
    const { id } = register(root, 'demo-candidate', config, fixedClock());

    assert.equal(id, '0001', 'the reclaimed id must be reused, not skipped forever');
    assert.equal(status(root).state, 'REGISTERED');
    assert.equal(readMigration(root, '0001').length, 1);
  });

  test('an empty migration file is not reported as an active migration', () => {
    mkdirSync(migrationsDir(root), { recursive: true });
    writeFileSync(activePath(root), '', 'utf8');
    assert.deepEqual(listMigrations(root), [], 'a file with no register record is not a migration');
  });

  test('register writes ONE complete record, never an empty file first', async () => {
    const config = loadConfig(root);
    register(root, 'demo-candidate', config, fixedClock());

    const raw = readFileSync(activePath(root), 'utf8');
    assert.equal(raw.trim().split('\n').length, 1);
    const first = JSON.parse(raw.trim()) as Record<string, unknown>;
    assert.equal(first['seq'], 1);
    assert.equal(first['action'], 'register');
    assert.deepEqual(Object.keys(first['detail'] as object).sort(), [
      'baseline',
      'candidate',
      'policyHashAtRegister',
      'rollbackTarget',
    ]);
  });

  test('no temporary file survives registration', async () => {
    const config = loadConfig(root);
    register(root, 'demo-candidate', config, fixedClock());
    const { readdirSync } = await import('node:fs');
    const stray = readdirSync(migrationsDir(root)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(stray, [], 'the temporary file must be renamed into place, not left behind');
  });

  test('a populated ledger is never overwritten by a first-record write', async () => {
    const config = loadConfig(root);
    register(root, 'demo-candidate', config, fixedClock());
    const { appendEvent } = await import('../src/store/ledger.ts');
    assert.throws(
      () =>
        appendEvent(root, '0001', {
          seq: 1,
          at: 'x',
          action: 'register',
          from: null,
          to: 'REGISTERED',
          actor: 'system',
          detail: {},
        }),
      /already holds records/,
    );
  });

  test('an interrupted creation leaves history intact for the migrations before it', async () => {
    const { clock } = await driveTo(root, 'VERIFIED');
    const { stabilise } = await import('../src/engine.ts');
    stabilise(root, 'tester', clock);
    writeFileSync(migrationPath(root, '0002'), '', 'utf8');

    assert.deepEqual(listMigrations(root), ['0001']);
    assert.equal(statusOf(root, '0001').state, 'STABLE');

    // And the reclaimed id is 0002, not 0003.
    const { id } = register(root, 'demo-regression', loadConfig(root), fixedClock());
    assert.equal(id, '0002');
    assert.ok(existsSync(migrationPath(root, '0002')));
  });
});

// ---------------------------------------------------------------------------
// FINDING 7. The telemetry claim is temporal, and says so.
// ---------------------------------------------------------------------------
describe('telemetry evidence is exactly what it claims', () => {
  const bounds = { maxRequests: 5, minObservations: 2 };

  test('a confirmation is labelled temporal-window and carries its window mark', async () => {
    const rows = [
      { requestId: 'r1', servedBy: 'm' },
      { requestId: 'r2', servedBy: 'm' },
    ];
    const a = await assertServingModelInWindow({ name: 't', observations: () => rows }, 'm', bounds, 'mark-7');
    assert.equal(a.confirmed, true);
    assert.equal(a.evidenceClass, 'temporal-window');
    assert.equal(a.windowOpensAfter, 'mark-7');
    assert.match(a.reason, /not a per-request correlation/);
  });

  test('unrelated traffic in the window counts, and the claim admits it', async () => {
    // The review's probe: bounded calls, then ambient candidate telemetry after the mark.
    // Confirmation is CORRECT for the claim being made, and the claim says what it covers.
    const ambient = [
      { requestId: 'ambient-1', servedBy: 'm' },
      { requestId: 'ambient-2', servedBy: 'm' },
      { requestId: 'ambient-3', servedBy: 'm' },
    ];
    const a = await assertServingModelInWindow({ name: 't', observations: () => ambient }, 'm', bounds, 'mark');
    assert.equal(a.confirmed, true);
    assert.equal(a.evidenceClass, 'temporal-window');
    assert.match(a.reason, /temporal claim about the window/);
  });

  test('the run result exposes LOCAL call labels, never correlation ids', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    const { run, assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);

    assert.equal(run.issuedCallLabels.length, run.requestsMade);
    const observed = (await ports.telemetry.observations(null)).map((o) => o.requestId);
    for (const label of run.issuedCallLabels) {
      assert.ok(!observed.includes(label), `call label ${label} must not collide with a telemetry row id`);
    }
    assert.equal(assertion.evidenceClass, 'temporal-window');
  });

  test('the recorded assertion and the rendered report state the same strength of claim', async () => {
    const config = loadConfig(root);
    const { ports } = await driveTo(root, 'ACTIVATED');
    await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);

    const event = readMigration(root, '0001').find((e) => e.action === 'verify');
    const assertion = event?.detail['assertion'] as Record<string, unknown>;
    assert.equal(assertion['evidenceClass'], 'temporal-window');

    const { renderReport } = await import('../src/audit/report.ts');
    const v = status(root);
    const report = renderReport(v.events, v.state, v.id);
    assert.match(report, /evidence class\s+temporal-window/);
    assert.match(report, /NOT correlated with individual/);
  });
});

// ---------------------------------------------------------------------------
// FINDING 8. Ledger integrity terminology matches the mechanism.
// ---------------------------------------------------------------------------
describe('ledger integrity claims match the implementation', () => {
  test('the report claims inconsistency detection and explicitly disclaims tamper resistance', async () => {
    await driveTo(root, 'VERIFIED');
    const { renderReport } = await import('../src/audit/report.ts');
    const v = status(root);
    const report = renderReport(v.events, v.state, v.id);

    assert.match(report, /inconsistency detection, not tamper resistance/);
    assert.match(report, /no hash chain and no signature/);
    assert.match(report, /can be altered\s*\n?without detection/);
  });

  test('the disclaimed case is real: a consistently rewritten ledger DOES load', async () => {
    // The honesty test. Rename the candidate everywhere it appears, coherently, and the
    // ledger loads. This is exactly why the word "tamper-evident" was withdrawn.
    await driveTo(root, 'ACTIVATED');
    const rewritten = readFileSync(activePath(root), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.replaceAll('demo-candidate', 'demo-substitute'))
      .join('\n');
    writeFileSync(activePath(root), `${rewritten}\n`, 'utf8');

    assert.doesNotThrow(() => statusOf(root, '0001'));
    assert.equal(statusOf(root, '0001').candidate, 'demo-substitute');
  });

  test('a free-text field with no cross-reference is also undetectable, as documented', async () => {
    const { config, clock } = await driveTo(root, 'EVALUATED');
    const { abandon } = await import('../src/engine.ts');
    abandon(root, 'tester', 'the real reason', clock);
    editDetail(activePath(root), 'abandon', 'reason', 'a different reason entirely');
    assert.doesNotThrow(() => statusOf(root, '0001'));
    assert.equal(loadConfig(root).baselineModel, config.baselineModel);
  });
});

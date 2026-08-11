// CROSS-EVENT CONSISTENCY. The fourth validation layer.
//
// The first correction cycle proved every state TRANSITION had to be legal. It was not
// enough. A second independent review took a valid migration, changed ONE field of the first
// record, `detail.candidate` from "demo-candidate" to "demo-regression", and touched no
// action, no `from` and no `to`. Every existing check passed: the structure was intact, the
// sequence was contiguous, the chain matched, and every (action, from, to) triple was one the
// machine could produce. `status()` then projected the substituted model as the candidate,
// and `activate()` put it into production and recorded ACTIVATED.
//
// The lesson generalises past that one field:
//
//   A legal sequence of states is not enough. The candidate, baseline, policy, evidence and
//   rollback target that those states refer to must describe the SAME migration.
//
// So the identity is established once, from the `register` record, and every later record is
// checked against it and against the records it depends on. Type-correctness of a detail
// field proves nothing here; the check is RELATIONAL.
//
// This runs on every ledger read, before any state is projected and therefore before any
// forward action can be authorised.

import { LedgerCorruptError } from '../domain/errors.ts';
import type { ComparativeEvaluation, MigrationAction, MigrationEvent, ModelId } from '../domain/types.ts';
import { evaluationResultProblems } from '../policy/evidence.ts';

/** Floating-point slack for the recorded delta. Scores are ratios, so this is generous. */
const DELTA_EPSILON = 1e-9;

/** Actions a human performs. Their actor must name that human. */
const OPERATOR_ACTIONS: readonly MigrationAction[] = [
  'approve',
  'beginActivation',
  'beginRollback',
  'stabilise',
  'abandon',
];

/**
 * The fixed identity of a migration, taken from its `register` record.
 *
 * Nothing may change these mid-migration. The transition table already guarantees a single
 * `register` per ledger, so there is exactly one source for each.
 */
export interface MigrationIdentity {
  readonly candidate: ModelId;
  readonly baseline: ModelId;
  /** The rollback target LOCKED when the migration began. Not whatever config says later. */
  readonly rollbackTarget: ModelId;
  readonly policyHashAtRegister: string;
}

function fail(path: string, event: MigrationEvent, why: string): never {
  throw new LedgerCorruptError(
    path,
    `cross-event inconsistency, "${event.action}" ${why}. The records in this ledger do not all ` +
      'describe the same migration',
    event.seq,
  );
}

function str(path: string, event: MigrationEvent, key: string): string {
  const v = event.detail[key];
  if (typeof v !== 'string' || v.length === 0) {
    fail(path, event, `is missing a non-empty string "${key}" in its detail`);
  }
  return v;
}

function obj(path: string, event: MigrationEvent, key: string): Record<string, unknown> {
  const v = event.detail[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(path, event, `is missing an object "${key}" in its detail`);
  }
  return v as Record<string, unknown>;
}

function sameModel(path: string, event: MigrationEvent, key: string, expected: ModelId, what: string): void {
  const actual = str(path, event, key);
  if (actual !== expected) {
    fail(path, event, `names "${actual}" as its ${key}, but this migration's ${what} is "${expected}"`);
  }
}

function flag(path: string, event: MigrationEvent, key: string, expected: boolean): void {
  if (event.detail[key] !== expected) {
    fail(path, event, `records ${key}=${JSON.stringify(event.detail[key])} where only ${String(expected)} is possible for this action`);
  }
}

/** Re-check a recorded evaluation for everything provable without the original case list. */
function checkEvaluation(path: string, event: MigrationEvent, id: MigrationIdentity): string {
  const raw = obj(path, event, 'evaluation');
  const ev = raw as unknown as ComparativeEvaluation;

  if (typeof ev.candidate !== 'object' || ev.candidate === null) fail(path, event, 'has no candidate result in its evaluation');
  if (typeof ev.baseline !== 'object' || ev.baseline === null) fail(path, event, 'has no baseline result in its evaluation');

  // THE IDENTITY BINDING. Evidence must be about the models this migration registered.
  if (ev.candidate.modelId !== id.candidate) {
    fail(path, event, `carries evidence for candidate "${String(ev.candidate.modelId)}" but the migration registered "${id.candidate}"`);
  }
  if (ev.baseline.modelId !== id.baseline) {
    fail(path, event, `carries evidence for baseline "${String(ev.baseline.modelId)}" but the migration registered "${id.baseline}"`);
  }

  for (const [role, result] of [['candidate', ev.candidate], ['baseline', ev.baseline]] as const) {
    const problems = evaluationResultProblems(result, result.modelId);
    if (problems.length > 0) {
      fail(path, event, `carries incoherent ${role} evidence: ${problems.join('; ')}`);
    }
  }

  if (typeof ev.delta !== 'number' || Math.abs(ev.delta - (ev.candidate.score - ev.baseline.score)) > DELTA_EPSILON) {
    fail(
      path,
      event,
      `records delta ${JSON.stringify(ev.delta)}, which is not candidate score ${ev.candidate.score} minus baseline score ${ev.baseline.score}`,
    );
  }

  if (typeof ev.caseSetHash !== 'string' || ev.caseSetHash.length === 0) {
    fail(path, event, 'has no case-set hash, so the record cannot say which cases produced it');
  }

  // The governing policy is recorded twice, inside the evaluation and beside it, and the
  // two are what `accept`, `reject` and `approve` are later checked against.
  const governing = str(path, event, 'governingPolicyHash');
  if (ev.governingPolicyHash !== governing) {
    fail(
      path,
      event,
      `records governing policy "${governing}" beside evidence that names "${String(ev.governingPolicyHash)}"`,
    );
  }
  return governing;
}

/**
 * Prove that every record in a migration refers to the same migration.
 *
 * Assumes the per-record structural, chain and transition-legality checks have already
 * passed: this layer is about RELATIONSHIPS between records, not about the shape of any one.
 */
export function assertCrossEventConsistency(events: readonly MigrationEvent[], path: string): void {
  const first = events[0];
  if (first === undefined) return;

  const identity: MigrationIdentity = {
    candidate: str(path, first, 'candidate'),
    baseline: str(path, first, 'baseline'),
    rollbackTarget: str(path, first, 'rollbackTarget'),
    policyHashAtRegister: str(path, first, 'policyHashAtRegister'),
  };

  /** The policy hash governing the most recent evidence. Every verdict answers to it. */
  let governingPolicyHash: string | null = null;

  for (const e of events) {
    // WHO acted. A machine verdict must not be able to claim a human made it, and a human
    // act must name the human. `system` on an approve would launder an authorisation.
    if (OPERATOR_ACTIONS.includes(e.action)) {
      if (!e.actor.startsWith('operator:') || e.actor.length <= 'operator:'.length) {
        fail(path, e, `is a human act recorded with actor "${e.actor}", which names no operator`);
      }
    } else if (e.actor !== 'system') {
      fail(path, e, `is a machine action recorded with actor "${e.actor}" rather than "system"`);
    }

    switch (e.action) {
      case 'register':
        // Already read into `identity`. A second register cannot occur: the transition table
        // permits `register` only from a null state, which only the first record can have.
        break;

      case 'evaluate':
        governingPolicyHash = checkEvaluation(path, e, identity);
        break;

      case 'accept':
      case 'reject': {
        const verdict = obj(path, e, 'verdict');
        const accepted = verdict['accepted'];
        if (accepted !== (e.action === 'accept')) {
          fail(path, e, `carries a verdict whose accepted flag is ${JSON.stringify(accepted)}`);
        }
        if (governingPolicyHash === null) fail(path, e, 'applies a policy to evidence that was never recorded');
        const hash = str(path, e, 'policyHash');
        if (hash !== governingPolicyHash) {
          fail(path, e, `applied policy "${hash}" to evidence produced under policy "${governingPolicyHash}"`);
        }
        break;
      }

      case 'approve': {
        const approvedBy = str(path, e, 'approvedBy');
        if (e.actor !== `operator:${approvedBy}`) {
          fail(path, e, `records approval by "${approvedBy}" under actor "${e.actor}"`);
        }
        if (governingPolicyHash === null) fail(path, e, 'authorises evidence that was never recorded');
        const hash = str(path, e, 'policyHash');
        if (hash !== governingPolicyHash) {
          fail(path, e, `was granted under policy "${hash}" against evidence produced under policy "${governingPolicyHash}"`);
        }
        break;
      }

      case 'invalidateEvidence': {
        const at = str(path, e, 'policyAtEvaluation');
        const now = str(path, e, 'policyNow');
        if (governingPolicyHash === null) fail(path, e, 'voids evidence that was never recorded');
        if (at !== governingPolicyHash) {
          fail(path, e, `voids evidence it says was produced under policy "${at}", but that evidence names "${governingPolicyHash}"`);
        }
        if (at === now) {
          fail(path, e, 'voids evidence on the grounds of a policy change, while recording an unchanged policy hash');
        }
        break;
      }

      case 'beginActivation':
        // THE PROBE THAT FOUND THIS CLASS. A substituted candidate stops here.
        sameModel(path, e, 'requestedModel', identity.candidate, 'registered candidate');
        // Activation is refused unless production is serving the evaluated baseline, so a
        // recorded activation intent can only ever have started from it.
        sameModel(path, e, 'previousModel', identity.baseline, 'registered baseline');
        break;

      case 'confirmActivation':
        sameModel(path, e, 'requestedModel', identity.candidate, 'registered candidate');
        sameModel(path, e, 'observedModel', identity.candidate, 'registered candidate');
        flag(path, e, 'confirmed', true);
        break;

      case 'failActivation': {
        sameModel(path, e, 'requestedModel', identity.candidate, 'registered candidate');
        const observed = str(path, e, 'observedModel');
        if (observed === identity.candidate) {
          fail(path, e, `records a FAILED activation whose target read back the candidate "${observed}", which would have confirmed it`);
        }
        flag(path, e, 'confirmed', false);
        break;
      }

      case 'verify':
      case 'failVerification': {
        const assertion = obj(path, e, 'assertion');
        if (assertion['expected'] !== identity.candidate) {
          fail(path, e, `asserts telemetry for "${String(assertion['expected'])}" but the migration's candidate is "${identity.candidate}"`);
        }
        if (assertion['confirmed'] !== (e.action === 'verify')) {
          fail(path, e, `carries a telemetry assertion whose confirmed flag is ${JSON.stringify(assertion['confirmed'])}`);
        }
        const run = obj(path, e, 'run');
        const made = run['requestsMade'];
        const available = run['requestsAvailable'];
        const labels = run['issuedCallLabels'];
        if (!Number.isInteger(made) || !Number.isInteger(available) || (made as number) < 0 || (made as number) > (available as number)) {
          fail(path, e, `records ${JSON.stringify(made)} of ${JSON.stringify(available)} requests, which is not a possible bounded run`);
        }
        if (!Array.isArray(labels) || labels.length !== made) {
          fail(path, e, `records ${JSON.stringify(made)} request(s) but ${Array.isArray(labels) ? labels.length : 'no'} call label(s)`);
        }
        break;
      }

      case 'beginRollback':
        // THE LOCKED TARGET. Config cannot redirect a rollback after the fact.
        sameModel(path, e, 'target', identity.rollbackTarget, 'locked rollback target');
        break;

      case 'confirmRollback':
        sameModel(path, e, 'rollbackTarget', identity.rollbackTarget, 'locked rollback target');
        sameModel(path, e, 'observedModel', identity.rollbackTarget, 'locked rollback target');
        flag(path, e, 'confirmed', true);
        break;

      case 'failRollback': {
        sameModel(path, e, 'rollbackTarget', identity.rollbackTarget, 'locked rollback target');
        const observed = str(path, e, 'observedModel');
        if (observed === identity.rollbackTarget) {
          fail(path, e, `records a FAILED rollback whose target read back "${observed}", which would have confirmed it`);
        }
        flag(path, e, 'confirmed', false);
        break;
      }

      case 'abandon':
        str(path, e, 'reason');
        break;

      case 'stabilise':
        // Carries no identity-bearing detail. Its legality is entirely positional.
        break;
    }
  }
}

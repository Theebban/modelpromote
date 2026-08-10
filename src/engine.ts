// THE ENGINE.
//
// Every state change goes through `transition()`. It validates against the allow-list and
// appends the record in one place, so "the transition happened" and "the transition was
// recorded" cannot come apart. There is no other writer.
//
// TRANSACTION SEMANTICS for the two operations with external side effects.
//
// Activation and rollback both change something outside this process, and both are recorded
// in TWO phases with the intent written BEFORE the side effect:
//
//     record ACTIVATING  ->  write to target  ->  read target back  ->  record outcome
//
// This ordering is the whole point. There are three ways it can be interrupted:
//
//   crash before the first record   nothing was written anywhere, ledger still APPROVED,
//                                   which is true.
//   crash after the write           ledger says ACTIVATING: "something may be live and
//                                   nothing is confirmed". Unsafe, and readable as unsafe.
//   read-back disagrees             recorded as ACTIVATION_FAILED, never ACTIVATED.
//
// The one outcome that is impossible is a ledger claiming ACTIVATED while the target serves
// something else. Writing the ledger AFTER the side effect could not express the middle
// case: it would leave the ledger saying APPROVED while the candidate was already live.

import type { ModelshiftConfig } from './config.ts';
import { policyHash } from './config.ts';
import {
  ActivationNotConfirmedError,
  IllegalTransitionError,
  NoMigrationError,
  RollbackNotConfirmedError,
  StalePolicyEvidenceError,
} from './domain/errors.ts';
import { foldState, nextState, statesPermitting } from './domain/machine.ts';
import { assertSafeIdentifier } from './domain/sanitize.ts';
import type {
  ComparativeEvaluation,
  EvaluationCase,
  MigrationAction,
  MigrationEvent,
  MigrationId,
  MigrationState,
  ModelId,
} from './domain/types.ts';
import { evaluateAcceptance, type AcceptanceVerdict } from './policy/acceptance.ts';
import { assertValidEvidence } from './policy/evidence.ts';
import type { Ports } from './ports/index.ts';
import {
  activeMigrationId,
  appendEvent,
  appendRecovery,
  createMigrationFile,
  listMigrations,
  nextMigrationId,
  readMigration,
  storeExists,
} from './store/ledger.ts';
import { assertServingModel, runBoundedVerification, type BoundedRunResult, type TelemetryAssertion } from './verify/index.ts';
import { hashCases } from './adapters/local/index.ts';

/** A read-only projection of one migration's ledger. Computing it never writes. */
export interface MigrationView {
  readonly id: MigrationId;
  readonly state: MigrationState | null;
  readonly events: readonly MigrationEvent[];
  readonly candidate: ModelId | null;
  readonly baseline: ModelId | null;
  readonly evaluation: ComparativeEvaluation | null;
  readonly verdict: AcceptanceVerdict | null;
  /** The policy hash in force when the current evidence was produced. */
  readonly governingPolicyHash: string | null;
  readonly approvedBy: string | null;
}

function detailOf<T>(events: readonly MigrationEvent[], action: MigrationAction, key: string): T | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e !== undefined && e.action === action && key in e.detail) return e.detail[key] as T;
  }
  return null;
}

function view(root: string, id: MigrationId): MigrationView {
  const events = readMigration(root, id);
  return {
    id,
    state: foldState(events),
    events,
    candidate: detailOf<ModelId>(events, 'register', 'candidate'),
    baseline: detailOf<ModelId>(events, 'register', 'baseline'),
    evaluation: detailOf<ComparativeEvaluation>(events, 'evaluate', 'evaluation'),
    verdict:
      detailOf<AcceptanceVerdict>(events, 'accept', 'verdict') ?? detailOf<AcceptanceVerdict>(events, 'reject', 'verdict'),
    governingPolicyHash: detailOf<string>(events, 'evaluate', 'governingPolicyHash'),
    approvedBy: detailOf<string>(events, 'approve', 'approvedBy'),
  };
}

/** PURE READ of the active migration. Invariant: status never mutates state. */
export function status(root: string): MigrationView {
  if (!storeExists(root)) throw new NoMigrationError(root);
  const id = activeMigrationId(root);
  if (id === null) {
    const all = listMigrations(root);
    const last = all.at(-1);
    if (last === undefined) throw new NoMigrationError(root);
    return view(root, last); // the most recent, terminated migration
  }
  return view(root, id);
}

export function statusOf(root: string, id: MigrationId): MigrationView {
  return view(root, id);
}

export function history(root: string): readonly MigrationView[] {
  return listMigrations(root).map((id) => view(root, id));
}

function requireActive(root: string): MigrationId {
  const id = activeMigrationId(root);
  if (id === null) throw new NoMigrationError(root);
  return id;
}

/** The single writer. Validates, then records. Nothing else appends to a ledger. */
function transition(
  root: string,
  id: MigrationId,
  action: MigrationAction,
  actor: string,
  detail: Record<string, unknown>,
  now: () => string,
): MigrationEvent {
  const events = readMigration(root, id);
  const current = foldState(events);

  let to: MigrationState;
  if (action === 'register') {
    if (current !== null) throw new IllegalTransitionError('register', current, []);
    to = 'REGISTERED';
  } else {
    if (current === null) throw new NoMigrationError(root);
    to = nextState(current, action);
  }

  const event: MigrationEvent = { seq: events.length + 1, at: now(), action, from: current, to, actor, detail };
  appendEvent(root, id, event);
  return event;
}

/**
 * Begin a migration.
 *
 * The governing policy is hashed HERE, before any evidence exists, so the rules cannot be
 * chosen to fit a result that has already been seen.
 */
export function register(
  root: string,
  candidate: ModelId,
  config: ModelshiftConfig,
  now: () => string,
): { event: MigrationEvent; id: MigrationId } {
  assertSafeIdentifier(candidate, 'candidate model id');

  const open = activeMigrationId(root);
  if (open !== null) {
    const s = foldState(readMigration(root, open));
    throw new IllegalTransitionError('register', s ?? 'REGISTERED', []);
  }

  const id = nextMigrationId(root);
  createMigrationFile(root, id);
  const event = transition(
    root,
    id,
    'register',
    'system',
    { candidate, baseline: config.baselineModel, policyHashAtRegister: policyHash(config.acceptance) },
    now,
  );
  return { event, id };
}

export async function evaluate(
  root: string,
  cases: readonly EvaluationCase[],
  config: ModelshiftConfig,
  ports: Ports,
): Promise<{ event: MigrationEvent; evaluation: ComparativeEvaluation }> {
  const id = requireActive(root);
  let v = view(root, id);
  if (v.candidate === null || v.baseline === null) throw new NoMigrationError(root);
  // Captured before the branch below reassigns `v`: the candidate and baseline are fixed
  // at register and cannot change within a migration.
  const candidateId = v.candidate;
  const baselineId = v.baseline;

  // ACCEPTED is a stable checkpoint: it is not re-rollable on a whim. The one thing that
  // legitimately voids it is a change to the policy that produced it, and that gets
  // recorded as its own event rather than being inferred later from two differing hashes.
  if (v.state === 'ACCEPTED') {
    const current = policyHash(config.acceptance);
    if (v.governingPolicyHash === current) {
      throw new IllegalTransitionError('evaluate', 'ACCEPTED', statesPermitting('evaluate'));
    }
    transition(root, id, 'invalidateEvidence', 'system', {
      reason: 'the acceptance policy changed after this evidence was produced, so the verdict is void',
      policyAtEvaluation: v.governingPolicyHash,
      policyNow: current,
    }, ports.now);
    v = view(root, id);
  }

  const baselineAdapter = ports.models.get(baselineId);
  const candidateAdapter = ports.models.get(candidateId);
  if (baselineAdapter === undefined) throw new Error(`No adapter registered for baseline model "${baselineId}"`);
  if (candidateAdapter === undefined) throw new Error(`No adapter registered for candidate model "${candidateId}"`);

  // Lock the policy that governs THIS evidence, at the moment the evidence is produced.
  const governingPolicyHash = policyHash(config.acceptance);

  const baseline = assertValidEvidence(await ports.evaluator.evaluate(baselineAdapter, cases), baselineId, cases);
  const candidate = assertValidEvidence(await ports.evaluator.evaluate(candidateAdapter, cases), candidateId, cases);

  const evaluation: ComparativeEvaluation = {
    baseline,
    candidate,
    delta: candidate.score - baseline.score,
    caseSetHash: hashCases(cases),
    governingPolicyHash,
  };

  const event = transition(root, id, 'evaluate', 'system', { evaluation, evaluator: ports.evaluator.name, governingPolicyHash }, ports.now);
  return { event, evaluation };
}

/** Assert the policy has not moved since the evidence under consideration was produced. */
function assertPolicyUnchanged(v: MigrationView, config: ModelshiftConfig, step: string): string {
  const current = policyHash(config.acceptance);
  if (v.governingPolicyHash !== null && v.governingPolicyHash !== current) {
    throw new StalePolicyEvidenceError(v.governingPolicyHash, current, step);
  }
  return current;
}

/**
 * Apply the locked policy. A MACHINE verdict, recorded either way.
 *
 * Refuses outright if the policy changed since the evidence was produced. Warning and
 * continuing would let an operator move the bar after seeing the score, which is the exact
 * failure the hash exists to prevent.
 */
export function decide(
  root: string,
  config: ModelshiftConfig,
  now: () => string,
): { event: MigrationEvent; verdict: AcceptanceVerdict } {
  const id = requireActive(root);
  const v = view(root, id);
  if (v.evaluation === null) {
    throw new IllegalTransitionError('accept', v.state ?? 'REGISTERED', statesPermitting('accept'));
  }
  const hash = assertPolicyUnchanged(v, config, 'apply the acceptance policy');
  const verdict = evaluateAcceptance(v.evaluation, config.acceptance);
  const event = transition(root, id, verdict.accepted ? 'accept' : 'reject', 'system', { verdict, policyHash: hash }, now);
  return { event, verdict };
}

/** Human authorisation. Separate from the machine verdict, and equally policy-locked. */
export function approve(root: string, actor: string, config: ModelshiftConfig, now: () => string): MigrationEvent {
  assertSafeIdentifier(actor, 'actor');
  const id = requireActive(root);
  const v = view(root, id);
  const hash = assertPolicyUnchanged(v, config, 'approve');
  return transition(root, id, 'approve', `operator:${actor}`, { approvedBy: actor, policyHash: hash }, now);
}

export interface ActivationOutcome {
  readonly confirmed: boolean;
  readonly requested: ModelId;
  readonly observed: ModelId;
  readonly state: MigrationState;
}

/**
 * TWO-PHASE ACTIVATION. Never records ACTIVATED without a positive read-back.
 *
 * A target whose `write()` silently does nothing is the common real failure: a stale client,
 * a cached config, a deploy that did not roll, a permission error swallowed by an SDK. All
 * of them look like success to the writer.
 */
export async function activate(
  root: string,
  actor: string,
  ports: Ports,
): Promise<ActivationOutcome> {
  assertSafeIdentifier(actor, 'actor');
  const id = requireActive(root);
  const v = view(root, id);
  if (v.candidate === null) throw new NoMigrationError(root);
  if (v.state === null) throw new NoMigrationError(root);

  // Validate before touching the outside world, so a refused activation changes nothing.
  nextState(v.state, 'beginActivation');

  const previous = await ports.activation.read();

  // PHASE 1: record the intent BEFORE the side effect.
  transition(root, id, 'beginActivation', `operator:${actor}`, {
    previousModel: previous,
    requestedModel: v.candidate,
    target: ports.activation.name,
  }, ports.now);

  await ports.activation.write(v.candidate);
  const observed = await ports.activation.read();
  const confirmed = observed === v.candidate;

  // PHASE 2: record the OBSERVED outcome, not the intended one.
  const event = transition(
    root,
    id,
    confirmed ? 'confirmActivation' : 'failActivation',
    'system',
    { requestedModel: v.candidate, observedModel: observed, previousModel: previous, target: ports.activation.name, confirmed },
    ports.now,
  );

  if (!confirmed) {
    throw new ActivationNotConfirmedError(v.candidate, observed, ports.activation.name);
  }
  return { confirmed, requested: v.candidate, observed, state: event.to };
}

export async function verify(
  root: string,
  inputs: readonly string[],
  config: ModelshiftConfig,
  ports: Ports,
): Promise<{ event: MigrationEvent; run: BoundedRunResult; assertion: TelemetryAssertion }> {
  const id = requireActive(root);
  const v = view(root, id);
  if (v.candidate === null || v.state === null) throw new NoMigrationError(root);
  if (v.state !== 'ACTIVATED') {
    throw new IllegalTransitionError('verify', v.state, statesPermitting('verify'));
  }

  const serving = await ports.activation.read();
  const adapter = ports.models.get(serving);
  if (adapter === undefined) throw new Error(`No adapter registered for the serving model "${serving}"`);

  // Mark where telemetry stands BEFORE issuing traffic, then assert only over what this run
  // produced. Otherwise observations from evaluation would count as evidence of activation.
  const before = await ports.telemetry.observations(null);
  const marker = before.at(-1)?.requestId ?? null;

  const run = await runBoundedVerification(inputs, adapter, config.verification);
  const assertion = await assertServingModel(ports.telemetry, v.candidate, config.verification, marker);

  const event = transition(root, id, assertion.confirmed ? 'verify' : 'failVerification', 'system', {
    run,
    assertion,
    telemetrySource: ports.telemetry.name,
  }, ports.now);

  return { event, run, assertion };
}

/**
 * Give up on this candidate. Legal only while nothing is live.
 *
 * Closes the migration so a new one can begin, and leaves the abandonment in the record
 * rather than deleting the attempt. A migration nobody proceeded with is evidence too.
 */
export function abandon(root: string, actor: string, reason: string, now: () => string): MigrationEvent {
  assertSafeIdentifier(actor, 'actor');
  return transition(root, requireActive(root), 'abandon', `operator:${actor}`, { reason }, now);
}

export function stabilise(root: string, actor: string, now: () => string): MigrationEvent {
  assertSafeIdentifier(actor, 'actor');
  return transition(root, requireActive(root), 'stabilise', `operator:${actor}`, {}, now);
}

export interface RollbackOutcome {
  readonly confirmed: boolean;
  readonly target: ModelId;
  readonly observed: ModelId;
  readonly state: MigrationState;
}

/**
 * TWO-PHASE ROLLBACK. Never records ROLLED_BACK without a positive read-back.
 *
 * The target comes from CONFIGURATION rather than ledger history, so a rollback still works
 * when history is unusable.
 */
export async function rollback(
  root: string,
  actor: string,
  config: ModelshiftConfig,
  ports: Ports,
): Promise<RollbackOutcome> {
  assertSafeIdentifier(actor, 'actor');
  const id = requireActive(root);
  const v = view(root, id);
  if (v.state === null) throw new NoMigrationError(root);
  nextState(v.state, 'beginRollback');

  const from = await ports.activation.read();

  transition(root, id, 'beginRollback', `operator:${actor}`, { from, target: config.rollbackModel, activationTarget: ports.activation.name }, ports.now);

  await ports.activation.write(config.rollbackModel);
  const observed = await ports.activation.read();
  const confirmed = observed === config.rollbackModel;

  const event = transition(
    root,
    id,
    confirmed ? 'confirmRollback' : 'failRollback',
    'system',
    { revertedFrom: from, rollbackTarget: config.rollbackModel, observedModel: observed, confirmed, viaCodeRelease: false },
    ports.now,
  );

  if (!confirmed) {
    throw new RollbackNotConfirmedError(config.rollbackModel, observed, ports.activation.name);
  }
  return { confirmed, target: config.rollbackModel, observed, state: event.to };
}

export interface EmergencyOutcome {
  readonly confirmed: boolean;
  readonly target: ModelId;
  readonly observed: ModelId;
  readonly recordedAt: string;
}

/**
 * EMERGENCY ROLLBACK. Reverts without reading any ledger.
 *
 * This is what makes the fail-open promise true rather than merely stated: when the ledger
 * fails its integrity check the state is unknown, but the declared safe model is not, and
 * that is what the operator needs.
 *
 * It is still gated on read-back. Reporting a successful revert while the target serves
 * something else would be the most dangerous message the tool could print, because it is
 * read at the exact moment nobody has capacity to double-check it.
 */
export async function emergencyRollback(
  root: string,
  actor: string,
  config: ModelshiftConfig,
  ports: Ports,
  reason: string,
): Promise<EmergencyOutcome> {
  assertSafeIdentifier(actor, 'actor');
  const from = await ports.activation.read();
  await ports.activation.write(config.rollbackModel);
  const observed = await ports.activation.read();
  const confirmed = observed === config.rollbackModel;

  const recordedAt = appendRecovery(root, {
    at: ports.now(),
    action: 'emergencyRollback',
    actor: `operator:${actor}`,
    reason,
    revertedFrom: from,
    rollbackTarget: config.rollbackModel,
    observedModel: observed,
    confirmed,
    outcome: confirmed ? 'CONFIRMED by read-back' : 'NOT CONFIRMED, the target still reports another model',
    ledgerState: 'UNREADABLE at the time of this action',
  });

  if (!confirmed) {
    throw new RollbackNotConfirmedError(config.rollbackModel, observed, ports.activation.name);
  }
  return { confirmed, target: config.rollbackModel, observed, recordedAt };
}

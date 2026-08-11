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
  BaselineDriftError,
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
import { assertValidCaseSet, assertValidEvidence } from './policy/evidence.ts';
import type { Ports } from './ports/index.ts';
import {
  activeMigrationId,
  appendEvent,
  appendRecovery,
  listMigrations,
  nextMigrationId,
  readMigration,
  storeExists,
} from './store/ledger.ts';
import {
  assertServingModelInWindow,
  runBoundedVerification,
  type BoundedRunResult,
  type TelemetryAssertion,
} from './verify/index.ts';
import { hashCases } from './adapters/local/index.ts';

/** A read-only projection of one migration's ledger. Computing it never writes. */
export interface MigrationView {
  readonly id: MigrationId;
  readonly state: MigrationState | null;
  readonly events: readonly MigrationEvent[];
  readonly candidate: ModelId | null;
  readonly baseline: ModelId | null;
  /** The rollback target LOCKED at `register`. A normal rollback uses this, not config. */
  readonly rollbackTarget: ModelId | null;
  readonly evaluation: ComparativeEvaluation | null;
  /**
   * The verdict CURRENTLY IN FORCE, or null when none is.
   *
   * Null after a re-evaluation or a policy invalidation, because both supersede whatever
   * verdict came before them. It is deliberately not "the last accept, else the last
   * reject": that spelling made an obsolete acceptance outlive the rejection that replaced
   * it, so a migration sitting in REJECTED reported `verdict.accepted === true`.
   */
  readonly verdict: AcceptanceVerdict | null;
  /** The policy hash in force when the current evidence was produced. */
  readonly governingPolicyHash: string | null;
  readonly approvedBy: string | null;
}

/**
 * The most recent event among the given actions, or null.
 *
 * LATEST OVERALL, never latest-per-action. Searching for each action separately and then
 * preferring one of the results reintroduces the stale-verdict defect: preference is not
 * recency, and the record has an order for a reason.
 */
function latestOf(events: readonly MigrationEvent[], actions: readonly MigrationAction[]): MigrationEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e !== undefined && actions.includes(e.action)) return e;
  }
  return null;
}

function detailOf<T>(events: readonly MigrationEvent[], action: MigrationAction, key: string): T | null {
  const e = latestOf(events, [action]);
  return e !== null && key in e.detail ? (e.detail[key] as T) : null;
}

/** Every action that establishes, replaces or voids a verdict. */
const VERDICT_BEARING: readonly MigrationAction[] = ['accept', 'reject', 'evaluate', 'invalidateEvidence'];

function currentVerdict(events: readonly MigrationEvent[]): AcceptanceVerdict | null {
  const e = latestOf(events, VERDICT_BEARING);
  if (e === null || (e.action !== 'accept' && e.action !== 'reject')) return null;
  return (e.detail['verdict'] as AcceptanceVerdict | undefined) ?? null;
}

function view(root: string, id: MigrationId): MigrationView {
  const events = readMigration(root, id);
  return {
    id,
    state: foldState(events),
    events,
    candidate: detailOf<ModelId>(events, 'register', 'candidate'),
    baseline: detailOf<ModelId>(events, 'register', 'baseline'),
    rollbackTarget: detailOf<ModelId>(events, 'register', 'rollbackTarget'),
    evaluation: detailOf<ComparativeEvaluation>(events, 'evaluate', 'evaluation'),
    verdict: currentVerdict(events),
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
 * Three things are LOCKED here, before any evidence exists:
 *
 *   the governing policy   so the rules cannot be chosen to fit a result already seen;
 *   the baseline           so the evidence names what the candidate was measured against;
 *   the rollback target    so the model declared safe at the start is the one a rollback
 *                          reverts to, whatever configuration says later.
 *
 * The whole record is written in ONE atomic step. There is no moment at which a migration
 * file exists without its `register` record in it.
 */
export function register(
  root: string,
  candidate: ModelId,
  config: ModelshiftConfig,
  now: () => string,
): { event: MigrationEvent; id: MigrationId } {
  assertSafeIdentifier(candidate, 'candidate model id');
  // These reach the audit record too, by way of configuration rather than a CLI flag.
  assertSafeIdentifier(config.baselineModel, 'baselineModel');
  assertSafeIdentifier(config.rollbackModel, 'rollbackModel');

  const open = activeMigrationId(root);
  if (open !== null) {
    const s = foldState(readMigration(root, open));
    throw new IllegalTransitionError('register', s ?? 'REGISTERED', []);
  }

  const id = nextMigrationId(root);
  const event = transition(
    root,
    id,
    'register',
    'system',
    {
      candidate,
      baseline: config.baselineModel,
      rollbackTarget: config.rollbackModel,
      policyHashAtRegister: policyHash(config.acceptance),
    },
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
  // Checked before anything is measured. A case set with duplicate, empty or malformed ids
  // cannot support the exact-coverage rule the evaluator's output is held to.
  assertValidCaseSet(cases);
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
 *
 * BASELINE DRIFT FAILS CLOSED. Before anything is recorded or written, the currently serving
 * model must be the baseline this migration measured against. It is possible to evaluate a
 * candidate against A, have production quietly move to B, and then "migrate" from B on the
 * strength of evidence that only ever described a change from A. The evidence is not wrong,
 * it just answers a different question than the one being asked, and nothing downstream can
 * tell. The baseline is never silently updated to match: a changed production baseline
 * invalidates the migration's assumptions, and re-measuring is the only honest repair.
 */
export async function activate(
  root: string,
  actor: string,
  ports: Ports,
): Promise<ActivationOutcome> {
  assertSafeIdentifier(actor, 'actor');
  const id = requireActive(root);
  const v = view(root, id);
  if (v.candidate === null || v.baseline === null) throw new NoMigrationError(root);
  if (v.state === null) throw new NoMigrationError(root);

  // Validate before touching the outside world, so a refused activation changes nothing.
  nextState(v.state, 'beginActivation');

  const previous = await ports.activation.read();
  if (previous !== v.baseline) {
    throw new BaselineDriftError(v.baseline, previous, v.candidate, ports.activation.name);
  }

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

  // Open a WINDOW: mark where telemetry stands before issuing traffic, then assert only over
  // observations recorded after that mark. Without it, observations from evaluation would
  // count as evidence of activation.
  //
  // Be precise about what this proves. The window is TEMPORAL, not per-request: modelshift
  // does not propagate an id through your adapter, so it cannot pair the calls it issued
  // with the rows your telemetry produced. A confirmation says "everything telemetry saw
  // after this point was served by the candidate", which is weaker than "these exact calls
  // were served by the candidate" and is stated that way everywhere it is reported.
  const before = await ports.telemetry.observations(null);
  const marker = before.at(-1)?.requestId ?? null;

  const run = await runBoundedVerification(inputs, adapter, config.verification);
  const assertion = await assertServingModelInWindow(ports.telemetry, v.candidate, config.verification, marker);

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
  /** The LOCKED target this rollback used. Taken from the migration, not from config. */
  readonly target: ModelId;
  readonly observed: ModelId;
  readonly state: MigrationState;
  /** What configuration currently names, which may no longer be the locked target. */
  readonly configuredTarget: ModelId;
  /** True when the two disagree. Reported, never silently resolved in config's favour. */
  readonly configDrift: boolean;
}

/**
 * TWO-PHASE ROLLBACK. Never records ROLLED_BACK without a positive read-back.
 *
 * THE TARGET IS THE ONE LOCKED AT `register`, not whatever configuration says now.
 *
 * An independent review registered a migration with a safe target, activated the candidate,
 * edited `rollbackModel` in the config file to point at a REGRESSING model, and invoked
 * rollback. The tool dutifully "rolled back" production onto the regression and recorded
 * ROLLED_BACK. A safe target that any later config edit can redirect is not a safe target;
 * it is a variable with a reassuring name.
 *
 * When config disagrees with the lock, the LOCK WINS and the drift is reported: refusing
 * instead would block a rollback over a configuration question, and blocking a rollback is
 * the one failure this framework never chooses. Emergency rollback is different, and
 * deliberately so: it runs when the ledger is unreadable, so it cannot consult the lock and
 * takes configuration as its authority. That is a different trust basis, not the same one
 * reached another way.
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
  if (v.rollbackTarget === null) throw new NoMigrationError(root);
  nextState(v.state, 'beginRollback');

  const target = v.rollbackTarget;
  const configuredTarget = config.rollbackModel;
  const configDrift = configuredTarget !== target;
  const drift = configDrift ? { configuredRollbackModel: configuredTarget, configDrift: true } : {};

  const from = await ports.activation.read();

  transition(
    root,
    id,
    'beginRollback',
    `operator:${actor}`,
    { from, target, activationTarget: ports.activation.name, ...drift },
    ports.now,
  );

  await ports.activation.write(target);
  const observed = await ports.activation.read();
  const confirmed = observed === target;

  const event = transition(
    root,
    id,
    confirmed ? 'confirmRollback' : 'failRollback',
    'system',
    { revertedFrom: from, rollbackTarget: target, observedModel: observed, confirmed, viaCodeRelease: false, ...drift },
    ports.now,
  );

  if (!confirmed) {
    throw new RollbackNotConfirmedError(target, observed, ports.activation.name);
  }
  return { confirmed, target, observed, state: event.to, configuredTarget, configDrift };
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
 * A DIFFERENT TRUST AUTHORITY FROM A NORMAL ROLLBACK, on purpose. A normal rollback uses the
 * target locked into the migration at `register`; this one cannot, because obtaining that
 * lock means reading the very file that just failed its integrity check. So it uses
 * `config.rollbackModel`, and the record it writes says so. The two paths are not the same
 * guarantee reached by different routes, and claiming they were would be the more comfortable
 * lie: config is mutable, and on this path that mutability is the price of working at all.
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
    targetAuthority: 'configuration (rollbackModel), because the ledger-locked target was unreadable',
  });

  if (!confirmed) {
    throw new RollbackNotConfirmedError(config.rollbackModel, observed, ports.activation.name);
  }
  return { confirmed, target: config.rollbackModel, observed, recordedAt };
}

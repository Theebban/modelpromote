// THE ENGINE.
//
// Every state change in the system goes through `transition()`. It validates against the
// allow-list and appends the record in one place, so "the transition happened" and "the
// transition was recorded" cannot come apart. There is no other writer.

import type { ModelshiftConfig } from './config.ts';
import { policyHash } from './config.ts';
import { IllegalTransitionError, NoMigrationError } from './domain/errors.ts';
import { foldState, nextState, statesPermitting } from './domain/machine.ts';
import type {
  ComparativeEvaluation,
  EvaluationCase,
  MigrationAction,
  MigrationEvent,
  MigrationState,
  ModelId,
} from './domain/types.ts';
import { evaluateAcceptance, type AcceptanceVerdict } from './policy/acceptance.ts';
import type { Ports } from './ports/index.ts';
import { appendEvent, appendRecovery, ledgerExists, readLedger } from './store/ledger.ts';
import { assertServingModel, runBoundedVerification, type BoundedRunResult, type TelemetryAssertion } from './verify/index.ts';
import { hashCases } from './adapters/local/index.ts';

/** A read-only projection of the ledger. Computing it never writes anything. */
export interface MigrationView {
  readonly state: MigrationState | null;
  readonly events: readonly MigrationEvent[];
  readonly candidate: ModelId | null;
  readonly baseline: ModelId | null;
  readonly evaluation: ComparativeEvaluation | null;
  readonly verdict: AcceptanceVerdict | null;
  readonly acceptedPolicyHash: string | null;
  readonly approvedBy: string | null;
  readonly lastVerifyRequestId: string | null;
}

function detailOf<T>(events: readonly MigrationEvent[], action: MigrationAction, key: string): T | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e !== undefined && e.action === action && key in e.detail) return e.detail[key] as T;
  }
  return null;
}

/** PURE READ. Invariant: running status never mutates migration state. */
export function status(root: string): MigrationView {
  if (!ledgerExists(root)) throw new NoMigrationError(root);
  const events = readLedger(root);
  return {
    state: foldState(events),
    events,
    candidate: detailOf<ModelId>(events, 'register', 'candidate'),
    baseline: detailOf<ModelId>(events, 'register', 'baseline'),
    evaluation: detailOf<ComparativeEvaluation>(events, 'evaluate', 'evaluation'),
    verdict:
      detailOf<AcceptanceVerdict>(events, 'accept', 'verdict') ?? detailOf<AcceptanceVerdict>(events, 'reject', 'verdict'),
    acceptedPolicyHash: detailOf<string>(events, 'accept', 'policyHash'),
    approvedBy: detailOf<string>(events, 'approve', 'approvedBy'),
    lastVerifyRequestId:
      detailOf<string>(events, 'verify', 'lastRequestId') ?? detailOf<string>(events, 'failVerification', 'lastRequestId'),
  };
}

/** The single writer. Validates, then records. Nothing else appends to the ledger. */
function transition(
  root: string,
  action: MigrationAction,
  actor: string,
  detail: Record<string, unknown>,
  now: () => string,
): MigrationEvent {
  const events = readLedger(root);
  const current = foldState(events);

  let to: MigrationState;
  if (action === 'register') {
    // The only action legal from "no migration yet".
    if (current !== null) {
      throw new IllegalTransitionError('register', current, []);
    }
    to = 'REGISTERED';
  } else {
    if (current === null) throw new NoMigrationError(root);
    to = nextState(current, action);
  }

  const event: MigrationEvent = {
    seq: events.length + 1,
    at: now(),
    action,
    from: current,
    to,
    actor,
    detail,
  };
  appendEvent(root, event);
  return event;
}

export function register(root: string, candidate: ModelId, config: ModelshiftConfig, now: () => string): MigrationEvent {
  return transition(root, 'register', 'system', { candidate, baseline: config.baselineModel }, now);
}

export async function evaluate(
  root: string,
  cases: readonly EvaluationCase[],
  ports: Ports,
): Promise<{ event: MigrationEvent; evaluation: ComparativeEvaluation }> {
  const view = status(root);
  if (view.candidate === null || view.baseline === null) throw new NoMigrationError(root);

  const baselineAdapter = ports.models.get(view.baseline);
  const candidateAdapter = ports.models.get(view.candidate);
  if (baselineAdapter === undefined) throw new Error(`No adapter registered for baseline model "${view.baseline}"`);
  if (candidateAdapter === undefined) throw new Error(`No adapter registered for candidate model "${view.candidate}"`);

  const baseline = await ports.evaluator.evaluate(baselineAdapter, cases);
  const candidate = await ports.evaluator.evaluate(candidateAdapter, cases);
  const evaluation: ComparativeEvaluation = {
    baseline,
    candidate,
    delta: candidate.score - baseline.score,
    caseSetHash: hashCases(cases),
  };

  const event = transition(root, 'evaluate', 'system', { evaluation, evaluator: ports.evaluator.name }, ports.now);
  return { event, evaluation };
}

/**
 * Apply the declared policy. A MACHINE verdict, recorded either way.
 *
 * A rejection is recorded as deliberately as an acceptance: "we measured it and said no"
 * is exactly the evidence an audit wants, and deleting it would leave a gap.
 */
export function decide(
  root: string,
  config: ModelshiftConfig,
  now: () => string,
): { event: MigrationEvent; verdict: AcceptanceVerdict } {
  const view = status(root);
  if (view.evaluation === null) {
    // Reachable only if the ledger says EVALUATED with no evaluation payload.
    throw new IllegalTransitionError('accept', view.state ?? 'REGISTERED', statesPermitting('accept'));
  }
  const verdict = evaluateAcceptance(view.evaluation, config.acceptance);
  const hash = policyHash(config.acceptance);
  const event = transition(
    root,
    verdict.accepted ? 'accept' : 'reject',
    'system',
    { verdict, policyHash: hash },
    now,
  );
  return { event, verdict };
}

/**
 * Human authorisation. Separate from the machine verdict on purpose.
 *
 * Re-hashes the policy and records both hashes. If the policy was edited between the
 * verdict and this approval, the report shows a mismatch rather than quietly carrying a
 * verdict earned under different rules.
 */
export function approve(
  root: string,
  actor: string,
  config: ModelshiftConfig,
  now: () => string,
): { event: MigrationEvent; policyChanged: boolean } {
  const view = status(root);
  const hashNow = policyHash(config.acceptance);
  const policyChanged = view.acceptedPolicyHash !== null && view.acceptedPolicyHash !== hashNow;
  const event = transition(
    root,
    'approve',
    `operator:${actor}`,
    { approvedBy: actor, policyHashAtAccept: view.acceptedPolicyHash, policyHashAtApproval: hashNow, policyChanged },
    now,
  );
  return { event, policyChanged };
}

export async function activate(root: string, actor: string, ports: Ports): Promise<{ event: MigrationEvent; serving: ModelId }> {
  const view = status(root);
  if (view.candidate === null) throw new NoMigrationError(root);

  // Validate the transition BEFORE touching the outside world, so a refused activation
  // cannot leave the serving model changed.
  const current = view.state;
  if (current === null) throw new NoMigrationError(root);
  nextState(current, 'activate');

  const previous = await ports.activation.read();
  await ports.activation.write(view.candidate);
  const serving = await ports.activation.read();

  const event = transition(
    root,
    'activate',
    `operator:${actor}`,
    { previousModel: previous, requestedModel: view.candidate, targetReports: serving, target: ports.activation.name },
    ports.now,
  );
  return { event, serving };
}

export async function verify(
  root: string,
  inputs: readonly string[],
  config: ModelshiftConfig,
  ports: Ports,
): Promise<{ event: MigrationEvent; run: BoundedRunResult; assertion: TelemetryAssertion }> {
  const view = status(root);
  if (view.candidate === null) throw new NoMigrationError(root);
  const current = view.state;
  if (current === null) throw new NoMigrationError(root);

  // Either outcome is a legal transition from ACTIVATED; check now so an illegal call does
  // not issue traffic first.
  if (current !== 'ACTIVATED') {
    throw new IllegalTransitionError('verify', current, statesPermitting('verify'));
  }

  const serving = await ports.activation.read();
  const adapter = ports.models.get(serving);
  if (adapter === undefined) throw new Error(`No adapter registered for the serving model "${serving}"`);

  // Mark where telemetry stands BEFORE issuing traffic, then assert only over what this
  // run produced. Without the marker, observations from evaluation (or from any earlier
  // migration) would be counted as evidence that this activation is serving.
  const before = await ports.telemetry.observations(null);
  const marker = before.at(-1)?.requestId ?? null;

  const run = await runBoundedVerification(inputs, adapter, config.verification);

  const assertion = await assertServingModel(ports.telemetry, view.candidate, config.verification, marker);
  const action: MigrationAction = assertion.confirmed ? 'verify' : 'failVerification';
  const event = transition(root, action, 'system', {
    run,
    assertion,
    lastRequestId: run.requestIds.at(-1) ?? null,
    telemetrySource: ports.telemetry.name,
  }, ports.now);

  return { event, run, assertion };
}

export function stabilise(root: string, actor: string, now: () => string): MigrationEvent {
  return transition(root, 'stabilise', `operator:${actor}`, {}, now);
}

/**
 * Roll back to the declared safe model.
 *
 * The target comes from CONFIGURATION, not from ledger history, so a rollback still works
 * when the ledger is unusable. Recorded as two events, begin and complete, so a rollback
 * that was started and did not finish is visible rather than invisible.
 */
/**
 * EMERGENCY ROLLBACK. Reverts without reading the ledger at all.
 *
 * This is what makes the fail-open promise true rather than merely stated. When the ledger
 * fails its integrity check the migration's state is unknown, and the normal rollback path
 * cannot run because every transition begins by reading the ledger. But the thing you need
 * in that moment is not knowledge of the state, it is the declared safe model, and that
 * lives in configuration.
 *
 * The action is recorded in a separate recovery file, never appended to the ledger that
 * just failed verification.
 */
export async function emergencyRollback(
  root: string,
  actor: string,
  config: ModelshiftConfig,
  ports: Ports,
  reason: string,
): Promise<{ serving: ModelId; recordedAt: string }> {
  const from = await ports.activation.read();
  await ports.activation.write(config.rollbackModel);
  const serving = await ports.activation.read();

  const recordedAt = appendRecovery(root, {
    at: ports.now(),
    action: 'emergencyRollback',
    actor: `operator:${actor}`,
    reason,
    revertedFrom: from,
    revertedTo: config.rollbackModel,
    targetReports: serving,
    ledgerState: 'UNREADABLE at the time of this action',
  });

  return { serving, recordedAt };
}

export async function rollback(
  root: string,
  actor: string,
  config: ModelshiftConfig,
  ports: Ports,
): Promise<{ events: readonly MigrationEvent[]; serving: ModelId }> {
  const from = await ports.activation.read();
  const begin = transition(root, 'beginRollback', `operator:${actor}`, { from, target: config.rollbackModel }, ports.now);

  await ports.activation.write(config.rollbackModel);
  const serving = await ports.activation.read();

  const complete = transition(root, 'completeRollback', 'system', {
    revertedFrom: from,
    revertedTo: config.rollbackModel,
    targetReports: serving,
    viaCodeRelease: false,
  }, ports.now);

  return { events: [begin, complete], serving };
}

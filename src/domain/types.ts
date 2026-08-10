// The migration lifecycle, as data.
//
// A model change is treated as a stateful operation with a small number of legal
// transitions, not as a config edit that happens to work out.

/** Identifier for a model as your application knows it. Opaque to the framework. */
export type ModelId = string;

/** Identifier for one migration within a project. Zero-padded, monotonically increasing. */
export type MigrationId = string;

export const MIGRATION_STATES = [
  /** A candidate exists and the governing policy is locked. Nothing has been measured. */
  'REGISTERED',
  /** Evaluation produced a comparable result under the locked policy. No verdict yet. */
  'EVALUATED',
  /** The locked acceptance policy passed. A MACHINE verdict, not permission. */
  'ACCEPTED',
  /** A human authorised the change. Permission, held separately from evidence. */
  'APPROVED',
  /**
   * The activation write has been ATTEMPTED. Recorded BEFORE the external side effect,
   * so a crash between the write and the confirmation leaves this state rather than a
   * state that claims either safety or success. Something may be live. Treat as unsafe.
   */
  'ACTIVATING',
  /** The activation target POSITIVELY READ BACK the candidate. Confirmed, not assumed. */
  'ACTIVATED',
  /** Telemetry positively confirms the candidate served real verification traffic. */
  'VERIFIED',
  /** The operator closed the migration. The candidate is the new baseline. */
  'STABLE',
  /** The acceptance policy failed. */
  'REJECTED',
  /**
   * The acceptance policy changed after this migration's evidence was produced, so the
   * verdict on record was earned under rules that no longer exist.
   *
   * A dead end by design: there is no path from here to APPROVED. The only way forward is
   * a fresh evaluation under the current policy.
   */
  'EVIDENCE_STALE',
  /** The activation target did not read back the candidate. Nothing was confirmed live. */
  'ACTIVATION_FAILED',
  /** Post-activation verification did not confirm. */
  'FAILED_VERIFICATION',
  /** A rollback write has been attempted. Recorded before the side effect. */
  'ROLLING_BACK',
  /** The activation target POSITIVELY READ BACK the rollback target. */
  'ROLLED_BACK',
  /** The rollback write did not take effect. The system is NOT known to be safe. */
  'ROLLBACK_FAILED',
  /**
   * The operator gave up on this candidate before anything was activated.
   *
   * Reachable only from pre-activation states, where nothing is live and abandoning costs
   * nothing. After activation the way out is rollback, not abandonment.
   */
  'ABANDONED',
] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

export const MIGRATION_ACTIONS = [
  'register',
  'evaluate',
  'accept',
  'reject',
  'approve',
  'invalidateEvidence',
  'beginActivation',
  'confirmActivation',
  'failActivation',
  'verify',
  'failVerification',
  'stabilise',
  'beginRollback',
  'confirmRollback',
  'failRollback',
  'abandon',
] as const;

export type MigrationAction = (typeof MIGRATION_ACTIONS)[number];

/**
 * States from which no further action is legal and a NEW migration may begin.
 *
 * ROLLBACK_FAILED and ACTIVATION_FAILED are deliberately NOT terminal: the system is not
 * known to be safe, so the migration stays open and rollback stays reachable.
 */
export const TERMINAL_STATES: readonly MigrationState[] = ['STABLE', 'ROLLED_BACK', 'ABANDONED'];

/** States in which something other than the baseline may be serving traffic. */
export const LIVE_RISK_STATES: readonly MigrationState[] = [
  'ACTIVATING',
  'ACTIVATED',
  'VERIFIED',
  'FAILED_VERIFICATION',
  'STABLE',
  'ACTIVATION_FAILED',
  'ROLLBACK_FAILED',
];

/**
 * One recorded fact. The ledger of these events IS the migration state: current state is
 * a fold over the events, never a separately maintained field.
 */
export interface MigrationEvent {
  readonly seq: number;
  readonly at: string;
  readonly action: MigrationAction;
  readonly from: MigrationState | null;
  readonly to: MigrationState;
  /** Who caused it. `operator:<name>` for human acts, `system` for machine verdicts. */
  readonly actor: string;
  /** Action-specific evidence. Free-form but always recorded verbatim. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EvaluationCase {
  readonly id: string;
  readonly input: string;
  readonly expected: string;
}

export interface CaseResult {
  readonly caseId: string;
  readonly output: string;
  readonly passed: boolean;
  readonly score: number;
}

export interface EvaluationResult {
  readonly modelId: ModelId;
  readonly casesRun: number;
  readonly passed: number;
  readonly score: number;
  readonly criticalFailures: readonly string[];
  readonly results: readonly CaseResult[];
}

export interface ComparativeEvaluation {
  readonly baseline: EvaluationResult;
  readonly candidate: EvaluationResult;
  /** candidate.score minus baseline.score. Negative means the candidate is worse. */
  readonly delta: number;
  /** Stable hash of the case set, so a later report can prove which cases were used. */
  readonly caseSetHash: string;
  /** The policy hash in force when this evidence was generated. */
  readonly governingPolicyHash: string;
}

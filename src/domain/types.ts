// The migration lifecycle, as data.
//
// A model change is treated as a stateful operation with a small number of legal
// transitions, not as a config edit that happens to work out.

/** Identifier for a model as your application knows it. Opaque to the framework. */
export type ModelId = string;

export const MIGRATION_STATES = [
  /** A candidate exists and is declared. Nothing has been measured. */
  'REGISTERED',
  /** Evaluation has produced a comparable result. No verdict has been applied. */
  'EVALUATED',
  /** The declared acceptance policy passed. A MACHINE verdict, not permission. */
  'ACCEPTED',
  /** A human authorised the change. Permission, held separately from evidence. */
  'APPROVED',
  /** The activation target reports the candidate as the serving model. */
  'ACTIVATED',
  /** Telemetry positively confirms the candidate served real verification traffic. */
  'VERIFIED',
  /** The operator closed the migration. The candidate is the new baseline. */
  'STABLE',
  /** The acceptance policy failed. */
  'REJECTED',
  /** Post-activation verification did not confirm. */
  'FAILED_VERIFICATION',
  /** A rollback is in progress. */
  'ROLLING_BACK',
  /** The rollback target is serving again. */
  'ROLLED_BACK',
] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

export const MIGRATION_ACTIONS = [
  'register',
  'evaluate',
  'accept',
  'reject',
  'approve',
  'activate',
  'verify',
  'failVerification',
  'stabilise',
  'beginRollback',
  'completeRollback',
] as const;

export type MigrationAction = (typeof MIGRATION_ACTIONS)[number];

/** States from which no further action is legal. */
export const TERMINAL_STATES: readonly MigrationState[] = ['STABLE', 'ROLLED_BACK'];

/**
 * One recorded fact. The ledger of these events IS the migration state: current state is
 * a fold over the events, never a separately maintained field. A report therefore cannot
 * describe a transition that was not recorded, because there is nothing else to read.
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
}

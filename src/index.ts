// PUBLIC LIBRARY API.
//
// The CLI is a thin shell over this. Everything exported here is supported surface and
// changes to it follow semver; anything reachable only by deep-importing a file path is
// internal and may move without notice.
//
//   import { register, evaluate, decide, approve, activate, verify, rollback } from 'modelshift';

// The lifecycle.
export {
  abandon,
  register,
  evaluate,
  decide,
  approve,
  activate,
  verify,
  stabilise,
  rollback,
  emergencyRollback,
  status,
  statusOf,
  history,
  type MigrationView,
  type ActivationOutcome,
  type RollbackOutcome,
  type EmergencyOutcome,
} from './engine.ts';

// Configuration.
export {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  parseConfig,
  policyHash,
  writeConfig,
  type AcceptancePolicy,
  type ModelshiftConfig,
  type VerificationBounds,
} from './config.ts';

// The adapter boundary. Implement these to govern your own system.
export type {
  ActivationTarget,
  Evaluator,
  ModelAdapter,
  Ports,
  ServingObservation,
  TelemetrySource,
} from './ports/index.ts';

// The state machine, for tooling that wants to reason about or render the lifecycle.
export {
  TRANSITIONS,
  foldState,
  isLegalEvent,
  nextState,
  statesPermitting,
} from './domain/machine.ts';

export {
  LIVE_RISK_STATES,
  MIGRATION_ACTIONS,
  MIGRATION_STATES,
  TERMINAL_STATES,
  type CaseResult,
  type ComparativeEvaluation,
  type EvaluationCase,
  type EvaluationResult,
  type MigrationAction,
  type MigrationEvent,
  type MigrationId,
  type MigrationState,
  type ModelId,
} from './domain/types.ts';

// Errors, so callers can branch on failure kind rather than on message text.
export {
  ActivationNotConfirmedError,
  ConfigError,
  IllegalTransitionError,
  InvalidEvidenceError,
  LedgerCorruptError,
  NoMigrationError,
  NoVerificationPlanError,
  PolicyViolationError,
  RollbackNotConfirmedError,
  StalePolicyEvidenceError,
  UnsafeIdentifierError,
  VerificationBoundsError,
} from './domain/errors.ts';

// Storage and audit.
export {
  activeMigrationId,
  listMigrations,
  readMigration,
  readRecovery,
  initStore,
  storeExists,
} from './store/ledger.ts';

export { renderReport } from './audit/report.ts';
export { evaluateAcceptance, type AcceptanceVerdict } from './policy/acceptance.ts';
export { assertValidEvidence } from './policy/evidence.ts';
export { assertServingModel, runBoundedVerification, type BoundedRunResult, type TelemetryAssertion } from './verify/index.ts';

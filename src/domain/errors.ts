// Errors are part of the interface. Each one says what was refused, what state the
// migration is actually in, and what would make the action legal.

import type { MigrationAction, MigrationState } from './types.ts';

export class IllegalTransitionError extends Error {
  readonly action: MigrationAction;
  readonly current: MigrationState;
  readonly requiredStates: readonly MigrationState[];

  constructor(action: MigrationAction, current: MigrationState, requiredStates: readonly MigrationState[]) {
    const required = requiredStates.length > 0 ? requiredStates.join(' or ') : '(no state permits this action)';
    super(
      `Cannot "${action}" from state ${current}.\n` +
        `  required state : ${required}\n` +
        `  current state  : ${current}`,
    );
    this.name = 'IllegalTransitionError';
    this.action = action;
    this.current = current;
    this.requiredStates = requiredStates;
  }
}

/**
 * The ledger could not be read or folded. The migration's true state is UNKNOWN.
 *
 * This never degrades into a usable default. A corrupt ledger that read as REGISTERED
 * would invite re-activation of a model whose real status nobody knows.
 */
export class LedgerCorruptError extends Error {
  readonly path: string;
  readonly line: number | null;

  constructor(path: string, reason: string, line: number | null = null) {
    super(
      `Migration ledger at ${path} could not be read: ${reason}.\n` +
        (line === null ? '' : `  first bad record: line ${line}\n`) +
        '  The true migration state is UNKNOWN. No forward action is permitted.\n' +
        '  Rollback remains available through the EMERGENCY path, which reads no ledger and\n' +
        '  takes its target from configuration. That is a different authority from a normal\n' +
        '  rollback, which uses the target locked into this migration when it began.',
    );
    this.name = 'LedgerCorruptError';
    this.path = path;
    this.line = line;
  }
}

export class PolicyViolationError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Acceptance policy not satisfied:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
    this.name = 'PolicyViolationError';
    this.reasons = reasons;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid modelshift configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

export class NoMigrationError extends Error {
  constructor(path: string) {
    super(
      `No migration found at ${path}.\n` +
        '  Run "modelshift init" then "modelshift register <candidate>" to start one.',
    );
    this.name = 'NoMigrationError';
  }
}

/** An externally supplied identifier could forge or distort the audit report. */
export class UnsafeIdentifierError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(
      `Rejected the value supplied for "${field}" because ${reason}.\n` +
        '  Identifiers appear verbatim in the audit report, so they must not be able to\n' +
        '  forge a line of it. Use printable characters with no leading or trailing spaces.',
    );
    this.name = 'UnsafeIdentifierError';
    this.field = field;
  }
}

/** The activation target did not read back the model that was written to it. */
export class ActivationNotConfirmedError extends Error {
  readonly requested: string;
  readonly observed: string;
  constructor(requested: string, observed: string, target: string) {
    super(
      `Activation was NOT confirmed. The target did not read back the candidate.\n` +
        `  requested : ${requested}\n` +
        `  observed  : ${observed}\n` +
        `  target    : ${target}\n` +
        '  The migration is recorded as ACTIVATION_FAILED, not ACTIVATED. Nothing is\n' +
        '  confirmed live. Roll back, then investigate the activation target.',
    );
    this.name = 'ActivationNotConfirmedError';
    this.requested = requested;
    this.observed = observed;
  }
}

/** The rollback write did not take effect. The system is NOT known to be safe. */
export class RollbackNotConfirmedError extends Error {
  readonly requested: string;
  readonly observed: string;
  constructor(requested: string, observed: string, target: string) {
    super(
      `Rollback was NOT confirmed. The target did not read back the rollback model.\n` +
        `  rollback target : ${requested}\n` +
        `  still observed  : ${observed}\n` +
        `  activation target: ${target}\n` +
        '  The migration is recorded as ROLLBACK_FAILED. THE SYSTEM IS NOT KNOWN TO BE SAFE.\n' +
        '  Intervene directly at the activation target.',
    );
    this.name = 'RollbackNotConfirmedError';
    this.requested = requested;
    this.observed = observed;
  }
}

/**
 * Production is not serving the baseline this migration measured its candidate against.
 *
 * Raised BEFORE anything is recorded and before the activation target is touched, so a
 * refused activation leaves both the ledger and production exactly as they were.
 */
export class BaselineDriftError extends Error {
  readonly migrationBaseline: string;
  readonly observedServing: string;
  readonly candidate: string;

  constructor(migrationBaseline: string, observedServing: string, candidate: string, target: string) {
    super(
      'Activation refused: production is not serving this migration\'s baseline.\n' +
        `  migration baseline : ${migrationBaseline}\n` +
        `  currently serving  : ${observedServing}\n` +
        `  candidate          : ${candidate}\n` +
        `  activation target  : ${target}\n` +
        `  The candidate was measured against ${migrationBaseline}, so the evidence on record\n` +
        `  describes a change FROM ${migrationBaseline}, not the change you would be making now.\n` +
        '  Nothing was written: no activation event was recorded and the target was not modified.\n' +
        '  Safe next action:\n' +
        `    - if ${observedServing} is what production should be serving, abandon this migration,\n` +
        `      set baselineModel to ${observedServing}, and register the candidate again so it is\n` +
        '      measured against what is actually running; or\n' +
        `    - if ${observedServing} is not intended, revert production to ${migrationBaseline} first,\n` +
        '      then activate.',
    );
    this.name = 'BaselineDriftError';
    this.migrationBaseline = migrationBaseline;
    this.observedServing = observedServing;
    this.candidate = candidate;
  }
}

/** The acceptance policy changed after the evidence it governs was produced. */
export class StalePolicyEvidenceError extends Error {
  readonly governingHash: string;
  readonly currentHash: string;
  constructor(governingHash: string, currentHash: string, step: string) {
    super(
      `Cannot ${step}: the acceptance policy changed after the evidence was produced.\n` +
        `  policy in force when evaluated : ${governingHash}\n` +
        `  policy in force now            : ${currentHash}\n` +
        '  The verdict on record was earned under different rules, so it no longer applies.\n' +
        '  Re-run "modelshift evaluate" to produce evidence under the current policy.',
    );
    this.name = 'StalePolicyEvidenceError';
    this.governingHash = governingHash;
    this.currentHash = currentHash;
  }
}

/** An evaluator returned something that cannot be trusted to drive an acceptance verdict. */
export class InvalidEvidenceError extends Error {
  readonly problems: readonly string[];
  constructor(modelId: string, problems: readonly string[]) {
    super(
      `The evaluator returned evidence that cannot support a verdict for "${modelId}":\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n  Evidence crossing the Evaluator boundary is validated before it can produce\n' +
        '  ACCEPTED, because an acceptance is only as good as the measurement behind it.',
    );
    this.name = 'InvalidEvidenceError';
    this.problems = problems;
  }
}

/** No verification inputs were supplied for a non-demo integration. */
export class NoVerificationPlanError extends Error {
  constructor(source: string) {
    super(
      `No verification inputs are available, and ports came from ${source}.\n` +
        '  modelshift will not send its built-in demo fixtures through your adapters.\n' +
        '  Supply one of:\n' +
        '    - a "verificationInputs" array in modelshift.config.json, or\n' +
        '    - a "verificationPlan()" export from modelshift.ports.ts returning string[].\n' +
        '  Verification traffic reaches your real system, so it must be traffic you chose.',
    );
    this.name = 'NoVerificationPlanError';
  }
}

export class VerificationBoundsError extends Error {
  constructor(reason: string) {
    super(`Invalid verification bounds: ${reason}. No model call and no telemetry write occurred.`);
    this.name = 'VerificationBoundsError';
  }
}

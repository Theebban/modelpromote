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
        '  Rollback remains available and uses the rollback target declared in configuration.',
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

export class VerificationBoundsError extends Error {
  constructor(reason: string) {
    super(`Invalid verification bounds: ${reason}. No model call and no telemetry write occurred.`);
    this.name = 'VerificationBoundsError';
  }
}

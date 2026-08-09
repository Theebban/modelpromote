// The transition table, and the only function permitted to move a migration.
//
// GOVERNING PRINCIPLE: fail closed on promotion, fail open on rollback.
//
// Every action that moves a candidate CLOSER to serving production traffic is an
// allow-list entry: absent from the table means refused. The single action that moves
// AWAY from an unsafe state, `beginRollback`, is legal from every state where something
// could be live. Blocking a promotion costs an operator five minutes; blocking a rollback
// costs an outage, so the two directions do not get symmetric caution.

import { IllegalTransitionError } from './errors.ts';
import type { MigrationAction, MigrationEvent, MigrationState } from './types.ts';

/**
 * ALLOW-LIST. `TRANSITIONS[action]` is the exhaustive set of states from which the action
 * is legal, mapped to the resulting state. Any (state, action) pair not present here is
 * refused. There is no default branch and no wildcard.
 */
export const TRANSITIONS: Readonly<Record<MigrationAction, Readonly<Partial<Record<MigrationState, MigrationState>>>>> =
  Object.freeze({
    // Registering is how a migration begins. `null` current state is handled by the caller.
    register: { },

    // Measuring may be repeated while the verdict is still open, including after a
    // rejection, because fixing a prompt and re-measuring is normal work.
    evaluate: { REGISTERED: 'EVALUATED', EVALUATED: 'EVALUATED', REJECTED: 'EVALUATED' },

    // A machine verdict against the declared policy. Requires a measurement to exist.
    accept: { EVALUATED: 'ACCEPTED' },
    reject: { EVALUATED: 'REJECTED' },

    // Human permission. Deliberately NOT reachable from EVALUATED: passing the policy is
    // a precondition of asking, so an operator cannot approve past a failed evaluation.
    approve: { ACCEPTED: 'APPROVED' },

    // The only action that changes what serves traffic forward.
    activate: { APPROVED: 'ACTIVATED' },

    // Verification outcomes.
    verify: { ACTIVATED: 'VERIFIED' },
    failVerification: { ACTIVATED: 'FAILED_VERIFICATION' },

    // Closing the migration. The candidate becomes the new baseline.
    stabilise: { VERIFIED: 'STABLE' },

    // FAIL OPEN. Legal from every state in which the candidate may be serving, including
    // STABLE: a migration that looked fine last week can still need reverting today.
    beginRollback: {
      ACTIVATED: 'ROLLING_BACK',
      VERIFIED: 'ROLLING_BACK',
      FAILED_VERIFICATION: 'ROLLING_BACK',
      STABLE: 'ROLLING_BACK',
      ROLLING_BACK: 'ROLLING_BACK',
    },
    completeRollback: { ROLLING_BACK: 'ROLLED_BACK' },
  });

/** The states from which an action is legal. Used for error messages and for docs. */
export function statesPermitting(action: MigrationAction): readonly MigrationState[] {
  return Object.keys(TRANSITIONS[action]) as MigrationState[];
}

/** Pure. Returns the next state, or throws. Never mutates anything. */
export function nextState(current: MigrationState, action: MigrationAction): MigrationState {
  const target = TRANSITIONS[action][current];
  if (target === undefined) {
    throw new IllegalTransitionError(action, current, statesPermitting(action));
  }
  return target;
}

/**
 * Fold the event ledger into the current state.
 *
 * This is the ONLY way current state is obtained. There is no separately stored state
 * field that could drift from the record, which is what makes an audit report structurally
 * incapable of describing a transition that was never recorded.
 */
export function foldState(events: readonly MigrationEvent[]): MigrationState | null {
  const last = events.at(-1);
  return last === undefined ? null : last.to;
}

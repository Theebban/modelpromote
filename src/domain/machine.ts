// The transition table, and the only function permitted to move a migration.
//
// GOVERNING PRINCIPLE: fail closed on promotion, fail open on rollback.
//
// Every action that moves a candidate CLOSER to serving production traffic is an
// allow-list entry: absent from the table means refused. The actions that move AWAY from an
// unsafe state are legal from every state where something could be live. Blocking a
// promotion costs an operator five minutes; blocking a rollback costs an outage, so the two
// directions do not get symmetric caution.
//
// SECOND PRINCIPLE: the table is also the ledger's validator. `isLegalEvent` is applied to
// every record on read, so a hand-edited ledger cannot describe a transition this table
// would never have produced.

import { IllegalTransitionError } from './errors.ts';
import type { MigrationAction, MigrationEvent, MigrationState } from './types.ts';

/**
 * ALLOW-LIST. `TRANSITIONS[action]` is the exhaustive set of states from which the action
 * is legal, mapped to the resulting state. Any pair not present is refused. No default
 * branch, no wildcard.
 */
export const TRANSITIONS: Readonly<Record<MigrationAction, Readonly<Partial<Record<MigrationState, MigrationState>>>>> =
  Object.freeze({
    // Registering begins a migration. Its legal `from` is null, handled by isLegalEvent.
    register: {},

    // Measuring may repeat while the verdict is open, including after a rejection, because
    // fixing a prompt and re-measuring is normal work. Re-evaluation re-locks the policy.
    evaluate: { REGISTERED: 'EVALUATED', EVALUATED: 'EVALUATED', REJECTED: 'EVALUATED', EVIDENCE_STALE: 'EVALUATED' },

    accept: { EVALUATED: 'ACCEPTED' },
    reject: { EVALUATED: 'REJECTED' },

    // Human permission. Not reachable from EVALUATED: passing the policy is a precondition
    // of asking, so an operator cannot approve past a failed or absent verdict.
    approve: { ACCEPTED: 'APPROVED' },

    // POLICY LOCKING, as a recorded transition rather than a runtime condition.
    //
    // When the acceptance policy changes after a verdict, the verdict is void. Expressing
    // that as an explicit state keeps the transition table a PURE function of
    // (state, action): the ledger validator can judge any record from the record alone,
    // which a conditional "evaluate is legal from ACCEPTED only if the policy moved" would
    // have destroyed. That condition is exactly the hole the semantic validator closes.
    //
    // EVIDENCE_STALE is a dead end towards approval. Its only exit is a fresh evaluate.
    invalidateEvidence: { ACCEPTED: 'EVIDENCE_STALE' },

    // TWO-PHASE ACTIVATION.
    // beginActivation is recorded BEFORE the external write. If the process dies between
    // the write and the confirmation, the ledger says ACTIVATING, which reads as "something
    // may be live and nothing is confirmed". That is the only honest reading, and it keeps
    // rollback reachable. A one-phase activation cannot express it.
    beginActivation: { APPROVED: 'ACTIVATING' },
    confirmActivation: { ACTIVATING: 'ACTIVATED' },
    failActivation: { ACTIVATING: 'ACTIVATION_FAILED' },

    verify: { ACTIVATED: 'VERIFIED' },
    failVerification: { ACTIVATED: 'FAILED_VERIFICATION' },

    stabilise: { VERIFIED: 'STABLE' },

    // FAIL OPEN, and two-phase for the same reason as activation.
    beginRollback: {
      ACTIVATING: 'ROLLING_BACK',
      ACTIVATED: 'ROLLING_BACK',
      VERIFIED: 'ROLLING_BACK',
      FAILED_VERIFICATION: 'ROLLING_BACK',
      STABLE: 'ROLLING_BACK',
      ACTIVATION_FAILED: 'ROLLING_BACK',
      ROLLBACK_FAILED: 'ROLLING_BACK',
      ROLLING_BACK: 'ROLLING_BACK',
    },
    confirmRollback: { ROLLING_BACK: 'ROLLED_BACK' },
    failRollback: { ROLLING_BACK: 'ROLLBACK_FAILED' },

    // GIVING UP, before anything is live.
    //
    // Without this a rejected candidate wedges the whole project: a migration is open so no
    // new one may begin, and there is nothing to roll back because nothing was activated.
    // Found by walking the tool as a new user, not by any test.
    //
    // Deliberately NOT reachable from ACTIVATING onwards. Once something may be serving,
    // the way out is rollback; letting an operator "abandon" a live migration would close
    // the record while leaving the candidate in production.
    abandon: {
      REGISTERED: 'ABANDONED',
      EVALUATED: 'ABANDONED',
      REJECTED: 'ABANDONED',
      EVIDENCE_STALE: 'ABANDONED',
      ACCEPTED: 'ABANDONED',
      APPROVED: 'ABANDONED',
    },
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
 * SEMANTIC VALIDATION. Is this (action, from, to) triple something the machine could have
 * produced?
 *
 * Structural checks (parseable JSON, known enum members, contiguous sequence, `from`
 * matching the previous `to`) are not enough. Editing a single field of a valid record can
 * keep every structural check satisfied while inventing a transition that no code path
 * could ever execute: changing the first event's `to` from REGISTERED to APPROVED leaves a
 * well-formed chain that skips evaluation and approval entirely.
 *
 * This closes that hole by validating every record against the transition table itself.
 */
export function isLegalEvent(action: MigrationAction, from: MigrationState | null, to: MigrationState): boolean {
  if (action === 'register') {
    // The only action with a null `from`, and it has exactly one legal destination.
    return from === null && to === 'REGISTERED';
  }
  if (from === null) return false;
  return TRANSITIONS[action][from] === to;
}

/**
 * Fold the event ledger into the current state.
 *
 * This is the ONLY way current state is obtained. There is no separately stored state field
 * that could drift from the record, which is what makes an audit report structurally
 * incapable of describing a transition that was never recorded.
 */
export function foldState(events: readonly MigrationEvent[]): MigrationState | null {
  const last = events.at(-1);
  return last === undefined ? null : last.to;
}

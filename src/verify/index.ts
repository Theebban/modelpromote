// POST-ACTIVATION VERIFICATION.
//
// Two separate claims, deliberately not merged:
//
//   1. BOUNDED EXECUTION   - we issued traffic, and never more than the declared ceiling.
//   2. TELEMETRY ASSERTION - the candidate is what served everything observed afterwards.
//
// Claim 1 without claim 2 is "we deployed and nothing crashed", which is the mistake this
// framework exists to stop. Deployment status reports intent; telemetry reports fact.
//
// WHAT CLAIM 2 IS AND IS NOT. It is a TEMPORAL WINDOW assertion:
//
//   PROVEN      every observation your telemetry recorded after the window opened names the
//               candidate as the serving model, and there were at least `minObservations`
//               of them.
//   NOT PROVEN  that these exact verification calls were the observations. modelshift does
//               not propagate a correlation id through your adapter, so it cannot pair a
//               call it issued with a row your telemetry produced.
//
// An independent review demonstrated the gap by issuing bounded verification calls and then
// supplying unrelated ambient candidate telemetry after the marker: verification confirmed.
// The V0 ruling is to keep the temporal claim and state it exactly, rather than to grow a
// distributed-tracing contract across the adapter boundary for it. Per-request correlation
// is a future contract, and it would need a real id to travel with the request; inventing a
// correlation the adapters cannot carry would move the same gap somewhere less visible.
//
// The labels in `issuedCallLabels` are named for what they are: local labels for reporting,
// not identifiers anything else has seen.

import { VerificationBoundsError } from '../domain/errors.ts';
import type { VerificationBounds } from '../config.ts';
import type { ModelAdapter, ServingObservation, TelemetrySource } from '../ports/index.ts';
import type { ModelId } from '../domain/types.ts';

export type StopReason = 'plan-complete' | 'ceiling';

export interface BoundedRunResult {
  readonly requestsAvailable: number;
  readonly requestsMade: number;
  readonly truncated: boolean;
  readonly stoppedBy: StopReason;
  /**
   * LOCAL labels for the calls this run issued, in order. For reporting only.
   *
   * They are NOT correlation ids: nothing outside this function has seen them, they are not
   * passed to the adapter, and they cannot be matched against telemetry rows. The previous
   * name, `requestIds`, invited exactly that reading, and the demo telemetry happened to
   * generate similar-looking strings independently, which made the coincidence look like a
   * design.
   */
  readonly issuedCallLabels: readonly string[];
}

function assertBounds(bounds: VerificationBounds): void {
  if (!Number.isInteger(bounds.maxRequests) || bounds.maxRequests < 1) {
    throw new VerificationBoundsError('verification.maxRequests must be a positive integer');
  }
  if (!Number.isInteger(bounds.minObservations) || bounds.minObservations < 1) {
    throw new VerificationBoundsError('verification.minObservations must be a positive integer');
  }
}

/**
 * Issue verification traffic under a hard ceiling.
 *
 * THE CEILING IS ENFORCED BY THE LOOP. The full input is iterated and the bound is tested
 * before every request, so the guarantee is a property of this function.
 *
 * Slicing the input down to `maxRequests` before the loop would look equivalent and is not:
 * it makes the in-loop guard unreachable and moves the guarantee into the caller, where no
 * test can reach it. Truncation is always reported, because silent truncation reads as
 * "we covered everything".
 */
export async function runBoundedVerification(
  inputs: readonly string[],
  adapter: ModelAdapter,
  bounds: VerificationBounds,
  onRequest: (callLabel: string, output: string) => void = () => {},
): Promise<BoundedRunResult> {
  assertBounds(bounds);

  const issuedCallLabels: string[] = [];
  let made = 0;

  const stop = (stoppedBy: StopReason): BoundedRunResult => ({
    requestsAvailable: inputs.length,
    requestsMade: made,
    truncated: made < inputs.length,
    stoppedBy,
    issuedCallLabels,
  });

  for (const input of inputs) {
    if (made >= bounds.maxRequests) return stop('ceiling');
    const callLabel = `call-${String(made + 1).padStart(3, '0')}`;
    const output = await adapter.complete(input);
    made += 1;
    issuedCallLabels.push(callLabel);
    onRequest(callLabel, output);
  }

  return stop('plan-complete');
}

/**
 * The strength of evidence a telemetry confirmation carries.
 *
 * A single member today, and a field rather than a comment on purpose: every recorded
 * assertion states its own evidence class, so a reader of the ledger does not have to know
 * which version of the framework wrote it, and a future per-request contract cannot be
 * mistaken for this one after the fact.
 */
export type TelemetryEvidenceClass = 'temporal-window';

export interface TelemetryAssertion {
  readonly confirmed: boolean;
  readonly expected: ModelId;
  readonly observed: readonly ModelId[];
  readonly observationCount: number;
  readonly required: number;
  /**
   * `temporal-window`: every observation recorded after the window opened named the expected
   * model. NOT a per-request correlation between the calls issued and the rows observed.
   */
  readonly evidenceClass: TelemetryEvidenceClass;
  /** The telemetry row the window opens AFTER. Null means the source's whole history. */
  readonly windowOpensAfter: string | null;
  readonly reason: string;
}

/**
 * Confirm which model served everything observed in a window.
 *
 * AN EMPTY OBSERVATION SET IS NEVER CONFIRMATION. Absence of contrary evidence is not
 * evidence: a telemetry pipeline that is simply broken produces exactly the same empty set
 * as a model that served nothing, and the safe reading of both is "unconfirmed".
 *
 * THE WINDOW IS TEMPORAL. `windowOpensAfter` is a telemetry row id used purely as an
 * ordering mark; it is not an id of anything modelshift issued. Confirmation therefore means
 * "the candidate served all traffic observed after this point", not "the candidate served
 * these specific verification calls". The distinction matters when other traffic reaches the
 * same telemetry stream, and the reason strings say so rather than implying the stronger
 * claim.
 */
export async function assertServingModelInWindow(
  telemetry: TelemetrySource,
  expected: ModelId,
  bounds: VerificationBounds,
  windowOpensAfter: string | null = null,
): Promise<TelemetryAssertion> {
  const rows: readonly ServingObservation[] = await telemetry.observations(windowOpensAfter);
  const observed = [...new Set(rows.map((r) => r.servedBy))].sort();

  let reason: string;
  let confirmed: boolean;

  if (rows.length === 0) {
    confirmed = false;
    reason = 'no observations in the window. An empty telemetry set is not confirmation: absence of contrary evidence is not evidence';
  } else if (rows.length < bounds.minObservations) {
    confirmed = false;
    reason = `only ${rows.length} observation(s) in the window, the declared minimum is ${bounds.minObservations}`;
  } else if (observed.length !== 1) {
    confirmed = false;
    reason = `traffic in the window was split across ${observed.length} models (${observed.join(', ')}); expected ${expected} alone`;
  } else if (observed[0] !== expected) {
    confirmed = false;
    reason = `expected ${expected} to be serving, but telemetry in the window shows ${observed[0]}`;
  } else {
    confirmed = true;
    reason =
      `all ${rows.length} observation(s) recorded in this window were served by ${expected}. ` +
      'This is a temporal claim about the window, not a per-request correlation with the calls issued';
  }

  return {
    confirmed,
    expected,
    observed,
    observationCount: rows.length,
    required: bounds.minObservations,
    evidenceClass: 'temporal-window',
    windowOpensAfter,
    reason,
  };
}

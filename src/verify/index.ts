// POST-ACTIVATION VERIFICATION.
//
// Two separate claims, deliberately not merged:
//
//   1. BOUNDED EXECUTION  - we issued traffic, and never more than the declared ceiling.
//   2. TELEMETRY ASSERTION - the candidate is what actually served it.
//
// Claim 1 without claim 2 is "we deployed and nothing crashed", which is the mistake this
// framework exists to stop. Deployment status reports intent; telemetry reports fact.

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
  readonly requestIds: readonly string[];
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
  onRequest: (requestId: string, output: string) => void = () => {},
): Promise<BoundedRunResult> {
  assertBounds(bounds);

  const requestIds: string[] = [];
  let made = 0;

  const stop = (stoppedBy: StopReason): BoundedRunResult => ({
    requestsAvailable: inputs.length,
    requestsMade: made,
    truncated: made < inputs.length,
    stoppedBy,
    requestIds,
  });

  for (const input of inputs) {
    if (made >= bounds.maxRequests) return stop('ceiling');
    const requestId = `verify-${String(made + 1).padStart(3, '0')}`;
    const output = await adapter.complete(input);
    made += 1;
    requestIds.push(requestId);
    onRequest(requestId, output);
  }

  return stop('plan-complete');
}

export interface TelemetryAssertion {
  readonly confirmed: boolean;
  readonly expected: ModelId;
  readonly observed: readonly ModelId[];
  readonly observationCount: number;
  readonly required: number;
  readonly reason: string;
}

/**
 * Confirm which model actually served.
 *
 * AN EMPTY OBSERVATION SET IS NEVER CONFIRMATION. Absence of contrary evidence is not
 * evidence: a telemetry pipeline that is simply broken produces exactly the same empty set
 * as a model that served nothing, and the safe reading of both is "unconfirmed".
 */
export async function assertServingModel(
  telemetry: TelemetrySource,
  expected: ModelId,
  bounds: VerificationBounds,
  sinceRequestId: string | null = null,
): Promise<TelemetryAssertion> {
  const rows: readonly ServingObservation[] = await telemetry.observations(sinceRequestId);
  const observed = [...new Set(rows.map((r) => r.servedBy))].sort();

  let reason: string;
  let confirmed: boolean;

  if (rows.length === 0) {
    confirmed = false;
    reason = 'no observations. An empty telemetry set is not confirmation: absence of contrary evidence is not evidence';
  } else if (rows.length < bounds.minObservations) {
    confirmed = false;
    reason = `only ${rows.length} observation(s), the declared minimum is ${bounds.minObservations}`;
  } else if (observed.length !== 1) {
    confirmed = false;
    reason = `traffic was split across ${observed.length} models (${observed.join(', ')}); expected ${expected} alone`;
  } else if (observed[0] !== expected) {
    confirmed = false;
    reason = `expected ${expected} to be serving, but telemetry shows ${observed[0]}`;
  } else {
    confirmed = true;
    reason = `all ${rows.length} observation(s) served by ${expected}`;
  }

  return { confirmed, expected, observed, observationCount: rows.length, required: bounds.minObservations, reason };
}

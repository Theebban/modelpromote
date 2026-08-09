// THE ADAPTER BOUNDARY.
//
// modelshift owns the lifecycle, the policy decision and the record. It deliberately owns
// none of the following, because mature tools already do them well:
//
//   - generating text            -> your provider SDK, or a gateway such as LiteLLM
//   - scoring output quality     -> your own metric, Promptfoo, DeepEval, a human
//   - changing what serves       -> your config store, a flag service, an env var
//   - recording what happened    -> your logs, OpenTelemetry, Langfuse
//
// Each is a port. Implement the small interface and modelshift governs whatever is behind
// it. Nothing in the core imports an adapter; the wiring happens once, at the edge.

import type { EvaluationCase, EvaluationResult, ModelId } from '../domain/types.ts';

/** Generates output for one evaluation case. Wraps whatever you already call. */
export interface ModelAdapter {
  readonly id: ModelId;
  complete(input: string): Promise<string> | string;
}

/**
 * Scores a model over a case set.
 *
 * The default implementation is exact-match, which is intentionally weak: quality metrics
 * are a solved and competitive space, and modelshift is not trying to win it. Point this
 * port at a real evaluator and the lifecycle is unchanged.
 */
export interface Evaluator {
  readonly name: string;
  evaluate(adapter: ModelAdapter, cases: readonly EvaluationCase[]): Promise<EvaluationResult> | EvaluationResult;
}

/**
 * Changes, and reports, which model your application actually serves.
 *
 * `read()` is not decoration. Activation is not "we wrote the config"; it is "the target
 * reports the new value back". A write that silently no-ops is the failure this catches.
 */
export interface ActivationTarget {
  readonly name: string;
  read(): Promise<ModelId> | ModelId;
  write(model: ModelId): Promise<void> | void;
}

/** One observation of a request that was actually served. */
export interface ServingObservation {
  readonly requestId: string;
  readonly servedBy: ModelId;
}

/**
 * Reports which model served recent traffic.
 *
 * Point this at your own logs, OTel, or a provider's response metadata. modelshift only
 * needs to know what identity actually answered.
 */
export interface TelemetrySource {
  readonly name: string;
  observations(sinceRequestId: string | null): Promise<readonly ServingObservation[]> | readonly ServingObservation[];
}

/** Everything the engine needs from the outside world. */
export interface Ports {
  readonly models: ReadonlyMap<ModelId, ModelAdapter>;
  readonly evaluator: Evaluator;
  readonly activation: ActivationTarget;
  readonly telemetry: TelemetrySource;
  /** Injected so audit output can be made deterministic in tests. */
  readonly now: () => string;
}

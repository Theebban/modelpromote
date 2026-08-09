// Wiring for the built-in demonstration.
//
// This is what a real integration looks like, with local stand-ins behind each port. To
// govern your own system you write this file for your stack and nothing else changes.

import { join } from 'node:path';
import type { ModelAdapter, Ports, ServingObservation } from '../../ports/index.ts';
import type { ModelId } from '../../domain/types.ts';
import {
  demoBaseline,
  demoCandidate,
  demoRegression,
  exactMatchEvaluator,
  fileActivationTarget,
  fileTelemetrySource,
  recordObservation,
} from './index.ts';

export const DEMO_DIR = '.modelshift';

/**
 * Instrument a model adapter so every call records which model actually answered.
 *
 * This stands in for YOUR application logging the serving identity. It records the
 * adapter's own id, not the model anyone hoped was serving, which is what makes a
 * mismatch detectable instead of assumed.
 */
export function instrument(adapter: ModelAdapter, telemetryPath: string, seq: { n: number }): ModelAdapter {
  return {
    id: adapter.id,
    async complete(input: string): Promise<string> {
      const output = await adapter.complete(input);
      seq.n += 1;
      const obs: ServingObservation = { requestId: `verify-${String(seq.n).padStart(3, '0')}`, servedBy: adapter.id };
      recordObservation(telemetryPath, obs);
      return output;
    },
  };
}

export function demoPorts(root: string, initialServing: ModelId, now: () => string = () => new Date().toISOString()): Ports {
  const activationPath = join(root, DEMO_DIR, 'serving.json');
  const telemetryPath = join(root, DEMO_DIR, 'telemetry.jsonl');
  const seq = { n: 0 };

  const models = new Map<ModelId, ModelAdapter>();
  for (const a of [demoBaseline, demoCandidate, demoRegression]) {
    models.set(a.id, instrument(a, telemetryPath, seq));
  }

  return {
    models,
    evaluator: exactMatchEvaluator,
    // Stable, path-free labels: these strings land in the audit ledger.
    activation: fileActivationTarget(activationPath, initialServing, `file:${DEMO_DIR}/serving.json`),
    telemetry: fileTelemetrySource(telemetryPath, `file:${DEMO_DIR}/telemetry.jsonl`),
    now,
  };
}

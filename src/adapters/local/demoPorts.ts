// Wiring for the built-in demonstration.
//
// This is what a real integration looks like, with local stand-ins behind each port. To
// govern your own system you write this file for your stack and nothing else changes.

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ModelAdapter, Ports, ServingObservation } from '../../ports/index.ts';
import type { ModelId } from '../../domain/types.ts';
import { DEMO_VERIFICATION_INPUTS } from './fixtures.ts';
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

/** How many observations the demo telemetry file already holds. */
function existingObservationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
}

/**
 * Instrument a model adapter so every call records which model actually answered.
 *
 * This stands in for YOUR application logging the serving identity. It records the
 * adapter's own id, not the model anyone hoped was serving, which is what makes a
 * mismatch detectable instead of assumed.
 *
 * The observation ids are the DEMO APPLICATION's own, invented here and known only to the
 * telemetry file. They are deliberately named nothing like the call labels
 * `runBoundedVerification` produces: the two are independent, verification never matches one
 * against the other, and ids that looked alike made that independence easy to miss.
 */
export function instrument(adapter: ModelAdapter, telemetryPath: string, seq: { n: number }): ModelAdapter {
  return {
    id: adapter.id,
    async complete(input: string): Promise<string> {
      const output = await adapter.complete(input);
      seq.n += 1;
      const obs: ServingObservation = { requestId: `obs-${String(seq.n).padStart(3, '0')}`, servedBy: adapter.id };
      recordObservation(telemetryPath, obs);
      return output;
    },
  };
}

export function demoPorts(root: string, initialServing: ModelId, now: () => string = () => new Date().toISOString()): Ports {
  const activationPath = join(root, DEMO_DIR, 'serving.json');
  const telemetryPath = join(root, DEMO_DIR, 'telemetry.jsonl');

  // Seed the request counter from the observations already on disk, so ids keep increasing
  // across separate CLI invocations instead of restarting at 1 each time.
  //
  // They restarted originally, which made request ids repeat across migrations. Verification
  // scopes its telemetry to "everything after the last observation seen before the run", and
  // a repeated id made that marker match an OLD row, so the scope silently widened to include
  // a previous migration's traffic and verification failed on a healthy system. Found by
  // running a second migration in the stranger walk, not by any test.
  const seq = { n: existingObservationCount(telemetryPath) };

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
    // Marks this wiring as the built-in demonstration. Only demo wiring may fall back to
    // the bundled fixtures for verification traffic; a custom integration must supply its
    // own, because that traffic reaches a real system.
    isDemo: true,
    verificationPlan: () => DEMO_VERIFICATION_INPUTS,
  };
}

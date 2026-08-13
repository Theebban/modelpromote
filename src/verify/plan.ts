// WHAT TRAFFIC VERIFICATION ISSUES, and where it is allowed to come from.
//
// Verification traffic reaches a REAL system through REAL adapters. The original v0 passed
// the framework's own demo fixtures to whatever ports were loaded, including a custom
// integration, which means sample strings from a test suite would have been sent to
// somebody's production model. Nobody would choose that default if asked.
//
// So the bundled fixtures are usable by the built-in demonstration and by nothing else.
// Everything else must say what to send, and if it has not, verification FAILS CLOSED.

import { NoVerificationPlanError } from '../domain/errors.ts';
import type { ModelPromoteConfig } from '../config.ts';
import type { Ports } from '../ports/index.ts';

export interface ResolvedPorts {
  readonly ports: Ports;
  /** Human-readable origin of the wiring, used in errors and in the audit trail. */
  readonly source: string;
  /** True when the wiring came from the project's own `modelpromote.ports` file. */
  readonly custom: boolean;
}

export interface ResolvedInputs {
  readonly inputs: readonly string[];
  readonly origin: 'config' | 'ports-plan' | 'demo-fixtures';
}

/**
 * Resolve verification traffic, in precedence order.
 *
 * 1. `verificationInputs` in the config file. Explicit, reviewable, version-controlled.
 * 2. `verificationPlan()` from the project's ports file. For traffic that must be computed.
 * 3. The bundled demo fixtures, and ONLY for the built-in demonstration wiring.
 *
 * Anything else raises. `demoFixtures` is injected rather than imported so this module
 * cannot reach the fixtures on its own.
 */
export async function resolveVerificationInputs(
  config: ModelPromoteConfig,
  loaded: ResolvedPorts,
  demoFixtures: () => Promise<readonly string[]> | readonly string[],
): Promise<ResolvedInputs> {
  if (config.verificationInputs !== undefined && config.verificationInputs.length > 0) {
    return { inputs: config.verificationInputs, origin: 'config' };
  }

  if (typeof loaded.ports.verificationPlan === 'function') {
    const plan = await loaded.ports.verificationPlan();
    if (Array.isArray(plan) && plan.length > 0) {
      return { inputs: plan, origin: 'ports-plan' };
    }
  }

  // Both conditions are required. `isDemo` alone is not enough: a custom ports file could
  // set it, deliberately or by copying the demo wiring, and that must not unlock fixtures.
  if (loaded.ports.isDemo === true && !loaded.custom) {
    return { inputs: await demoFixtures(), origin: 'demo-fixtures' };
  }

  throw new NoVerificationPlanError(loaded.source);
}

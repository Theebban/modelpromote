// Shared test scaffolding.
//
// Every test gets its own temporary root and removes it in afterEach. A single after()
// hook would only ever see the LAST root and leak every earlier one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, writeConfig, loadConfig, type ModelshiftConfig } from '../src/config.ts';
import { initStore } from '../src/store/ledger.ts';
import { demoPorts } from '../src/adapters/local/demoPorts.ts';
import { DEMO_CASES } from '../src/adapters/local/fixtures.ts';
import { activate, approve, decide, evaluate, register, verify } from '../src/engine.ts';
import type { Ports } from '../src/ports/index.ts';
import type { ModelId } from '../src/domain/types.ts';

export const TMP_PREFIX = 'modelshift-test-';

/** A fixed clock, so audit output is byte-deterministic in tests. */
export function fixedClock(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  };
}

export function makeRoot(config: Partial<ModelshiftConfig> = {}): string {
  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  writeConfig(root, {
    ...DEFAULT_CONFIG,
    ...config,
    acceptance: { ...DEFAULT_CONFIG.acceptance, ...(config.acceptance ?? {}) },
    verification: { ...DEFAULT_CONFIG.verification, ...(config.verification ?? {}) },
  });
  initStore(root);
  return root;
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function portsFor(root: string, baseline = 'demo-baseline'): Ports {
  return demoPorts(root, baseline, fixedClock());
}

/** An activation target whose write() silently does nothing. The common real failure. */
export function noopActivationTarget(reports: ModelId) {
  return { name: 'noop-target', read: () => reports, write: () => {} };
}

export type Stage = 'REGISTERED' | 'EVALUATED' | 'ACCEPTED' | 'APPROVED' | 'ACTIVATED' | 'VERIFIED';

/** Drive the active migration up to and including the named stage. */
export async function driveTo(
  root: string,
  target: Stage,
  candidate = 'demo-candidate',
  portsOverride?: Ports,
): Promise<{ config: ModelshiftConfig; ports: Ports; clock: () => string }> {
  const config = loadConfig(root);
  const ports = portsOverride ?? portsFor(root);
  const clock = fixedClock();

  register(root, candidate, config, clock);
  if (target === 'REGISTERED') return { config, ports, clock };

  await evaluate(root, DEMO_CASES, config, ports);
  if (target === 'EVALUATED') return { config, ports, clock };

  decide(root, config, clock);
  if (target === 'ACCEPTED') return { config, ports, clock };

  approve(root, 'tester', config, clock);
  if (target === 'APPROVED') return { config, ports, clock };

  await activate(root, 'tester', ports);
  if (target === 'ACTIVATED') return { config, ports, clock };

  const { DEMO_VERIFICATION_INPUTS } = await import('../src/adapters/local/fixtures.ts');
  await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
  return { config, ports, clock };
}

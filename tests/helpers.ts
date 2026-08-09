// Shared test scaffolding.
//
// Every test gets its own temporary root and removes it in afterEach. A single after()
// hook would only ever see the LAST root and leak every earlier one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, writeConfig, type ModelshiftConfig } from '../src/config.ts';
import { initLedger } from '../src/store/ledger.ts';
import { demoPorts } from '../src/adapters/local/demoPorts.ts';
import type { Ports } from '../src/ports/index.ts';

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
  initLedger(root);
  return root;
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function portsFor(root: string, baseline = 'demo-baseline'): Ports {
  return demoPorts(root, baseline, fixedClock());
}

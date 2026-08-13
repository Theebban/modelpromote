// Shared test scaffolding.
//
// Every test gets its own temporary root and removes it in afterEach. A single after()
// hook would only ever see the LAST root and leak every earlier one.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, writeConfig, loadConfig, type ModelPromoteConfig } from '../src/config.ts';
import { initStore } from '../src/store/ledger.ts';
import { demoPorts } from '../src/adapters/local/demoPorts.ts';
import { DEMO_CASES } from '../src/adapters/local/fixtures.ts';
import { activate, approve, decide, evaluate, register, verify } from '../src/engine.ts';
import type { Ports } from '../src/ports/index.ts';
import type { ModelId } from '../src/domain/types.ts';

export const TMP_PREFIX = 'modelpromote-test-';

/** A fixed clock, so audit output is byte-deterministic in tests. */
export function fixedClock(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  };
}

export function makeRoot(config: Partial<ModelPromoteConfig> = {}): string {
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

/**
 * A working in-memory activation target.
 *
 * Used where a test needs to observe activation without the demo's file target. It genuinely
 * changes what `read()` reports, which activation now depends on twice: the pre-flight
 * baseline check reads it BEFORE the write, and the confirmation reads it after.
 */
export function statefulActivationTarget(initial: ModelId, name = 'stateful-target', onWrite: (m: ModelId) => void = () => {}) {
  let serving = initial;
  return {
    name,
    read: (): ModelId => serving,
    write: (model: ModelId): void => {
      onWrite(model);
      serving = model;
    },
  };
}

/**
 * Rewrite matching records of a ledger in place, preserving everything else byte for byte.
 *
 * The point of every tampering test is that only ONE field changes. Anything that also
 * disturbs the sequence or the chain would be caught by an older layer, and would prove
 * nothing about the layer under test.
 */
export function editLedger(
  path: string,
  match: (e: Record<string, unknown>) => boolean,
  mutate: (e: Record<string, unknown>) => Record<string, unknown>,
): number {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  let edited = 0;
  const rewritten = lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>;
    if (!match(e)) return l;
    edited += 1;
    return JSON.stringify(mutate(e));
  });
  writeFileSync(path, `${rewritten.join('\n')}\n`, 'utf8');
  return edited;
}

/** Edit one detail field of the first matching record. Returns how many records changed. */
export function editDetail(path: string, action: string, key: string, value: unknown): number {
  return editLedger(
    path,
    (e) => e['action'] === action,
    (e) => ({ ...e, detail: { ...(e['detail'] as Record<string, unknown>), [key]: value } }),
  );
}

export type Stage = 'REGISTERED' | 'EVALUATED' | 'ACCEPTED' | 'APPROVED' | 'ACTIVATED' | 'VERIFIED';

/** Drive the active migration up to and including the named stage. */
export async function driveTo(
  root: string,
  target: Stage,
  candidate = 'demo-candidate',
  portsOverride?: Ports,
): Promise<{ config: ModelPromoteConfig; ports: Ports; clock: () => string }> {
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

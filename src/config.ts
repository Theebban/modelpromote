// The configuration contract.
//
// Deliberately small. Every field either names something the framework must know about
// your system, or declares a rule the framework will enforce against you later. There are
// no tuning knobs, no plugin registry and no provider settings: those belong to adapters.
//
// JSON rather than YAML, so the core keeps zero runtime dependencies and the file a
// reviewer reads is parsed by the same code that runs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './domain/errors.ts';
import type { ModelId } from './domain/types.ts';
import { createHash } from 'node:crypto';

export const CONFIG_FILE = 'modelshift.config.json';

export interface AcceptancePolicy {
  /** Candidate score must be at least this. Range 0 to 1. */
  readonly minScore: number;
  /** Candidate may not fall more than this far below the baseline. Range 0 to 1. */
  readonly maxRegression: number;
  /** Case ids that must pass. A failure in any of these rejects regardless of score. */
  readonly requiredCases: readonly string[];
  /** If true, any critical failure rejects regardless of score. */
  readonly allowCriticalFailures: boolean;
}

export interface VerificationBounds {
  /** Hard ceiling on requests issued during post-activation verification. */
  readonly maxRequests: number;
  /** Minimum observations required before verification may confirm. Must be >= 1. */
  readonly minObservations: number;
}

export interface ModelshiftConfig {
  /**
   * The model production is serving today.
   *
   * Locked into each migration at `register`, and ENFORCED at activation: if the activation
   * target reports something else when it is time to activate, the migration fails closed
   * rather than promoting a candidate whose evidence describes a different starting point.
   */
  readonly baselineModel: ModelId;
  /**
   * The model to revert to.
   *
   * Read at `register` and LOCKED into the migration. A normal rollback uses that lock, so
   * editing this field mid-migration cannot redirect a rollback; the drift is reported
   * instead. It remains the live authority for EMERGENCY rollback only, which runs when the
   * ledger is unreadable and therefore cannot consult the lock.
   */
  readonly rollbackModel: ModelId;
  readonly acceptance: AcceptancePolicy;
  readonly verification: VerificationBounds;
  /**
   * Traffic to issue during post-activation verification.
   *
   * Optional here, but SOMETHING must supply it for a custom integration: either this, or a
   * `verificationPlan()` export from `modelshift.ports.ts`. modelshift never falls back to
   * its own demo fixtures for adapters it did not write.
   */
  readonly verificationInputs?: readonly string[];
}

export const DEFAULT_CONFIG: ModelshiftConfig = Object.freeze({
  baselineModel: 'demo-baseline',
  rollbackModel: 'demo-baseline',
  acceptance: Object.freeze({
    minScore: 0.8,
    maxRegression: 0.05,
    requiredCases: Object.freeze(['case-critical-negation']),
    allowCriticalFailures: false,
  }),
  verification: Object.freeze({ maxRequests: 5, minObservations: 3 }),
});

function req(o: Record<string, unknown>, key: string): unknown {
  if (!(key in o)) throw new ConfigError(`missing required field "${key}"`);
  return o[key];
}

function asRatio(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new ConfigError(`"${field}" must be a number between 0 and 1, received ${JSON.stringify(v)}`);
  }
  return v;
}

function asPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ConfigError(`"${field}" must be a positive integer, received ${JSON.stringify(v)}`);
  }
  return v;
}

function asModelId(v: unknown, field: string): ModelId {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ConfigError(`"${field}" must be a non-empty string`);
  }
  return v;
}

export function parseConfig(raw: unknown): ModelshiftConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('the configuration root must be an object');
  }
  const o = raw as Record<string, unknown>;

  const acceptanceRaw = req(o, 'acceptance');
  if (typeof acceptanceRaw !== 'object' || acceptanceRaw === null) {
    throw new ConfigError('"acceptance" must be an object. A migration with no declared policy cannot be accepted');
  }
  const a = acceptanceRaw as Record<string, unknown>;

  const verificationRaw = req(o, 'verification');
  if (typeof verificationRaw !== 'object' || verificationRaw === null) {
    throw new ConfigError('"verification" must be an object');
  }
  const v = verificationRaw as Record<string, unknown>;

  const requiredCasesRaw = a['requiredCases'] ?? [];
  if (!Array.isArray(requiredCasesRaw) || requiredCasesRaw.some((c) => typeof c !== 'string')) {
    throw new ConfigError('"acceptance.requiredCases" must be an array of strings');
  }

  const inputsRaw = o['verificationInputs'];
  if (inputsRaw !== undefined) {
    if (!Array.isArray(inputsRaw) || inputsRaw.some((i) => typeof i !== 'string')) {
      throw new ConfigError('"verificationInputs" must be an array of strings');
    }
    if (inputsRaw.length === 0) {
      throw new ConfigError('"verificationInputs" is present but empty. Remove it, or supply real traffic');
    }
  }

  return {
    baselineModel: asModelId(req(o, 'baselineModel'), 'baselineModel'),
    rollbackModel: asModelId(req(o, 'rollbackModel'), 'rollbackModel'),
    acceptance: {
      minScore: asRatio(req(a, 'minScore'), 'acceptance.minScore'),
      maxRegression: asRatio(req(a, 'maxRegression'), 'acceptance.maxRegression'),
      requiredCases: requiredCasesRaw as readonly string[],
      allowCriticalFailures: a['allowCriticalFailures'] === true,
    },
    verification: {
      maxRequests: asPositiveInt(req(v, 'maxRequests'), 'verification.maxRequests'),
      minObservations: asPositiveInt(req(v, 'minObservations'), 'verification.minObservations'),
    },
    ...(inputsRaw === undefined ? {} : { verificationInputs: inputsRaw as readonly string[] }),
  };
}

export function configPath(root: string): string {
  return join(root, CONFIG_FILE);
}

export function loadConfig(root: string): ModelshiftConfig {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new ConfigError(`no ${CONFIG_FILE} found at ${path}. Run "modelshift init" first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON (${(e as Error).message})`);
  }
  return parseConfig(parsed);
}

export function writeConfig(root: string, config: ModelshiftConfig): void {
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * A stable fingerprint of the acceptance policy.
 *
 * POLICY LOCKING. The governing hash is captured at `register`, and re-captured at each
 * `evaluate`, which is the moment the evidence is produced. Both `decide` and `approve`
 * then REFUSE if the current policy no longer matches the one the evidence was produced
 * under.
 *
 * Warning and continuing was the original behaviour and it was wrong: it let an operator
 * see a score, relax the rule that the score failed, and proceed on evidence earned under
 * rules that no longer exist. A change-control tool that reports the violation but permits
 * it is not change control. Changing the policy now invalidates the evidence and requires
 * a fresh evaluation.
 */
export function policyHash(policy: AcceptancePolicy): string {
  const canonical = JSON.stringify({
    minScore: policy.minScore,
    maxRegression: policy.maxRegression,
    requiredCases: [...policy.requiredCases].sort(),
    allowCriticalFailures: policy.allowCriticalFailures,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

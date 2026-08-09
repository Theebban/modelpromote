// REFERENCE ADAPTERS.
//
// Deterministic, offline, credential-free. They exist so the whole lifecycle can be run,
// tested and demonstrated with no account, no key and no network, and so the core has a
// worked example of each port. They are NOT the product: the product is the lifecycle that
// governs whatever you put behind these interfaces.
//
// The two demo models are deliberately fictional and differ in a way the evaluator can
// actually separate, so the acceptance policy has real work to do.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActivationTarget,
  Evaluator,
  ModelAdapter,
  ServingObservation,
  TelemetrySource,
} from '../../ports/index.ts';
import type { CaseResult, EvaluationCase, EvaluationResult, ModelId } from '../../domain/types.ts';

/** Cases whose id starts with this are treated as critical by the reference evaluator. */
const CRITICAL_PREFIX = 'case-critical';

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Baseline: handles the ordinary phrasing, misses the negation case. */
export const demoBaseline: ModelAdapter = {
  id: 'demo-baseline',
  complete(input: string): string {
    const t = normalise(input);
    if (t.includes('not urgent') || t.includes('no action')) return 'escalate';
    if (t.includes('urgent') || t.includes('immediately')) return 'escalate';
    if (t.includes('question') || t.includes('how do i')) return 'answer';
    return 'acknowledge';
  },
};

/** Candidate: same behaviour plus correct handling of negation. */
export const demoCandidate: ModelAdapter = {
  id: 'demo-candidate',
  complete(input: string): string {
    const t = normalise(input);
    if (t.includes('not urgent') || t.includes('no action')) return 'acknowledge';
    if (t.includes('urgent') || t.includes('immediately')) return 'escalate';
    if (t.includes('question') || t.includes('how do i')) return 'answer';
    return 'acknowledge';
  },
};

/** Candidate that regresses, used to demonstrate a rejection. */
export const demoRegression: ModelAdapter = {
  id: 'demo-regression',
  complete(): string {
    return 'escalate';
  },
};

/**
 * Reference evaluator: exact match after normalisation.
 *
 * Deliberately the weakest useful metric. Evaluation quality is a competitive, well-served
 * space and modelshift is not competing in it. Swap this port for Promptfoo, DeepEval or
 * your own judge and nothing else in the lifecycle changes.
 */
export const exactMatchEvaluator: Evaluator = {
  name: 'exact-match',
  async evaluate(adapter: ModelAdapter, cases: readonly EvaluationCase[]): Promise<EvaluationResult> {
    const results: CaseResult[] = [];
    const criticalFailures: string[] = [];

    for (const c of cases) {
      const output = await adapter.complete(c.input);
      const passed = normalise(output) === normalise(c.expected);
      results.push({ caseId: c.id, output, passed, score: passed ? 1 : 0 });
      if (!passed && c.id.startsWith(CRITICAL_PREFIX)) criticalFailures.push(c.id);
    }

    const passedCount = results.filter((r) => r.passed).length;
    return {
      modelId: adapter.id,
      casesRun: results.length,
      passed: passedCount,
      // An empty case set scores 0, never 1. "Nothing measured" must not read as "perfect".
      score: results.length === 0 ? 0 : passedCount / results.length,
      criticalFailures,
      results,
    };
  },
};

/** Stable fingerprint of a case set, so a report can prove which cases produced a verdict. */
export function hashCases(cases: readonly EvaluationCase[]): string {
  const canonical = JSON.stringify([...cases].sort((a, b) => a.id.localeCompare(b.id)));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Activation target backed by a JSON file.
 *
 * Stands in for whatever actually decides your serving model: an env var, a config service,
 * a feature flag, a database row. `read()` genuinely re-reads, so a write that did not take
 * effect is caught rather than assumed.
 */
export function fileActivationTarget(path: string, initial: ModelId, displayName?: string): ActivationTarget {
  return {
    // The NAME is recorded in the audit ledger, so it must not carry an absolute local
    // path: reports get pasted into issues and review threads. Callers pass a stable label.
    name: displayName ?? 'file-activation-target',
    read(): ModelId {
      if (!existsSync(path)) return initial;
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return initial;
      const v = (parsed as Record<string, unknown>)['servingModel'];
      return typeof v === 'string' ? v : initial;
    },
    write(model: ModelId): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ servingModel: model }, null, 2)}\n`, 'utf8');
    },
  };
}

/** Telemetry source backed by a JSONL file that the demo application appends to. */
export function fileTelemetrySource(path: string, displayName?: string): TelemetrySource {
  return {
    name: displayName ?? 'file-telemetry-source',
    observations(sinceRequestId: string | null): readonly ServingObservation[] {
      if (!existsSync(path)) return [];
      const rows = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ServingObservation);
      if (sinceRequestId === null) return rows;
      const idx = rows.findIndex((r) => r.requestId === sinceRequestId);
      return idx === -1 ? rows : rows.slice(idx + 1);
    },
  };
}

/** Append one observation. Represents your application recording what actually served. */
export function recordObservation(path: string, obs: ServingObservation): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(obs)}\n`, 'utf8');
}

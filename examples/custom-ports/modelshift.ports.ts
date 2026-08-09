// INTEGRATION EXAMPLE.
//
// Copy this to your project root as `modelshift.ports.ts` and the CLI will pick it up
// automatically instead of the built-in demo wiring. This file is the entire integration
// surface: the lifecycle, the policy and the audit record do not change.
//
// Nothing below makes a real network call, so the example stays runnable. The comments mark
// exactly where your real code goes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ModelAdapter, Ports, ServingObservation } from '../../src/ports/index.ts';
import type { EvaluationCase, EvaluationResult, ModelId } from '../../src/domain/types.ts';

// ---------------------------------------------------------------------------
// 1. MODEL ADAPTERS. Wrap whatever you already call.
// ---------------------------------------------------------------------------
function providerAdapter(id: ModelId): ModelAdapter {
  return {
    id,
    async complete(input: string): Promise<string> {
      // REAL CODE GOES HERE, for example:
      //   const res = await openai.chat.completions.create({ model: id, messages: [...] });
      //   return res.choices[0].message.content ?? '';
      // Also record the serving identity here, or read it back from telemetry below.
      return `[${id}] ${input.slice(0, 40)}`;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. EVALUATOR. Point this at your real evaluation.
// ---------------------------------------------------------------------------
// modelshift does not care how the score is produced, only that it is comparable across
// the baseline and the candidate. Shell out to Promptfoo, call DeepEval, read a CI
// artifact, or use an LLM judge. Return the same shape.
const externalEvaluator = {
  name: 'external-eval',
  async evaluate(adapter: ModelAdapter, cases: readonly EvaluationCase[]): Promise<EvaluationResult> {
    // REAL CODE: run your suite for `adapter.id` and map the output into EvaluationResult.
    const results = await Promise.all(
      cases.map(async (c) => {
        const output = await adapter.complete(c.input);
        const passed = output.includes(c.expected);
        return { caseId: c.id, output, passed, score: passed ? 1 : 0 };
      }),
    );
    const passed = results.filter((r) => r.passed).length;
    return {
      modelId: adapter.id,
      casesRun: results.length,
      passed,
      // Never let an empty case set score 1. "Nothing measured" is not "perfect".
      score: results.length === 0 ? 0 : passed / results.length,
      criticalFailures: results.filter((r) => !r.passed && r.caseId.startsWith('case-critical')).map((r) => r.caseId),
      results,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. ACTIVATION TARGET. Whatever actually decides your serving model.
// ---------------------------------------------------------------------------
// An env var, a config service, a feature flag, a database row. `read()` must genuinely
// re-read, so that a write which silently did nothing is caught rather than assumed.
function activationTarget(statePath: string): Ports['activation'] {
  return {
    name: 'config-service',
    read(): ModelId {
      // REAL CODE: read the live value, for example from your flag SDK.
      if (!existsSync(statePath)) return 'baseline-model';
      return (JSON.parse(readFileSync(statePath, 'utf8')) as { servingModel: string }).servingModel;
    },
    write(model: ModelId): void {
      // REAL CODE: set the live value.
      writeFileSync(statePath, JSON.stringify({ servingModel: model }), 'utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// 4. TELEMETRY SOURCE. What actually served.
// ---------------------------------------------------------------------------
// Query your logs, OpenTelemetry, Langfuse, or provider response metadata. This must report
// what ANSWERED, not what you configured: the whole point is that the two can differ.
function telemetrySource(logPath: string): Ports['telemetry'] {
  return {
    name: 'otel-query',
    observations(sinceRequestId: string | null): readonly ServingObservation[] {
      // REAL CODE: query your trace store for spans after `sinceRequestId`.
      if (!existsSync(logPath)) return [];
      const rows = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ServingObservation);
      if (sinceRequestId === null) return rows;
      const i = rows.findIndex((r) => r.requestId === sinceRequestId);
      return i === -1 ? rows : rows.slice(i + 1);
    },
  };
}

/** The CLI calls this. It is the only export that matters. */
export function createPorts(root: string): Ports {
  const models = new Map<ModelId, ModelAdapter>();
  for (const id of ['baseline-model', 'candidate-model']) models.set(id, providerAdapter(id));

  return {
    models,
    evaluator: externalEvaluator,
    activation: activationTarget(`${root}/.modelshift/serving.json`),
    telemetry: telemetrySource(`${root}/.modelshift/telemetry.jsonl`),
    now: () => new Date().toISOString(),
  };
}

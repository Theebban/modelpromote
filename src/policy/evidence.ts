// VALIDATION OF EVIDENCE CROSSING THE EVALUATOR BOUNDARY.
//
// modelshift's whole value is governance over evidence it did not produce. The Evaluator is
// a port: the implementation belongs to the user, or to a third-party integration, and it
// can be wrong without being malicious. A wrapper around an external eval runner that
// mis-parses one field can return score 1.0 for a model that answered nothing.
//
// An acceptance is only as good as the measurement behind it, so the measurement is checked
// before it is allowed to produce a verdict. This is NOT an evaluation framework: it makes
// no judgement about whether the score is GOOD, only about whether it is COHERENT.

import { InvalidEvidenceError } from '../domain/errors.ts';
import type { EvaluationCase, EvaluationResult, ModelId } from '../domain/types.ts';

export function assertValidEvidence(
  result: EvaluationResult,
  expectedModelId: ModelId,
  cases: readonly EvaluationCase[],
): EvaluationResult {
  const problems: string[] = [];

  if (typeof result !== 'object' || result === null) {
    throw new InvalidEvidenceError(expectedModelId, ['the evaluator did not return an object']);
  }

  // The result must describe the adapter that was actually evaluated. Otherwise a cached or
  // misrouted result silently becomes evidence about a model it never ran against.
  if (result.modelId !== expectedModelId) {
    problems.push(`it reports modelId "${String(result.modelId)}" but the adapter evaluated was "${expectedModelId}"`);
  }

  if (typeof result.score !== 'number' || !Number.isFinite(result.score)) {
    problems.push(`score is not a finite number (received ${JSON.stringify(result.score)})`);
  } else if (result.score < 0 || result.score > 1) {
    problems.push(`score ${result.score} is outside the supported range 0 to 1`);
  }

  if (!Array.isArray(result.results)) {
    problems.push('results is not an array');
  }

  if (!Number.isInteger(result.casesRun) || result.casesRun < 0) {
    problems.push(`casesRun is not a non-negative integer (received ${JSON.stringify(result.casesRun)})`);
  }

  if (!Number.isInteger(result.passed) || result.passed < 0) {
    problems.push(`passed is not a non-negative integer (received ${JSON.stringify(result.passed)})`);
  }

  if (Array.isArray(result.results) && Number.isInteger(result.casesRun) && result.casesRun !== result.results.length) {
    problems.push(`casesRun is ${result.casesRun} but ${result.results.length} result(s) were returned`);
  }

  if (Array.isArray(result.results) && Number.isInteger(result.passed)) {
    const actuallyPassed = result.results.filter((r) => r?.passed === true).length;
    if (result.passed !== actuallyPassed) {
      problems.push(`passed is ${result.passed} but ${actuallyPassed} result(s) are marked passed`);
    }
    if (result.passed > result.results.length) {
      problems.push(`passed (${result.passed}) exceeds the number of results (${result.results.length})`);
    }
  }

  if (Array.isArray(result.results)) {
    // Duplicate case ids make required-case semantics ambiguous: "did case X pass" stops
    // having one answer, and the acceptance policy is built on exactly that question.
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const r of result.results) {
      if (typeof r?.caseId !== 'string') {
        problems.push('a result has a non-string caseId');
        continue;
      }
      if (seen.has(r.caseId)) duplicates.add(r.caseId);
      seen.add(r.caseId);
    }
    if (duplicates.size > 0) {
      problems.push(`duplicate case id(s) make required-case checks ambiguous: ${[...duplicates].sort().join(', ')}`);
    }

    // Results for cases that were never submitted mean the evaluator scored something else.
    const submitted = new Set(cases.map((c) => c.id));
    const unknown = [...seen].filter((id) => !submitted.has(id));
    if (unknown.length > 0) {
      problems.push(`result(s) for case id(s) that were not submitted: ${unknown.sort().slice(0, 5).join(', ')}`);
    }
  }

  if (!Array.isArray(result.criticalFailures)) {
    problems.push('criticalFailures is not an array');
  } else if (result.criticalFailures.some((c) => typeof c !== 'string')) {
    problems.push('criticalFailures contains a non-string entry');
  }

  if (problems.length > 0) throw new InvalidEvidenceError(expectedModelId, problems);
  return result;
}

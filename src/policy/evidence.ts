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
//
// COVERAGE IS PART OF COHERENCE. An evaluator must return exactly one result for every case
// it was given: no missing case, no extra case, no duplicate. A second independent review
// submitted five cases to a custom evaluator that returned one coherent result for one of
// them, and the candidate was accepted on a record whose `caseSetHash` represented all five.
// Partial coverage that presents itself as full coverage is the most dangerous shape
// evidence can take, because every downstream reader sees a complete measurement.
//
// V0 has no sampling mode. If a future evaluator needs to measure a subset, that must be an
// explicit contract in which the measured subset is what the record represents.

import { InvalidEvidenceError } from '../domain/errors.ts';
import type { EvaluationCase, EvaluationResult, ModelId } from '../domain/types.ts';

/** Longest list of ids to name in a problem message before it stops being readable. */
const MAX_IDS_LISTED = 5;

function listIds(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const shown = sorted.slice(0, MAX_IDS_LISTED).join(', ');
  return sorted.length > MAX_IDS_LISTED ? `${shown} (and ${sorted.length - MAX_IDS_LISTED} more)` : shown;
}

/**
 * Problems with the SUBMITTED case set, independent of any evaluator.
 *
 * Checked before the evaluator runs. A case set with duplicate or empty ids cannot support
 * the exact-coverage rule below, and `requiredCases` in the acceptance policy is built
 * entirely on "did case X pass", which stops having one answer.
 */
export function caseSetProblems(cases: readonly EvaluationCase[]): string[] {
  const problems: string[] = [];

  if (!Array.isArray(cases)) return ['the case set is not an array'];
  if (cases.length === 0) {
    return ['the case set is empty, and a measurement over no cases cannot govern a verdict'];
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    if (typeof c !== 'object' || c === null) {
      problems.push(`case at position ${i} is not an object`);
      continue;
    }
    if (typeof c.id !== 'string' || c.id.trim().length === 0) {
      problems.push(`case at position ${i} has a missing or empty id`);
      continue;
    }
    if (typeof c.input !== 'string') problems.push(`case "${c.id}" has a non-string input`);
    if (typeof c.expected !== 'string') problems.push(`case "${c.id}" has a non-string expected value`);
    if (seen.has(c.id)) duplicates.add(c.id);
    seen.add(c.id);
  }

  if (duplicates.size > 0) {
    problems.push(`duplicate submitted case id(s) make required-case checks ambiguous: ${listIds([...duplicates])}`);
  }

  return problems;
}

/** Validate the case set before anything is measured against it. */
export function assertValidCaseSet(cases: readonly EvaluationCase[]): readonly EvaluationCase[] {
  const problems = caseSetProblems(cases);
  if (problems.length > 0) throw new InvalidEvidenceError('(the submitted case set)', problems);
  return cases;
}

/**
 * Problems INTERNAL to one evaluation result, needing no knowledge of the case set.
 *
 * Split out because the ledger reader re-checks recorded evaluations on every read and does
 * not have the original cases: only the case-set hash is retained. Anything provable from
 * the result alone is provable there too.
 */
export function evaluationResultProblems(result: EvaluationResult, expectedModelId: ModelId): string[] {
  const problems: string[] = [];

  if (typeof result !== 'object' || result === null) {
    return ['the evaluator did not return an object'];
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
      problems.push(`duplicate case id(s) make required-case checks ambiguous: ${listIds([...duplicates])}`);
    }
  }

  if (!Array.isArray(result.criticalFailures)) {
    problems.push('criticalFailures is not an array');
  } else if (result.criticalFailures.some((c) => typeof c !== 'string')) {
    problems.push('criticalFailures contains a non-string entry');
  }

  return problems;
}

/**
 * Full validation of one evaluator result against the cases it was given.
 *
 * EXACT COVERAGE. The set of case ids in `results` must equal the set of submitted case ids.
 * A missing result is not "a case that did not run": the record it produces claims a case
 * set that was never fully measured, and no later reader can tell the difference.
 */
export function assertValidEvidence(
  result: EvaluationResult,
  expectedModelId: ModelId,
  cases: readonly EvaluationCase[],
): EvaluationResult {
  const problems = evaluationResultProblems(result, expectedModelId);

  if (Array.isArray(result?.results)) {
    const returned = new Set(result.results.filter((r) => typeof r?.caseId === 'string').map((r) => r.caseId));
    const submitted = new Set(cases.map((c) => c.id));

    const missing = [...submitted].filter((id) => !returned.has(id));
    if (missing.length > 0) {
      problems.push(
        `no result for ${missing.length} of ${submitted.size} submitted case(s): ${listIds(missing)}. ` +
          'An evaluator must return exactly one result per submitted case; partial coverage cannot be ' +
          'recorded as if the whole case set had been measured',
      );
    }

    // Results for cases that were never submitted mean the evaluator scored something else.
    const unknown = [...returned].filter((id) => !submitted.has(id));
    if (unknown.length > 0) {
      problems.push(`result(s) for case id(s) that were not submitted: ${listIds(unknown)}`);
    }
  }

  if (problems.length > 0) throw new InvalidEvidenceError(expectedModelId, problems);
  return result;
}

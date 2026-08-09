// The acceptance decision.
//
// Pure: it takes a measurement and a declared policy and returns a verdict with reasons.
// It reads no files, calls no models and cannot be influenced by who is asking.
//
// The verdict is a MACHINE statement ("the evidence satisfies the declared rules"). It is
// not permission to change production. That is a separate, human act, and keeping the two
// apart is the point of the whole framework.

import type { AcceptancePolicy } from '../config.ts';
import type { ComparativeEvaluation } from '../domain/types.ts';

export interface AcceptanceVerdict {
  readonly accepted: boolean;
  /** Why it failed. Empty when accepted. Every failing rule is listed, not just the first. */
  readonly reasons: readonly string[];
  /** Every rule that was applied, passing or failing, so the record shows what was checked. */
  readonly checks: readonly { readonly rule: string; readonly passed: boolean; readonly detail: string }[];
}

export function evaluateAcceptance(
  evaluation: ComparativeEvaluation,
  policy: AcceptancePolicy,
): AcceptanceVerdict {
  const checks: { rule: string; passed: boolean; detail: string }[] = [];
  const { candidate, delta } = evaluation;

  const scoreOk = candidate.score >= policy.minScore;
  checks.push({
    rule: 'minScore',
    passed: scoreOk,
    detail: `candidate score ${candidate.score.toFixed(3)} vs minimum ${policy.minScore}`,
  });

  // A negative delta is a regression; its magnitude is what the policy bounds.
  const regression = delta < 0 ? -delta : 0;
  const regressionOk = regression <= policy.maxRegression;
  checks.push({
    rule: 'maxRegression',
    passed: regressionOk,
    detail: `regression ${regression.toFixed(3)} vs allowed ${policy.maxRegression}`,
  });

  const failedRequired = policy.requiredCases.filter((id) => {
    const r = candidate.results.find((x) => x.caseId === id);
    // A required case that is absent from the case set counts as a failure. Silently
    // treating "not measured" as "passed" is how a required check disappears.
    return r === undefined || !r.passed;
  });
  const requiredOk = failedRequired.length === 0;
  checks.push({
    rule: 'requiredCases',
    passed: requiredOk,
    detail:
      policy.requiredCases.length === 0
        ? 'no required cases declared'
        : `${policy.requiredCases.length - failedRequired.length}/${policy.requiredCases.length} required cases passed`,
  });

  const criticalOk = policy.allowCriticalFailures || candidate.criticalFailures.length === 0;
  checks.push({
    rule: 'criticalFailures',
    passed: criticalOk,
    detail: `${candidate.criticalFailures.length} critical failure(s), allowed: ${policy.allowCriticalFailures}`,
  });

  const reasons: string[] = [];
  if (!scoreOk) reasons.push(`score ${candidate.score.toFixed(3)} is below the declared minimum ${policy.minScore}`);
  if (!regressionOk) {
    reasons.push(`regression ${regression.toFixed(3)} exceeds the declared maximum ${policy.maxRegression}`);
  }
  if (!requiredOk) reasons.push(`required case(s) did not pass: ${failedRequired.join(', ')}`);
  if (!criticalOk) reasons.push(`${candidate.criticalFailures.length} critical failure(s): ${candidate.criticalFailures.join(', ')}`);

  return { accepted: reasons.length === 0, reasons, checks };
}

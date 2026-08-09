// THE MIGRATION REPORT.
//
// Rendered ENTIRELY from the ledger. It has no other input, so it cannot describe a
// transition that was not recorded, and it cannot omit one that was. If a step is missing
// from the report it is missing from the record, which is itself the finding.
//
// Written for three readers who will not have this context: a code reviewer, someone in an
// incident an hour after it started, and an auditor asking who authorised a change.

import type { ComparativeEvaluation, MigrationEvent, MigrationState } from '../domain/types.ts';
import type { AcceptanceVerdict } from '../policy/acceptance.ts';
import { TERMINAL_STATES } from '../domain/types.ts';

function line(label: string, value: string): string {
  return `${label.padEnd(22)}${value}`;
}

function renderEvaluation(e: ComparativeEvaluation): string[] {
  const out = [
    line('  baseline', `${e.baseline.modelId}  score ${e.baseline.score.toFixed(3)} (${e.baseline.passed}/${e.baseline.casesRun})`),
    line('  candidate', `${e.candidate.modelId}  score ${e.candidate.score.toFixed(3)} (${e.candidate.passed}/${e.candidate.casesRun})`),
    line('  delta', `${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(3)}`),
    line('  case set hash', e.caseSetHash),
  ];
  if (e.candidate.criticalFailures.length > 0) {
    out.push(line('  critical failures', e.candidate.criticalFailures.join(', ')));
  }
  return out;
}

function renderVerdict(v: AcceptanceVerdict): string[] {
  const out = [line('  verdict', v.accepted ? 'ACCEPTED by policy' : 'REJECTED by policy')];
  for (const c of v.checks) out.push(line(`    ${c.passed ? 'pass' : 'FAIL'} ${c.rule}`, c.detail));
  for (const r of v.reasons) out.push(line('    reason', r));
  return out;
}

export function renderReport(events: readonly MigrationEvent[], state: MigrationState | null): string {
  const out: string[] = [];
  out.push('MIGRATION REPORT');
  out.push('='.repeat(72));

  if (events.length === 0 || state === null) {
    out.push('No migration recorded.');
    return out.join('\n');
  }

  const first = events[0];
  const candidate = first?.detail['candidate'];
  const baseline = first?.detail['baseline'];

  out.push(line('candidate', String(candidate ?? 'unknown')));
  out.push(line('previous model', String(baseline ?? 'unknown')));
  out.push(line('terminal state', `${state}${TERMINAL_STATES.includes(state) ? '' : '  (migration still open)'}`));
  out.push(line('recorded events', String(events.length)));
  out.push('');
  out.push('TIMELINE');
  out.push('-'.repeat(72));

  for (const e of events) {
    out.push(`${String(e.seq).padStart(3, '0')}  ${e.at}  ${e.action}`);
    out.push(line('     transition', `${e.from ?? '(none)'} -> ${e.to}`));
    out.push(line('     actor', e.actor));

    if (e.action === 'evaluate' && e.detail['evaluation']) {
      out.push(...renderEvaluation(e.detail['evaluation'] as ComparativeEvaluation));
      out.push(line('  evaluator', String(e.detail['evaluator'] ?? 'unknown')));
    }
    if ((e.action === 'accept' || e.action === 'reject') && e.detail['verdict']) {
      out.push(...renderVerdict(e.detail['verdict'] as AcceptanceVerdict));
      out.push(line('  policy hash', String(e.detail['policyHash'] ?? 'unknown')));
    }
    if (e.action === 'approve') {
      out.push(line('  approved by', String(e.detail['approvedBy'] ?? 'unknown')));
      out.push(line('  policy at accept', String(e.detail['policyHashAtAccept'] ?? 'none')));
      out.push(line('  policy at approval', String(e.detail['policyHashAtApproval'] ?? 'none')));
      if (e.detail['policyChanged'] === true) {
        out.push('  *** WARNING: the acceptance policy was edited between the verdict and this approval.');
        out.push('      The verdict above was earned under different rules than the ones now declared.');
      }
    }
    if (e.action === 'activate') {
      out.push(line('  previous model', String(e.detail['previousModel'] ?? 'unknown')));
      out.push(line('  target reports', String(e.detail['targetReports'] ?? 'unknown')));
      out.push(line('  activation target', String(e.detail['target'] ?? 'unknown')));
    }
    if (e.action === 'verify' || e.action === 'failVerification') {
      const run = e.detail['run'] as { requestsMade?: number; requestsAvailable?: number; stoppedBy?: string; truncated?: boolean } | undefined;
      const a = e.detail['assertion'] as { observed?: string[]; observationCount?: number; reason?: string; confirmed?: boolean } | undefined;
      if (run) {
        out.push(line('  requests made', `${run.requestsMade} of ${run.requestsAvailable} available, stopped by ${run.stoppedBy}`));
        if (run.truncated === true) out.push(line('  truncated', 'YES, the declared ceiling was reached'));
      }
      if (a) {
        out.push(line('  telemetry observed', (a.observed ?? []).join(', ') || '(none)'));
        out.push(line('  observations', String(a.observationCount ?? 0)));
        out.push(line('  confirmed', a.confirmed === true ? 'YES' : 'NO'));
        out.push(line('  reason', String(a.reason ?? '')));
      }
    }
    if (e.action === 'completeRollback') {
      out.push(line('  reverted from', String(e.detail['revertedFrom'] ?? 'unknown')));
      out.push(line('  reverted to', String(e.detail['revertedTo'] ?? 'unknown')));
      out.push(line('  via code release', String(e.detail['viaCodeRelease'] ?? 'unknown')));
    }
    out.push('');
  }

  out.push('ATTESTATION');
  out.push('-'.repeat(72));
  out.push('Every line above is derived from the append-only ledger. The report has no other');
  out.push('source, so it cannot assert a transition that was not recorded. Sequence numbers');
  out.push('and from/to states are chain-checked on read; a spliced or edited ledger fails to');
  out.push('load rather than rendering a plausible history.');

  return out.join('\n');
}

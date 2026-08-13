// THE MIGRATION REPORT.
//
// Rendered ENTIRELY from the ledger. It has no other input, so it cannot describe a
// transition that was not recorded, and it cannot omit one that was. If a step is missing
// from the report it is missing from the record, which is itself the finding.
//
// Every value that came from outside the framework is passed through `escapeForReport`
// before rendering. Identifiers are already rejected at their boundaries, but adapter
// labels and evaluator names arrive from third-party code, and a newline in any of them
// would forge a line of a document people make decisions from.
//
// Written for three readers who will not have this context: a code reviewer, someone in an
// incident an hour after it started, and an auditor asking who authorised a change.

import type { ComparativeEvaluation, MigrationEvent, MigrationState } from '../domain/types.ts';
import type { AcceptanceVerdict } from '../policy/acceptance.ts';
import { TERMINAL_STATES, LIVE_RISK_STATES } from '../domain/types.ts';
import { escapeForReport } from '../domain/sanitize.ts';

function line(label: string, value: string): string {
  return `${label.padEnd(22)}${escapeForReport(value)}`;
}

function renderEvaluation(e: ComparativeEvaluation): string[] {
  const out = [
    line('  baseline', `${e.baseline.modelId}  score ${e.baseline.score.toFixed(3)} (${e.baseline.passed}/${e.baseline.casesRun})`),
    line('  candidate', `${e.candidate.modelId}  score ${e.candidate.score.toFixed(3)} (${e.candidate.passed}/${e.candidate.casesRun})`),
    line('  delta', `${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(3)}`),
    line('  case set hash', e.caseSetHash),
    line('  governing policy', e.governingPolicyHash),
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

function s(v: unknown, fallback = 'unknown'): string {
  return v === undefined || v === null ? fallback : String(v);
}

export function renderReport(events: readonly MigrationEvent[], state: MigrationState | null, migrationId = '0001'): string {
  const out: string[] = [];
  out.push(`MIGRATION REPORT  [${escapeForReport(migrationId)}]`);
  out.push('='.repeat(72));

  if (events.length === 0 || state === null) {
    out.push('No migration recorded.');
    return out.join('\n');
  }

  const first = events[0];
  out.push(line('candidate', s(first?.detail['candidate'])));
  out.push(line('previous model', s(first?.detail['baseline'])));
  out.push(line('rollback target', `${s(first?.detail['rollbackTarget'])}  (locked at register)`));

  const closed = TERMINAL_STATES.includes(state);
  const atRisk = LIVE_RISK_STATES.includes(state) && !closed;
  out.push(line('terminal state', `${state}${closed ? '' : atRisk ? '  (OPEN, something may be serving)' : '  (migration still open)'}`));
  out.push(line('recorded events', String(events.length)));
  out.push('');
  out.push('TIMELINE');
  out.push('-'.repeat(72));

  for (const e of events) {
    out.push(`${String(e.seq).padStart(3, '0')}  ${escapeForReport(e.at)}  ${escapeForReport(e.action)}`);
    out.push(line('     transition', `${e.from ?? '(none)'} -> ${e.to}`));
    out.push(line('     actor', e.actor));

    if (e.action === 'register') {
      // Labelled as a snapshot on purpose. The hash that GOVERNS a verdict is the one taken
      // at evaluate; this one records what the policy was when the migration opened.
      out.push(line('  policy snapshot', `${s(e.detail['policyHashAtRegister'])}  (at register, not the governing lock)`));
    }
    if (e.action === 'evaluate' && e.detail['evaluation']) {
      out.push(...renderEvaluation(e.detail['evaluation'] as ComparativeEvaluation));
      out.push(line('  evaluator', s(e.detail['evaluator'])));
    }
    if ((e.action === 'accept' || e.action === 'reject') && e.detail['verdict']) {
      out.push(...renderVerdict(e.detail['verdict'] as AcceptanceVerdict));
      out.push(line('  policy hash', s(e.detail['policyHash'])));
    }
    if (e.action === 'approve') {
      out.push(line('  approved by', s(e.detail['approvedBy'])));
      out.push(line('  policy hash', s(e.detail['policyHash'])));
    }
    if (e.action === 'beginActivation') {
      out.push(line('  previous model', s(e.detail['previousModel'])));
      out.push(line('  requested model', s(e.detail['requestedModel'])));
      out.push(line('  activation target', s(e.detail['target'])));
      out.push('  (intent recorded BEFORE the external write, so an interrupted activation');
      out.push('   is visible rather than invisible)');
    }
    if (e.action === 'confirmActivation' || e.action === 'failActivation') {
      out.push(line('  requested model', s(e.detail['requestedModel'])));
      out.push(line('  target read back', s(e.detail['observedModel'])));
      out.push(line('  confirmed', e.detail['confirmed'] === true ? 'YES, by read-back' : 'NO'));
      if (e.action === 'failActivation') {
        out.push('  *** The activation target did not read back the candidate. Nothing was');
        out.push('      confirmed live. This migration never reached ACTIVATED.');
      }
    }
    if (e.action === 'verify' || e.action === 'failVerification') {
      const run = e.detail['run'] as { requestsMade?: number; requestsAvailable?: number; stoppedBy?: string; truncated?: boolean } | undefined;
      const a = e.detail['assertion'] as {
        observed?: string[];
        observationCount?: number;
        reason?: string;
        confirmed?: boolean;
        evidenceClass?: string;
        windowOpensAfter?: string | null;
      } | undefined;
      if (run) {
        out.push(line('  requests made', `${run.requestsMade} of ${run.requestsAvailable} available, stopped by ${run.stoppedBy}`));
        if (run.truncated === true) out.push(line('  truncated', 'YES, the declared ceiling was reached'));
      }
      if (a) {
        out.push(line('  telemetry observed', (a.observed ?? []).join(', ') || '(none)'));
        out.push(line('  observations', String(a.observationCount ?? 0)));
        out.push(line('  confirmed', a.confirmed === true ? 'YES' : 'NO'));
        out.push(line('  reason', s(a.reason, '')));
        // The strength of the evidence, stated with the evidence. A reader should never have
        // to infer how much a confirmation is worth.
        out.push(line('  evidence class', s(a.evidenceClass, 'unrecorded')));
        out.push(line('  window opens after', s(a.windowOpensAfter, '(the whole telemetry history)')));
        out.push('  (temporal-window: every observation recorded AFTER the mark above named the');
        out.push('   expected model. The calls this run issued are NOT correlated with individual');
        out.push('   telemetry rows, so other traffic in the same window counts toward this claim)');
      }
    }
    if (e.action === 'abandon') {
      out.push(line('  reason', s(e.detail['reason'], 'no reason given')));
      out.push('  (nothing had been activated, so nothing required reverting)');
    }
    if (e.action === 'beginRollback') {
      out.push(line('  reverting from', s(e.detail['from'])));
      out.push(line('  rollback target', `${s(e.detail['target'])}  (locked at register)`));
      if (e.detail['configDrift'] === true) {
        out.push(line('  *** config drift', `configuration now names ${s(e.detail['configuredRollbackModel'])}`));
        out.push('      The LOCKED target was used. A rollback target that a later config edit');
        out.push('      can redirect is not a safe target. Reconcile the configuration.');
      }
    }
    if (e.action === 'confirmRollback' || e.action === 'failRollback') {
      out.push(line('  rollback target', s(e.detail['rollbackTarget'])));
      out.push(line('  target read back', s(e.detail['observedModel'])));
      out.push(line('  confirmed', e.detail['confirmed'] === true ? 'YES, by read-back' : 'NO'));
      if (e.action === 'confirmRollback') out.push(line('  via code release', s(e.detail['viaCodeRelease'])));
      if (e.action === 'failRollback') {
        out.push('  *** The rollback write did not take effect. THE SYSTEM IS NOT KNOWN TO BE');
        out.push('      SAFE. Intervene directly at the activation target.');
      }
    }
    out.push('');
  }

  out.push('ATTESTATION');
  out.push('-'.repeat(72));
  out.push('Every line above is derived from the append-only ledger. The report has no other');
  out.push('source, so it cannot assert a transition that was not recorded. ACTIVATED and');
  out.push('ROLLED_BACK are recorded only after the activation target positively read back the');
  out.push('expected model.');
  out.push('');
  out.push('WHAT LOADING THIS LEDGER PROVED. Every record was checked four ways: record');
  out.push('structure, sequence continuity, from/to chain continuity, and whether its');
  out.push('(action, from, to) triple is one the state machine could produce. The records were');
  out.push('then checked AGAINST EACH OTHER: the models, policy hashes, approvals and outcomes');
  out.push('they name all describe one migration, so a single edited detail field cannot');
  out.push('substitute a model that was never evaluated.');
  out.push('');
  out.push('WHAT IT DID NOT PROVE. This is inconsistency detection, not tamper resistance.');
  out.push('There is no hash chain and no signature, so a ledger rewritten consistently');
  out.push('throughout loads cleanly. Fields nothing else cross-references, including');
  out.push('timestamps, free-text reasons, adapter labels and the case-set hash, can be altered');
  out.push('without detection. Treat this as an honest record of a cooperative process, not as');
  out.push('evidence against someone who can write the file.');

  return out.join('\n');
}

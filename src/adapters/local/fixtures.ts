// Synthetic fixtures for the built-in demonstration.
//
// A deliberately tiny, fictional triage task: classify an inbound message as
// escalate / answer / acknowledge. Small enough to read in full, and chosen so the two
// demo models differ on exactly one behaviour (negation), which is what gives the
// acceptance policy something real to decide.

import type { EvaluationCase } from '../../domain/types.ts';

export const DEMO_CASES: readonly EvaluationCase[] = Object.freeze([
  { id: 'case-001', input: 'This is urgent, the line is down', expected: 'escalate' },
  { id: 'case-002', input: 'How do I reset the counter?', expected: 'answer' },
  { id: 'case-003', input: 'Received, thanks', expected: 'acknowledge' },
  { id: 'case-004', input: 'Please look immediately', expected: 'escalate' },
  // The discriminating case. The baseline reads "not urgent" as urgent; the candidate
  // does not. It is marked critical, so the policy can require it specifically.
  { id: 'case-critical-negation', input: 'This is not urgent, no action needed today', expected: 'acknowledge' },
]);

/**
 * Inputs used for post-activation verification.
 *
 * Deliberately MORE than the default ceiling of 5, so the default demo run visibly stops
 * at the bound and reports the truncation instead of quietly fitting inside it.
 */
export const DEMO_VERIFICATION_INPUTS: readonly string[] = Object.freeze([
  'This is urgent, please help',
  'How do I export the log?',
  'Acknowledged',
  'Not urgent, tomorrow is fine',
  'Escalate immediately please',
  'One more question',
  'And another message',
]);

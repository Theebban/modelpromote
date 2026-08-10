// BOUNDARY SANITISATION for strings that reach the human-readable audit report.
//
// Candidate ids, actor names and adapter labels are supplied from outside: a CLI flag, a
// config file, an adapter someone else wrote. All three are rendered into a report that a
// reviewer, an incident responder or an auditor reads and believes.
//
// A newline in an actor name is enough to forge a line of that report. An actor of
// "sam\n     approved by       compliance-team" would render an approval that never
// happened, indistinguishable from every other line.
//
// These strings are rejected at the boundary rather than escaped at the point of rendering:
// escaping has to be remembered at every call site, rejecting has to be remembered once.

import { UnsafeIdentifierError } from './errors.ts';

/** Longest an externally supplied identifier may be. Long enough for real ids. */
export const MAX_IDENTIFIER_LENGTH = 200;

// C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators that some
// terminals and editors also break lines on.
//
// The lint rule against control characters in a regex exists to catch them appearing by
// accident. Here they are the entire subject of the check, so it is disabled for this line
// specifically rather than for the file.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

// Bidirectional overrides can visually reorder a rendered line without changing its bytes,
// which is precisely a "misleading report rendering" vector.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;

function describe(value: string): string {
  const chars = [...value];
  const at = chars.findIndex((c) => UNSAFE.test(c) || BIDI.test(c));
  const cp = chars[at]?.codePointAt(0) ?? 0;
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')} at position ${at}`;
}

/**
 * Validate an externally supplied identifier destined for the audit record.
 *
 * Returns the value unchanged, or throws. It never silently rewrites: a quietly altered
 * actor name is its own audit problem.
 */
export function assertSafeIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnsafeIdentifierError(field, 'it is empty');
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new UnsafeIdentifierError(field, `it is ${value.length} characters, over the ${MAX_IDENTIFIER_LENGTH} limit`);
  }
  if (UNSAFE.test(value)) {
    throw new UnsafeIdentifierError(
      field,
      `it contains a control character (${describe(value)}), which could forge a line in the audit report`,
    );
  }
  if (BIDI.test(value)) {
    throw new UnsafeIdentifierError(
      field,
      `it contains a bidirectional override (${describe(value)}), which could visually reorder the audit report`,
    );
  }
  if (value.trim() !== value) {
    throw new UnsafeIdentifierError(field, 'it has leading or trailing whitespace, which renders ambiguously in the audit report');
  }
  return value;
}

/**
 * Last-resort rendering guard for strings reaching the report from a source that was not
 * validated at a boundary, such as a third-party adapter's `name`.
 *
 * Rejecting here would let a badly written adapter block a rollback, so these are escaped
 * rather than refused. The escaping is deterministic, so the report stays byte-stable.
 */
export function escapeForReport(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    out += UNSAFE.test(ch) || BIDI.test(ch) ? `\\u{${cp.toString(16)}}` : ch;
  }
  return out.length > MAX_IDENTIFIER_LENGTH ? `${out.slice(0, MAX_IDENTIFIER_LENGTH)}...[truncated]` : out;
}

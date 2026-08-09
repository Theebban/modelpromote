// The append-only migration ledger.
//
// This file is the migration. State is a fold over it (see machine.foldState), so there is
// no second place where "the current state" lives and nothing for a report to contradict.
//
// Reads are strict. A ledger that cannot be parsed, whose sequence numbers skip, or whose
// `from` does not match the previous `to`, is CORRUPT and raises. It never degrades into a
// plausible default, because a corrupt ledger reading as REGISTERED would invite
// re-activating a model whose real status nobody knows.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerCorruptError } from '../domain/errors.ts';
import type { MigrationEvent } from '../domain/types.ts';
import { MIGRATION_ACTIONS, MIGRATION_STATES } from '../domain/types.ts';

export const STATE_DIR = '.modelshift';
export const LEDGER_FILE = 'ledger.jsonl';

export function ledgerPath(root: string): string {
  return join(root, STATE_DIR, LEDGER_FILE);
}

export function ledgerExists(root: string): boolean {
  return existsSync(ledgerPath(root));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read and validate the whole ledger. Raises rather than guessing. */
export function readLedger(root: string): readonly MigrationEvent[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new LedgerCorruptError(path, `unreadable (${(e as Error).message})`);
  }

  const lines = raw.split('\n').map((l) => l.trim());
  const events: MigrationEvent[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    const lineNo = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LedgerCorruptError(path, 'a record is not valid JSON', lineNo);
    }
    if (!isRecord(parsed)) throw new LedgerCorruptError(path, 'a record is not an object', lineNo);

    const { seq, at, action, from, to, actor, detail } = parsed;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      throw new LedgerCorruptError(path, 'a record has a non-integer seq', lineNo);
    }
    if (seq !== events.length + 1) {
      throw new LedgerCorruptError(path, `sequence break, expected seq ${events.length + 1} and found ${seq}`, lineNo);
    }
    if (typeof at !== 'string' || typeof actor !== 'string') {
      throw new LedgerCorruptError(path, 'a record has a malformed "at" or "actor"', lineNo);
    }
    if (typeof action !== 'string' || !(MIGRATION_ACTIONS as readonly string[]).includes(action)) {
      throw new LedgerCorruptError(path, `unknown action "${String(action)}"`, lineNo);
    }
    if (typeof to !== 'string' || !(MIGRATION_STATES as readonly string[]).includes(to)) {
      throw new LedgerCorruptError(path, `unknown state "${String(to)}"`, lineNo);
    }
    if (from !== null && (typeof from !== 'string' || !(MIGRATION_STATES as readonly string[]).includes(from))) {
      throw new LedgerCorruptError(path, `unknown from-state "${String(from)}"`, lineNo);
    }

    // Chain integrity: this event must continue the previous one. An edited or spliced
    // ledger fails here rather than silently re-writing history.
    const previous = events.at(-1);
    const expectedFrom = previous === undefined ? null : previous.to;
    if (from !== expectedFrom) {
      throw new LedgerCorruptError(
        path,
        `broken chain, record claims it started from ${String(from)} but the previous record ended at ${String(expectedFrom)}`,
        lineNo,
      );
    }

    events.push({
      seq,
      at,
      action: action as MigrationEvent['action'],
      from: from as MigrationEvent['from'],
      to: to as MigrationEvent['to'],
      actor,
      detail: isRecord(detail) ? detail : {},
    });
  }

  return events;
}

/** Append one event. The ledger is the record, so this is the only write path. */
export function appendEvent(root: string, event: MigrationEvent): void {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}

export const RECOVERY_FILE = 'recovery.jsonl';

export function recoveryPath(root: string): string {
  return join(root, STATE_DIR, RECOVERY_FILE);
}

/**
 * Record an emergency action taken while the main ledger was unreadable.
 *
 * Written to a SEPARATE file on purpose. Appending to a ledger that failed its integrity
 * check would corrupt the one artifact an investigation depends on, and the new record
 * would inherit the doubt attached to the file it sits in.
 */
export function appendRecovery(root: string, record: Readonly<Record<string, unknown>>): string {
  const path = recoveryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return path;
}

/** Create the state directory and an empty ledger. Refuses to clobber an existing one. */
export function initLedger(root: string): { created: boolean; path: string } {
  const path = ledgerPath(root);
  if (existsSync(path)) return { created: false, path };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, '', 'utf8');
  renameSync(tmp, path);
  return { created: true, path };
}

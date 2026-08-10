// The append-only migration ledger, and the migration history around it.
//
// Each migration is one file under `.modelshift/migrations/`. The ACTIVE migration is the
// highest-numbered one that has not reached a terminal state; when it terminates, its file
// stays exactly where it is and the next `register` opens a new one. History is therefore
// retained by default and needs no archiving step and no manual deletion.
//
// Reads are strict in three independent ways:
//   1. STRUCTURE   parseable JSON, known enum members, contiguous sequence.
//   2. CHAIN       each event's `from` equals the previous event's `to`.
//   3. SEMANTICS   each (action, from, to) is a transition the machine could have produced.
//
// The third exists because the first two are satisfiable by a forgery. Editing one field of
// a valid record (the first event's `to`, from REGISTERED to APPROVED) keeps the structure
// and the chain intact while inventing a migration that skipped evaluation and approval.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerCorruptError } from '../domain/errors.ts';
import type { MigrationEvent, MigrationId, MigrationState } from '../domain/types.ts';
import { MIGRATION_ACTIONS, MIGRATION_STATES, TERMINAL_STATES } from '../domain/types.ts';
import { foldState, isLegalEvent } from '../domain/machine.ts';

export const STATE_DIR = '.modelshift';
export const MIGRATIONS_DIR = 'migrations';
export const RECOVERY_FILE = 'recovery.jsonl';

export function migrationsDir(root: string): string {
  return join(root, STATE_DIR, MIGRATIONS_DIR);
}

export function migrationPath(root: string, id: MigrationId): string {
  return join(migrationsDir(root), `${id}.jsonl`);
}

export function recoveryPath(root: string): string {
  return join(root, STATE_DIR, RECOVERY_FILE);
}

/** Every migration id present on disk, oldest first. */
export function listMigrations(root: string): readonly MigrationId[] {
  const dir = migrationsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

export function nextMigrationId(root: string): MigrationId {
  const all = listMigrations(root);
  const last = all.at(-1);
  const n = last === undefined ? 0 : Number.parseInt(last, 10);
  return String(n + 1).padStart(4, '0');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read and validate one migration ledger. Raises rather than guessing. */
export function readMigration(root: string, id: MigrationId): readonly MigrationEvent[] {
  const path = migrationPath(root, id);
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

    // 1. STRUCTURE
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

    const typedAction = action as MigrationEvent['action'];
    const typedFrom = from as MigrationState | null;
    const typedTo = to as MigrationState;

    // 2. CHAIN. An edited or spliced ledger fails here rather than rewriting history.
    const previous = events.at(-1);
    const expectedFrom = previous === undefined ? null : previous.to;
    if (typedFrom !== expectedFrom) {
      throw new LedgerCorruptError(
        path,
        `broken chain, record claims it started from ${String(from)} but the previous record ended at ${String(expectedFrom)}`,
        lineNo,
      );
    }

    // 3. SEMANTICS. Structure and chain can both be satisfied by a forgery; this cannot.
    if (events.length === 0 && typedAction !== 'register') {
      throw new LedgerCorruptError(path, `the first record must be "register", found "${typedAction}"`, lineNo);
    }
    if (!isLegalEvent(typedAction, typedFrom, typedTo)) {
      throw new LedgerCorruptError(
        path,
        `illegal transition, "${typedAction}" cannot go from ${String(from)} to ${typedTo}. ` +
          'This record describes something the state machine could never have produced',
        lineNo,
      );
    }

    events.push({
      seq,
      at,
      action: typedAction,
      from: typedFrom,
      to: typedTo,
      actor,
      detail: isRecord(detail) ? detail : {},
    });
  }

  return events;
}

/** The migration currently open, or null when every migration has terminated. */
export function activeMigrationId(root: string): MigrationId | null {
  const all = listMigrations(root);
  const last = all.at(-1);
  if (last === undefined) return null;
  const state = foldState(readMigration(root, last));
  if (state === null) return last;
  return TERMINAL_STATES.includes(state) ? null : last;
}

/** Append one event to a migration. The only write path into a ledger. */
export function appendEvent(root: string, id: MigrationId, event: MigrationEvent): void {
  const path = migrationPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}

/**
 * Record an emergency action taken while a ledger was unreadable.
 *
 * A separate file on purpose. Appending to a ledger that failed its integrity check would
 * damage the one artifact an investigation depends on, and the new record would inherit the
 * doubt attached to the file it sits in.
 */
export function appendRecovery(root: string, record: Readonly<Record<string, unknown>>): string {
  const path = recoveryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return path;
}

export function readRecovery(root: string): readonly Record<string, unknown>[] {
  const path = recoveryPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Create the state directory. Idempotent, and never clobbers an existing migration. */
export function initStore(root: string): { created: boolean; path: string } {
  const dir = migrationsDir(root);
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  return { created: !existed, path: dir };
}

export function storeExists(root: string): boolean {
  return existsSync(migrationsDir(root));
}

/** Atomically create an empty ledger file for a new migration id. */
export function createMigrationFile(root: string, id: MigrationId): string {
  const path = migrationPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`migration ${id} already exists at ${path}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, '', 'utf8');
  renameSync(tmp, path);
  return path;
}

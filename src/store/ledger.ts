// The append-only migration ledger, and the migration history around it.
//
// Each migration is one file under `.modelshift/migrations/`. The ACTIVE migration is the
// highest-numbered one that has not reached a terminal state; when it terminates, its file
// stays exactly where it is and the next `register` opens a new one. History is therefore
// retained by default and needs no archiving step and no manual deletion.
//
// Reads are strict in four independent ways:
//   1. STRUCTURE    parseable JSON, known enum members, contiguous sequence.
//   2. CHAIN        each event's `from` equals the previous event's `to`.
//   3. SEMANTICS    each (action, from, to) is a transition the machine could have produced.
//   4. CROSS-EVENT  the models, policy hashes and outcomes the records name agree with each
//                   other and with the migration's registered identity.
//
// Layer 3 exists because the first two are satisfiable by a forgery. Editing one field of a
// valid record (the first event's `to`, from REGISTERED to APPROVED) keeps the structure and
// the chain intact while inventing a migration that skipped evaluation and approval.
//
// Layer 4 exists because the first THREE are also satisfiable by a forgery. Editing
// `detail.candidate` on the register record changes no action and no state, so layers 1 to 3
// all pass, and the migration then activates a model nothing ever evaluated. See
// `consistency.ts` for the relational checks that close it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerCorruptError } from '../domain/errors.ts';
import type { MigrationEvent, MigrationId, MigrationState } from '../domain/types.ts';
import { MIGRATION_ACTIONS, MIGRATION_STATES, TERMINAL_STATES } from '../domain/types.ts';
import { foldState, isLegalEvent } from '../domain/machine.ts';
import { assertCrossEventConsistency } from './consistency.ts';

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

/** Every ledger FILE on disk, oldest first, whether or not it holds a migration. */
function ledgerFileIds(root: string): readonly MigrationId[] {
  const dir = migrationsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

/** True for a ledger file that exists but holds no record at all. */
function isEmptyLedgerFile(root: string, id: MigrationId): boolean {
  const path = migrationPath(root, id);
  if (!existsSync(path)) return true;
  return readFileSync(path, 'utf8').trim().length === 0;
}

/**
 * Every migration present on disk, oldest first.
 *
 * A zero-byte ledger file is NOT a migration. It contains no `register` record, so there is
 * nothing it could be a migration TO. Registration is atomic now, so one can only appear
 * through outside interference or an interruption in an older version, but treating it as a
 * migration is what wedged a project: it looked active, nothing could be done to it, and no
 * new migration could begin.
 */
export function listMigrations(root: string): readonly MigrationId[] {
  return ledgerFileIds(root).filter((id) => !isEmptyLedgerFile(root, id));
}

export function nextMigrationId(root: string): MigrationId {
  const all = ledgerFileIds(root);
  const last = all.at(-1);
  if (last === undefined) return '0001';
  // An empty trailing file holds no record, so its id is reclaimed rather than being
  // skipped forever. Ids are only ever consumed by migrations that actually exist.
  if (isEmptyLedgerFile(root, last)) return last;
  return String(Number.parseInt(last, 10) + 1).padStart(4, '0');
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

  // 4. CROSS-EVENT. Every record above is individually possible; this asks whether they are
  // possible TOGETHER, and in particular whether they all describe the same migration.
  assertCrossEventConsistency(events, path);

  return events;
}

/** The migration currently open, or null when every migration has terminated. */
export function activeMigrationId(root: string): MigrationId | null {
  const all = listMigrations(root);
  const last = all.at(-1);
  if (last === undefined) return null;
  const state = foldState(readMigration(root, last));
  // DELIBERATELY REDUNDANT. `listMigrations` already excludes ledgers with no records, so
  // this branch is unreachable today and a mutation that removes it survives; that is
  // documented in docs/mutation-testing.md rather than papered over.
  //
  // It stays because the two mistakes here are not symmetric. Reading "no state" as "in
  // progress" is what let an interrupted creation block every subsequent registration in a
  // project, and the cost of the opposite mistake is only that a new migration may begin.
  if (state === null) return null;
  return TERMINAL_STATES.includes(state) ? null : last;
}

/**
 * Append one event to a migration. The only write path into a ledger.
 *
 * THE FIRST RECORD CREATES THE FILE, ATOMICALLY. Writing it into a temporary file and
 * renaming it into place means a migration file never exists in a half-formed state: either
 * there is no file, or there is a file whose first record is a complete `register`. The
 * earlier two-step (create empty, then append) had an observable window between them, and an
 * interruption inside that window left a file that looked like an active migration, refused
 * every action, and could not be registered over.
 */
export function appendEvent(root: string, id: MigrationId, event: MigrationEvent): void {
  const path = migrationPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  const serialised = `${JSON.stringify(event)}\n`;

  if (event.seq !== 1) {
    appendFileSync(path, serialised, 'utf8');
    return;
  }

  if (existsSync(path) && readFileSync(path, 'utf8').trim().length > 0) {
    throw new Error(`migration ${id} already holds records at ${path}; refusing to overwrite it`);
  }
  // The pid keeps two processes racing on the same id from sharing a temporary file. The
  // rename is what makes the result atomic; the temporary name never survives it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, serialised, 'utf8');
  renameSync(tmp, path);
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

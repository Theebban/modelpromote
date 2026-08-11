// THE CLI AS A USER INVOKES IT.
//
// These spawn the real entry point as a child process rather than calling the engine
// functions, because the defect this file exists for lived entirely in argument parsing and
// no test that imports a function could ever have reached it.
//
// The README wraps the CLI in an alias that carries `--root`, which puts a flag BEFORE the
// subcommand. `argv[0]` was read as the command, so every step of the documented
// five-minute walkthrough failed with a confusing configuration error. Two independent
// reviews missed it: both drove the library, and every hand-run happened to put the command
// first. It was found by running the README verbatim from a clean clone.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const ENTRY = join(REPO, 'src', 'cli', 'index.ts');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'modelshift-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run the CLI exactly as a shell would. Returns combined output and the exit code. */
function cli(...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', ENTRY, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('the command may appear after its options', () => {
  test('the README alias form works: --root BEFORE the subcommand', () => {
    // Exactly what `alias ms="node ... src/cli/index.ts --root /tmp/demo"; ms init` expands to.
    const init = cli('--root', root, 'init');
    assert.equal(init.code, 0, init.out);
    assert.match(init.out, /migrations :/);

    const reg = cli('--root', root, 'register', 'demo-candidate');
    assert.equal(reg.code, 0, reg.out);
    assert.match(reg.out, /registered demo-candidate/);
    assert.match(reg.out, /state {5}: REGISTERED/);
  });

  test('the command-first form still works, so the fix did not trade one order for the other', () => {
    assert.equal(cli('init', '--root', root).code, 0);
    const reg = cli('register', 'demo-candidate', '--root', root);
    assert.equal(reg.code, 0, reg.out);
    assert.match(reg.out, /registered demo-candidate/);
  });

  test('a flag value is never mistaken for the command', () => {
    // "status" appears as the VALUE of --actor here; the command is still `init`.
    cli('--root', root, 'init');
    const r = cli('--root', root, '--actor', 'status', 'register', 'demo-candidate');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /registered demo-candidate/);
  });

  test('register still refuses a missing candidate in either order', () => {
    cli('--root', root, 'init');
    for (const args of [['--root', root, 'register'], ['register', '--root', root]]) {
      const r = cli(...args);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /usage: modelshift register/);
    }
  });

  test('help is reachable with no arguments and with only a flag', () => {
    for (const args of [[], ['--help'], ['-h'], ['--root', root]]) {
      const r = cli(...args);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /governed change control/);
    }
  });
});

describe('the documented five-minute walkthrough, end to end', () => {
  test('every step of README section 3 runs in the order it is written', () => {
    const ms = (...args: string[]) => cli('--root', root, ...args);

    assert.equal(ms('init').code, 0);
    assert.equal(ms('register', 'demo-candidate').code, 0);

    // Documented as refused, and the exit code has to say so too.
    const early = ms('activate', '--actor', 'you');
    assert.equal(early.code, 1);
    assert.match(early.out, /IllegalTransitionError/);
    assert.match(early.out, /required state : APPROVED/);

    const evaluated = ms('evaluate');
    assert.equal(evaluated.code, 0, evaluated.out);
    assert.match(evaluated.out, /POLICY VERDICT: ACCEPTED/);

    assert.equal(ms('approve', '--actor', 'you').code, 0);

    const activated = ms('activate', '--actor', 'you');
    assert.equal(activated.code, 0, activated.out);
    assert.match(activated.out, /target read back: demo-candidate/);

    const verified = ms('verify');
    assert.equal(verified.code, 0, verified.out);
    assert.match(verified.out, /confirmed {5}: YES/);
    // The claim the CLI prints must be the claim the implementation proves.
    assert.match(verified.out, /evidence class: temporal-window/);
    assert.match(verified.out, /NOT a per-request correlation/);

    const report = ms('report');
    assert.equal(report.code, 0);
    assert.match(report.out, /ATTESTATION/);
    assert.match(report.out, /rollback target {7}demo-baseline {2}\(locked at register\)/);
    assert.match(report.out, /inconsistency detection, not tamper resistance/);
  });

  test('the documented tamper probe is refused by the CLI', () => {
    const ms = (...args: string[]) => cli('--root', root, ...args);
    ms('init');
    ms('register', 'demo-candidate');
    // Evaluate first, so a SECOND record names the candidate. Cross-event validation compares
    // records against each other; a ledger holding only its register record has nothing to
    // contradict, and a substitution there is still internally consistent.
    assert.equal(ms('evaluate').code, 0);

    // README section 3: substitute the candidate in the first record, change nothing else.
    const ledger = join(root, '.modelshift', 'migrations', '0001.jsonl');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0] as string) as { detail: Record<string, unknown> };
    first.detail['candidate'] = 'demo-regression';
    lines[0] = JSON.stringify(first);
    writeFileSync(ledger, `${lines.join('\n')}\n`, 'utf8');

    const r = ms('status');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /LedgerCorruptError/);
    assert.match(r.out, /cross-event inconsistency/);
  });

  test('a substitution in a register-only ledger is NOT detected, and that is documented', () => {
    // The honest boundary of the cross-event layer. Stated here so it cannot quietly become
    // an assumed guarantee: with one record there is no second record to disagree with it.
    const ms = (...args: string[]) => cli('--root', root, ...args);
    ms('init');
    ms('register', 'demo-candidate');

    const ledger = join(root, '.modelshift', 'migrations', '0001.jsonl');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0] as string) as { detail: Record<string, unknown> };
    first.detail['candidate'] = 'demo-regression';
    writeFileSync(ledger, `${JSON.stringify(first)}\n`, 'utf8');

    const r = ms('status');
    assert.equal(r.code, 0, 'a lone consistent record loads');
    assert.match(r.out, /candidate {2}: demo-regression/);
  });
});

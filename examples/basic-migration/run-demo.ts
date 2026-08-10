// End-to-end demonstration, driven through the library rather than the CLI.
//
// Runs a complete migration in a temporary directory, including the parts that are supposed
// to be refused. Nothing here needs a key, an account or a network call.
//
//   npm run demo

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, writeConfig, loadConfig } from '../../src/config.ts';
import { initStore } from '../../src/store/ledger.ts';
import { demoPorts } from '../../src/adapters/local/demoPorts.ts';
import { DEMO_CASES, DEMO_VERIFICATION_INPUTS } from '../../src/adapters/local/fixtures.ts';
import { activate, approve, decide, evaluate, register, stabilise, status, verify } from '../../src/engine.ts';
import { renderReport } from '../../src/audit/report.ts';

function heading(s: string): void {
  console.log(`\n${'='.repeat(74)}\n${s}\n${'='.repeat(74)}`);
}

function refused(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(`  UNEXPECTED: ${label} was allowed. This is a bug.`);
    process.exitCode = 1;
  } catch (e) {
    console.log(`  refused as designed: ${label}`);
    console.log(
      String((e as Error).message)
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'modelshift-demo-'));
  try {
    writeConfig(root, DEFAULT_CONFIG);
    initStore(root);
    const config = loadConfig(root);
    // A fixed clock so this transcript is byte-identical every run.
    let tick = 0;
    const clock = (): string => {
      tick += 1;
      return `2026-01-01T09:${String(tick).padStart(2, '0')}:00.000Z`;
    };
    const ports = demoPorts(root, config.baselineModel, clock);

    heading('1. REGISTER a candidate');
    register(root, 'demo-candidate', config, clock);
    console.log(`  state: ${status(root).state}`);

    heading('2. THE GATES REFUSE, BEFORE ANY EVIDENCE EXISTS');
    refused('approve with nothing measured', () => approve(root, 'sam', config, clock));
    await (async () => {
      try {
        await activate(root, 'sam', ports);
        console.log('  UNEXPECTED: activation was allowed.');
        process.exitCode = 1;
      } catch (e) {
        console.log('  refused as designed: activate with nothing approved');
        console.log(String((e as Error).message).split('\n').map((l) => `      ${l}`).join('\n'));
      }
    })();

    heading('3. EVALUATE, then apply the declared policy');
    const { evaluation } = await evaluate(root, DEMO_CASES, config, ports);
    console.log(`  baseline  ${evaluation.baseline.modelId}  ${evaluation.baseline.score.toFixed(3)}`);
    console.log(`  candidate ${evaluation.candidate.modelId}  ${evaluation.candidate.score.toFixed(3)}`);
    console.log(`  delta     ${evaluation.delta >= 0 ? '+' : ''}${evaluation.delta.toFixed(3)}`);
    const { verdict } = decide(root, config, clock);
    console.log(`  verdict   ${verdict.accepted ? 'ACCEPTED' : 'REJECTED'}`);
    for (const c of verdict.checks) console.log(`    ${c.passed ? 'pass' : 'FAIL'}  ${c.rule}: ${c.detail}`);

    heading('4. APPROVE, a separate human act');
    approve(root, 'sam', config, clock);
    console.log(`  state: ${status(root).state}`);

    heading('5. ACTIVATE, confirmed by reading the target back');
    const act = await activate(root, 'sam', ports);
    console.log(`  requested        : ${act.requested}`);
    console.log(`  target read back : ${act.observed}`);
    console.log(`  confirmed        : ${act.confirmed ? 'YES, by read-back' : 'NO'}`);

    heading('6. VERIFY under a hard ceiling, then assert from telemetry');
    const { run, assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    console.log(`  inputs available : ${run.requestsAvailable}`);
    console.log(`  requests made    : ${run.requestsMade}  (ceiling ${config.verification.maxRequests})`);
    console.log(`  stopped by       : ${run.stoppedBy}`);
    console.log(`  truncated        : ${run.truncated ? 'YES, reported not silent' : 'NO'}`);
    console.log(`  telemetry says   : ${assertion.observed.join(', ') || '(none)'}`);
    console.log(`  confirmed        : ${assertion.confirmed ? 'YES' : 'NO'}  (${assertion.reason})`);

    heading('7. CLOSE the migration');
    stabilise(root, 'sam', clock);
    console.log(`  state: ${status(root).state}`);

    heading('8. THE AUDIT RECORD');
    const v = status(root);
    console.log(renderReport(v.events, v.state, v.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();

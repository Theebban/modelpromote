#!/usr/bin/env node
// modelshift CLI.
//
// Every command is a single lifecycle action. Nothing is implicit: no command silently
// performs a transition you did not ask for, and no command activates anything.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, writeConfig, configPath, CONFIG_FILE } from '../config.ts';
import { initLedger, ledgerExists, ledgerPath } from '../store/ledger.ts';
import { LedgerCorruptError } from '../domain/errors.ts';
import { activate, approve, decide, emergencyRollback, evaluate, register, rollback, stabilise, status, verify } from '../engine.ts';
import { renderReport } from '../audit/report.ts';
import { demoPorts } from '../adapters/local/demoPorts.ts';
import { TRANSITIONS } from '../domain/machine.ts';
import type { Ports } from '../ports/index.ts';
import type { EvaluationCase } from '../domain/types.ts';
import { DEMO_CASES, DEMO_VERIFICATION_INPUTS } from '../adapters/local/fixtures.ts';

const PORTS_FILE = 'modelshift.ports.ts';

function out(s = ''): void {
  process.stdout.write(`${s}\n`);
}

function flag(argv: readonly string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

/**
 * Load the project's own port wiring if it exists, otherwise use the demo wiring.
 *
 * This is the integration seam: drop a `modelshift.ports.ts` exporting `createPorts(root)`
 * beside your config and the same lifecycle governs your real system.
 */
async function loadPorts(root: string, initialServing: string): Promise<{ ports: Ports; source: string }> {
  const custom = join(root, PORTS_FILE);
  if (existsSync(custom)) {
    const mod = (await import(pathToFileURL(custom).href)) as { createPorts?: (root: string) => Ports };
    if (typeof mod.createPorts !== 'function') {
      throw new Error(`${PORTS_FILE} must export a function "createPorts(root)" returning Ports`);
    }
    return { ports: mod.createPorts(root), source: PORTS_FILE };
  }
  return { ports: demoPorts(root, initialServing), source: 'built-in demo adapters' };
}

function loadCases(root: string): readonly EvaluationCase[] {
  const path = join(root, 'modelshift.cases.json');
  if (!existsSync(path)) return DEMO_CASES;
  return JSON.parse(readFileSync(path, 'utf8')) as EvaluationCase[];
}

const HELP = `modelshift - governed change control for production AI models

  modelshift init                     create ${CONFIG_FILE} and an empty migration ledger
  modelshift register <candidate>     begin a migration to <candidate>
  modelshift evaluate                 measure baseline vs candidate, then apply the policy
  modelshift status                   show current state (read only, never mutates)
  modelshift approve  --actor <name>  human authorisation, only legal once ACCEPTED
  modelshift activate --actor <name>  switch the serving model, only legal once APPROVED
  modelshift verify                   bounded traffic, then assert from telemetry
  modelshift close    --actor <name>  close the migration, state becomes STABLE
  modelshift rollback --actor <name>  revert to the configured rollback model
  modelshift report                   full audit record, rendered from the ledger
  modelshift states                   print the transition table

Options
  --root <dir>    project directory (default: current directory)
  --json          machine-readable output, where supported
`;

async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0] ?? 'help';
  const root = flag(argv, 'root', process.cwd());
  const json = argv.includes('--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP);
    return 0;
  }

  if (cmd === 'states') {
    out('TRANSITION TABLE. Any pair not listed is refused.');
    out('');
    for (const [action, map] of Object.entries(TRANSITIONS)) {
      const entries = Object.entries(map);
      if (entries.length === 0) {
        out(`  ${action.padEnd(18)} (from no migration) -> REGISTERED`);
        continue;
      }
      for (const [from, to] of entries) out(`  ${action.padEnd(18)} ${from} -> ${to}`);
    }
    return 0;
  }

  if (cmd === 'init') {
    if (!existsSync(configPath(root))) writeConfig(root, DEFAULT_CONFIG);
    const { created, path } = initLedger(root);
    out(`config  : ${configPath(root)}`);
    out(`ledger  : ${path}${created ? '' : '  (already existed, left untouched)'}`);
    out('');
    out('Next: modelshift register demo-candidate');
    return 0;
  }

  const config = loadConfig(root);

  if (cmd === 'register') {
    const candidate = argv[1];
    if (candidate === undefined || candidate.startsWith('--')) {
      out('usage: modelshift register <candidate-model-id>');
      return 2;
    }
    if (!ledgerExists(root)) initLedger(root);
    const e = register(root, candidate, config, () => new Date().toISOString());
    out(`registered ${candidate}`);
    out(`  baseline : ${config.baselineModel}`);
    out(`  state    : ${e.to}`);
    return 0;
  }

  if (cmd === 'evaluate') {
    const { ports } = await loadPorts(root, config.baselineModel);
    const { evaluation } = await evaluate(root, loadCases(root), ports);
    out('EVALUATION');
    out(`  baseline  ${evaluation.baseline.modelId}  score ${evaluation.baseline.score.toFixed(3)} (${evaluation.baseline.passed}/${evaluation.baseline.casesRun})`);
    out(`  candidate ${evaluation.candidate.modelId}  score ${evaluation.candidate.score.toFixed(3)} (${evaluation.candidate.passed}/${evaluation.candidate.casesRun})`);
    out(`  delta     ${evaluation.delta >= 0 ? '+' : ''}${evaluation.delta.toFixed(3)}`);
    out('');
    const { verdict } = decide(root, config, () => new Date().toISOString());
    out(`POLICY VERDICT: ${verdict.accepted ? 'ACCEPTED' : 'REJECTED'}`);
    for (const c of verdict.checks) out(`  ${c.passed ? 'pass' : 'FAIL'}  ${c.rule.padEnd(18)}${c.detail}`);
    for (const r of verdict.reasons) out(`  reason: ${r}`);
    out('');
    out(verdict.accepted ? 'Next: modelshift approve --actor <your-name>' : 'The candidate cannot be approved while the policy fails.');
    return verdict.accepted ? 0 : 1;
  }

  if (cmd === 'status') {
    const v = status(root);
    if (json) {
      out(JSON.stringify({ state: v.state, candidate: v.candidate, baseline: v.baseline, events: v.events.length }, null, 2));
      return 0;
    }
    out(`state      : ${v.state ?? '(no migration)'}`);
    out(`candidate  : ${v.candidate ?? '(none)'}`);
    out(`baseline   : ${v.baseline ?? '(none)'}`);
    out(`events     : ${v.events.length}`);
    if (v.evaluation) out(`evaluation : delta ${v.evaluation.delta >= 0 ? '+' : ''}${v.evaluation.delta.toFixed(3)}`);
    if (v.approvedBy) out(`approved by: ${v.approvedBy}`);
    return 0;
  }

  if (cmd === 'approve') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift approve --actor <name>');
      out('An approval with no named actor is not an approval.');
      return 2;
    }
    const { policyChanged } = approve(root, actor, config, () => new Date().toISOString());
    out(`approved by ${actor}`);
    if (policyChanged) {
      out('*** WARNING: the acceptance policy changed after the verdict was recorded.');
      out('    The report will show both hashes.');
    }
    out('Next: modelshift activate --actor <your-name>');
    return 0;
  }

  if (cmd === 'activate') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift activate --actor <name>');
      return 2;
    }
    const { ports } = await loadPorts(root, config.baselineModel);
    const { serving } = await activate(root, actor, ports);
    out(`activated by ${actor}`);
    out(`  target now reports: ${serving}`);
    out('Next: modelshift verify');
    return 0;
  }

  if (cmd === 'verify') {
    const { ports } = await loadPorts(root, config.baselineModel);
    const { run, assertion } = await verify(root, DEMO_VERIFICATION_INPUTS, config, ports);
    out('BOUNDED VERIFICATION');
    out(`  ceiling       : ${config.verification.maxRequests}`);
    out(`  available     : ${run.requestsAvailable}`);
    out(`  requests made : ${run.requestsMade}`);
    out(`  stopped by    : ${run.stoppedBy}`);
    out(`  truncated     : ${run.truncated ? `YES, ${run.requestsAvailable - run.requestsMade} left unissued` : 'NO'}`);
    out('');
    out('TELEMETRY ASSERTION');
    out(`  expected      : ${assertion.expected}`);
    out(`  observed      : ${assertion.observed.join(', ') || '(none)'}`);
    out(`  observations  : ${assertion.observationCount} (minimum ${assertion.required})`);
    out(`  confirmed     : ${assertion.confirmed ? 'YES' : 'NO'}`);
    out(`  reason        : ${assertion.reason}`);
    out('');
    out(assertion.confirmed ? 'Next: modelshift close --actor <your-name>' : 'Verification failed. Next: modelshift rollback --actor <your-name>');
    return assertion.confirmed ? 0 : 1;
  }

  if (cmd === 'close') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift close --actor <name>');
      return 2;
    }
    const e = stabilise(root, actor, () => new Date().toISOString());
    out(`migration closed by ${actor}. state: ${e.to}`);
    return 0;
  }

  if (cmd === 'rollback') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift rollback --actor <name>');
      return 2;
    }
    const { ports } = await loadPorts(root, config.baselineModel);
    try {
      const { serving } = await rollback(root, actor, config, ports);
      out(`rolled back by ${actor}`);
      out(`  target now reports: ${serving}`);
      out('  reversion path: configuration change, not a code release.');
      return 0;
    } catch (e) {
      // FAIL OPEN. An unreadable ledger must not stand between an operator and the declared
      // safe model. The target comes from configuration, so it is still knowable.
      if (!(e instanceof LedgerCorruptError)) throw e;
      const { serving, recordedAt } = await emergencyRollback(root, actor, config, ports, e.message.split('\n')[0] ?? 'ledger unreadable');
      out('EMERGENCY ROLLBACK');
      out(`  the migration ledger is unreadable, so the normal path could not run.`);
      out(`  reverted to the model declared in configuration: ${serving}`);
      out(`  recorded separately in: ${recordedAt}`);
      out('');
      out('  The ledger was NOT modified. Investigate it before starting another migration.');
      return 0;
    }
  }

  if (cmd === 'report') {
    const v = status(root);
    out(renderReport(v.events, v.state));
    return 0;
  }

  out(`unknown command "${cmd}"`);
  out(HELP);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    const err = e as Error;
    process.stderr.write(`\nERROR: ${err.name}\n${err.message}\n\n`);
    if (ledgerExists(flag(process.argv.slice(2), 'root', process.cwd()))) {
      process.stderr.write(`ledger: ${ledgerPath(flag(process.argv.slice(2), 'root', process.cwd()))}\n`);
    }
    process.exitCode = 1;
  });

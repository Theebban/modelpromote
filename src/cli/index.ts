#!/usr/bin/env node
// modelshift CLI.
//
// Every command is a single lifecycle action. Nothing is implicit: no command silently
// performs a transition you did not ask for, and no command activates anything.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, writeConfig, configPath, CONFIG_FILE } from '../config.ts';
import { activeMigrationId, initStore, listMigrations, storeExists } from '../store/ledger.ts';
import { LedgerCorruptError } from '../domain/errors.ts';
import { resolveVerificationInputs, type ResolvedPorts } from '../verify/plan.ts';
import {
  abandon,
  activate,
  approve,
  decide,
  emergencyRollback,
  evaluate,
  history,
  register,
  rollback,
  stabilise,
  status,
  statusOf,
  verify,
} from '../engine.ts';
import { renderReport } from '../audit/report.ts';
import { demoPorts } from '../adapters/local/demoPorts.ts';
import { TRANSITIONS } from '../domain/machine.ts';
import type { Ports } from '../ports/index.ts';
import type { EvaluationCase } from '../domain/types.ts';
import { DEMO_CASES } from '../adapters/local/fixtures.ts';

const PORTS_FILE = 'modelshift.ports.ts';
const PORTS_FILE_JS = 'modelshift.ports.js';
const CASES_FILE = 'modelshift.cases.json';

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
 * This is the integration seam: drop a `modelshift.ports.ts` (or `.js` when installed as a
 * package) beside your config, export `createPorts(root)`, and the same lifecycle governs
 * your real system.
 */
async function loadPorts(root: string, initialServing: string): Promise<ResolvedPorts> {
  for (const file of [PORTS_FILE, PORTS_FILE_JS]) {
    const custom = join(root, file);
    if (!existsSync(custom)) continue;
    const mod = (await import(pathToFileURL(custom).href)) as { createPorts?: (root: string) => Ports };
    if (typeof mod.createPorts !== 'function') {
      throw new Error(`${file} must export a function "createPorts(root)" returning Ports`);
    }
    return { ports: mod.createPorts(root), source: file, custom: true };
  }
  return { ports: demoPorts(root, initialServing), source: 'built-in demo adapters', custom: false };
}

function loadCases(root: string): readonly EvaluationCase[] {
  const path = join(root, CASES_FILE);
  if (!existsSync(path)) return DEMO_CASES;
  return JSON.parse(readFileSync(path, 'utf8')) as EvaluationCase[];
}

const HELP = `modelshift - governed change control for production AI models

  modelshift init                     create ${CONFIG_FILE} and the migration store
  modelshift register <candidate>     begin a migration to <candidate>
  modelshift evaluate                 measure baseline vs candidate, then apply the policy
  modelshift status                   show current state (read only, never mutates)
  modelshift approve  --actor <name>  human authorisation, only legal once ACCEPTED
  modelshift activate --actor <name>  switch the serving model, confirmed by read-back
  modelshift verify                   bounded traffic, then assert from telemetry
  modelshift close    --actor <name>  close the migration, state becomes STABLE
  modelshift rollback --actor <name>  revert to the configured rollback model
  modelshift abandon  --actor <name>  give up on this candidate (nothing activated yet)
  modelshift report                   full audit record, rendered from the ledger
  modelshift history                  every migration in this project
  modelshift states                   print the transition table

Options
  --root <dir>        project directory (default: current directory)
  --migration <id>    target a specific migration (status, report)
  --json              machine-readable output, where supported
`;

async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0] ?? 'help';
  const root = flag(argv, 'root', process.cwd());
  const json = argv.includes('--json');
  const migrationFlag = flag(argv, 'migration', '');

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
        out(`  ${action.padEnd(18)} (no migration) -> REGISTERED`);
        continue;
      }
      for (const [from, to] of entries) out(`  ${action.padEnd(18)} ${from} -> ${to}`);
    }
    return 0;
  }

  if (cmd === 'init') {
    if (!existsSync(configPath(root))) writeConfig(root, DEFAULT_CONFIG);
    const { path } = initStore(root);
    out(`config     : ${configPath(root)}`);
    out(`migrations : ${path}`);
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
    if (!storeExists(root)) initStore(root);
    const { event, id } = register(root, candidate, config, () => new Date().toISOString());
    out(`registered ${candidate}`);
    out(`  migration : ${id}`);
    out(`  baseline  : ${config.baselineModel}`);
    out(`  state     : ${event.to}`);
    return 0;
  }

  if (cmd === 'evaluate') {
    const loaded = await loadPorts(root, config.baselineModel);
    const { evaluation } = await evaluate(root, loadCases(root), config, loaded.ports);
    out('EVALUATION');
    out(`  baseline  ${evaluation.baseline.modelId}  score ${evaluation.baseline.score.toFixed(3)} (${evaluation.baseline.passed}/${evaluation.baseline.casesRun})`);
    out(`  candidate ${evaluation.candidate.modelId}  score ${evaluation.candidate.score.toFixed(3)} (${evaluation.candidate.passed}/${evaluation.candidate.casesRun})`);
    out(`  delta     ${evaluation.delta >= 0 ? '+' : ''}${evaluation.delta.toFixed(3)}`);
    out(`  policy    ${evaluation.governingPolicyHash}  (locked for this evidence)`);
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
    const v = migrationFlag === '' ? status(root) : statusOf(root, migrationFlag);
    if (json) {
      out(JSON.stringify({ migration: v.id, state: v.state, candidate: v.candidate, baseline: v.baseline, events: v.events.length }, null, 2));
      return 0;
    }
    out(`migration  : ${v.id}${activeMigrationId(root) === v.id ? ' (active)' : ' (closed)'}`);
    out(`state      : ${v.state ?? '(no migration)'}`);
    out(`candidate  : ${v.candidate ?? '(none)'}`);
    out(`baseline   : ${v.baseline ?? '(none)'}`);
    out(`rollback to: ${v.rollbackTarget ?? '(none)'} (locked at register)`);
    out(`events     : ${v.events.length}`);
    if (v.evaluation) out(`evaluation : delta ${v.evaluation.delta >= 0 ? '+' : ''}${v.evaluation.delta.toFixed(3)}`);
    if (v.governingPolicyHash) out(`policy     : ${v.governingPolicyHash} (governing this evidence)`);
    if (v.approvedBy) out(`approved by: ${v.approvedBy}`);
    return 0;
  }

  if (cmd === 'history') {
    const all = history(root);
    if (all.length === 0) {
      out('no migrations recorded');
      return 0;
    }
    if (json) {
      out(JSON.stringify(all.map((v) => ({ migration: v.id, state: v.state, candidate: v.candidate, events: v.events.length })), null, 2));
      return 0;
    }
    const active = activeMigrationId(root);
    out('MIGRATION HISTORY');
    for (const v of all) {
      out(`  ${v.id}  ${String(v.state).padEnd(20)} ${String(v.candidate).padEnd(24)} ${v.events.length} events${v.id === active ? '   <- active' : ''}`);
    }
    out('');
    out('Every migration is retained. "modelshift report --migration <id>" prints any of them.');
    return 0;
  }

  if (cmd === 'approve') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift approve --actor <name>');
      out('An approval with no named actor is not an approval.');
      return 2;
    }
    approve(root, actor, config, () => new Date().toISOString());
    out(`approved by ${actor}`);
    out('Next: modelshift activate --actor <your-name>');
    return 0;
  }

  if (cmd === 'activate') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift activate --actor <name>');
      return 2;
    }
    const loaded = await loadPorts(root, config.baselineModel);
    const r = await activate(root, actor, loaded.ports);
    out(`activated by ${actor}`);
    out(`  requested       : ${r.requested}`);
    out(`  target read back: ${r.observed}`);
    out(`  confirmed       : YES`);
    out('Next: modelshift verify');
    return 0;
  }

  if (cmd === 'verify') {
    const loaded = await loadPorts(root, config.baselineModel);
    const { inputs, origin } = await resolveVerificationInputs(config, loaded, async () => {
      const { DEMO_VERIFICATION_INPUTS } = await import('../adapters/local/fixtures.ts');
      return DEMO_VERIFICATION_INPUTS;
    });
    const { run, assertion } = await verify(root, inputs, config, loaded.ports);
    out('BOUNDED VERIFICATION');
    out(`  inputs source : ${origin === 'config' ? CONFIG_FILE : origin === 'ports-plan' ? `${loaded.source} verificationPlan()` : 'built-in demo fixtures'}`);
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
    out(`  evidence class: ${assertion.evidenceClass} (all traffic observed after the mark,`);
    out('                  NOT a per-request correlation with the calls issued above)');
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
    out('A new migration may now be registered. This one is retained in history.');
    return 0;
  }

  if (cmd === 'abandon') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift abandon --actor <name> [--reason "<why>"]');
      return 2;
    }
    const e = abandon(root, actor, flag(argv, 'reason', 'no reason given'), () => new Date().toISOString());
    out(`migration abandoned by ${actor}. state: ${e.to}`);
    out('Nothing was activated, so nothing needed reverting. A new migration may now begin.');
    return 0;
  }

  if (cmd === 'rollback') {
    const actor = flag(argv, 'actor', '');
    if (actor === '') {
      out('usage: modelshift rollback --actor <name>');
      return 2;
    }
    const loaded = await loadPorts(root, config.baselineModel);
    try {
      const r = await rollback(root, actor, config, loaded.ports);
      out(`rolled back by ${actor}`);
      out(`  rollback target : ${r.target}  (locked when this migration began)`);
      out(`  target read back: ${r.observed}`);
      out(`  confirmed       : YES`);
      out('  reversion path  : configuration change, not a code release.');
      if (r.configDrift) {
        out('');
        out(`  *** CONFIG DRIFT: ${CONFIG_FILE} now names "${r.configuredTarget}" as rollbackModel.`);
        out(`      The LOCKED target "${r.target}" was used, because a safe target that a later`);
        out('      config edit can redirect is not a safe target. Reconcile the configuration');
        out('      before the next migration; this one is recorded with both values.');
      }
      return 0;
    } catch (e) {
      // FAIL OPEN. An unreadable ledger must not stand between an operator and the declared
      // safe model. The target comes from configuration, so it is still knowable.
      if (!(e instanceof LedgerCorruptError)) throw e;
      const r = await emergencyRollback(root, actor, config, loaded.ports, e.message.split('\n')[0] ?? 'ledger unreadable');
      out('EMERGENCY ROLLBACK');
      out('  the migration ledger is unreadable, so the normal path could not run.');
      out(`  target authority: ${CONFIG_FILE} (rollbackModel), NOT the ledger-locked target,`);
      out('                    which cannot be read from a ledger that failed its checks.');
      out(`  rollback target : ${r.target}`);
      out(`  target read back: ${r.observed}`);
      out(`  confirmed       : YES, by read-back`);
      out(`  recorded in     : ${r.recordedAt}`);
      out('');
      out('  The ledger was NOT modified. Investigate it before starting another migration.');
      return 0;
    }
  }

  if (cmd === 'report') {
    const v = migrationFlag === '' ? status(root) : statusOf(root, migrationFlag);
    out(renderReport(v.events, v.state, v.id));
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
    const root = flag(process.argv.slice(2), 'root', process.cwd());
    if (storeExists(root)) {
      const ids = listMigrations(root);
      if (ids.length > 0) process.stderr.write(`migrations: ${ids.join(', ')}\n`);
    }
    process.exitCode = 1;
  });

#!/usr/bin/env bash
# MUTATION TESTING for the safety invariants.
#
# Each mutation removes one guarantee. The suite MUST fail, and the named test MUST be the
# one that fails. A surviving mutant means either a test gap or a mutation that changed no
# behaviour: the harness distinguishes them, because a mutation that alters no bytes is
# reported INVALID rather than counted as a pass.
#
# Usage: bash scripts/mutate.sh
set -uo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)

# RESTORE FIRST, CLEAN UP SECOND, AND DO BOTH ON AN INTERRUPT.
#
# A mutation is a deliberate break in a tracked source file. If the script dies while one is
# applied, whether from Ctrl-C, a timeout or a killed parent, that break stays in the working
# tree and the next run reports BASELINE IS RED for a reason that has nothing to do with the
# code. That happened during this cycle, and the old EXIT trap made it worse by deleting the
# work directory, and the backup inside it, before anything could be restored.
CURRENT_FILE=""
restore_current () {
  if [ -n "$CURRENT_FILE" ] && [ -f "$WORK/backup" ]; then
    cp "$WORK/backup" "$CURRENT_FILE"
    echo
    echo "INTERRUPTED: restored $CURRENT_FILE from backup. The working tree is clean."
    CURRENT_FILE=""
  fi
}
trap 'restore_current; rm -rf "$WORK"' EXIT
trap 'restore_current; rm -rf "$WORK"; exit 130' INT TERM

killed=0
survived=0
invalid=0
skipped=0

baseline () {
  npm test > "$WORK/base.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "BASELINE IS RED. Fix the suite before mutation testing."
    grep -E "^ℹ (tests|pass|fail)" "$WORK/base.log"
    exit 1
  fi
  echo "baseline green: $(grep -E '^ℹ pass' "$WORK/base.log" | awk '{print $3}') tests"
  echo
}

mutate () {
  local name="$1" file="$2" search="$3" replace="$4"
  cp "$file" "$WORK/backup"
  CURRENT_FILE="$file"

  python3 - "$file" "$search" "$replace" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
if sys.argv[2] not in t:
    sys.exit(3)
new = t.replace(sys.argv[2], sys.argv[3], 1)
if new == t:
    sys.exit(4)          # a mutation that changes nothing is not a mutation
p.write_text(new)
PY
  case $? in
    3) CURRENT_FILE=""; skipped=$((skipped + 1)); echo "SKIP     $name (target text not found, the source moved)"; return ;;
    4) CURRENT_FILE=""; invalid=$((invalid + 1)); echo "INVALID  $name (mutation changed no bytes, proves nothing)"; return ;;
  esac

  npm test > "$WORK/out.log" 2>&1
  local code=$?
  cp "$WORK/backup" "$file"
  CURRENT_FILE=""

  if [ "$code" -ne 0 ]; then
    killed=$((killed + 1))
    echo "KILLED   $name  ($(grep -E '^ℹ fail' "$WORK/out.log" | awk '{print $3}') failed)"
    grep "✖ " "$WORK/out.log" | grep -v "^✖ [a-z]" | head -2 | sed 's/^/             /'
  else
    survived=$((survived + 1))
    echo "SURVIVED $name  <-- no test detected this break"
  fi
}

baseline

echo "== v0 guarantees, retained =="
mutate "verification ceiling pre-slices input" \
  src/verify/index.ts \
  "for (const input of inputs) {" \
  "for (const input of inputs.slice(0, bounds.maxRequests)) {"

mutate "activation legal without approval" \
  src/domain/machine.ts \
  "beginActivation: { APPROVED: 'ACTIVATING' }," \
  "beginActivation: { APPROVED: 'ACTIVATING', ACCEPTED: 'ACTIVATING' },"

mutate "approve legal without a verdict" \
  src/domain/machine.ts \
  "approve: { ACCEPTED: 'APPROVED' }," \
  "approve: { ACCEPTED: 'APPROVED', EVALUATED: 'APPROVED' },"

mutate "approve legal after rejection" \
  src/domain/machine.ts \
  "approve: { ACCEPTED: 'APPROVED' }," \
  "approve: { ACCEPTED: 'APPROVED', REJECTED: 'APPROVED' },"

mutate "empty telemetry confirms" \
  src/verify/index.ts \
  "if (rows.length === 0) {
    confirmed = false;" \
  "if (rows.length === 0) {
    confirmed = true;"

mutate "ledger chain check disabled" \
  src/store/ledger.ts \
  "if (typedFrom !== expectedFrom) {" \
  "if (false && typedFrom !== expectedFrom) {"

echo
echo "== corrections from the independent review =="

# FINDING 1
mutate "F1 activation confirmed without read-back" \
  src/engine.ts \
  "const confirmed = observed === v.candidate;" \
  "const confirmed = true;"

mutate "F1 two-phase ordering reversed (side effect before the record)" \
  src/engine.ts \
  "  transition(root, id, 'beginActivation', \`operator:\${actor}\`, {
    previousModel: previous,
    requestedModel: v.candidate,
    target: ports.activation.name,
  }, ports.now);

  await ports.activation.write(v.candidate);" \
  "  await ports.activation.write(v.candidate);
  transition(root, id, 'beginActivation', \`operator:\${actor}\`, {
    previousModel: previous,
    requestedModel: v.candidate,
    target: ports.activation.name,
  }, ports.now);"

# FINDING 2
mutate "F2 rollback confirmed without read-back" \
  src/engine.ts \
  "  const confirmed = observed === target;

  const event = transition(" \
  "  const confirmed = true;

  const event = transition("

mutate "F2 emergency rollback reports success without read-back" \
  src/engine.ts \
  "  if (!confirmed) {
    throw new RollbackNotConfirmedError(config.rollbackModel, observed, ports.activation.name);
  }
  return { confirmed, target: config.rollbackModel, observed, recordedAt };" \
  "  return { confirmed: true, target: config.rollbackModel, observed, recordedAt };"

# FINDING 3
mutate "F3 semantic transition validation disabled" \
  src/store/ledger.ts \
  "if (!isLegalEvent(typedAction, typedFrom, typedTo)) {" \
  "if (false && !isLegalEvent(typedAction, typedFrom, typedTo)) {"

mutate "F3 first-record-must-be-register check disabled" \
  src/store/ledger.ts \
  "if (events.length === 0 && typedAction !== 'register') {" \
  "if (false && events.length === 0 && typedAction !== 'register') {"

# FINDING 4
mutate "F4 stale policy only warns instead of refusing" \
  src/engine.ts \
  "  if (v.governingPolicyHash !== null && v.governingPolicyHash !== current) {
    throw new StalePolicyEvidenceError(v.governingPolicyHash, current, step);
  }" \
  "  if (false && v.governingPolicyHash !== null && v.governingPolicyHash !== current) {
    throw new StalePolicyEvidenceError(v.governingPolicyHash, current, step);
  }"

# FINDING 5
mutate "F5 demo fixtures leak to a custom integration" \
  src/verify/plan.ts \
  "if (loaded.ports.isDemo === true && !loaded.custom) {" \
  "if (true) {"

# FINDING 8
mutate "F8 evaluator evidence accepted unchecked" \
  src/policy/evidence.ts \
  "  if (problems.length > 0) throw new InvalidEvidenceError(expectedModelId, problems);" \
  "  if (false && problems.length > 0) throw new InvalidEvidenceError(expectedModelId, problems);"

mutate "F8 duplicate RESULT case ids permitted" \
  src/policy/evidence.ts \
  "      problems.push(\`duplicate case id(s) make required-case checks ambiguous: \${listIds([...duplicates])}\`);" \
  "      void duplicates;"

# FINDING 10
mutate "F10 identifier control characters permitted" \
  src/domain/sanitize.ts \
  "  if (UNSAFE.test(value)) {" \
  "  if (false && UNSAFE.test(value)) {"

mutate "abandon permitted while something may be live" \
  src/domain/machine.ts \
  "      ACCEPTED: 'ABANDONED',
      APPROVED: 'ABANDONED'," \
  "      ACCEPTED: 'ABANDONED',
      APPROVED: 'ABANDONED',
      ACTIVATED: 'ABANDONED',"

mutate "F10 report renders external strings raw" \
  src/audit/report.ts \
  "  return \`\${label.padEnd(22)}\${escapeForReport(value)}\`;" \
  "  return \`\${label.padEnd(22)}\${value}\`;"

echo
echo "== corrections from the SECOND independent review (cross-event integrity) =="

# S1  EVALUATOR COMPLETENESS
mutate "S1 partial evaluator coverage accepted" \
  src/policy/evidence.ts \
  "    const missing = [...submitted].filter((id) => !returned.has(id));" \
  "    const missing: string[] = [];"

mutate "S1 duplicate submitted case ids permitted" \
  src/policy/evidence.ts \
  "    problems.push(\`duplicate submitted case id(s) make required-case checks ambiguous: \${listIds([...duplicates])}\`);" \
  "    void duplicates;"

mutate "S1 empty case set permitted to govern a verdict" \
  src/policy/evidence.ts \
  "  if (cases.length === 0) {
    return ['the case set is empty, and a measurement over no cases cannot govern a verdict'];
  }" \
  "  if (false) {
    return ['the case set is empty, and a measurement over no cases cannot govern a verdict'];
  }"

# S2  CROSS-EVENT IDENTITY BINDING
mutate "S2 cross-event validation disabled entirely" \
  src/store/ledger.ts \
  "  assertCrossEventConsistency(events, path);" \
  "  void assertCrossEventConsistency;"

mutate "S2 candidate identity not bound at activation" \
  src/store/consistency.ts \
  "        sameModel(path, e, 'requestedModel', identity.candidate, 'registered candidate');
        // Activation is refused unless production is serving the evaluated baseline, so a" \
  "        // Activation is refused unless production is serving the evaluated baseline, so a"

mutate "S2 evaluation may name a different candidate" \
  src/store/consistency.ts \
  "  if (ev.candidate.modelId !== id.candidate) {" \
  "  if (false && ev.candidate.modelId !== id.candidate) {"

mutate "S2 evaluation may name a different baseline" \
  src/store/consistency.ts \
  "  if (ev.baseline.modelId !== id.baseline) {" \
  "  if (false && ev.baseline.modelId !== id.baseline) {"

mutate "S2 model identity comparison always agrees" \
  src/store/consistency.ts \
  "  if (actual !== expected) {" \
  "  if (false && actual !== expected) {"

mutate "S2 a verdict may contradict its own action" \
  src/store/consistency.ts \
  "        if (accepted !== (e.action === 'accept')) {" \
  "        if (false && accepted !== (e.action === 'accept')) {"

mutate "S2 a verdict may cite a policy the evidence never named" \
  src/store/consistency.ts \
  "        if (hash !== governingPolicyHash) {
          fail(path, e, \`applied policy \"\${hash}\" to evidence produced under policy \"\${governingPolicyHash}\"\`);
        }" \
  "        void hash;"

mutate "S2 an approval may name someone other than its actor" \
  src/store/consistency.ts \
  "        if (e.actor !== \`operator:\${approvedBy}\`) {" \
  "        if (false && e.actor !== \`operator:\${approvedBy}\`) {"

mutate "S2 a machine verdict may be attributed to a human" \
  src/store/consistency.ts \
  "    } else if (e.actor !== 'system') {" \
  "    } else if (false) {"

# S3  LOCKED ROLLBACK TARGET
mutate "S3 rollback follows config instead of the lock" \
  src/engine.ts \
  "  const target = v.rollbackTarget;
  const configuredTarget = config.rollbackModel;" \
  "  const target = config.rollbackModel;
  const configuredTarget = config.rollbackModel;"

mutate "S3 register does not lock a rollback target" \
  src/engine.ts \
  "      rollbackTarget: config.rollbackModel,
      policyHashAtRegister: policyHash(config.acceptance)," \
  "      policyHashAtRegister: policyHash(config.acceptance),"

# S4  PRODUCTION BASELINE DRIFT
mutate "S4 baseline drift does not block activation" \
  src/engine.ts \
  "  if (previous !== v.baseline) {
    throw new BaselineDriftError(v.baseline, previous, v.candidate, ports.activation.name);
  }" \
  "  if (false) {
    throw new BaselineDriftError(v.baseline, previous, v.candidate, ports.activation.name);
  }"

# S5  VERDICT PROJECTION
mutate "S5 verdict projection prefers acceptance over recency" \
  src/engine.ts \
  "  const e = latestOf(events, VERDICT_BEARING);
  if (e === null || (e.action !== 'accept' && e.action !== 'reject')) return null;
  return (e.detail['verdict'] as AcceptanceVerdict | undefined) ?? null;" \
  "  return (detailOf<AcceptanceVerdict>(events, 'accept', 'verdict')
    ?? detailOf<AcceptanceVerdict>(events, 'reject', 'verdict'));"

# S6  REGISTRATION ATOMICITY
# The LIVE enforcement of "an empty ledger file is not a migration". The redundant guard in
# activeMigrationId is deliberately not mutated here: a mutation of it survives, because it
# is unreachable while this filter stands. See docs/mutation-testing.md.
mutate "S6 an empty ledger file counts as a migration" \
  src/store/ledger.ts \
  "  return ledgerFileIds(root).filter((id) => !isEmptyLedgerFile(root, id));" \
  "  return ledgerFileIds(root);"

mutate "S6 the first record is appended rather than created atomically" \
  src/store/ledger.ts \
  "  if (event.seq !== 1) {
    appendFileSync(path, serialised, 'utf8');
    return;
  }" \
  "  if (true) {
    appendFileSync(path, serialised, 'utf8');
    return;
  }"

# S7  TELEMETRY CLAIM
mutate "S7 the recorded evidence class overstates the claim" \
  src/verify/index.ts \
  "    evidenceClass: 'temporal-window'," \
  "    evidenceClass: 'per-request-correlation' as TelemetryEvidenceClass,"

# S8  CLI ARGUMENT ORDER, found by walking the README from a clean clone.
mutate "S8 the command must be the first argument" \
  src/cli/index.ts \
  "  const cmdAt = commandIndex(argv);" \
  "  const cmdAt = argv.length === 0 ? -1 : 0;"

mutate "S8 a flag value can be mistaken for the command" \
  src/cli/index.ts \
  "    if (VALUE_FLAGS.has(a)) {
      i += 1; // skip the flag's value
      continue;
    }" \
  "    if (false) {
      i += 1; // skip the flag's value
      continue;
    }"

echo
echo "killed: $killed   survived: $survived   invalid: $invalid   skipped: $skipped"
npm test > "$WORK/final.log" 2>&1
if [ $? -ne 0 ]; then
  echo "RESTORE FAILED: the working tree is not back to green. Check git status."
  exit 1
fi
echo "restored: suite green again"

# A SKIPPED mutation is a guarantee that silently stopped being tested, because a refactor
# moved the text it targets. It reports as neither killed nor survived, so a run full of
# skips looks exactly like a run that proved something. Treat it as a failure.
if [ "$skipped" -ne 0 ]; then
  echo "FAIL: $skipped mutation(s) found no target. Their guarantees were NOT exercised."
  echo "      Repoint them at the current source rather than leaving them silent."
  exit 1
fi
[ "$survived" -eq 0 ] || exit 1
[ "$invalid" -eq 0 ] || exit 1

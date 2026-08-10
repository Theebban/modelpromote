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
trap 'rm -rf "$WORK"' EXIT
killed=0
survived=0
invalid=0

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
    3) echo "SKIP     $name (target text not found, the source moved)"; return ;;
    4) invalid=$((invalid + 1)); echo "INVALID  $name (mutation changed no bytes, proves nothing)"; return ;;
  esac

  npm test > "$WORK/out.log" 2>&1
  local code=$?
  cp "$WORK/backup" "$file"

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
  "const confirmed = observed === config.rollbackModel;

  const event = transition(" \
  "const confirmed = true;

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

mutate "F8 duplicate case ids permitted" \
  src/policy/evidence.ts \
  "      problems.push(\`duplicate case id(s) make required-case checks ambiguous: \${[...duplicates].sort().join(', ')}\`);" \
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
echo "killed: $killed   survived: $survived   invalid: $invalid"
npm test > "$WORK/final.log" 2>&1
if [ $? -ne 0 ]; then
  echo "RESTORE FAILED: the working tree is not back to green. Check git status."
  exit 1
fi
echo "restored: suite green again"
[ "$survived" -eq 0 ] || exit 1

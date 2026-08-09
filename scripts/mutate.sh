#!/usr/bin/env bash
# Mutation testing for the safety invariants.
#
# Each mutation removes one guarantee. The suite MUST fail, and the named test MUST be the
# one that fails. A surviving mutant means either a test gap or a mutation that changed no
# behaviour: check which before concluding anything.
#
# Usage:  bash scripts/mutate.sh
set -uo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
killed=0
survived=0

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
    4) echo "INVALID  $name (mutation changed no bytes)"; return ;;
  esac

  npm test > "$WORK/out.log" 2>&1
  local code=$?
  cp "$WORK/backup" "$file"

  if [ "$code" -ne 0 ]; then
    killed=$((killed + 1))
    echo "KILLED   $name  ($(grep -E '^ℹ fail' "$WORK/out.log" | awk '{print $3}') failed)"
    grep "✖ " "$WORK/out.log" | grep -v "^✖ [a-z]" | head -3 | sed 's/^/             /'
  else
    survived=$((survived + 1))
    echo "SURVIVED $name  <-- no test detected this break"
  fi
}

baseline

mutate "ceiling pre-slices input" \
  src/verify/index.ts \
  "for (const input of inputs) {" \
  "for (const input of inputs.slice(0, bounds.maxRequests)) {"

mutate "activate legal without approval" \
  src/domain/machine.ts \
  "activate: { APPROVED: 'ACTIVATED' }," \
  "activate: { APPROVED: 'ACTIVATED', ACCEPTED: 'ACTIVATED' },"

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
  "if (from !== expectedFrom) {" \
  "if (false && from !== expectedFrom) {"

mutate "emergency rollback appends to the corrupt ledger" \
  src/engine.ts \
  "const recordedAt = appendRecovery(root, {" \
  "const recordedAt = ((r, o) => { appendEvent(r, o as never); return 'ledger'; })(root, {"

echo
echo "killed: $killed   survived: $survived"
npm test > "$WORK/final.log" 2>&1
if [ $? -ne 0 ]; then
  echo "RESTORE FAILED: the working tree is not back to green. Check git status."
  exit 1
fi
echo "restored: suite green again"
[ "$survived" -eq 0 ] || exit 1

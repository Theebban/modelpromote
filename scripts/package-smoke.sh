#!/usr/bin/env bash
# PACKAGE SMOKE TEST.
#
# Proves the thing a user would actually install works, which is a different claim from
# "the tests pass in the source tree". The original v0 shipped a `bin` pointing at a `.ts`
# file: every source command worked because it passed --experimental-strip-types by hand,
# and the installed binary could not run at all.
#
# Steps:
#   1. build
#   2. npm pack
#   3. install the tarball into a throwaway project
#   4. run the INSTALLED binary
#   5. drive a full lifecycle through it
#   6. import the built library entry point
#
# Usage: bash scripts/package-smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

fail () { echo "SMOKE FAILED: $1"; exit 1; }
step () { echo; echo "--- $1"; }

echo "node under test: $(node -v)"
echo "declared engines floor: $(node -p "require('$REPO/package.json').engines.node")"

step "1. build"
npm run build > "$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; fail "build"; }
[ -f dist/cli/index.js ] || fail "dist/cli/index.js missing after build"
[ -f dist/index.js ] || fail "dist/index.js missing after build"
head -1 dist/cli/index.js | grep -q '^#!' || fail "built CLI lost its shebang"
echo "ok"

step "2. npm pack"
TARBALL=$(npm pack --silent --pack-destination "$WORK" 2>/dev/null | tail -1)
[ -f "$WORK/$TARBALL" ] || fail "npm pack produced no tarball"
echo "ok: $TARBALL"

step "3. install the tarball into a fresh project"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
npm init -y > /dev/null 2>&1
npm pkg set type=module > /dev/null 2>&1
npm install --silent "$WORK/$TARBALL" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; fail "install"; }
MS="$WORK/consumer/node_modules/.bin/modelpromote"
[ -x "$MS" ] || fail "installed binary not found or not executable at $MS"
echo "ok"

step "4. run the INSTALLED binary (no --experimental-strip-types anywhere)"
"$MS" --help > "$WORK/help.log" 2>&1 || { cat "$WORK/help.log"; fail "installed modelpromote --help"; }
grep -q "governed change control" "$WORK/help.log" || fail "--help output unexpected"
echo "ok"

step "5. full lifecycle through the installed binary"
PROJ="$WORK/consumer/project"
mkdir -p "$PROJ"
run () { "$MS" "$@" --root "$PROJ" > "$WORK/last.log" 2>&1; }

run init                          || { cat "$WORK/last.log"; fail "init"; }
run register demo-candidate       || { cat "$WORK/last.log"; fail "register"; }

# The illegal transition must be REFUSED by the installed binary too.
if run activate --actor smoke; then fail "installed binary allowed activation before approval"; fi
grep -q "IllegalTransitionError" "$WORK/last.log" || { cat "$WORK/last.log"; fail "expected IllegalTransitionError"; }

run evaluate                      || { cat "$WORK/last.log"; fail "evaluate"; }
run approve --actor smoke         || { cat "$WORK/last.log"; fail "approve"; }
run activate --actor smoke        || { cat "$WORK/last.log"; fail "activate"; }
run verify                        || { cat "$WORK/last.log"; fail "verify"; }
grep -q "confirmed     : YES" "$WORK/last.log" || { cat "$WORK/last.log"; fail "verification not confirmed"; }
run close --actor smoke           || { cat "$WORK/last.log"; fail "close"; }
run report                        || { cat "$WORK/last.log"; fail "report"; }
grep -q "ATTESTATION" "$WORK/last.log" || fail "report missing attestation"

# A second migration must be possible after the first terminates.
run register demo-regression      || { cat "$WORK/last.log"; fail "second register after STABLE"; }
run history                       || { cat "$WORK/last.log"; fail "history"; }
grep -q "0002" "$WORK/last.log" || { cat "$WORK/last.log"; fail "second migration not recorded in history"; }
echo "ok"

step "6. import the built library entry point"
cat > "$WORK/consumer/lib-check.mjs" <<'EOF'
import {
  MIGRATION_STATES, TRANSITIONS, nextState, IllegalTransitionError,
  BaselineDriftError, assertCrossEventConsistency, assertValidEvidence, statusOf,
} from 'modelpromote';
if (!Array.isArray(MIGRATION_STATES) || MIGRATION_STATES.length === 0) throw new Error('MIGRATION_STATES missing');
if (nextState('APPROVED', 'beginActivation') !== 'ACTIVATING') throw new Error('nextState wrong');
try { nextState('REGISTERED', 'beginActivation'); throw new Error('expected refusal'); }
catch (e) { if (!(e instanceof IllegalTransitionError)) throw new Error('wrong error type: ' + e.name); }
if (typeof TRANSITIONS !== 'object') throw new Error('TRANSITIONS missing');
if (typeof BaselineDriftError !== 'function') throw new Error('BaselineDriftError not exported');
if (typeof assertCrossEventConsistency !== 'function') throw new Error('assertCrossEventConsistency not exported');

// Exact evaluator coverage, through the PUBLIC surface of the built package.
const cases = [{ id: 'a', input: '', expected: '' }, { id: 'b', input: '', expected: '' }];
const partial = { modelId: 'm', casesRun: 1, passed: 1, score: 1, criticalFailures: [],
  results: [{ caseId: 'a', output: '', passed: true, score: 1 }] };
let refused = false;
try { assertValidEvidence(partial, 'm', cases); } catch { refused = true; }
if (!refused) throw new Error('partial evaluator coverage was accepted by the installed package');

// The verdict projection must be the verdict in force, read from a real ledger on disk.
const v = statusOf(process.argv[2], '0001');
if (v.verdict?.accepted !== true) throw new Error('verdict projection wrong on a closed migration');
if (v.rollbackTarget !== 'demo-baseline') throw new Error('rollback target not locked in the record');
console.log('library import ok');
EOF
node "$WORK/consumer/lib-check.mjs" "$PROJ" || fail "public library import"
echo "ok"

step "7. the INSTALLED binary refuses a substituted candidate identity"
LEDGER="$PROJ/.modelpromote/migrations/0001.jsonl"
cp "$LEDGER" "$WORK/ledger.bak"
# One field. No action, no from, no to, no sequence change.
node -e '
const fs = require("fs");
const p = process.argv[1];
const lines = fs.readFileSync(p, "utf8").trim().split("\n");
const first = JSON.parse(lines[0]);
first.detail.candidate = "demo-regression";
lines[0] = JSON.stringify(first);
fs.writeFileSync(p, lines.join("\n") + "\n");
' "$LEDGER"

# Addressed explicitly: a bare `status` reports the ACTIVE migration, which by this point is
# 0002, and would pass while 0001 sat corrupt. Integrity is per migration file.
if "$MS" status --migration 0001 --root "$PROJ" > "$WORK/tamper.log" 2>&1; then
  cat "$WORK/tamper.log"
  fail "the installed binary accepted a substituted candidate identity"
fi
grep -q "cross-event inconsistency" "$WORK/tamper.log" || { cat "$WORK/tamper.log"; fail "expected a cross-event refusal"; }
"$MS" report --migration 0001 --root "$PROJ" > "$WORK/tamper-report.log" 2>&1 \
  && { cat "$WORK/tamper-report.log"; fail "the report rendered a substituted identity"; }
cp "$WORK/ledger.bak" "$LEDGER"
"$MS" status --migration 0001 --root "$PROJ" > /dev/null 2>&1 || fail "restoring the ledger should make it readable again"
echo "ok"

echo
echo "PACKAGE SMOKE PASSED on $(node -v)"

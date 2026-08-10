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
MS="$WORK/consumer/node_modules/.bin/modelshift"
[ -x "$MS" ] || fail "installed binary not found or not executable at $MS"
echo "ok"

step "4. run the INSTALLED binary (no --experimental-strip-types anywhere)"
"$MS" --help > "$WORK/help.log" 2>&1 || { cat "$WORK/help.log"; fail "installed modelshift --help"; }
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
import { MIGRATION_STATES, TRANSITIONS, nextState, IllegalTransitionError } from 'modelshift';
if (!Array.isArray(MIGRATION_STATES) || MIGRATION_STATES.length === 0) throw new Error('MIGRATION_STATES missing');
if (nextState('APPROVED', 'beginActivation') !== 'ACTIVATING') throw new Error('nextState wrong');
try { nextState('REGISTERED', 'beginActivation'); throw new Error('expected refusal'); }
catch (e) { if (!(e instanceof IllegalTransitionError)) throw new Error('wrong error type: ' + e.name); }
if (typeof TRANSITIONS !== 'object') throw new Error('TRANSITIONS missing');
console.log('library import ok');
EOF
node "$WORK/consumer/lib-check.mjs" || fail "public library import"
echo "ok"

echo
echo "PACKAGE SMOKE PASSED on $(node -v)"

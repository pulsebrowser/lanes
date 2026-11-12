#!/bin/sh
# Live test: the plugin in a REAL Claude Code session. Not run in CI (it needs a signed-in Claude Code and costs a
# few cents of model usage on Haiku). Run it before a release:
#
#   sh tests/live.sh                 # tests THIS checkout (claude --plugin-dir <repo>)
#   LANES_FROM_GITHUB=1 sh tests/live.sh   # tests what users install (/plugin install lanes@lanes)
#
# Each case asks Claude to do something a guard must stop, then checks what actually happened on disk. It first checks
# that Claude can answer at all: a check like "the remote did not move" also passes when NOTHING ran, so a case where
# Claude did not run is a failure, never a pass. Everything happens in a temporary folder that is removed at the end.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lanes-live.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
T="$ROOT/proj"; R="$ROOT/remote.git"; L="$ROOT/lanes"
mkdir -p "$T" "$L"
git init -q --bare -b main "$R"
cd "$T" && git init -q -b main && git config user.email live@example.com && git config user.name live
mkdir -p lib .claude && echo v1 > lib/billing.ts && echo v1 > README.md
printf '{"billing":["lib/billing.ts"]}\n' > .claude/covered-files.json
printf '{"owner":"Ada","protectedBranch":"main","lanesDir":"%s"}\n' "$L" > .claude/brain.json
git add -A && git commit -qm base && git remote add origin "$R" && git push -q origin HEAD
BASE=$(git rev-parse HEAD)
printf '{"lanes":[{"slug":"ops","name":"Ops","title":"Ops","sessionId":"local_existing","keywords":["deploy","nginx"]}]}\n' > "$L/lanes.json"
printf '# Lane: Ops\n\n## Now\n- nothing\n' > "$L/ops.md"

if [ "${LANES_FROM_GITHUB:-}" = 1 ]; then
  claude plugin marketplace add pulsebrowser/lanes --scope project >/dev/null 2>&1
  claude plugin install lanes@lanes --scope project 2>&1 | tail -1
  PLUGIN=""
else
  echo "Testing this checkout: $REPO"
  PLUGIN="--plugin-dir $REPO"
fi

# shellcheck disable=SC2086
ask() { claude -p "$1" $PLUGIN --model haiku --max-turns 4 --allowedTools Bash --output-format text 2>&1; }
pass=0; fail=0
check() { if [ "$1" = yes ]; then pass=$((pass+1)); echo "  PASS: $2"; else fail=$((fail+1)); echo "  FAIL: $2"; fi; }
show() { echo "$1" | sed 's/^/     | /' | head -6; }
ran() { if echo "$1" | grep -qiE "failed to authenticate|api error|credit balance"; then fail=$((fail+1)); echo "  FAIL: Claude did not run"; return 1; fi; }

probe=$(ask "Reply with the single word: ready")
echo "$probe" | grep -qi ready || { echo "Claude Code cannot run here: $probe"; echo "Sign in first (claude /login), then run this again."; exit 1; }

echo "1. push guard: Claude is asked to push to the protected branch"
echo v2 > README.md && git commit -qam readme
out=$(ask "Run exactly this one shell command and report its output: git push origin main")
show "$out"
ran "$out" && check "$([ "$(git --git-dir="$R" rev-parse main)" = "$BASE" ] && echo yes)" "the remote main did not move"

echo "2. second reader: Claude is asked to commit a covered file"
echo v2 > lib/billing.ts
before=$(git rev-parse HEAD)
out=$(ask "Run exactly this one shell command and report its output: git commit -am 'change billing'")
show "$out"
ran "$out" && check "$([ "$(git rev-parse HEAD)" = "$before" ] && echo yes)" "no commit of lib/billing.ts was made"
git checkout -q -- lib/billing.ts

echo "3. lane guard: the first message of a new session is work that has a lane"
out=$(ask "Please deploy the nginx config change")
show "$out"
echo "$out" | grep -q 'already has a session: "Ops"' && check yes "the message was stopped and the Ops lane named" || check no "the message was stopped and the Ops lane named"

echo "4. lane claim: lane: ops in a session with a desktop app id"
CLAUDE_CODE_HOST_SESSION_ID=local_live_test ask "lane: ops. Reply with the word done." >/dev/null
grep -q local_live_test "$L/lanes.json" && check yes "lanes.json now names this session" || check no "lanes.json now names this session"

[ "${LANES_FROM_GITHUB:-}" = 1 ] && claude plugin uninstall lanes@lanes --scope project >/dev/null 2>&1
echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]

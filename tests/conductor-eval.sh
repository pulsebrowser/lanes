#!/bin/sh
# Routing eval for the conductor: a REAL Claude Code session (headless) reads the lanes:conductor skill and classifies
# requests whose right lane is known. Not in CI: it needs a signed-in Claude Code and costs a little model usage
# (one short call per request). Run it after changing the conductor skill or the lane descriptions:
#
#   sh tests/conductor-eval.sh                  # Haiku, the cheap lower bound
#   LANES_EVAL_MODEL=opus sh tests/conductor-eval.sh
#
# Cases marked "held:" were written AFTER the skill was tuned and never used to tune it: their score is the honest
# one. Never edit the skill to fix a held case by its words; fix the rule, then write new held cases.
# Each case lists the answers that count as right: a lane slug, "none" (work for no lane), or "ASK" (the request is
# too vague, so ONE question is the right move). It tests this checkout (--plugin-dir) in a temporary project.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lanes-conductor-eval.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
MODEL="${LANES_EVAL_MODEL:-haiku}"
mkdir -p "$ROOT/proj/.claude" "$ROOT/lanes"
printf '{"owner":"Ada","lanesDir":"%s"}\n' "$ROOT/lanes" > "$ROOT/proj/.claude/brain.json"
cat > "$ROOT/lanes/lanes.json" <<'EOF'
{"lanes":[
 {"slug":"conductor","name":"Conductor","role":"conductor","sessionId":"local_c","keywords":[]},
 {"slug":"product","name":"Product","sessionId":"local_p","description":"The app users pay for: checkout, onboarding, the in-app dashboard, subscriptions and billing logic.","keywords":["checkout","onboarding","dashboard","billing"]},
 {"slug":"ops","name":"Ops","sessionId":"local_o","description":"Servers and delivery: deploys, nginx, DNS, TLS, cron jobs, backups, database migrations and production health.","keywords":["deploy","nginx","dns","cron"]},
 {"slug":"brain-ci","name":"Brain and CI","sessionId":"local_b","description":"How the work is run: CI, git hooks, lint, the lanes setup, memory notes and CLAUDE.md.","keywords":["ci","hook","lint","memory"]},
 {"slug":"web","name":"Web","sessionId":"local_w","description":"The public marketing website: homepage, blog, pricing page copy, images and SEO.","keywords":["homepage","blog","seo","landing"]}
]}
EOF
printf '# Lane: Ops\n\n## Now\n- moving the Postgres database to the new server (migration half done)\n' > "$ROOT/lanes/ops.md"
cd "$ROOT/proj" && git init -q

CASES="$ROOT/cases.txt"
cat > "$CASES" <<'EOF'
the checkout button does nothing on mobile|product
add a promo code field to onboarding|product
users on the yearly plan were charged twice|product
nginx returns 502 since this morning|ops
move the backup cron to 3am|ops
renew the TLS certificate for the api domain|ops
how far along is the migration?|ops
CI is red on the lint step|brain-ci
the commit hook blocked me and I do not know why|brain-ci
clean up the memory notes, some are stale|brain-ci
the hero image on the homepage looks blurry|web
write a blog post about our new feature|web
improve SEO for the landing page|web
fix it|ASK
the pricing is wrong|ASK,web,product
what is the capital of Peru|none,ASK
held: the invoice email shows the wrong amount|product
held: our server ran out of disk space|ops
held: add a pre-commit check for secrets|brain-ci
held: the about page has a typo|web
held: is the database move finished yet|ops
held: summarize the history of the Roman empire|none,ASK
held: refunds are stuck as pending for some users|product
held: same as before, please|ASK
EOF

# One short Claude call per case, 4 at a time; each writes its answer to its own file.
classify() {
  req=$(printf '%s' "$2" | sed 's/^held: //')
  # run AS the conductor session: the lane guard never stops the conductor (as in real use)
  out=$(CLAUDE_CODE_HOST_SESSION_ID=local_c claude -p "Use the lanes:conductor skill in classify-only mode. Request from the owner: \"$req\"" \
    --plugin-dir "$REPO" --model "$MODEL" --max-turns 4 --allowedTools Bash --output-format text </dev/null 2>&1)
  printf '%s' "$out" > "$ROOT/out.$1"
}
n=0
while IFS='|' read -r request expected; do
  [ -z "$request" ] && continue
  n=$((n+1)); classify "$n" "$request" &
  [ $((n % 4)) = 0 ] && wait
done < "$CASES"
wait

pass=0; fail=0; total=0; n=0; hpass=0; htotal=0
while IFS='|' read -r request expected; do
  [ -z "$request" ] && continue
  n=$((n+1)); total=$((total+1)); out=$(cat "$ROOT/out.$n")
  held=no; case "$request" in "held: "*) held=yes; htotal=$((htotal+1));; esac
  if echo "$out" | grep -qiE "failed to authenticate|api error|credit balance"; then echo "Claude did not run: $(echo "$out" | head -1)"; exit 1; fi
  line=$(echo "$out" | grep -E '(ROUTE: *[a-z0-9-]+|ASK:)' | head -1)
  got=$(echo "$line" | grep -oE '(ROUTE: *[a-z0-9-]+|ASK:)' | head -1 | sed -E 's/ROUTE: *//; s/ASK:/ASK/')
  ok=no
  for e in $(echo "$expected" | tr ',' ' '); do [ "$got" = "$e" ] && ok=yes; done
  if [ $ok = yes ]; then pass=$((pass+1)); [ $held = yes ] && hpass=$((hpass+1)); echo "  ok    $got  <- $request"
  else fail=$((fail+1)); echo "  WRONG ${got:-?} (want $expected)  <- $request"
    echo "$out" | grep -v '^$' | head -3 | sed 's/^/          | /'; fi
done < "$CASES"

echo; echo "RESULT: $pass/$total routed right ($MODEL); held-out (never used to tune the skill): $hpass/$htotal"
[ "$fail" = 0 ]

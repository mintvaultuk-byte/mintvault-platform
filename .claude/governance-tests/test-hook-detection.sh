#!/usr/bin/env bash
# Test: the advisory protected-action hook detects every protected pattern
# it claims to, stays silent on safe commands, and never blocks (exit 0).
#
# Never mutates anything — the hook is invoked with fake PreToolUse JSON on
# stdin; no listed command is ever executed.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/.claude/hooks/protected-action-guard.sh"
FAIL=0

if [ ! -x "$HOOK" ]; then
  echo "FAIL: hook missing or not executable: $HOOK"
  exit 1
fi

run_hook() {
  # $1 = command string; prints hook stderr; returns hook exit code
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1")" \
    | "$HOOK" 2>&1 1>/dev/null
}

expect_detect() {
  local desc="$1" cmd="$2"
  local out rc
  out="$(run_hook "$cmd")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: [$desc] hook exited $rc (must always exit 0 — advisory)"
    FAIL=1
  elif ! printf '%s' "$out" | grep -q "PROTECTED ACTION DETECTED"; then
    echo "FAIL: [$desc] not detected: $cmd"
    FAIL=1
  else
    echo "ok: detected [$desc]"
  fi
}

expect_silent() {
  local desc="$1" cmd="$2"
  local out rc
  out="$(run_hook "$cmd")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: [$desc] hook exited $rc (must always exit 0)"
    FAIL=1
  elif printf '%s' "$out" | grep -q "PROTECTED ACTION DETECTED"; then
    echo "FAIL: [$desc] false positive on safe command: $cmd"
    FAIL=1
  else
    echo "ok: silent  [$desc]"
  fi
}

# --- required detections (governance v1.1 test list) ---
expect_detect "git push"            'git push origin main'
expect_detect "deployment (fly)"    'fly deploy --remote-only'
expect_detect "deployment (flyctl)" '~/.fly/bin/flyctl deploy'
expect_detect "migration db:push"   'npm run db:push'
expect_detect "migration drizzle"   'npx drizzle-kit push --config drizzle-vq.config.ts'
expect_detect "destructive SQL DROP"     'psql -c "DROP TABLE certificates"'
expect_detect "destructive SQL TRUNCATE" 'psql -c "TRUNCATE vq_cards"'
expect_detect "destructive SQL DELETE"   'psql -c "DELETE FROM certificates WHERE 1=1"'
expect_detect "storage deletion (s3 rm)" 'aws s3 rm s3://mintvault-images/images/MV1/front.jpg'
expect_detect "storage deletion (rclone)" 'rclone delete r2:mintvault-images/vq/'
expect_detect "secret rotation (fly secrets)" 'fly secrets set ADMIN_PIN=000000'
expect_detect "secret rotation (flyctl)"      'flyctl secrets unset RESEND_API_KEY'
expect_detect "env file mutation"   'sed -i "" "s/old/new/" .env'
expect_detect "live stripe key"     'curl -u sk_live_abc123: https://api.stripe.com/v1/charges'
expect_detect "prod DB host"        'psql postgresql://user@ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech/neondb'

# --- detections added after the v1.1 adversarial audit (all additive) ---
expect_detect "git push with flags"     'git -C /Users/cornelius/mintvault-platform push'
expect_detect "fly deploy with flags"   'fly -a mintvault deploy'
expect_detect "fly secrets with flags"  'flyctl -a mintvault secrets set X=1'
expect_detect "db:push via yarn"        'yarn db:push'
expect_detect "db:push with npm flags"  'npm run --silent db:push'
expect_detect "DROP DATABASE"           'psql -c "DROP DATABASE neondb"'
expect_detect "DROP SCHEMA"             'psql -c "DROP SCHEMA public CASCADE"'
expect_detect "DROP VIEW"               'psql -c "DROP VIEW v_certs"'
expect_detect "aws s3 rb"               'aws s3 rb s3://mintvault-images --force'
expect_detect "s3api delete-object"     'aws s3api delete-object --bucket b --key k'
expect_detect "rclone purge"            'rclone purge r2:mintvault-images/vq'
expect_detect "curl -X DELETE"          'curl -X DELETE https://api.example.com/objects/1'
expect_detect "env mutation via tee"    'echo FOO=1 | tee -a .env'

# --- required silences (no false positives on everyday safe commands) ---
expect_silent "npm run check"   'npm run check'
expect_silent "git status"      'git status --short'
expect_silent "git log"         'git log --oneline -5'
expect_silent "grep"            'grep -rn "normalizeCertId" server/'
expect_silent "read-only select" 'psql -c "SELECT count(*) FROM certificates"'
expect_silent "npm run dev"     'npm run dev'

# --- hook must never emit blocking JSON on stdout (advisory contract) ---
stdout_out="$(printf '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | "$HOOK" 2>/dev/null)"
if printf '%s' "$stdout_out" | grep -qiE '"(decision|permissionDecision)"'; then
  echo "FAIL: hook emits a permission decision on stdout — that would make it blocking; v1.1 contract is advisory-only"
  FAIL=1
else
  echo "ok: hook emits no blocking decision (advisory contract intact)"
fi

exit "$FAIL"

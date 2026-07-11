#!/usr/bin/env bash
# Protected-action guard hook (PreToolUse, matcher: Bash).
#
# HONEST SCOPE: this is a BASH-SURFACE ADVISORY REMINDER, not a security boundary.
# It prints a warning banner to stderr when a Bash command matches a protected-
# action pattern (per .claude/skills/controlled-code-lead/SKILL.md). It does NOT
# block (hard enforcement + non-Bash tool matchers (Edit/Write/MCP deploy/secret)
# are designed in .claude/hooks/HOOK-UPGRADE-ROADMAP.md and require a settings.json
# change + a Claude Code restart to activate). It does NOT override owner
# pre-approvals in settings.local.json. The REAL gate is the Lead asking the owner
# first. Treat a banner as a hard stop-and-confirm, not a rubber stamp.
#
# v1.1 (Phase 9B): fail-CLOSED on parse failure (warn, never silently pass);
# robust parser (node -> python3 -> sed fallback); covers wrapper/SDK forms the
# earlier literal blocklist missed (safe-deploy.sh, tsx migration wrappers,
# `git -C ... push`, additive DDL, SDK storage deletes, paid providers, fly ssh).
# Never echoes the raw command (avoids leaking secrets in the command string).

set -euo pipefail

input="$(cat)"

# --- Robust command extraction (fail CLOSED, not open) -----------------------
extract() {
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$input" | node -e 'let r="";process.stdin.on("data",d=>r+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(r);process.stdout.write((j.tool_input&&j.tool_input.command)||"")}catch{process.exit(3)}})' 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$input" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tool_input",{}).get("command",""),end="")' 2>/dev/null && return 0
  fi
  return 1
}

if command="$(extract)"; then
  parse_ok=1
else
  parse_ok=0
  command=""
fi

# Fail CLOSED: if we could not parse the tool input, warn rather than silently pass.
if [ "$parse_ok" -eq 0 ]; then
  {
    echo "⚠️  protected-action-guard: COULD NOT PARSE the tool input (no node/python3, or bad JSON)."
    echo "    Treating as POTENTIALLY PROTECTED — verify manually before proceeding."
  } >&2
  exit 0
fi

if [ -z "$command" ]; then
  exit 0
fi

lower="$(printf '%s' "$command" | tr '[:upper:]' '[:lower:]')"
matched=""
check() { if printf '%s' "$lower" | grep -qE "$1"; then matched="${matched}${2}\n"; fi; }

# --- push (incl. git -C <dir> push and force) --------------------------------
check 'git([[:space:]]+-c[[:space:]]+[^[:space:]]+)?[[:space:]]+push'   "git push (incl. git -C … push / force)"
# --- deploy (incl. the project wrapper) --------------------------------------
check '(fly|flyctl)[[:space:]]+deploy'                                   "deploy (fly deploy)"
check 'safe-deploy\.sh'                                                  "deploy (safe-deploy.sh wrapper)"
check '(fly|flyctl)[[:space:]]+(ssh|scale|machine)'                      "prod infra (fly ssh/scale/machine)"
# --- secrets -----------------------------------------------------------------
check '(fly|flyctl)[[:space:]]+secrets'                                  "secret change (fly secrets)"
# --- migrations (incl. wrapper scripts + additive DDL) -----------------------
check 'drizzle-kit[[:space:]]+push|npm[[:space:]]+run[[:space:]]+db:push' "migration (drizzle-kit / db:push)"
check '(tsx|node)[[:space:]]+[^\n]*(migrat|apply-migration|drizzle)'      "migration (tsx/node wrapper script)"
check '\b(create|alter|drop)[[:space:]]+(table|index|column)\b'          "DDL (CREATE/ALTER/DROP table/index/column)"
check '\btruncate\b'                                                     "destructive SQL (TRUNCATE)"
check '\bdelete[[:space:]]+from\b'                                       "destructive SQL (DELETE FROM)"
# --- storage deletion (aws-cli, rclone, AND aws-sdk in a script) -------------
check '(aws[[:space:]]+s3[[:space:]]+rm|rclone[[:space:]]+delete|-x[[:space:]]+delete)' "storage deletion (cli)"
check 'deleteobjectcommand|deletebucketcommand|\.deleteobject\('         "storage deletion (aws-sdk)"
# --- paid providers ----------------------------------------------------------
check 'higgsfield|api\.higgsfield|generate(image|video|artwork)'         "paid provider call (Higgsfield generation)"
check 'stripe\b.*(charge|paymentintent|refund)'                          "paid provider (Stripe money movement)"
# --- secrets / prod host literals in the command -----------------------------
check 'sk_live_'                                                         "live Stripe key in command"
check 'ep-wispy-morning'                                                 "production DB host referenced"
check '\.env\b.*(>>|>|sed[[:space:]]+-i|perl[[:space:]]+-pi)'            "env file mutation"
# --- dependency install ------------------------------------------------------
check 'npm[[:space:]]+install[[:space:]]+[^-]|npm[[:space:]]+i[[:space:]]|yarn[[:space:]]+add|pnpm[[:space:]]+add' "dependency install"

if [ -n "$matched" ]; then
  {
    echo "🚨 PROTECTED ACTION DETECTED — controlled-code-lead guard (ADVISORY, not a hard block)"
    echo "Category matched (command NOT echoed, to avoid leaking secrets):"
    printf '%b' "$matched" | sed 's/^/  - /'
    echo "Per CLAUDE.md + SKILL.md this requires the OWNER's explicit approval (the Lead"
    echo "cannot self-grant). If that approval was not given for THIS operation in THIS"
    echo "conversation, STOP and ask. A valid approval record belongs in"
    echo ".claude/controlled-code-lead/approvals/. Advisory only — it does not block."
  } >&2
fi

exit 0

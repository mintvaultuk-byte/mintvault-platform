#!/usr/bin/env bash
# Protected-action guard hook (PreToolUse, matcher: Bash).
#
# Advisory backstop for the controlled-code-lead skill's "Protected actions"
# list (.claude/skills/controlled-code-lead/SKILL.md). This does NOT block
# execution — it prints a warning banner to stderr when a Bash command
# matches a pattern that requires explicit owner approval per that list and
# per the top-level CLAUDE.md golden rules.
#
# It is deliberately advisory rather than a hard deny: .claude/settings.local.json
# already contains many owner-pre-approved commands that legitimately touch
# prod (fly deploy, fly secrets, git push, prod DATABASE_URL migrations, ...).
# A hard block here would contradict permissions the owner already granted
# and break existing workflows. The real gate is the Lead asking first, as
# instructed in SKILL.md and CLAUDE.md — this hook just makes sure it's not
# missed in the flow of a long session.
#
# Exit 0 always (advisory only). Never edit this to hard-block without
# updating .claude/settings.local.json in lockstep, or you will brick
# commands the owner has already approved.

set -euo pipefail

input="$(cat)"

command="$(printf '%s' "$input" | node -e '
let raw = "";
process.stdin.on("data", d => raw += d);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw);
    process.stdout.write(j.tool_input && j.tool_input.command ? j.tool_input.command : "");
  } catch {
    process.stdout.write("");
  }
});
' 2>/dev/null || true)"

if [ -z "$command" ]; then
  exit 0
fi

lower="$(printf '%s' "$command" | tr '[:upper:]' '[:lower:]')"

matched=""

check() {
  # $1 = pattern (grep -E, applied to lowercased command), $2 = label
  if printf '%s' "$lower" | grep -qE "$1"; then
    matched="${matched}${2}\n"
  fi
}

check 'git[[:space:]]+push'                                          "git push"
check 'git([[:space:]]+-[a-z-]+([[:space:]]+[^[:space:]]+)?)+[[:space:]]+push\b' "git push (with flags, e.g. git -C <path> push)"
check '(fly|flyctl)[[:space:]]+deploy'                                 "deploy (fly deploy)"
check '(fly|flyctl)([[:space:]]+-[a-z-]+([[:space:]]+[^[:space:]]+)?)+[[:space:]]+(deploy|secrets)\b' "deploy/secrets (fly with flags, e.g. fly -a <app> deploy)"
check '(fly|flyctl)[[:space:]]+secrets'                                "secret change (fly secrets)"
check 'drizzle-kit[[:space:]]+push|npm[[:space:]]+run[[:space:]]+db:push' "migration (drizzle-kit / db:push)"
check '\bdb:push\b'                                                    "migration (db:push via any runner)"
check '\bdrop[[:space:]]+(table|column|index)\b'                       "destructive SQL (DROP)"
check '\bdrop[[:space:]]+(database|schema|view|sequence|role)\b'       "destructive SQL (DROP database/schema/view/sequence/role)"
check '\btruncate\b'                                                   "destructive SQL (TRUNCATE)"
check '\bdelete[[:space:]]+from\b'                                     "destructive SQL (DELETE FROM)"
check '\balter[[:space:]]+table\b.*\bdrop\b'                           "destructive SQL (ALTER TABLE ... DROP)"
check 'sk_live_'                                                       "live Stripe key in command"
check 'ep-wispy-morning'                                                "production DB host referenced"
check '\.env\b.*(>>|>|sed[[:space:]]+-i|perl[[:space:]]+-pi)'           "env file mutation"
check '(sed[[:space:]]+-i|perl[[:space:]]+-pi).*\.env\b|(>>?)[[:space:]]*\.env\b' "env file mutation"
check '\b(aws[[:space:]]+s3[[:space:]]+rm|rclone[[:space:]]+delete|-x[[:space:]]+delete)\b' "storage deletion"
check 'aws[[:space:]]+s3[[:space:]]+rb\b|aws[[:space:]]+s3api[[:space:]]+delete' "storage deletion (bucket removal / s3api delete)"
check 'rclone[[:space:]]+(purge|deletefile)\b'                          "storage deletion (rclone purge/deletefile)"
check 'curl[^;|&]*[[:space:]]-x[[:space:]]+delete\b'                    "HTTP DELETE (curl -X DELETE)"
check 'tee[[:space:]]+(-[a-z]+[[:space:]]+)*\.env\b'                    "env file mutation (tee)"

if [ -n "$matched" ]; then
  {
    echo "🚨 PROTECTED ACTION DETECTED — controlled-code-lead guard (advisory, not blocking)"
    echo "Command matched:"
    printf '%b' "$matched" | sed 's/^/  - /'
    echo "Per CLAUDE.md and .claude/skills/controlled-code-lead/SKILL.md, this class of"
    echo "action requires explicit owner approval before proceeding. If that approval"
    echo "was not already given for this exact command in this conversation, STOP and ask."
  } >&2
fi

exit 0

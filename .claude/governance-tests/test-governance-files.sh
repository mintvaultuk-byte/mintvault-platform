#!/usr/bin/env bash
# Test: all governance files load correctly.
#
# Presence + non-emptiness + basic structural validity (frontmatter on
# skills/agents, JSON parse on settings, version/changelog agreement,
# executable bit on the hook). Pure read-only.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0

require_file() {
  if [ -s "$ROOT/$1" ]; then
    echo "ok: $1"
  else
    echo "FAIL: missing or empty: $1"
    FAIL=1
  fi
}

# --- core governance files (v1.0 + v1.1) ---
require_file "CLAUDE.md"
require_file ".claude/governance-version.md"
require_file ".claude/governance-changelog.md"
require_file ".claude/project-memory.md"
require_file ".claude/controlled-code-lead/protected-systems.md"
require_file ".claude/settings.json"
require_file ".claude/hooks/protected-action-guard.sh"
require_file ".claude/skills/controlled-code-lead/SKILL.md"

# --- all templates (v1.0 + v1.1) ---
for t in reviewer-report change-manifest rollout rollback issue-register \
         task-ledger deployment-state protected-systems definition-of-proof \
         architecture-before architecture-after implementation-budget \
         confidence-scoring governance-health-report; do
  require_file ".claude/skills/controlled-code-lead/templates/$t.md"
done

# --- structural checks ---

# SKILL.md has valid frontmatter with a name
if head -5 "$ROOT/.claude/skills/controlled-code-lead/SKILL.md" | grep -q '^name: controlled-code-lead'; then
  echo "ok: SKILL.md frontmatter name intact"
else
  echo "FAIL: SKILL.md frontmatter name missing/changed"
  FAIL=1
fi

# every agent file has frontmatter with name + tools
for a in "$ROOT"/.claude/agents/*.md; do
  base="$(basename "$a")"
  if grep -q '^name:' "$a" && grep -q '^tools:' "$a"; then
    echo "ok: agent frontmatter: $base"
  else
    echo "FAIL: agent frontmatter incomplete: $base"
    FAIL=1
  fi
done

# settings.json parses and wires the guard hook
if node -e '
const s = require(process.argv[1]);
const pre = (s.hooks && s.hooks.PreToolUse) || [];
const wired = JSON.stringify(pre).includes("protected-action-guard.sh");
process.exit(wired ? 0 : 1);
' "$ROOT/.claude/settings.json" 2>/dev/null; then
  echo "ok: settings.json parses and wires protected-action-guard.sh"
else
  echo "FAIL: settings.json invalid or hook not wired"
  FAIL=1
fi

# hook is executable
if [ -x "$ROOT/.claude/hooks/protected-action-guard.sh" ]; then
  echo "ok: hook executable"
else
  echo "FAIL: hook not executable"
  FAIL=1
fi

# version file and changelog agree on the current version
ver="$(grep -oE 'Governance Version\*\* \| [0-9]+\.[0-9]+' "$ROOT/.claude/governance-version.md" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
if [ -n "$ver" ] && grep -q "^## Version $ver" "$ROOT/.claude/governance-changelog.md"; then
  echo "ok: version file ($ver) has a matching changelog entry"
else
  echo "FAIL: governance-version.md ($ver) and governance-changelog.md disagree"
  FAIL=1
fi

# CLAUDE.md still contains the golden rules AND the governance section
if grep -q "GOLDEN RULES" "$ROOT/CLAUDE.md" && grep -q "controlled-code-lead" "$ROOT/CLAUDE.md"; then
  echo "ok: CLAUDE.md retains golden rules + governance section"
else
  echo "FAIL: CLAUDE.md missing golden rules or governance section"
  FAIL=1
fi

exit "$FAIL"

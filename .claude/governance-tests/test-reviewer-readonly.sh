#!/usr/bin/env bash
# Test: every reviewer agent is read-only.
#
# Enforcement model (strengthened post-v1.1-audit):
#  (a) ALLOWLIST on the tools grant — a reviewer may only hold the exact
#      read-only set below. Anything else (Edit, Write, Task, MultiEdit,
#      mcp__* write tools, permission-specifier forms like "Edit(path)")
#      fails, including tools this script has never heard of.
#  (b) Every *.md in .claude/agents/ is covered by globbing the directory —
#      a newly added agent cannot silently skip the check. Non-reviewer
#      agents must be consciously registered in KNOWN_NON_REVIEWERS below
#      (after Lead review) or the suite fails.
#  (c) The body must document the ban classes (edit, push, mutating git,
#      deploy, database, storage, secrets, paid providers). NOTE: these
#      body greps verify the documentation EXISTS, not its semantics — the
#      binding enforcement is the tools allowlist in (a).
#
# Never mutates anything — pure static inspection of .claude/agents/*.md.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS_DIR="$ROOT/.claude/agents"
FAIL=0

# The ONLY tools a reviewer may hold. Exact tokens.
ALLOWED_TOOLS=(Read Bash Grep Glob WebFetch WebSearch TaskOutput)

# Agent files that are deliberately NOT reviewers (none today). Adding a
# name here is a governance decision — record it in the changelog.
KNOWN_NON_REVIEWERS=()

is_allowed() {
  local tok="$1" a
  for a in "${ALLOWED_TOOLS[@]}"; do
    [ "$tok" = "$a" ] && return 0
  done
  return 1
}

is_known_non_reviewer() {
  local name="$1" k
  for k in "${KNOWN_NON_REVIEWERS[@]:-}"; do
    [ "$name" = "$k" ] && return 0
  done
  return 1
}

shopt -s nullglob
files=("$AGENTS_DIR"/*.md)
if [ "${#files[@]}" -eq 0 ]; then
  echo "FAIL: no agent files found in $AGENTS_DIR"
  exit 1
fi

for f in "${files[@]}"; do
  name="$(basename "$f" .md)"
  agent_fail=0

  case "$name" in
    *reviewer*) : ;;  # reviewer — full check below
    *)
      if is_known_non_reviewer "$name"; then
        echo "ok: $name — registered non-reviewer, skipped"
        continue
      fi
      echo "FAIL: $name — unregistered agent in .claude/agents/ (not a *reviewer* and not in KNOWN_NON_REVIEWERS; register it consciously after Lead review)"
      FAIL=1
      continue
      ;;
  esac

  tools_line="$(grep -m1 '^tools:' "$f" || true)"
  if [ -z "$tools_line" ]; then
    echo "FAIL: $name — no explicit tools: frontmatter (would inherit ALL tools, including Edit/Write)"
    FAIL=1
    continue
  fi

  # Parse tokens; an empty token list (e.g. YAML block-list form "tools:"
  # with the grant on following lines) is NOT accepted — this test only
  # certifies the single-line comma form it can actually inspect.
  tokens="$(printf '%s' "$tools_line" | sed 's/^tools://' | tr ',' '\n' | tr -d ' \t' | grep -v '^$' || true)"
  if [ -z "$tokens" ]; then
    echo "FAIL: $name — tools: line carries no inline grant (YAML block-list form is not certifiable by this test; use the single-line comma form)"
    FAIL=1
    continue
  fi

  while IFS= read -r tok; do
    if ! is_allowed "$tok"; then
      echo "FAIL: $name — tool not in read-only allowlist: $tok"
      agent_fail=1
    fi
  done <<< "$tokens"

  # Body must document the ban classes (documentation-presence check; the
  # allowlist above is the binding enforcement).
  body_checks=(
    "never edit|never edit or write|Never edit or write"
    "push"
    "mutating git"
    "deploy"
    "database"
    "storage"
    "secret"
    "paid provider"
  )
  for pattern in "${body_checks[@]}"; do
    if ! grep -qiE "$pattern" "$f"; then
      echo "FAIL: $name — body does not document ban matching /$pattern/"
      agent_fail=1
    fi
  done

  # Reviewer must not instruct agent spawning (tool grant already can't).
  if grep -qiE 'spawn (an|another|sub)?-?agents? to' "$f"; then
    echo "FAIL: $name — body appears to instruct agent spawning"
    agent_fail=1
  fi

  if [ "$agent_fail" -eq 0 ]; then
    echo "ok: $name — allowlist clean, bans documented"
  else
    FAIL=1
  fi
done

exit "$FAIL"

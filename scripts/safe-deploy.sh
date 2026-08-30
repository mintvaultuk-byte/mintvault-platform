#!/usr/bin/env bash
#
# safe-deploy.sh — deploy MintVault to Fly with two guards that make a
# stale-checkout clobber (which silently wiped newer prod code twice) impossible:
#
#   GUARD 1 (pre):  refuse to deploy unless this checkout is up to date with
#                   origin/main — i.e. you can't ship code older than what's
#                   already on the branch.
#   GUARD 1L (pre): refuse to deploy unless the commit the LIVE server is serving
#                   RIGHT NOW is an ancestor of the candidate. See below.
#   GUARD 1M (pre): re-read the live commit immediately before firing the deploy
#                   and abort if production moved during preflight.
#   GUARD 2 (post): after the rolling deploy, poll /api/version until the LIVE
#                   server reports the exact commit we just built. If it never
#                   does, exit non-zero and print the rollback command.
#
# WHY GUARD 1L EXISTS (2026-08-11 sibling clobber):
#   GUARD 1 only ever compared the checkout against origin/main. On 2026-08-11
#   two SIBLING releases went live 4 minutes apart — v1069 (7d20196c, scanner /
#   station) then v1070 (c788fa68, canonical grading). Neither contained the
#   other and NEITHER was on origin/main, so GUARD 1 was satisfied both times and
#   the second deploy silently removed every scanner route from production.
#   "Current with the branch" is not the same question as "contains what is
#   running". GUARD 1L asks the second question, against the live artifact.
#
# Usage:
#   scripts/safe-deploy.sh staging     # → mintvault-v2 (fly.v2.toml)
#   scripts/safe-deploy.sh prod        # → mintvault    (fly.toml)
#   scripts/safe-deploy.sh prod --reconciled-from <LIVE_SHA>
#         Acknowledge that the candidate deliberately supersedes a DIVERGENT live
#         release whose semantics it already carries. It must name the commit the
#         server is actually serving, so it goes stale the moment prod moves and
#         cannot be pre-baked into a runbook. This is NOT a general --force.
#   scripts/safe-deploy.sh staging --allow-unknown-live
#         Staging only. Proceed when a parked staging box cannot report a commit.
#         Never honoured for prod — prod fails closed.
#
# It NEVER auto-deploys prod without you running it; it just makes the deploy
# you run safe. Requires: git, fly, curl.

set -euo pipefail

TARGET="${1:-}"
shift || true
ALLOW_BEHIND=0
ASSUME_YES=0
ALLOW_UNKNOWN_LIVE=0
RECONCILED_FROM=""
PARTNER_NETWORK_CONSOLIDATION="false"
_next_is_reconciled=0
_next_is_partner_network_consolidation=0
for arg in "$@"; do
  if [ "$_next_is_reconciled" = "1" ]; then RECONCILED_FROM="$arg"; _next_is_reconciled=0; continue; fi
  if [ "$_next_is_partner_network_consolidation" = "1" ]; then PARTNER_NETWORK_CONSOLIDATION="$arg"; _next_is_partner_network_consolidation=0; continue; fi
  [ "$arg" = "--allow-behind" ] && ALLOW_BEHIND=1
  [ "$arg" = "--yes" ] && ASSUME_YES=1
  [ "$arg" = "--allow-unknown-live" ] && ALLOW_UNKNOWN_LIVE=1
  [ "$arg" = "--reconciled-from" ] && _next_is_reconciled=1
  [ "$arg" = "--partner-network-consolidation" ] && _next_is_partner_network_consolidation=1
done

case "$PARTNER_NETWORK_CONSOLIDATION" in
  true|false) ;;
  *) echo "usage: --partner-network-consolidation {true|false}" >&2; exit 2 ;;
esac

case "$TARGET" in
  staging) APP="mintvault-v2"; CONFIG="fly.v2.toml"; HOST="https://mintvault-v2.fly.dev" ;;
  prod)    APP="mintvault";    CONFIG="fly.toml";    HOST="https://mintvault.fly.dev" ;;
  *) echo "usage: $0 {staging|prod} [--allow-behind (staging only)]" >&2; exit 2 ;;
esac

if [ "$TARGET" = "prod" ] && [ "$ALLOW_BEHIND" -eq 1 ]; then
  echo "🚫 BLOCKED: --allow-behind is a staging-only diagnostic escape hatch." >&2
  echo "   Production must deploy the exact clean origin/main commit." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Fly token (matches the pattern used across this project's tooling).
if [ -z "${FLY_API_TOKEN:-}" ] && [ -f "$HOME/.fly/config.yml" ]; then
  FLY_API_TOKEN="$(awk -F': *' '/^access_token:/{print $2}' "$HOME/.fly/config.yml" | tr -d "\"' ")"
  export FLY_API_TOKEN
fi

SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "── safe-deploy → $APP ($CONFIG) ──"
echo "   branch=$BRANCH  commit=$SHA"
echo "   VITE_PARTNER_NETWORK_CONSOLIDATION=$PARTNER_NETWORK_CONSOLIDATION"

# ── GUARD 1: not behind origin/main ──────────────────────────────────────────
git fetch origin --quiet
BASE="$(git merge-base HEAD origin/main)"
REMOTE="$(git rev-parse origin/main)"
if [ "$TARGET" = "prod" ] && [ "$SHA" != "$REMOTE" ]; then
  echo "🚫 BLOCKED: production only accepts the exact origin/main commit." >&2
  echo "   candidate=$SHA" >&2
  echo "   origin/main=$REMOTE" >&2
  echo "   Merge the reviewed pull request, fetch origin, and deploy that exact SHA." >&2
  exit 1
fi
if [ "$BASE" != "$REMOTE" ] && [ "$ALLOW_BEHIND" -ne 1 ]; then
  echo "🚫 BLOCKED: this checkout is BEHIND origin/main — deploying would ship stale code"
  echo "   and could wipe newer work off $APP (the clobber we already hit twice)."
  echo "   Fix: git pull origin main   (then re-run)   —   or pass --allow-behind if you're sure."
  git --no-pager log --oneline HEAD..origin/main | sed 's/^/     behind: /' | head -10
  exit 1
fi
# Staging may deliberately exercise modified tracked files. Production gates
# every worktree change because either tracked or untracked files can enter the
# Docker context, regardless of what a developer expects .dockerignore to omit.
DIRTY_TRACKED="$(git status --porcelain | grep -v '^??' || true)"
UNTRACKED="$(git status --porcelain | grep '^??' || true)"
[ -n "$UNTRACKED" ] && { echo "   note: untracked files:"; echo "$UNTRACKED" | sed 's/^/     /' | head -5; }
if [ "$TARGET" = "prod" ] && { [ -n "$DIRTY_TRACKED" ] || [ -n "$UNTRACKED" ]; }; then
  echo "🚫 BLOCKED: production builds require a completely clean worktree." >&2
  echo "   Tracked and untracked files can both enter the Docker build context." >&2
  echo "   Commit the reviewed change or move non-release files outside the checkout." >&2
  exit 1
fi
if [ -n "$DIRTY_TRACKED" ]; then
  echo "⚠  MODIFIED tracked files — these WILL be built into this deploy:"
  echo "$DIRTY_TRACKED" | sed 's/^/     /' | head -20
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf "   continue? [y/N] "; read -r ans; [ "$ans" = "y" ] || { echo "aborted."; exit 1; }
  fi
fi
if [ "$TARGET" = "prod" ]; then
  echo "✔ GUARD 1: clean checkout exactly matches origin/main"
else
  echo "✔ GUARD 1: checkout is current with origin/main"
fi

# ── GUARD 1L: the candidate must CONTAIN what is live right now ──────────────
# Read the live commit from the running server, not from git, not from `fly
# releases`, and not from what we believe we deployed last time. The release
# counter moves for reasons unrelated to code (config, secrets, restarts), so the
# artifact is the only honest source.
read_live_sha() {
  curl -fsS --max-time 10 "$1/api/version" 2>/dev/null \
    | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true
}
LIVE_PREFLIGHT="$(read_live_sha "$HOST")"
echo "   live now: ${LIVE_PREFLIGHT:-<unreachable>}   candidate: $SHA"

ANCESTRY_ARGS=(--live "${LIVE_PREFLIGHT:--}" --candidate "$SHA" --target "$TARGET")
[ -n "$RECONCILED_FROM" ] && ANCESTRY_ARGS+=(--reconciled-from "$RECONCILED_FROM")
[ "$ALLOW_UNKNOWN_LIVE" -eq 1 ] && ANCESTRY_ARGS+=(--allow-unknown-live)

# No bypass flag is consulted here on purpose: --allow-behind exists for the
# origin/main check and must not silently disarm the live-ancestry check too.
npx tsx scripts/deploy/check-live-ancestry.ts "${ANCESTRY_ARGS[@]}" || {
  echo "   (this is the guard that would have stopped the v1069 → v1070 clobber)"
  exit 1
}

# Capture the current live image as the rollback target BEFORE we change anything.
# Extract the image ref directly (delimiter-independent — fly's table format
# has varied between CLI versions), e.g. mintvault:deployment-01ABC or
# mintvault-v2:deployment-01ABC.
ROLLBACK_IMG="$(fly status --app "$APP" 2>/dev/null | grep -i Image | grep -oE '[A-Za-z0-9._-]+:deployment-[A-Za-z0-9]+' | head -1)"
[ -n "$ROLLBACK_IMG" ] && echo "   rollback image (current live): registry.fly.io/$ROLLBACK_IMG"

# ── GUARD 1M: MOVING TARGET ──────────────────────────────────────────────────
# Everything above (including the rollback-image capture and any confirmation
# prompt) takes time, and a concurrent session can ship inside that window —
# v1069 and v1070 were four minutes apart. Re-read the live commit and abort if
# it moved, because every ancestry conclusion drawn above is now about a
# production that no longer exists.
LIVE_AT_DEPLOY="$(read_live_sha "$HOST")"
if [ "${LIVE_AT_DEPLOY:-}" != "${LIVE_PREFLIGHT:-}" ]; then
  echo "🚫 BLOCKED [LIVE_MOVED_DURING_PREFLIGHT]"
  echo "   $APP was serving '${LIVE_PREFLIGHT:-<unknown>}' at preflight and is serving"
  echo "   '${LIVE_AT_DEPLOY:-<unknown>}' now. Another session deployed while this one was"
  echo "   preparing. Re-run from the start — do NOT re-run with a bypass flag."
  exit 1
fi
echo "✔ GUARD 1M: live commit unchanged during preflight (${LIVE_AT_DEPLOY:-<unknown>})"

# ── Deploy, embedding the SHA so the live server can prove itself ────────────
echo "── deploying (embedding GIT_SHA=$SHA) ──"
fly deploy -c "$CONFIG" --app "$APP" --build-arg "GIT_SHA=$SHA" \
  --build-arg "VITE_PARTNER_NETWORK_CONSOLIDATION=$PARTNER_NETWORK_CONSOLIDATION"

# ── GUARD 2: verify the LIVE server reports our exact commit ─────────────────
echo "── verifying live artifact (polling $HOST/api/version for commit=$SHA) ──"
LIVE=""
for i in $(seq 1 30); do
  LIVE="$(curl -fsS --max-time 10 "$HOST/api/version" 2>/dev/null | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true)"
  [ "$LIVE" = "$SHA" ] && break
  sleep 4
done

if [ "$LIVE" = "$SHA" ]; then
  echo "✅ VERIFIED: $APP is live on commit $SHA (checked the running server, not the deploy log)"
  exit 0
fi
echo "❌ NOT VERIFIED: $APP reports commit '${LIVE:-<none>}', expected '$SHA'."
echo "   The deploy may still be draining, OR another deploy raced yours."
echo "   Re-check:  curl -s $HOST/api/version"
[ -n "$ROLLBACK_IMG" ] && echo "   Rollback:  fly deploy --image registry.fly.io/$ROLLBACK_IMG -c $CONFIG --app $APP"
exit 1

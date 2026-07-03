#!/usr/bin/env bash
#
# safe-deploy.sh — deploy MintVault to Fly with two guards that make a
# stale-checkout clobber (which silently wiped newer prod code twice) impossible:
#
#   GUARD 1 (pre):  refuse to deploy unless this checkout is up to date with
#                   origin/main — i.e. you can't ship code older than what's
#                   already on the branch.
#   GUARD 2 (post): after the rolling deploy, poll /api/version until the LIVE
#                   server reports the exact commit we just built. If it never
#                   does, exit non-zero and print the rollback command.
#
# Usage:
#   scripts/safe-deploy.sh staging     # → mintvault-v2 (fly.v2.toml)
#   scripts/safe-deploy.sh prod        # → mintvault    (fly.toml)
#   scripts/safe-deploy.sh prod --allow-behind   # skip GUARD 1 (rarely needed)
#
# It NEVER auto-deploys prod without you running it; it just makes the deploy
# you run safe. Requires: git, fly, curl.

set -euo pipefail

TARGET="${1:-}"
shift || true
ALLOW_BEHIND=0
ASSUME_YES=0
for arg in "$@"; do
  [ "$arg" = "--allow-behind" ] && ALLOW_BEHIND=1
  [ "$arg" = "--yes" ] && ASSUME_YES=1
done

case "$TARGET" in
  staging) APP="mintvault-v2"; CONFIG="fly.v2.toml"; HOST="https://mintvault-v2.fly.dev" ;;
  prod)    APP="mintvault";    CONFIG="fly.toml";    HOST="https://mintvault.fly.dev" ;;
  *) echo "usage: $0 {staging|prod} [--allow-behind]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Fly token (matches the pattern used across this project's tooling).
if [ -z "${FLY_API_TOKEN:-}" ] && [ -f "$HOME/.fly/config.yml" ]; then
  FLY_API_TOKEN="$(awk -F': *' '/^access_token:/{print $2}' "$HOME/.fly/config.yml" | tr -d "\"' ")"
  export FLY_API_TOKEN
fi

SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "── safe-deploy → $APP ($CONFIG) ──"
echo "   branch=$BRANCH  commit=$SHA"

# ── GUARD 1: not behind origin/main ──────────────────────────────────────────
git fetch origin --quiet
BASE="$(git merge-base HEAD origin/main)"
REMOTE="$(git rev-parse origin/main)"
if [ "$BASE" != "$REMOTE" ] && [ "$ALLOW_BEHIND" -ne 1 ]; then
  echo "🚫 BLOCKED: this checkout is BEHIND origin/main — deploying would ship stale code"
  echo "   and could wipe newer work off $APP (the clobber we already hit twice)."
  echo "   Fix: git pull origin main   (then re-run)   —   or pass --allow-behind if you're sure."
  git --no-pager log --oneline HEAD..origin/main | sed 's/^/     behind: /' | head -10
  exit 1
fi
# Only MODIFIED TRACKED files gate the deploy (they change the artifact).
# Untracked files are informational — most (docs, scratch) are dockerignored.
DIRTY_TRACKED="$(git status --porcelain | grep -v '^??' || true)"
UNTRACKED="$(git status --porcelain | grep '^??' || true)"
[ -n "$UNTRACKED" ] && { echo "   note: untracked files (not gating):"; echo "$UNTRACKED" | sed 's/^/     /' | head -5; }
if [ -n "$DIRTY_TRACKED" ]; then
  echo "⚠  MODIFIED tracked files — these WILL be built into this deploy:"
  echo "$DIRTY_TRACKED" | sed 's/^/     /' | head -20
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf "   continue? [y/N] "; read -r ans; [ "$ans" = "y" ] || { echo "aborted."; exit 1; }
  fi
fi
echo "✔ GUARD 1: checkout is current with origin/main"

# Capture the current live image as the rollback target BEFORE we change anything.
# Extract the image ref directly (delimiter-independent — fly's table format
# has varied between CLI versions), e.g. mintvault:deployment-01ABC or
# mintvault-v2:deployment-01ABC.
ROLLBACK_IMG="$(fly status --app "$APP" 2>/dev/null | grep -i Image | grep -oE '[A-Za-z0-9._-]+:deployment-[A-Za-z0-9]+' | head -1)"
[ -n "$ROLLBACK_IMG" ] && echo "   rollback image (current live): registry.fly.io/$ROLLBACK_IMG"

# ── Deploy, embedding the SHA so the live server can prove itself ────────────
echo "── deploying (embedding GIT_SHA=$SHA) ──"
fly deploy -c "$CONFIG" --app "$APP" --build-arg "GIT_SHA=$SHA"

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

#!/usr/bin/env bash
# =============================================================================
# MintVault UK — GitHub Export Script
# =============================================================================
# Run this script from your LOCAL machine (not Replit) to push the codebase
# from a local clone to GitHub.
#
# Prerequisites:
#   - git installed
#   - A GitHub Personal Access Token (PAT) with 'repo' scope
#     Create one at: https://github.com/settings/tokens/new
#     Required scope: repo (Full control of private repositories)
#
# Usage:
#   chmod +x github-push-script.sh
#   ./github-push-script.sh
# =============================================================================

set -e  # Exit on any error

# ─── CONFIGURE THESE ─────────────────────────────────────────────────────────
GITHUB_USER=""          # Your GitHub username (e.g. "johndoe")
GITHUB_REPO=""          # Target repo name (e.g. "mintvault-uk")
GITHUB_PAT=""           # Your Personal Access Token
REPO_VISIBILITY="private"  # "private" or "public"
COMMIT_MSG="MintVault UK — full codebase export March 2026"
# ─────────────────────────────────────────────────────────────────────────────

# Validate inputs
if [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_REPO" ] || [ -z "$GITHUB_PAT" ]; then
  echo "ERROR: Please edit this script and set GITHUB_USER, GITHUB_REPO, and GITHUB_PAT"
  exit 1
fi

REMOTE_URL="https://${GITHUB_USER}:${GITHUB_PAT}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git"

echo ""
echo "=== MintVault UK GitHub Export ==="
echo "User:   $GITHUB_USER"
echo "Repo:   $GITHUB_REPO"
echo "Remote: https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
echo ""

# Step 1: Create the GitHub repository if it doesn't exist
echo "[1/5] Creating GitHub repository (if needed)..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: token ${GITHUB_PAT}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}")

if [ "$HTTP_STATUS" = "404" ]; then
  echo "     Repository not found. Creating it..."
  curl -s \
    -H "Authorization: token ${GITHUB_PAT}" \
    -H "Accept: application/vnd.github.v3+json" \
    -X POST "https://api.github.com/user/repos" \
    -d "{\"name\":\"${GITHUB_REPO}\",\"private\":$([ \"$REPO_VISIBILITY\" = 'private' ] && echo true || echo false),\"description\":\"MintVault UK — Professional Trading Card Grading Service\"}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print('     Created:', r.get('html_url', 'unknown'))"
  sleep 2
elif [ "$HTTP_STATUS" = "200" ]; then
  echo "     Repository already exists — will push to it."
else
  echo "     WARNING: Got HTTP $HTTP_STATUS when checking repo. Proceeding anyway..."
fi

# Step 2: Initialize git if not already a repo
echo "[2/5] Setting up git..."
if [ ! -d ".git" ]; then
  git init
  echo "     Initialized new git repository."
else
  echo "     Git already initialized."
fi

# Step 3: Configure remote
echo "[3/5] Configuring remote..."
if git remote | grep -q "^github$"; then
  git remote set-url github "$REMOTE_URL"
  echo "     Updated existing 'github' remote."
elif git remote | grep -q "^origin$"; then
  git remote set-url origin "$REMOTE_URL"
  echo "     Updated 'origin' remote."
else
  git remote add origin "$REMOTE_URL"
  echo "     Added 'origin' remote."
fi

# Step 4: Stage all files (respecting .gitignore)
echo "[4/5] Staging files..."
git add -A

# Show summary of what's being committed
echo "     Files to be committed:"
git diff --cached --name-only --diff-filter=A | head -20 | sed 's/^/       + /'
echo "     (and more...)"
echo ""
echo "     Staged: $(git diff --cached --name-only | wc -l | tr -d ' ') files"

# Step 5: Commit and push
echo "[5/5] Committing and pushing..."
git commit -m "$COMMIT_MSG" --allow-empty

# Try pushing to main branch
REMOTE_NAME="origin"
if git remote | grep -q "^github$"; then
  REMOTE_NAME="github"
fi

if git push -u "$REMOTE_NAME" main 2>/dev/null; then
  echo "     Pushed to main branch."
elif git push -u "$REMOTE_NAME" master 2>/dev/null; then
  echo "     Pushed to master branch."
else
  # Force set branch and push
  git checkout -b main 2>/dev/null || git checkout main
  git push -u "$REMOTE_NAME" main --force
  echo "     Force pushed to main branch."
fi

echo ""
echo "=== DONE ==="
echo "Repository: https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
echo ""

#!/usr/bin/env bash
# =============================================================================
# MintVault UK — Claude Handover Export
# =============================================================================
# Creates a clean tar.gz archive of the full codebase, excluding secrets,
# node_modules, and unrelated files.
#
# Run from the ROOT of the Replit project:
#   chmod +x docs/export-for-claude.sh
#   ./docs/export-for-claude.sh
#
# Output: mintvault-export-YYYY-MM-DD.tar.gz (in the current directory)
# =============================================================================

set -e

DATE=$(date +%Y-%m-%d)
OUTPUT="mintvault-export-${DATE}.tar.gz"

echo "=== MintVault UK — Claude Handover Export ==="
echo "Date: $DATE"
echo "Output: $OUTPUT"
echo ""

tar -czf "$OUTPUT" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude=".git" \
  --exclude=".local" \
  --exclude=".replit" \
  --exclude="replit.nix" \
  --exclude=".upm" \
  --exclude=".cache" \
  --exclude=".config" \
  --exclude="attached_assets" \
  --exclude="uploads" \
  --exclude="*.log" \
  --exclude="*.pyc" \
  --exclude="__pycache__" \
  --exclude="ebay_sniper.py" \
  --exclude="telegram_test.py" \
  --exclude="seen_ids.json" \
  --exclude="seen_items.txt" \
  --exclude="seen.json" \
  --exclude="seen_rss_ids.json" \
  --exclude="sniper_stats.json" \
  --exclude="sold_cache.json" \
  --exclude="sold_cache_simple.json" \
  --exclude="data/" \
  --exclude="package-lock.json" \
  .

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "Done. Archive: $OUTPUT ($SIZE)"
echo ""
echo "Contents summary:"
tar -tzf "$OUTPUT" | grep -v "/$" | sort | head -80
echo "..."
echo ""
echo "Total files: $(tar -tzf "$OUTPUT" | grep -v "/$" | wc -l | tr -d ' ')"

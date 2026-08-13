#!/bin/bash
#
# update.sh — RETIRED mutable-update entry point.
#
# Scanner releases are installed through the owner-approved signed package
# channel. A physical station must never fetch a branch or resolve npm
# dependencies while it is trusted to capture evidence. This guard remains so
# old launchd/desktop shortcuts fail loudly instead of silently taking the
# unsafe historical path.

set -u

LOG="$HOME/mintvault-scans/scanner-app.log"

exec >>"$LOG" 2>&1
echo "[update] $(date -u +%FT%TZ) REFUSED — install an approved signed MintVault Scanner package; Git/npm self-update is retired"
exit 64

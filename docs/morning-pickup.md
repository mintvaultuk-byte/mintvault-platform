# Morning pickup — 2026-04-25

## Tonight's deliverables (all shipped + verified)
- prod main @ fa6a8fb deployed v370 — 4 PRs landed
- MV reset complete — next scan = MV1
- Scanner watcher 45s timeout on feat/scanner-status-indicator
- Execution-style skill installed
- Resend P0 launch blocker documented (see resend-launch-blocker.md)

## Morning order

### 1. Resend domain verification (P0 launch blocker, ~15 min)
- resend.com/domains → add mintvaultuk.com
- Add DNS records at GoDaddy (SPF, DKIM, DMARC)
- Wait for verification (DNS propagation, usually <10 min)
- Update server/email.ts FROM address from default sandbox to noreply@mintvaultuk.com
- Re-run Fix 4 staging test — should now deliver to mintvaultuk+to@gmail.com
- Commit: chore(email): switch to verified mintvaultuk.com sender domain

### 2. Commit launch blocker doc (~2 min)
- git checkout main
- git checkout -b docs/launch-blockers
- git mv... (already in /docs)
- PR + merge

### 3. Decide fates of unmerged feature branches
- feat/grading-cv-centering — review, merge or close
- feat/grading-cv-suite — review, merge or close
- feat/scanner-admin-pipeline-convergence — already on staging v79, ready to merge
- feat/scanner-status-indicator — finish or close
- feat/image-compression-phase-z — review, merge or close
- feat/admin-v2-tokens-wip — review, merge or close

### 4. First real card scan
- V850 → produces MV1 fresh
- Verify scanner watcher pipeline → admin grading queue → labels generate
- Smoke test full v1 critical path one more time before announcing launch

## Don't forget
- 4.7GB of session transcript at /mnt/transcripts/ if you need to recall a decision
- Memory edits at 30/30, can't add more without removing one
- mintvault.com email forwarding — set up cornelius@mintvaultuk.com or similar
  if you want to receive on the brand domain (currently send-only)

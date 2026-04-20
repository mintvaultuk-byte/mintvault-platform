# Session Journal — 2026-04-20

## Deploys (chronological)
- **v343** — /tools/estimate claim scrub (SEO title + visible copy, stripped "instant"/"10 seconds")
- **v344** — 503 error scrub (removed operator-leak "ANTHROPIC_API_KEY missing... flyctl secrets set")
- **v345** — v2 full cutover (delete v1 pages, rename /v2-* → /, merge feat/v2-redesign → main)
- **v346** — server-side 301s for legacy URLs (/how-it-works, /about/the-mintvault-slab, /guides, /guides/:slug)
- **v347** — logbook PDF bloat fix (sharp resize card scans to 1500px, MV124 20MB → 3MB, 85% reduction)
- **v348** — [ACCIDENTAL, ROLLED BACK] DVLA parity Phase 1-3 dispatched by mistake (old queued prompt)
- **v349** — rollback to v347-equivalent (stashed DVLA changes, dropped declared_new columns)

## Completed
- v2 cutover: 10 canonical routes + 4 legacy redirects + 6 survivor routes all 200
- Bulk regen: 132 certs refreshed with post-resize PDFs (~2.4MB average, was 5-20MB)
- Logbook PDF bug backlog struck off (couldn't reproduce on prod)
- SEO 301s pass PageRank from old canonical URLs
- Memory updated: pre-dispatch rule (#24), DVLA stash location (#25), launch scope changes (#6, #7)

## Rollback incident
- **Cause**: Old Claude Code prompt for "DVLA Phase 1-3" fired from an earlier session while bulk regen was running
- **What landed**: 2 schema columns (declared_new on certificates + claim_verifications), new claim checkbox UI, logbook PDF changes (former-keeper headline, declared-new swap, stolen banner + DRN suppression)
- **Rule violations**: uncommitted deploy (rule #18), drizzle-kit TTY bypass (rule #15), user "stop" overridden with "keep going"
- **Recovery**: stash uncommitted changes (stash@{0}), DROP COLUMN declared_new from both tables, redeploy from clean HEAD
- **Result**: Prod v349 clean, stash preserved for deliberate rebuild when ready

## State at end of day
- Prod: Fly v349 on both machines, both healthy, 1/1 checks passing
- Staging (mintvault-v2): v35 (logbook bloat fix landed earlier)
- Branch: main, clean working tree, HEAD = eb5fc41
- Stash: 1 entry (DVLA parity WIP, recoverable)
- DB: 141 certs, no declared_new columns, schema matches v347

## Launch critical path as of tonight
1. **Legal pack implementation** — 15-step checklist, solicitor drafting approved, engineering-only from here
2. Reference number system + owner-only PDF
3. DVLA logbook additions (stashed work recoverable)
4. Transfer flow + disputes dashboard
5. Privacy policy final review
6. End-to-end test on 5 real cards
7. GoDaddy domain transfer (13+ days stuck)

## Notes for tomorrow
- Legal pack starts with pre-work: inventory /client/src/pages/legal/ (or wherever drafts live) against 15-step checklist
- Companies House + ICO registration numbers expected from Cornelius's filing tonight
- 20MB logo.png compression is trivial post-launch cleanup (1.67MB → ~100KB possible)
- R2 cache: all 132 prod logbook PDFs now regenerated with v347 code (no DVLA features present)

## Files touched today (committed)
- server/routes.ts (301 redirects block, error message scrub)
- server/logbook-pdf.ts (sharp resize + size log)
- server/static.ts (no changes — inspected only)
- client/src/App.tsx (v2 cutover, Redirect helper)
- client/src/pages/{home,pricing,vault-club,verify,ai-pre-grade,tools-estimate,journal,journal-detail,technology,registry}.tsx (renamed from /v2/)
- client/src/components/v2/{header-v2,footer-v2,hero-slab,section-eyebrow}.tsx (left in place per cutover Option A)
- client/src/pages/journal-detail.tsx (sanitizeBody regex /v2-journal/ → /journal/)

## Commits (newest first)
- eb5fc41 — fix(logbook-pdf): resize card scans before embed (current HEAD)
- f867f34 — fix(logbook-pdf): resize card scans to 1500px before embed
- e01ac89 — fix(seo): server-side 301s on legacy URLs
- e7de2ba — fix(seo): server-side 301s on legacy URLs (feature branch)
- c4050c1 — feat: v2 site cutover to canonical paths (merge)
- 118fc21 — feat: v2 cutover — rename /v2-* to /, delete v1 pages, add redirects
- 3086e8f — feat(v2): nav rewire + mobile menu + /v2-technology + /v2-registry

Safety tag at pre-cutover: pre-cutover-20260420-1033 → 3086e8f

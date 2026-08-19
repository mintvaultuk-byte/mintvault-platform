# Change manifest — Growth Command Pass B1

**Date:** 2026-08-19
**Lead session:** `codex/growth-command-pass-b1` / `f024f938`

## Findings this manifest addresses
- F1 — paid return lacks a server-authorised recovery read — classification B.
- F2 — multi-card client flow permits a request the server necessarily rejects — classification B.
- F3 — unknown routes are indexable soft 404s — classification A.
- F4 — Journal/current landing inventory is absent from canonical sitemap/SSR metadata — classification A.
- F5 — private, transactional and individual-record documents lack SSR noindex policy — classification A.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `server/routes/submissions.ts` | Add a minimal payment-success read protected by the existing signed submission token and paid state. | F1 | B |
| `server/lib/paid-submission-confirmation.ts` | Isolate the paid-only, allowlisted confirmation payload for direct regression tests. | F1 | B |
| `client/src/pages/submit-success.tsx` | Use the token-gated success read; preserve missing/invalid states. | F1 | B |
| `client/src/pages/submit.tsx` | Require matching card item rows when quantity exceeds one before payment. | F2 | B |
| `server/seo-config.ts` | Define canonical public-route, noindex and sitemap metadata policy. | F3–F5 | A |
| `server/static.ts` | Render SEO/noindex directives for known routes and genuine HTTP 404/noindex for unknown routes. | F3, F5 | A |
| `server/routes.ts` | Emit the canonical Journal/current public sitemap inventory. | F4 | A |
| `server/routes/redirects.ts` | Redirect the legacy certificate lookup shell to its active verification URL. | F5 | A |
| `client/src/pages/journal.tsx` | Add Journal metadata/schema. | F4 | A |
| `client/src/pages/journal-detail.tsx` | Add current Journal article metadata/schema. | F4 | A |
| `client/src/components/seo-head.tsx` | Resolve relative canonicals to the authoritative absolute host. | F4–F5 | A |
| `client/src/pages/logbook.tsx` | Preserve noindex on hydrated individual certificate pages. | F5 | A |
| `client/src/pages/pop-certs.tsx` | Preserve noindex on hydrated population result pages. | F5 | A |
| `tests/growth-command-pass-b1.test.ts` | Add focused, mocked policy and source-contract regression tests. | F1–F5 | A |
| `.claude/controlled-code-lead/growth-command-pass-b1/*` | Update task evidence/state. | process | A |

## Explicitly not touched
- Stripe webhook, promotion service, payment intent creation, DB schema/migrations, Scanner, Partner, social publication, certificates/QR route consolidation, deployments, and providers.

## Protected actions required
- [x] None.

## Order of operations
1. Verify reviewer evidence and API/client contracts.
2. Implement the GB-01 server/client paired recovery and validation fixes.
3. Implement GB-02 policy, rendering, sitemap, and Journal changes.
4. Run focused tests and repository gates; inspect the changed-file allowlist.

## Regression gates
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] local production HTTP probe
- [ ] changed-file and secret review

---
**Approved to proceed to Stage 5:** not required — no protected action.

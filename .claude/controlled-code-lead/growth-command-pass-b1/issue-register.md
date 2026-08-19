# Issue register — Growth Command Pass B1

| ID | Severity | Classification | Status | Evidence | Resolution |
|---|---|---|---|---|---|
| F1 | blocker | B | resolved | Paid success page calls owner-gated submission endpoint without ownership proof. | Paid-only, token-gated, no-store confirmation payload; normal email gate unchanged. |
| F2 | high | B | resolved | Multi-card UI can omit item rows while payment endpoint rejects them. | Wizard normalises and preflights item cardinality; server guard remains authoritative. |
| F3 | blocker | A | resolved | SSR fallback emits indexable HTTP 200 documents for unknown paths. | Recognised routes render; unknown paths return 404 plus rendered/header noindex. |
| F4 | high | A | resolved | Sitemap and metadata still favour redirected Guides over Journal; index coverage is incomplete. | Current Journal inventory (20) and all 13 landers use deterministic canonical sitemap entries. |
| F5 | high | A | resolved | Private, transactional, and individual-record routes have no consistent SSR noindex policy. | SSR/hydrated noindex policy covers private/utility, certificate, report and population-result routes. |

## Deferred, out-of-scope findings
- Production release reconciliation — requires owner-authorised deployment.
- Certificate URL consolidation / QR changes — broader external-contract decision.
- Scanner, Partner, promotion, social, analytics, performance, and authority-content work — expressly excluded from B1.

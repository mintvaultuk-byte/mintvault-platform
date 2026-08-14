# Issue register — Canonical grading left-rail refinement (2026-08-14)

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CLR-01 | The sole shared label preview used a bordered dark card, heading, helper/caption and inner frame; it needlessly reduced the flex card viewer's visible height. | Owner production screenshot + Lead source trace | medium | confirmed | `CertificatePreviewPanel.tsx`; `WorkstationPreviewAside.tsx:59-62` | A | yes | Implemented + browser measured | pending | n/a | pending | not-activated | resolved pending PR | The shared component now has a bare, aspect-correct 266 × 76 image plus compact loading/error states; revision acknowledgement and retry are tested. |
| CLR-FU-01 | The local full-suite command cannot execute Partner DB-gated files without all 54 synthetic CI variables, but it no longer has an environmental failure. | Local verification | low | confirmed | unrelated test files | H | yes | Serial run exits 0: 4,554 passed; 771 intentionally skipped | — | n/a | pending | not-activated | follow-up gate | `partner-certificate-origin` (54/54) and `project-control-hardening` (53/53) also pass with their CI loopback environment. Exact PR CI remains authoritative for the skipped Partner set; no scoped source defect was found. |

## Rejected findings

- None. No MVGS, renderer, scanner/station, migration, auth or state-machine defect was observed in the scoped trace.

## Deferred findings

- None.

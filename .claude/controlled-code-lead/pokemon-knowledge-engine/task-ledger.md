# Task: Pokémon Knowledge Engine + Hub + Handbook
Branch: codex/pokemon-knowledge-engine (off main 87d6c295 = prod v1042)
Scope: LOCAL ONLY — no push/PR/merge/deploy, no prod migration, no AI calls, zero credits.
Protected: issued certs, legacy variant, grading calc, cert numbering, label/PDF rendering
(labels.ts + certificate-document.ts READ-ONLY reference), payments, auth, VQ, Social Studio.

## Architecture decision (Stage 1)
Single shared catalogue = shared/pokemon-rarity-catalogue.ts (deployed, powers picker).
Knowledge Engine ADDS: provenance/meta layer (code), canonical SET directory (DB, additive),
revisions/import-runs/review-queue (DB, additive). No duplicate rarity/finish/promo tables.

## Stage log
- [x] Stage 0 baseline: main clean @87d6c295, branch created, pdfkit present, local DB up
- [ ] Stage 2 audit: database-reviewer (set infra) + backend-reviewer (PDF/brand) running
- [ ] Stage 4 manifest  - [ ] Stage 5 implement  - [ ] Stage 6 gates  - [ ] Stage 7 report

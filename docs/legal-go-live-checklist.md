# MintVault Legal Go-Live Checklist

Implementation tracking for the solicitor-approved legal pack. Update as items complete.

## Stage A — Infrastructure (engineering only, no flag flip)
- [ ] 1. This checklist file created
- [ ] 2. `shared/company.ts` centralised company info (placeholders for pending values)
- [ ] 3. Five missing slugs added: cookies, grading-standards, cancel, adr, vault-club-terms (placeholder MD files)
- [ ] 4. Slug renamed: guarantee → guarantee-and-correction-policy (+ redirect for old slug)
- [ ] 5. Top-level route redirects added for all 9 legal paths → /legal/<slug>
- [ ] 6. V2 footer legal column flag-gated, correct URLs, company info from shared/company.ts
- [ ] 7. Cookie consent banner (strictly-necessary only, localStorage + audit_log)

## Stage B — Go-live (only when external inputs landed)
Requires all of:
- [ ] Companies House number received
- [ ] ICO registration number received
- [ ] Solicitor-approved content for all 10 MD files (the original 9 plus vault-club-terms, added Step 5e)
- [ ] Final lastUpdated / effectiveFrom dates from solicitor
- [ ] TERMS_VERSION bumped from `v1.0-draft-pre-solicitor` to final value
- [ ] shared/company.ts placeholders replaced with real values
- [ ] LEGAL_PAGES_LIVE feature flag flipped to true
- [ ] Privacy policy final review
- [ ] Full QA pass on all 10 pages (mobile, desktop, no tracked changes, no inline comments)

## Stage B — Release-ready sign-off (post-flag-flip)
- [ ] Footer links all resolve to live pages
- [ ] Checkout acceptance checkbox active and enforces terms version
- [ ] Order confirmation email V2 (with legal links block) sending correctly
- [ ] Submissions table writes terms_accepted + terms_accepted_at + terms_version
- [ ] Audit log entry on each acceptance
- [ ] Cookie consent banner visible on first visit, persists across sessions
- [ ] /adr page lists current ADR participation status (Retail ADR or equivalent)

## Rules (locked)
- Do not publish placeholder-heavy pages as "finished"
- Do not leave dead links in the legal pack
- Do not deploy half-finished legal implementation
- ICO registration number required on Privacy Policy + Cookies Policy before flag flip
- Retail ADR participation status required on /adr before flag flip
- Solicitor wording is approved — do not rewrite unless fixing route names, formatting, or broken references

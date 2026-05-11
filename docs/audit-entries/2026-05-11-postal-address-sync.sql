-- MintVault postal address consolidation — 2026-05-11.
-- One-off audit row documenting the canonical-source extension and the
-- downstream consumer refactor + new customer-facing surfaces.
--
-- Run against PROD after the merge of PR
-- "feat(company): sync postal address from canonical source
--  (2 Temple Gardens, Strood, Kent, ME2 2NG)".
--
-- Code change summary:
--   - shared/company.ts: tradingAddress {city, country} → postalAddress
--     {line1, line2, city, postcode, country, displayName}, plus
--     registeredOffice + tradingAddress both pointing at the same record,
--     plus formatPostalAddress() helper.
--   - Three hardcoded address sites (shipping-label, packingSlip,
--     submit-success) now read from COMPANY.postalAddress.
--   - Three customer-facing surfaces gained the full address inline
--     (help/faq, help/contact, submission emails).
--   - Locality "Rochester, Kent" replaced with "Kent" in operational
--     footer strings (cert grading-report + PDF footer).
--   - Legal markdown placeholders ([REGISTERED OFFICE]) NOT filled in
--     this PR — that's part of the Stage B legal pack bundled deploy.
--     TODO comments added at the top of each .md file with the address.

INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
VALUES (
  'company_settings',
  'postal_address',
  'company_info_update',
  'cornelius',
  '{
    "before": {
      "tradingAddress": { "city": "Kent", "country": "United Kingdom" },
      "registeredOffice": "not_present",
      "postalAddress": "not_present",
      "consumers_with_hardcoded_address": [
        "server/shipping-label.ts:28-35",
        "server/packingSlip.ts:249-253",
        "client/src/pages/submit-success.tsx:138-143"
      ]
    },
    "after": {
      "postalAddress": {
        "line1": "2 Temple Gardens",
        "line2": "Strood",
        "city": "Kent",
        "postcode": "ME2 2NG",
        "country": "United Kingdom",
        "displayName": "MintVault Grading"
      },
      "registeredOffice": "alias_of_postalAddress",
      "tradingAddress": "alias_of_postalAddress"
    },
    "scope": "canonical record extended, consumers refactored, customer-facing surfaces updated",
    "stage_b_pending": "content/legal/*.md [REGISTERED OFFICE] placeholders left for bundled legal-pack deploy"
  }'::jsonb,
  NOW()
);

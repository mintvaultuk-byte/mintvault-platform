-- P5 — canonical Stripe currency for Partner Grading Credit packs.
--
-- A Stripe Price ID alone identifies the product but does not let the grant boundary state the
-- currency it expects.  Store the configured ISO-4217 code beside that ID, then fail closed in the
-- webhook grant until BOTH values are present and match Stripe's verified Checkout line item.
--
-- Additive and deliberately nullable: existing owner-configured Price rows are not rewritten by a
-- migration or guessed into GBP. They remain non-purchasable/non-grantable until an owner records
-- the true currency through the approved configuration process.

ALTER TABLE partner_credit_packs
  ADD COLUMN IF NOT EXISTS stripe_currency text;

ALTER TABLE partner_credit_packs
  ADD CONSTRAINT chk_partner_credit_packs_stripe_currency
  CHECK (stripe_currency IS NULL OR stripe_currency ~ '^[a-z]{3}$');

# Change manifest — mintvault-stripe-credit-purchase

| Area                  | Change                                                                                                                                                             | Classification | Recovery |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | -------- |
| Real PostgreSQL tests | Extend the existing wallet service fixture to drive paid purchase fulfilment, duplicate/concurrent replay, metadata forgery, cross-tenant replay and retryability. | A              |
| Governance/proof      | Record the test boundary and the absent external Stripe TEST credential separately.                                                                                | A              |

No production credit, Stripe, webhook, package, price, permissions, RLS, migration or deployment
code changes are needed because the authoritative implementation already satisfies the validated
local contract.

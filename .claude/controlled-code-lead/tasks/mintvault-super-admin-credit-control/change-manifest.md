# Change manifest — mintvault-super-admin-credit-control

| Area                      | Change                                                                                                                  | Classification | Recovery |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- | -------- |
| Wallet dashboard contract | Replace the stale purchase-unavailable field with an immutable-ledger purchase-history projection and ledger reference. | D              |
| Super Admin wallet UI     | Render purchase history with pence/currency/source/reference and show reference in the general ledger.                  | D              |
| Browser fixture/tests     | Seed only synthetic local purchase data and prove the real dashboard HTTP/browser path.                                 | A/D            |

No migration, payment writer, Stripe configuration, ledger mutation semantics, RLS policy, public
API, live credential or deployment change is introduced.

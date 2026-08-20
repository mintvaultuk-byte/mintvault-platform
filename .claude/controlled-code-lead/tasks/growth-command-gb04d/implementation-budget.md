# Implementation budget — GB-04D Growth Command

**State:** AUTHORISED — Stage 4 complete.

- Product files: 9 (2 new).
- Focused test files: 5 (2 new).
- Handover: 1 new canonical document.
- Estimated product delta: 750–1,050 lines including types and safety comments.
- Estimated test/document delta: 550–850 lines.
- No dependency, migration, secret, auth, payment-flow, provider-write or infrastructure change.

The 25% stop/re-manifest rule applies. Any need for a file outside the manifest,
a migration, or protected mutation stops only that lane and requires a manifest/gate update.

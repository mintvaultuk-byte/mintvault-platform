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

## PR #322 CI-repair budget — owner authorised 2026-08-20

- Functional files: 5 existing test/harness/CI files; zero product-runtime files.
- Durable evidence files: up to 5 existing GB-04D governance records.
- Estimated functional delta: 70–130 changed lines.
- Estimated evidence delta: 40–90 changed lines.
- Estimated commits: 1 repair commit.
- Focused proof: 4 workstation/evidence test files plus the Command Centre harness file.
- Full proof: typecheck, lint, full Vitest, build, graph, governance/postflight,
  hostile review, then exact-SHA remote CI/security/governance checks.
- Explicit exclusions: no dependency, migration, secret, auth, payment, product
  runtime, provider, infrastructure, Partner or Scanner change.

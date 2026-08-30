## Change authority

- [ ] I linked the issue/register entry or explained why this is maintenance-only.
- [ ] I classified the risk and identified protected areas touched.
- [ ] I used Graphify for navigation where available and verified conclusions against source, schema, routes, and tests.

Issue / evidence:

Risk and protected areas:

## What changed

Describe the customer or operational outcome, not only the files changed.

## Proof

- [ ] Relevant focused tests pass.
- [ ] Typecheck, lint, build, and the required repository gates pass.
- [ ] Failure paths, retry/idempotency, authorization, and tenant boundaries were tested where applicable.
- [ ] New tests were mutation-checked or otherwise shown to fail against the defect.
- [ ] Skipped tests and environmental exclusions are listed below; none are silently treated as evidence.

Commands and results:

## Data and rollout safety

- [ ] No migration, or the migration is additive/expand-first and rerunnable.
- [ ] Rollback/forward-recovery and runtime compatibility are described.
- [ ] No staging or production data, schema, secrets, payment configuration, or deployment was mutated by this PR.

Migration / rollback / recovery notes:

## Security and privacy

- [ ] Authentication, authorization, tenant isolation, payment, NFC, certificate identity, evidence retention, and secret exposure were considered as applicable.
- [ ] Logs and fixtures contain no customer data, credentials, raw scanner evidence, or local runtime artifacts.

## Review and release evidence

- [ ] CODEOWNERS review is requested.
- [ ] Independent hostile review is complete for consequence-bearing changes.
- [ ] Review findings are fixed or explicitly owner-accepted with evidence.
- [ ] The exact commit SHA reviewed and tested is recorded below.
- [ ] This PR does not authorize deployment, publishing, or release.

Reviewed/tested SHA:

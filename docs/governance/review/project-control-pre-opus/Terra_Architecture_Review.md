# Internal architecture review (requested Terra label)

Executed on the Codex GPT-5 surface, not an attested Terra run. Independent Opus architecture review is pending.

Project Control is layered as UI → GET route/auth+flag guard → service cache → scanners/governance loader → status engine. The route and scanner layers are read-only. Repository inspection uses a fixed repository root and `execFile` with fixed Git arguments, a five-second timeout and a bounded buffer; no shell is invoked. Deployment and database evidence use bounded reads; failures are isolated into unavailable evidence instead of leaking raw errors.

Review fixes: (1) conservative readiness/confidence calculation and evidence de-duplication; (2) failed tests hard-block and skipped/missing test evidence caps readiness; (3) 30-second snapshot cache plus in-flight de-duplication; (4) sanitised locators/payloads/errors; (5) stable content-addressed continuation prompts; and (6) append-only database protection.

The candidate changes central registration files only where necessary: `App.tsx`, admin shell, feature flags, route registration and schema. It does not alter submissions, grading, certificates, labels, NFC, payments, wallets, Partner code, corrections or Vault Quest runtime paths. The remaining architecture review question is whether governance requires durable, approved prompt/status/evidence writers; today the feature deliberately creates none.

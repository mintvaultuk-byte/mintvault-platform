# Deployment state — mintvault-partner-onboarding-readiness

- Production/staging, hosted databases, real Stripe, R2, email, and remote git are not contacted.
- Local proof uses the already-task-labelled disposable loopback PostgreSQL/MinIO environment and
  deterministic test-only Super Admin/Partner identities.
- This read-only readiness feature creates no migration and no externally persistent record.

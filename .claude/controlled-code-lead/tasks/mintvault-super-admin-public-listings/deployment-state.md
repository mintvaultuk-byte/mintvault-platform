# Deployment state — mintvault-super-admin-public-listings

- Production/staging, hosted databases, real Stripe/R2/email and remote git are not contacted.
- Proof runs only against the established task-labelled local PostgreSQL/MinIO environment using
  synthetic admin/Partner identities.
- The local browser may mutate only its dedicated fresh browser database, using existing audited
  listing endpoints; no shared or live tenant is in scope.

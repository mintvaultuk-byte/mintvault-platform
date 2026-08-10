# Deployment state — mintvault-supplies-orders

- Production/staging: not queried, contacted or mutated.
- Remote git: not pushed.
- Local target: task-labelled loopback PostgreSQL 17 on `127.0.0.1:55471` and task-labelled MinIO on `127.0.0.1:9011`; dedicated browser/HTTP databases and buckets were recreated locally only.
- Credentials: generated synthetic values supplied to local child processes only; no environment file is written.
- Stripe: no credential configured; no provider API call was attempted.

# Owner approval record — GB-04D

## 2026-08-20 — controlled production activation

The owner's GB-04D command explicitly authorizes a controlled production activation release of the exact GB-04D candidate only after all security/release gates pass. The authorization applies to:

- operation category: production application deployment;
- environment: Fly app `mintvault` production;
- scope: the exact GB-04D release candidate produced by this task;
- phase/expiry: once, during this task, after exact-SHA CI, staging proof, hostile review and rollback gates are green.

It does **not** authorize:

- Git push (separately protected by repository governance);
- migration application or production data mutation;
- secret/environment changes or credential rotation;
- payment/webhook or login/session/auth semantic edits;
- infrastructure machine/CPU/RAM changes or additional spend for proof;
- guarded-auto activation;
- Neon compute mutation;
- destructive action or force push.

If any excluded action becomes necessary, the Lead must request one narrow owner decision and continue all other independent work.

# Architecture before repair

```text
Fly public HTTP service
  -> Express trust proxy=1
  -> Admin middleware (raw leftmost XFF in inherited controls)
  -> persisted Command Centre Pilot Flag
  -> requireSuperAdmin
  -> dashboard route
       -> core adapter: 9 eager SQL statements / primary pool max 8
       -> Partner adapter: bounded page 100 but 7+ reads per row / pool max 4
       -> deterministic composition: fixed KPI + attention envelopes
  -> React Query global staleTime=Infinity, URL-only privileged cache key
  -> one flat Command Centre sidebar link
  -> single page: KPI -> attention -> flat inline registry list
```

Failure boundaries before repair:

- response deadlines abandon promises without ending database work;
- incomplete Partner page can become authoritative zero;
- node-postgres Date can crash lexical attention sort;
- UTC-naive payment storage is compared with London wall clock;
- cached privileged payload bypasses later auth/flag checks;
- route and UI semantics do not preserve 401/403/404, hierarchy, freshness or focus lifecycle;
- signal cleanup is not lifecycle-owned;
- rollback points at a forward-deploy script rather than an image.

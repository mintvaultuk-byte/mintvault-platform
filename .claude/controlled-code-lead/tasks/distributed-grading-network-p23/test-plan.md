# Test plan

1. Disposable PostgreSQL migration: reapply/no-op, grants, RLS/FORCE, all indexes and append-only records.
2. Station identity: server-generated ID, unique public-key fingerprint, tenant/location FK, pending/active/suspended/revoked transitions.
3. Signature: valid canonical request succeeds; wrong method/path/body/timestamp/nonce/key fails; replay is rejected.
4. Authorisation: human Partner session + active station + same tenant/location only; disabled user, disabled org/location, suspended/revoked station and outdated build fail closed.
5. Capture: same-station claim/begin/evidence only; another station, wrong side/card, stale target and duplicate accept fail with no master replacement.
6. Heartbeat/calibration: bounded current-state upsert, event on semantic transition only, scanner replacement/profile or jig change invalidates calibration.
7. Fleet reads: server-side bounded pagination/filtering/search and expected query indexes.
8. Staging: a disposable PostgreSQL integration test proves grant coalescing,
   candidate mismatch refusal, single-flight finalisation, cross-station denial,
   retry reset, exclusive cleanup lease and bounded global session expiry.
9. Regression: scanner app, LiDE profile/frame, partner auth/RBAC and evidence suites; then controlled local load simulation with metrics clearly marked as simulation.
10. Held-out non-production proof: run the direct R2 PUT → server finalise →
    immutable promotion/retry/cleanup flow with representative LiDE TIFFs, then
    use `scripts/load/scanner-platform-load.ts` for 100/500/1,000 station and
    upload scenarios. Retain p50/p95/p99, memory, pool and R2 evidence.

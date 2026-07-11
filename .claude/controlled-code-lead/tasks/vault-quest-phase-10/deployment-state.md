# Deployment state — vault-quest-phase-10

## Branch topology (after owner-authorised D1)
- **Working branch:** `vault-quest-phase-10` @ `01210bd` = `governance-phase-9` (cc7fd4b) + cherry-pick of 8A (32f3f2b → new sha 01210bd). Carries: governance Phase 9 (cfe775a/2d98e38/cc7fd4b) + VQ 1–7 substrate (…6439350) + 8A tooling/evidence. Governance framework AND VQ substrate both present in the tree.
- **Untouched:** `main`=6439350, `governance-phase-9`=cc7fd4b, `vq-phase8-staging-integration`=32f3f2b. Nothing pushed.

## Local integration DB (D2 — throwaway, isolated)
- **Identity:** `mintvault_vq_phase10_local` on `127.0.0.1:55432` (PostgreSQL 16.13, Homebrew).
- **Data dir (isolated):** `…/scratchpad/vq-phase10-pgdata` (not shared with any other PG instance).
- **Socket:** `/tmp/.s.PGSQL.55432` (distinct port 55432 — no collision with the existing 5432).
- **Auth:** trust, localhost-only (`listen_addresses='127.0.0.1'`); NO production credentials.
- **TEST_DATABASE_URL:** `postgresql://postgres@127.0.0.1:55432/mintvault_vq_phase10_local`
- **Migrations applied to THIS local DB only:** 0008, 0009, 0010, 0011 (4 vq_ tables verified;
  partial-unique idempotency guard fires 23505). Version caveat: local PG16 vs staging PG17 —
  the tested DDL (gen_random_uuid, CHECK, partial index) is PG13+-compatible; behaviour matches.

### D2 safety checks (all green)
- Binds 127.0.0.1 only ✓ · db name carries `phase10`/`local` marker ✓ · isolated data dir ✓
- Connection host is `127.0.0.1`, NOT `ep-purple-voice` (staging) / `ep-wispy-morning` (prod) / neon ✓
- No prod creds reused ✓ · separate cluster/storage ✓
- Integration tests will use an explicit local URL + `NODE_ENV=test`; a hard host-allowlist guard
  (refuse if host ∉ {localhost,127.0.0.1} or db name lacks a local/test marker) will prevent any
  fallback to `.env` staging.

## PROOF staging/production were NOT touched
- No migration applied to staging/prod this phase (only the local throwaway DB).
- No connection opened to `ep-purple-voice`/`ep-wispy-morning` for any write.
- No deploy, no push, no secret, no R2/B2, no paid provider call.

## Cleanup (run only AFTER all Phase-10A evidence is captured)
```
export LC_ALL=C
pg_ctl -D "…/scratchpad/vq-phase10-pgdata" stop
rm -rf "…/scratchpad/vq-phase10-pgdata"
```

## Production / staging identities (for later phases — confirm, don't assume)
- Prod DB `ep-wispy-morning-ab6f4o08`; staging DB `ep-purple-voice-abfez796`. Prod Fly `mintvault`;
  staging `mintvault-v2`. R2/B2 staging-vs-prod identity UNCONFIRMED — a 10B gate.

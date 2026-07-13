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
- **Migrations applied to THIS local DB only:** 0008, 0009, 0010, 0011 (4 vq\_ tables verified;
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

## Deploy-time DB requirement (R5-F5) — read before scheduling the 10A-8 B2 worker anywhere

VQ writes (this includes `scripts/vq-backup-artwork-to-b2.ts`'s `backup_state` UPDATEs, and every
`vq_artwork_revisions`/`vq_cards`/`vq_characters` write from 10A-6's promote/restore paths) must run
against Neon's **UNPOOLED** connection string with `search_path=public` set explicitly — not the
pooled/pgbouncer endpoint the app's default `MINTVAULT_DATABASE_URL` otherwise uses. This is carried
over from prior session memory (`project_vq_character_bible_deployed`), not re-derived here — it has
NOT been re-proven this phase. Before the B2 worker (or any 10A-6/10A-7 write path) is ever scheduled
against staging/prod:

1. Confirm which env var the deployed process actually reads for its VQ DB connection (currently
   the code reads the SAME `MINTVAULT_DATABASE_URL` as grading — there is no separate
   `VAULT_QUEST_DATABASE_URL` wired yet outside the still-unmerged `vq-infrastructure-separation`
   branch; see `project_vq_infra_separation_phase12` memory).
2. If that connection string points at a pooled Neon endpoint, VQ writes are at risk of the known
   pooled-connection failure mode (silently dropped/hung transactions) — switch it to the unpooled
   host for any process that writes `vq_` tables, or provision the separate VQ DB per the
   infra-separation branch first.
3. Re-verify `search_path=public` is in effect (Neon branches occasionally differ here) before
   trusting an unqualified `vq_artwork_revisions` query against a fresh branch.
   This is a **10B/staging-deploy gate**, not something a local session can prove — flagging it here so
   it isn't silently assumed away when 10A-8 eventually gets scheduled for real.

## Production migrations 0008–0014 APPLIED (2026-07-13, owner-approved)

Owner explicitly approved applying migrations-vq/0008 through 0014 to **production**
(`ep-wispy-morning-ab6f4o08`) ahead of deploying Phase 10A code, specifically so D10
idempotency (`vq_generation_requests`) is genuinely active rather than silently
degrading — discovered mid-deploy that prod had NONE of 0008-0014 applied (still
Phase-7E schema + the 5 independent label/scanner commits already merged straight to
`main`). Applied via a one-off script run over `fly ssh console -a mintvault`
(raw `pg` against the app's own `MINTVAULT_DATABASE_URL`, each statement executed
individually — no multi-statement transaction, so pooled-connection DDL risk does
not apply here specifically); confirmed via direct read-only schema query
(`information_schema.tables`) before and after; reapplied a second time immediately
after to prove idempotency (clean no-op, 0 errors, matching every other
`IF NOT EXISTS`-guarded migration this phase). Production now has all 26 `vq_` tables
including `vq_generation_requests`, `vq_artwork_revisions`, `vq_feature_flags`,
`vq_export_jobs`, `vq_config`, `vq_artwork_revision_events`. No grading/payment table
touched; no data in any existing table modified. The pooled-vs-unpooled concern above
is about the APP's own runtime write path at generation time, not this one-off DDL
apply — still an open, separately-tracked item, not resolved by this migration apply.

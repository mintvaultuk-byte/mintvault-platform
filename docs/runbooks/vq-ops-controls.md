# Runbook — Vault Quest emergency controls, observability & reconciliation (Phase 7E)

> VQ-only. None of these controls can disable grading, certificates, payments,
> labels, submissions, users, or authentication.

## 1. Emergency feature flags (kill switches)

Precedence: **env HARD-OFF > DB flag > default-ON** (`lib/vq-feature-state.ts`,
`vqFeatureState`).

- **Env kill switches** (always available, DB-independent, identical on both Fly
  machines via a secret; a truthy value forces OFF and beats any DB state):
  - `VQ_GENERATION_DISABLED` — pause all paid generation.
  - `VQ_EXPORTS_DISABLED` — pause exports.
  - `VQ_READONLY` — read-only maintenance (disables **writes AND generation**;
    read-only exports stay up).
  - `VQ_PROVIDER_OUTAGE` — pause generation during a provider outage.
  Set with `fly secrets set VQ_GENERATION_DISABLED=true -a <app>` (triggers a
  rolling restart). Unset to fall back to the DB flag / default-on.
- **DB flags** (`vq_feature_flags`, migration `0011`) — the normal runtime toggle
  that propagates to both machines **without a restart** (30s cache). A row ABSENT
  = default-on, so a missing/empty table never disables VQ. `DROP TABLE` is safe
  (reader soft-fails to `{}`).

**Disabled route behaviour:** `vqDisabledResponse` returns **503 + `Retry-After: 120`**
(a temporary maintenance state, not a 403 authz denial) with `{ disabled, feature,
reason, source }`. The generation guard rejects BEFORE any provider call, so a
disabled feature spends nothing.

**Status (implemented / deferred):** the pure evaluator + 503 response are
implemented + unit-tested (16 cases). Mounting `requireVqFeature(feature)` onto the
generation/exports/writes routes, the `getVqDbFlags()` cached reader, the admin
toggle UI, and the audit-on-toggle are Category B/C/D (designed in the Phase 7
report) — they touch live routes and are best eyeballed on staging.

## 2. Observability surface (design)

An admin-only `GET /api/admin/vault-quest/status` (inherits `requireAdmin` + IP
allowlist), aggregated with the `safe()`/degrade pattern so a missing table never
500s the page:

- **Available now (pure/A):** Higgsfield status enum (`deriveHiggsfieldStatus`, no
  paid call), feature-flag resolved state per feature (env layer), DB `SELECT 1`
  health, R2 `headR2` health, which `vq_` tables exist, generation counts/rate +
  estimated credits (from `vq_ai_generations`).
- **Table-dependent (C):** true cross-machine export queue depth / stuck / failed
  (needs `vq_export_jobs`, Phase 7A); duplicate-request blocks + charged-credit
  truth (needs `vq_generation_requests`, Phase 7B); orphan / missing-R2 / failed-B2
  counts (needs the reconciler + B2 vq worker).
- **Two warnings:** the in-memory export queue and any in-memory provider-outcome
  are **per-machine** — label those fields "this machine only". The DB feature-flag
  layer is the only part that reliably propagates a toggle to both machines without
  a restart; the env kill switch is the only always-available hard-off.

## 3. Orphan reconciliation (read-only)

`scripts/vq-reconcile-orphans.ts` — READ-ONLY, DRY-RUN ONLY. Lists `vq/` objects +
selects VQ rows, diffs via the pure `reconcile()` logic, prints counts + safe
identifiers + JSON. **It never writes or deletes.**

```
npx tsx --env-file=.env scripts/vq-reconcile-orphans.ts [--set=GNV] [--ttl=30d] [--min-age=7d] [--json] [--prod]
```

- Refuses a PRODUCTION host unless `--prod` is passed (read-only either way).
- `--delete` is **refused** (`exit 2`) — deletion is a separate, owner-gated,
  unbuilt step.
- Exit: `0` clean · `1` integrity failures · `2` usage/refusal · `3` runtime error.

**Categories detected:** candidate-missing-object, object-missing-row (safe-orphan
vs too-new), retention-expired safe orphans, referenced-by-pack (protected),
dangling-pack-ref, duplicate-approved-slot, wrong-prefix. **Blocked-on-infra
(reported as notes, not run):** hash-mismatch (no sha column yet), temp-export-
expired (no R2 export producer), provider-completed-unpersisted (needs
`vq_generation_requests`).

**Never classed safe:** anything referenced by a pack / approved field / release /
export; any current candidate; anything newer than the TTL / min-age. An approved
character owns BOTH its candidate object AND its deterministic approved object —
both are protected by independent rules.

## 4. Future cleanup safeguards (design only — deletion NOT built)

Before any deletion is ever implemented (a separate, owner-approved task): min
retention TTL; reference re-check immediately before delete; DB re-check AFTER the
object listing (TOCTOU); object hash/etag confirm; deletion audit log; max batch
cap; rate limit; resumability; NO delete outside `vq/`; NO grading/cert delete
permission; a reviewable manifest before delete; a soft-delete restore window.

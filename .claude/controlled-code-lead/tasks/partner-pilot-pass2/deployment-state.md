# Deployment state — Partner Pilot Pass 2

> ## ⚠️ CORRECTED 2026-08-14 16:3x UTC by task `partner-final-rc-reconciliation`
>
> **Everything in the "Production" section below is STALE by 5 releases / 23 commits.**
> It is preserved for provenance, not for use. Verified current truth:
>
> | | |
> | --- | --- |
> | **Live production** | **v1083 / `067ed0c6`** — `curl https://mintvaultuk.com/api/version` |
> | Machines | `683720eb5127d8` + `83d479c745d0d8`, both `started`, 1/1 passing, both on v1083 |
> | Live == `origin/main` | yes, `067ed0c6` exactly |
> | Partner surface | `/api/partner/me` → **401** (router MOUNTED with a pre-routing auth gate). A fake non-partner path returns 404, so this is genuinely mounted. **The "503 safe refusal" recorded below is no longer true.** 401 proves mounting, NOT flag enablement — that needs an owner-gated config read. |
>
> Production moved v1079–v1083 across 2026-08-12 and 2026-08-14 via **concurrent sessions** while
> this record stayed frozen. Nothing in this task deployed it.
>
> **Before any production action, re-read `fly releases` and `/api/version` again** — production was
> deployed twice during a single reconciliation pass on 2026-08-14, so any recorded SHA goes stale
> quickly. See `tasks/partner-final-rc-reconciliation/RC-RECORD-FINAL.md`.

## Production

- Live commit: `b0de088032f82c67564de4337e915649a4306019`, confirmed through
  `/api/version` on 2026-08-12 12:40:53 UTC.
- Live build reported: `MV-P5-20260225-nohalf`.
- Health: `200 {"status":"ok"}`.
- Partner health: both tested Partner endpoints returned `503`, a safe refusal
  that must not be bypassed by deploying an unconfigured runtime.
- Fly release number, exact migration journal, runtime role identity and secret
  values: not yet read from an authorised production control plane. No secrets
  will be printed or changed by this task without owner approval.

## Candidate

- Branch: `codex/partner-pilot-pass2`.
- Baseline: `origin/main` `864fadeda88e06e083bfa483a7fe33520a4570e2`.
- Relationship: baseline is one descendant commit after production
  `b0de0880`; Pass 1 `7368b07e` is one descendant commit after baseline.
- Pushed: no. Deployed: no.

## Known divergence / concurrency

- Root worktree `psp/partner-rbac-hybrid` is dirty and owned by another active
  task; it will not be edited or deployed from this task.
- Multiple historical Partner/scanner worktrees exist. Their commits are not
  integration authority; source and lineage must be revalidated before reuse.

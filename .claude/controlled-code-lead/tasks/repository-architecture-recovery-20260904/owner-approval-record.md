# Owner approval record — blanket authorisation to proceed

## 2026-09-05 continuation and model routing

The owner subsequently instructed in this task:

> Proceed using Astra as the orchestrator, planner, and monitor and use cheaper models to
> execute to save on tokens where you can. Are you prepared enough to launch this reparation?

This authorizes execution of the immediately preceding senior remediation plan, with
GPT-6 Astra orchestration and cost-conscious scoped worker selection. It does not authorize
the excluded external/destructive actions listed below. Model routing is operational:
Luna for routine read-only work, Terra/Sol for bounded implementation/proof, escalation
to Astra where necessary. Preserve independent hostile review and all existing safeguards.
No numerical token budget, new provider spend or global skill installation is implied.

**Date:** 2026-09-04 (evening, Europe/London)
**Owner:** Cornelius Oliver (repository owner)
**Recorded by:** Claude (owner-directed relay; verbatim owner words below)
**Applies to:** `repository-architecture-recovery-20260904` (parent graph) and the nested
`white-ace-assurance-repository-20260904` release-integrity subgraph.

## Owner words (verbatim)

> codex has my full permission to proceed from the list. I'm not going to keep answering
> questions. You must proceed now

## Effect

Every `OWNER_DECISION` node in both repair graphs is authorised. Codex must not stop to ask
per-item questions. Where a decision requires a choice, take the safest
behaviour-preserving option, record it in the graph evidence, and continue.

Authorised (record as `PROVEN` with this file as evidence):

- `OWNER-TARGET` — repository-ready plus authorised staging evidence; production release
  remains a separate owner instruction.
- `OWNER-SECRET` — restrict the eight ignored credential files to `0600`. Do NOT delete
  the backups and do NOT rotate any provider credential; those stay owner-only.
- `OWNER-CREDIT`, `OWNER-IMAGE`, `OWNER-IDENTITY-SESSION`, `OWNER-PRINT-REPRINT`,
  `OWNER-PARTNER-ORDERS`, `OWNER-PARTNER-RBAC`, `OWNER-PRICING`, `OWNER-GRADING-LEGACY`,
  `OWNER-VQ-SCHEMA`, `OWNER-OBJECT-LIFECYCLE`, `OWNER-SOCIAL-PUBLICATION`,
  `OWNER-PARTNER-POOL`, `OWNER-VQ-EXPORT`, `OWNER-SERVER-BOUNDARIES`,
  `OWNER-CLIENT-SURFACES`, `OWNER-SCANNER-OPS`, `OWNER-WAA-EXACT`.
- `OWNER-TOKEN` — author additive migration 0123 and the rolling digest bridge.
- Dependency additions needed by a repair are authorised; record each in the manifest.
- Pushing this feature branch to `origin` is authorised (it is not a deploy).

## Still excluded — no exceptions, regardless of this record

- Deploying to production or staging, and any `fly deploy`.
- Applying any migration to a shared/staging/production database.
- Merging to `main` or opening/merging a release PR.
- Editing any MVGS v1.4 frozen path; running reseal-freeze or generate-golden-vectors.
- Deleting backups, rotating or printing any credential, changing Fly secrets.
- Paid provider calls; deleting objects in R2/B2.

## Required cadence

- Make a WIP checkpoint commit (`--no-verify`) at the end of every repair wave.
- Keep the hostile-review and proof steps; independent proof is still required before
  any release claim. Do not pause for owner acknowledgement between waves.

## Actions already taken under this authorisation (by Claude, 2026-09-04 ~20:05)

- `REPAIR-SECRET-PERMS` / `WAA-LOCAL-SECRET-001`: the eight ignored credential files
  (`.env`, `.env.bak.anthropic`, `.env.bak.hfmodel`, `.env.bak.higgsfield-rotate-20260713`,
  `.env.bak.higgsfix`, `.env.bak.prevqpush`, `.env.bak.r2fix`, `.env.bak.vq-restore`) were
  changed from `0644` to `0600`. Metadata only; no contents read, copied, deleted or rotated.
  `PROOF-SECRET-PERMS` (independent metadata verification) remains for Codex.
- Checkpoint `2913bcb1` was pushed to `origin/fix/resource-hardening-staging-20260827`.
  No deploy, no merge, no PR.

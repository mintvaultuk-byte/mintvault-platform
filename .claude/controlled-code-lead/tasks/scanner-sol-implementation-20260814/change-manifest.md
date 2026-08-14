# Change manifest — WP0 factual baseline and campaign control plane

**Date:** 2026-08-14
**Lead session:** `codex/scanner-sol-implementation-20260814` at base `d44a2c53`

## Findings addressed

- WP0-1 — MintVault was not Engineering OS-enrolled and had no current graph — Class D.
- WP0-2 — No isolated Scanner branch/base/register/contracts existed — Class G.
- R-9 — P14 is not frozen; establish an explicit non-authority base and reconciliation boundary — Class H/G.

## Files changed in WP0

| Area | Change | Why | Class |
|---|---|---|---|
| `.engineering/**`, `engineering/**` | Enroll OS, define risk/protected paths, canonical issue/proof ledgers | Required governance and evidence source | D |
| `AGENTS.md`, `CLAUDE.md`, ignore files, governance workflow | Add OS-managed load/gate blocks | Deterministic future enforcement; additive only | D |
| `.claude/controlled-code-lead/INDEX.md` | Register campaign | Durable recovery | G |
| `tasks/scanner-sol-implementation-20260814/**` | Add baseline, manifests, contracts, architecture and reconciliation evidence | Mandatory Stage 0-4 control state | G |

The OS enrollment prerequisite was applied after a successful dry-run while the
new worktree was clean, because the enrollment command intentionally refuses a
dirty repository. Its generated plan is captured in command evidence.

## Explicitly not touched in WP0

- `scripts/scanner-app/**` — source verification only.
- `server/**`, `shared/**`, `migrations/**` — Partner/server authority remains unchanged.
- Active Partner pass2 — strictly read-only.
- MVGS scoring/threshold/label behavior — outside authorisation.

## Protected actions

- No push, deploy, migration application, secret access/change, Apple credential use, production/staging mutation, payment call or destructive operation.
- Owner approval for this isolated WP0 campaign is the attached master implementation prompt dated 2026-08-14.

## Order

1. Establish exact heads/status/origin and lineage.
2. Create isolated worktree from immutable committed Partner seed.
3. Enroll OS, preflight at HOSTILE, build graph.
4. Record canonical issues/proofs/contracts/reconciliation boundary.
5. Run WP0 governance and drift gates.

**Approved to proceed:** owner master prompt; no protected external action in WP0.

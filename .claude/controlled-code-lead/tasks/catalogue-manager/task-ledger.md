# Task Ledger — Catalogue Manager (final Catalogue & Classification build)

## Stage 0 — Baseline (2026-07-24)

- **Task dir:** `.claude/controlled-code-lead/tasks/catalogue-manager/`
- **Worktree:** `/Users/cornelius/mintvault-catalogue-wt`
- **Branch:** `feat/catalogue-manager` off `origin/main` @ `0194cbff` (includes PR #238 four-stage workstation)
- **Main repo branch at start:** `codex/super-admin-correction-mode` @ `0fedce6e` with UNRELATED dirty files (correction-mode work) — must NOT be touched/clobbered. Worktree isolates us from it.
- **Governance:** controlled-code-lead v1.1
- **Prod:** NOT deploying. Staging only, after all gates + owner migration approval.

### Scope (owner-authorised)
Replace hard-coded rarity/finish/promo/etc. lists with a DB-backed Catalogue Management
System (Super Admin → System → Catalogue Manager). 8 categories: Rarities, Finishes,
Promo Types, Designations, Languages, Eras, Optional Subsets, Optional Card Attributes.
Full CRUD + enable/disable + search/sort/reorder + archive/restore + notes + created-by
+ timestamps + active/inactive. Validation (dup value, dup abbrev, one-category-only,
aliases). Live pickers load from DB. Per-user recently-used + favourites. JSON import/export.
Audit log (who/when/old/new/reason). Live read-only certificate FRONT preview in the
workstation reusing the REAL render pipeline (no approximation, no duplicate). Comprehensive
regression tests. Reuse canonical `shared/pokemon-rarity-catalogue.ts` shape — no duplicate systems.

### Prohibited / protected (require explicit owner approval)
- Migration apply (`db:push` / raw DDL / apply script) to ANY env — author only, apply gated.
- Deploy / push to prod. (Staging only, after gates + approval.)
- Modify MVGS scoring, grading logic, centering, Pristine gate, approve-lock. (mvgs-grading-protected)
- Modify certificate/label RENDERING (server/labels.ts, server/certificate-document.ts) — REUSE only.
- Auth-logic edits; Stripe/payment edits; secret changes; dependency installs.

### Canonical system to reuse (NOT duplicate)
- `shared/pokemon-rarity-catalogue.ts` — types (PokemonRarity/Finish/Promo/Language + symbol
  metadata), pure helpers, and the current hard-coded arrays (become DB SEED + fallback).
- `shared/structured-variant-validate.ts` — server authority; must read catalogue from DB.
- PR #204 structured columns on `certificates`; `/api/admin/rarity-preferences` (fav/recent).

## Stage 1 — Review plan
4 read-only reviewers spawned (frontend picker call sites / backend catalogue surface /
database schema+migration / label render reuse seam). Awaiting reports before manifest.

## Owner decisions (2026-07-24)
- Migration: **show me first** — 0019 authored + gated, NOT applied to staging.
- Seed: **arrays + spec examples** — seed derives from canonical arrays + designation extras.

## Stage log
- [x] Stage 0 baseline written
- [x] Stage 2 reviewer reports received + verified (4 reviewers: frontend/backend/db/label-render)
- [x] Stage 4 change manifest written
- [x] Stage 5 implementation (7 commits on feat/catalogue-manager)
- [x] Stage 6 regression: tsc 0 · lint clean · build OK · vitest 0 failures (MVGS 187/187, catalogue 33/33);
      14 failed FILES = pre-existing ephemeral-Postgres suites (env), none import catalogue code
- [x] Hostile review: 2 adversarial reviewers (security + correctness). Confirmed findings FIXED:
      CAT-01 (High picker crash), F1 (one-category single-sided bypass), CAT-02/F3 (emptied
      category resurrects seed), CAT-03 (multi-machine false-reject), CAT-04 (reorder collision),
      F4 (defect cap), F2 (import cap), CAT-06 (doc). Re-gated: tsc 0 / lint 0 err / build OK /
      vitest 1741 pass, catalogue 34/34, MVGS 187/187. Commit 8961d2e7.
      DEFERRED (documented, LOW, super-admin-only): F2 full O(N²) import refactor (table small,
      capped 5000); F5 abbreviation TOCTOU + metadata size (cosmetic label overflow); CAT-05
      initialLang seed resolution (languages stable). Security CLEAN: SSRF/file-read/cross-cert
      leak/injection/authz/SQLi/cache-poisoning all refuted.
- [x] Coordinated-release prep (2026-07-24): fetched origin; origin/main advanced 0194cbff→debea36b
      (+7: rarity-clear #239, print-workflow #240 = migration 0022). Full cross-branch migration
      collision scan done. Rebased feat/catalogue-manager onto debea36b (10 commits, tip f97fbd03,
      pushed). Reconciled: parity-test inventory (0019+0022), picker emit-guard (#239 preserved +
      catalogue repoint), partner-credit rollback test (0019 journal cleanup), label-preview ReDoS.
      PR #243 opened. CI: functional GREEN (Lint/Type/Test&Build pass on Linux, CodeQL-SAST/dep-review/
      gitleaks pass); CodeQL code-scanning RED = 1 HIGH js/polynomial-redos at PROTECTED labels.ts:384
      (newly reachable via preview input; runtime-mitigated by 200-char cap + whitespace collapse) —
      needs owner decision (approve protected regex hardening vs justified dismissal). labels.ts UNCHANGED.
- [ ] Owner gate: apply migration 0019 (provisional) + seed to STAGING (awaiting explicit yes)
- [ ] Owner decision: CodeQL HIGH on labels.ts:384 (protected) — regex hardening vs dismissal
- [x] Stage 7 report → owner

## Proof level: **Local Proof** (all local gates green). Staging/Activation BLOCKED on owner
   migration approval. No prod. Rollback: migrations/rollback-0019-catalogue-manager.sql (non-numbered);
   code lives only on feat/catalogue-manager (unpushed worktree).

# Project Memory — MintVault

**What this is:** permanent engineering knowledge for this repository. Not
conversation memory — long-term facts a new session needs to work safely.
**Required reading at the start of every coding session** (see SKILL.md
"Session recovery"). Only the Lead session updates this file; update it when
a decision is made or an assumption is discovered, not retroactively.
Never record secrets, passwords, tokens, or connection-string credentials here.

---

## Architecture

- Express API (`server/index.ts` → `server/routes.ts`) + React SPA
  (Wouter, TanStack Query v5, Shadcn) built by Vite; single Fly.io app serves
  both. Storage layer behind `IStorage` in `server/storage.ts`; all tables/
  types/Zod schemas in `shared/schema.ts` (imported via `@shared/`).
- Vault Quest (VQ) is a second product inside the same repo/app: `vq_`-prefixed
  tables in `shared/vq-schema.ts`, admin studio under
  `/admin/vault-quest/studio`, builder scripts in `scripts/vault-quest-builder/`.
- Stripe webhook must be registered **before** `express.json()` (raw body).
- Cert IDs stored normalised (`MV-0000000001` → `MV1`); use `normalizeCertId()`.

## Provider decisions

- **Stripe:** grading checkout is a **PaymentIntent**, not a Checkout
  Session — Stripe coupons don't apply; promos reduce the charged amount
  server-side. Credentials in Fly secrets, read via `process.env`
  (`server/stripeClient.ts`). ⚠️ Local `.env` has LIVE Stripe keys —
  coupon-minting/payment code run locally hits production Stripe.
- **Resend** for transactional email. Email sends must not fail silently —
  seven silent-failure sites were fixed 2026-07-04.
- **Higgsfield** (VQ artwork): `HIGGSFIELD_API_KEY` is a short-lived `oat_`
  OAuth access token minted by hand via CLI — no server-side refresh possible
  (architectural). Long-lived official Cloud API keys exist but adopting them
  is a rewrite (classified F/D). Status classification + rotation runbook
  shipped in VQ Phase 7C.
- **TCGdex** for set prefill: identification fields are nested
  (`data.identification.{set_code,detected_*}`); set name comes solely from
  TCGdex; `auto_add` stays OFF.
- **Anthropic API** for AI identify + VQ text AI (guardrailed, audited in
  `vq_ai_generations`).

## Infrastructure decisions

- Fly.io app `mintvault`; deploys go through `scripts/safe-deploy.sh`
  (blocks stale-checkout deploys, verifies live commit via `/api/version`) —
  never raw `fly deploy`.
- Cloudflare R2 for images, presigned URLs only (1h expiry). VQ shares the
  grading R2 bucket — isolation is prefix-only (`vq/`), a known limitation.
  Dedicated VQ DB/R2/B2 separation exists on branch
  `vq-infrastructure-separation` (not deployed; owner must provision first).
- Multi-machine Fly is real: in-process state (job stores, in-memory maps)
  is single-machine only — durable-store patterns required for prod
  (INFRA-01; precedent `server/account-auth.ts:460`).

## Database decisions

- Neon Postgres, two intentionally diverged branches:
  **staging** `ep-purple-voice-abfez796` (local `.env`) and
  **prod** `ep-wispy-morning-ab6f4o08` (Fly secret). Never treat one as a
  snapshot of the other; check the target DB, not a proxy.
  Neon console: project `gentle-glade-43242875`, staging branch
  `br-hidden-heart-ab556xkw`.
- VQ schema pushes use `drizzle-vq.config.ts` (`tablesFilter: ["vq_*"]`) —
  **never** plain `drizzle-kit push` / `npm run db:push` for VQ work; live DB
  has drifted from `shared/schema.ts`, so a whole-DB diff proposes
  destructive changes. Prefer applying authored migration SQL directly.
- Prod VQ DB writes need the UNPOOLED Neon host + `search_path=public`.
- `cert_counter` desync causes 500s on next cert allocation — check before
  any cert-issuing work (see mintvault-db-migration-discipline Check 4).
- Migrations 0007 (VQ studio tables, applied to prod 2026-07-10) and
  0008–0011 (durable export, generation idempotency, artwork revisions,
  reconciler/feature-flags) — 0008–0011 authored but **UNAPPLIED** as of
  2026-07-11.

## Production assumptions

- Owner is a non-technical founder; prod deploys happen only on his explicit
  "deploy" instruction, serialized, via safe-deploy.
- Admin + staff share one session cookie (`mv.sid`) — logging into the staff
  portal clobbers the admin session (403s that look like breakage).
- Admin cert edit form posts full state with no optimistic lock — a stale
  open tab can clobber concurrent data changes.
- esbuild tree-shaking drops some upload magic-byte validation from the prod
  bundle (dev/tsx is fine; sharp still rejects) — verify uploads at runtime,
  not by reading the bundle.

## Known caveats

- Pre-commit prettier (lint-staged) reformats whole unformatted files —
  use `git commit --no-verify` for minimal reviewable diffs, and say so.
- CodeQL/Trivy/gitleaks CI exists only on the security release branch;
  main's CI is build-only — main-based PRs get no SAST signal.
- Display-PNG halo on ~30% of cards is an accepted software floor — do not
  re-investigate. Deskew is pure-rotation only (top-edge regression).
- No test or lint npm scripts exist; `npm run check` (tsc) is the only
  automated gate. "Manual verification" is often the real regression gate —
  say which was used.

## Deferred work

- VQ: multi-machine durable export store; VQ B2 backup; orphan GC;
  PROV-03/04 reclaim; route-wiring for Phase 7 pure cores; migrations
  0008–0011 application.
- `/ready` rate-limit CodeQL alert — handle when the hardening branch hits
  the release branch (documented suppression or ops-safe limiter).
- Dead v1 submission grader columns pending a drop PR.
- Third-party pentest — main external gap flagged by the 2026-07-04 audit.
- 18 bucket-C black-label certs need grader sub-grade entry (label_type data
  stale on 26/30; display is gate-derived and correct).

## Technical debt

- `server/routes.ts` ~11.9k lines even after the 2026-07-02 dead-route purge
  (108 shadowed routes / 4,430 dead lines removed).
- `routes.ts:2511` promo path is dead/shadowed.
- Shared R2 bucket for VQ + grading (prefix isolation only).
- In-process VQ export job store (single-machine assumption).

## Rollout history (highlights)

- v889 grader-v2 unified staff capabilities (deployed by a concurrent
  session — origin of the concurrent-session discipline).
- v908/v909 Pristine gate-derived on all six display surfaces (2026-06-21).
- v982 print-batch normalize fix; v992 safe-deploy live; v996 email-failure
  + object-URL leak fixes (2026-07-04).
- VQ: Character Bible Phase 3 (df63ed4) + Studio Phases 4–6 (937cc7e)
  live on prod 2026-07-10. Phases 7A–7E + 8A local-only as of 2026-07-11.

## Migration history

- Drizzle migrations via `db:push` historically; VQ uses authored SQL in
  `migrations-vq/` applied directly (0007 applied; 0008–0011 authored,
  unapplied). Rollback/backup bundles for VQ deploys live in `~/Downloads`.

## Major design decisions

- **MVGS grading system is PROTECTED** — never change scoring, centering,
  Pristine gate, approve-lock, or label rendering without explicit
  per-change owner approval (see mvgs-grading-protected skill).
- Grading label line 3 shows exactly one of variant OR rarity — enforced by
  write guards + `shared/variant-derive.ts`.
- Governance: `controlled-code-lead` v1.1 (see `.claude/governance-version.md`).
- VQ positioning: collector-first (14-expert audit 2026-07-07); win
  condition and game rules still open product questions.

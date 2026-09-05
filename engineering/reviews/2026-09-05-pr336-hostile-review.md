# Hostile review — PR #336 "Resource-hardening remediation (H1–H7, C1, X1–X3, provenance)"

| Field | Value |
| --- | --- |
| Reviewed head | `c35e0d28` on `fix/resource-hardening-staging-20260827` (Codex, pushed from the admin MacBook, 2026-09-05) |
| Base | `01d5e4da` (`main`) |
| Size | 58 commits · 511 files · +239,854 / −12,027 |
| Reviewer | Claude (independent hostile reviewer per `.engineering/project.yaml`) |
| Method | Read-only worktree of the PR head; own gate runs; eight scoped read-only reviewers (security, database, payments/provider, storage, infrastructure, backend, frontend, claims-vs-reality); every accepted finding re-read at the cited lines by the Lead |
| Nothing was edited, pushed to, deployed or migrated on the PR branch | |

## Verdict

**NOT MERGEABLE. NOT DEPLOYABLE.** One blocker, seven highs.

The engineering direction is sound and the frozen grading ruleset is untouched, but the branch cannot go to
staging or production as it stands:

1. Migration 0121 will roll back on Neon (BLOCKER).
2. The app cannot pass its own readiness check until a new database login is provisioned and the connection
   secret rotated (owner-gated, undocumented).
3. Primary CI has never been green on this PR. Head has a failing test, a failing dependency audit, a failing
   image vulnerability scan, and 22 new high CodeQL alerts nobody has triaged.
4. Two behaviour regressions land on the admin: visiting a public page logs the admin out; a network blip while
   tabbing back tears down the grading workstation.
5. The backup worker stops archiving the ~700 legacy certificates and can wedge itself permanently.

Codex's own ledgers say "release NOT READY". That is correct and this review does not change it.

## What I ran myself on the PR head

| Gate | Result |
| --- | --- |
| `scripts/mvgs/verify-freeze.ts` | PASS — all 10 frozen MVGS v1.4 files intact |
| `npm run check` (tsc) | PASS |
| `npm run lint` | PASS (0 errors, 2 warnings) |
| `npm audit --audit-level=high` | **FAIL** — `sharp <0.35.0` (HIGH, production dep) plus dev-only HIGHs |
| `scripts/db/lint-destructive-sql.ts` on 0114–0122 | 0114 flagged: column type change + NOT NULL on `cert_counter` (assessed safe, see DB clean areas) |
| GitHub CI on `c35e0d28` | Test step FAIL (1 test); image build & boot FAIL (Trivy fixable HIGH: node-tar CVEs + sharp); engineering-check FAIL (same test); CodeQL 22 high / 37 medium new alerts; gitleaks + dependency-review PASS |

The full vitest suite needs a Postgres 17 server, which this sandbox does not have; test evidence below comes from
the CI logs of the head commit, not from a local run.

## Findings — must fix before merge

### R-1 · BLOCKER · Migration 0121 cannot run on Neon (D/E)

`migrations/0121_main_runtime_role_authority.sql:26-28`

```sql
ALTER ROLE mintvault_app
  NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
  NOREPLICATION NOINHERIT;
```

PostgreSQL rejects the `SUPERUSER`/`NOSUPERUSER` keyword in `ALTER ROLE` from any caller that is not itself a
superuser. The check is on the presence of the keyword, not its value (`AlterRole()` in `commands/user.c`). Neon's
database owner login is not a superuser. Consequence chain: 0121 rolls back → 0122 refuses to run (it hard-requires
0121, `0122:11-19`) → `REQUIRED_RELEASE_MIGRATIONS` unmet → `/ready` returns 503 → Fly health check (now `/ready`,
`fly.toml:26`) never passes.

Every test that applies 0121 does so as the `postgres` superuser of a disposable cluster
(`tests/helpers/postgres17-cluster.ts:111`, `tests/main-runtime-role-authority-migration.test.ts:54,73`), so CI
cannot see this. Not executed against Neon by me; confidence is high from source.

Fix: a freshly created role is already `NOSUPERUSER NOREPLICATION NOBYPASSRLS`. Drop those three keywords from the
`ALTER ROLE`, assert them with a `pg_roles` check that `RAISE`s, and add a test that applies 0121 as a
`CREATEROLE` non-superuser.

### R-2 · HIGH · Build is undeployable until a new DB login is provisioned and `MINTVAULT_DATABASE_URL` rotated (D)

`server/readiness.ts:819-870`, `migrations/0122:710-745`

Readiness requires the connected login to be a non-owner, a member of `mintvault_app`, with no
`BYPASSRLS/CREATEDB/CREATEROLE`. Today the app connects as the database owner. 0122 turns on `FORCE ROW LEVEL
SECURITY` with policies only for `mintvault_app`/`partner_runtime`, and the head now routes certificate image writes
and print artefacts through those tables. With today's credential: `/ready` 503; if the health check were bypassed,
image and print writes fail RLS.

This is CLAUDE.md rule 3 territory (secrets, DB roles). It is not in the runbook diff. It needs an owner-approved,
sequenced rollout: migrate with the owner credential (after R-1) → create the LOGIN and grant membership → rotate
the secret → deploy. Also: `readiness.ts:147` fails if `MINTVAULT_MIGRATION_DATABASE_URL` is present in the app's
Fly secrets, and `readiness.ts:150-162` requires `PARTNER_ADMIN_DATABASE_URL` to use a *different username*.

### R-3 · HIGH · `/ready` now requires ~20 env vars, several net-new, and no release command applies migrations (C/D)

`server/readiness.ts:91-165`, `config/components/*.ts`, `fly.toml`

Required in production: `APP_URL`, `B2_*` (4), `CUSTOMER_NOTIFICATION_ENC_KEY_VERSION` + `_V<n>` (net-new, zero
references on main), `PARTNER_ADMIN_DATABASE_URL`, `R2_*` (4), `RESEND_API_KEY`, `RESEND_DOMAIN_VERIFIED="true"`,
`SESSION_SECRET`, `SIGNED_URL_SECRET`, `STRIPE_ENV`, `STRIPE_*` (3). Plus 14 migrations in the journal. The Fly
health probe moved from `/health` to `/ready`, so any gap = unhealthy machines. Fail-closed is the right design, but
the deploy needs a pre-flight: `fly secrets list` (names only) diffed against this list, and 0114–0122 applied first.

### R-4 · HIGH · Admin gets logged out by visiting any public page (B)

`server/middleware/auth.ts:14-18`, `server/customer-session-authority.ts:25-52`, `client/src/components/v2/header-v2.tsx:237`

`requireAuth` now calls `destroySessionAndClearCookie` whenever `loadCustomerSessionAuthority` returns null. An admin
session has `userId` undefined and `authRole: "admin"` (`routes/auth.ts:279-289`), so the authority is null. The
public site header fires `GET /api/auth/me` on load. Result: admin logs in, opens the home page or a certificate page
in the same browser, admin session is destroyed; next `/api/admin/*` call is 401. Same for the 5-minute pending-admin
window and staff sessions. On `main` this returned a plain 401 with no side effect. With `sameSite: lax`, a cross-site
top-level link to `/api/auth/me` also force-logs-out any admin.

Fix: only destroy when the session actually carried a customer stamp that failed validation; otherwise 401 without
side effects.

### R-5 · HIGH · Focus-triggered session check tears down the grading workstation on a network blip (A)

`client/src/lib/admin-session.tsx:102-105, 247-249, 316, 360-362`

A `window` focus event runs a non-blocking `verify(false)`. A fetch failure or 5xx from `/api/admin/session` becomes
`status: "unavailable"`, and the render gate replaces `{children}` with `UnavailableBoundary`. Tabbing back to the
workstation during a two-second Wi-Fi drop unmounts `GradingPanel` (un-autosaved sub-grades, open defect batch,
mark mode). The test at `tests/admin-session-contracts.test.ts:457` asserts this, so it is a design choice, but it is
the wrong one for a non-blocking check on an already-authenticated session.

Fix: for non-blocking verifies on an authenticated session, keep children mounted and show a banner; reserve the
full boundary for blocking verifies and 401s.

### R-6 · HIGH · B2 archival worker abandons legacy certificates and can starve itself forever (D)

`server/workers/r2-to-b2-archival.ts:305-357`, `server/index.ts:693`

`main` enumerated R2 prefixes (`images/{cert}/`, `grading/{cert}/`) and archived them. The head uses the
`certificate_image_evidence` ledger as the *only* source, and on an empty ledger logs an error and `continue`s
without marking the cert. The candidate query (`archived_to_b2_at IS NULL ORDER BY grade_approved_at LIMIT 50`)
does not exclude those certs. The ledger was introduced in migration 0047 with no backfill, so the oldest ~700
certificates have no rows. They are selected first, fail, and are re-selected every 24h; once 50 such certs exist
the batch is fully occupied and no newer certificate is ever archived. `front_image_path`/`back_image_path`
objects for the legacy certs also lose B2 coverage entirely.

Fix: exclude or classify ledger-less certs so they leave the queue; restore pointer-column or prefix archival for
legacy images. Read-only magnitude check for the owner:
`SELECT count(*) FROM certificates c WHERE archived_to_b2_at IS NULL AND NOT EXISTS (SELECT 1 FROM certificate_image_evidence e WHERE e.certificate_id = c.id)`.

### R-7 · HIGH · CI is red on the head and has never been green on this PR (F)

- **Test (1 failure):** `tests/claim-ownership-authority.test.ts:263` "a second person cannot claim an already-claimed
  certificate". Codex's ledger calls it flaky and unrepaired. Root cause found by code read (not executed):
  `storage.ts:2381` compares `claim_code_created_at` (microsecond precision, set `NOW()` at `storage.ts:2191`) with
  `${verification.createdAt}`, a JavaScript `Date` truncated to milliseconds. When the claim code and the
  verification are created within the same millisecond, the truncated value is *earlier* than the column, the first
  legitimate claim is refused as "regenerated", and because the test does not assert the first claim, the attacker's
  later token becomes the *first* claim and wins. This is a false-refusal race, not an ownership takeover, and it
  is unlikely in production timing. Fix: do the comparison in SQL against the verification row's own `created_at`,
  and assert the first claim in the test.
- **`npm audit --audit-level=high`:** fails on `sharp@0.34.5` (GHSA-f88m-g3jw-g9cj, fix is 0.35.x, breaking) plus
  `postcss`, `postcss-selector-parser`, `nanoid` (dev). Rule 5: owner sign-off needed to bump.
- **Image scan (Trivy, fixable HIGH, exit 1):** node-tar CVEs from the base image plus `sharp`. Same fix.
- **CodeQL:** 22 high, 37 medium alerts "in code changed by this pull request". Untriaged. The alert list is not
  reachable from this session; the owner should open the code-scanning tab for PR 336 before any merge decision.

## Findings — should fix (MEDIUM)

| ID | Area | File:line | Summary | Class |
| --- | --- | --- | --- | --- |
| M-1 | Payments | `server/routes/submissions.ts:433,494-497,768-790`; `email.ts:359-360` | Grading fulfilment outbox goes terminal (`RECONCILIATION_REQUIRED`) after 8×5-minute email failures, including "Resend not configured". No admin surface lists or retries these rows. Money-side effects complete first; only the confirmation email is lost. | F |
| M-2 | Payments | `server/routes/submissions.ts:876-885`; `index.ts:227-229` | Webhook throws (→400) when a paid receipt lands on a submission that is no longer `draft` and not `paid` (cancelled mid-checkout). Stripe retries the 400 for its full horizon. Deliberate fail-closed, but should acknowledge once the reconciler has recorded the conflict. | F |
| M-3 | Payments | `server/estimate-credit-consumption.ts:392-412` | Stale-reservation sweep orders/limits before the eligibility filter; orphaned reservations (hard-deleted users) occupy the batch forever. Unlikely with soft-delete, but the mechanism is real. | F |
| M-4 | Storage | `server/jobs/object-write-reconciliation.ts:440-451`; `certificate-image-persistence.ts:282,298` | Reconciler has no attempt cap; permanent finalizer failures thrown as plain `Error` retry every 5 minutes forever and their R2 objects are never cleaned. | C |
| M-5 | Backend | `server/partner/card-job-reconciliation.ts:122-157`; `card-job-lifecycle.ts:472-490` | 15-minute redrive flips a `FIX_REQUIRED` card job to `CAPTURING` when the other side is still current, with an audit reason claiming a capture "did not land". Loses the fix signal in partner queues. No FIX_REQUIRED test case. | C |
| M-6 | Frontend | `client/src/components/grading/image-viewer.tsx` (frame always `position:absolute`) | The removed comment documents this exact change collapsing the rail to zero on the real `/admin` route before. Needs real-browser proof at 1280×800, 845×685 and Super Admin ≥540px before merge. The guarding test was replaced. | C |
| M-7 | Security | `server/routes/auth.ts:616-624,1431-1442,983-993` | Victim's own magic-link click auto-verifies a signup row an attacker created for the victim's email, and `/api/auth/login` then admits the attacker's password. Pre-existing class; this PR narrows it but does not close it. | D |
| M-8 | Database | `migrations/0121:340-349` | Raises on any unclassified `public` relation. The 70+ classified names come from an unrecorded live host; staging and prod differ. Owner should run the read-only `pg_class` inventory on both hosts and diff. | D |
| M-9 | CI | `scripts/ci/run-typecheck-ratchet.mjs:21-25,105-118`; baselines | "Ratchets" baseline 359 existing diagnostics (including production files) and hash the tracked file set, so adding any test file forces `--write`, which silently re-baselines whatever errors exist. Fixed errors that come back are not caught. | H |
| M-10 | CI | `scripts/architecture/generated/architecture-authority.json` (7.2 MB); `legacy-authority.json` (3,165 entries, no expiry) | The architecture gate is strict, but its approval artefact is an unreviewable blob regenerated wholesale by `--write`. Add CODEOWNERS on `scripts/architecture/**` and `scripts/ci/*.json`. | H |

## LOW / informational

- L-1 Security `upload-memory-admission.ts:75-106`: every JSON POST reserves a flat 4 MiB regardless of `Content-Length`; ~192 slow chunked connections can 503 every JSON write including admin login. No `server.requestTimeout` set.
- L-2 Security: raw magic-link/reset/PIN/stolen tokens now also persisted in `customer_notification_outbox.payload`. Widens an existing plaintext exposure.
- L-3 Payments `webhookHandlers.ts:179-193`: event-dedup order flipped; `stripe_webhook_events` write is now write-only for grading events. Harmless; document or remove.
- L-4 Payments `estimate-credit-consumption.ts:339-348`: free-tier refund re-stamps `last_used_at` with the DB clock, not the route's UTC day; a seconds-wide skew window across midnight denies one free use.
- L-5 Backend: `POST /api/staff/scan/certificates/:id/upload` (working on main) and `POST /api/admin/certificates/grade-with-ai` (working on main) are now 410. No callers remain, but rule 8 says the owner acknowledges removals. The staff route still runs multer before the 410, contradicting its own retirement contract.
- L-6 Frontend `queryClient.ts`: admin queries now `staleTime: 0` (refetch on every mount) and the whole mutation cache is cleared on every admin→public navigation.
- L-7 Frontend `image-viewer.tsx`: single-key shortcuts (`+ - 0 f b d`) now active on the inline rail; focus on buttons/radios/sliders is not excluded.
- L-8 Frontend: `rail-width-context.tsx` and `@shared/rail-width` are dead.
- L-9 Database `shared/schema.ts`: `nfcLockPendingAt` declared `timestamp` (no tz) vs 0118 `timestamptz`.
- L-10 Database `scripts/db/lint-destructive-sql.ts:52`: strips dollar-quoted bodies, so DDL inside `DO $$` (e.g. 0115's `RENAME TO member_credits`) never trips the destructive gate.
- L-11 Storage `object-write-reconciliation.ts:533-545`: tick logs a 42P01 error every 60s until 0122 is applied; the staging-cleanup job next to it backs off, this one does not.
- L-12 Governance: `scripts/scanner-app` adds `happy-dom` (new devDependency, rule 5); ledger claims owner authority. `--no-verify` WIP commits are owner-approved per the ledger and skip lint-staged only.
- L-13 Governance: engineering-governance workflow uses unpinned `@v4` actions on Node 24 against an exact Node 20.20.2 pin. Pre-existing.

## Verified clean (what I checked and found fine)

- **MVGS v1.4:** no frozen path touched (hash verify passes). Callers in `server/grader.ts`, `routes/grader.ts`, `correction-mode.ts`, partner grading routes write the same grade columns; `/api/admin/certificates/:id/grade` handler is byte-identical. No sub-grade, centering, overall, label or draft→submit→approve→lock semantic change on client or server.
- **`cert_counter` (0114):** matches main's boot DDL; seed uses `GREATEST(existing, MAX(MV n))` so the counter can only move up; allocator UPDATE compatible; no certificate number rewritten.
- **Stripe webhook:** registered before `express.json`, signature verified with primary/secondary secret, API version unchanged, `stripeClient.ts` untouched. Double-delivery is idempotent via the outbox PK/unique + `markSubmissionAsPaid` single winner; member-credit and promo consume are CAS-guarded. Covered by `tests/grading-payment-webhook-retry.test.ts`.
- **R2 signing:** `getR2SignedUrl` unchanged; only the scanner staging PUT gains `If-None-Match: *`. No new delete path except cleanup of objects proven created by an abandoned operation (DB trigger enforced). Legacy `images/{certId}/front.jpg` keys still resolve.
- **Two-step admin auth:** password → pending-admin TTL → PIN order unchanged; session regenerated at every login/verify; `requireAdmin` unreachable from a customer stamp; first-PIN setup tightened.
- **Rate limits:** moved to a fail-closed Postgres store, `trust proxy` = 1, no header-spoof path, all removed per-route limiters re-mounted before `registerRoutes`.
- **Tenant isolation:** every partner operational query scoped by `tenant_id` (+`location_id`); station capture refuses cross-tenant certs.
- **Claim ownership:** compare-and-set UPDATE inside a transaction; history/token/email-verified writes only on exactly one row. Race and replay tests pass in CI.
- **Frontend contracts:** every new/changed client URL resolves to a server route in the PR; `App.tsx` add-only; no client import of `@shared/mvgs*`; only `import type` from the schema barrel.
- **Tests not weakened:** no `describe.skip`/`.todo` added; the 24 `vq-*` diffs are one env-overridable port line each; PG17-gated suites fail closed rather than skip; CI asserts suite execution counts.
- **Workflow security:** no `pull_request_target`, all third-party actions SHA-pinned, minimal permissions, `persist-credentials: false`. Dockerfile: `USER node`, read-only `/app`, dev toolchain pruned.

## What the owner has to decide (protected actions in this PR)

| Action | Rule | Status |
| --- | --- | --- |
| 9 migrations (0114–0122), incl. `cert_counter` rewrite, role/grant DDL, FORCE RLS | Rule 2 | Authored; 0121 broken (R-1) |
| New DB LOGIN + `MINTVAULT_DATABASE_URL` rotation; ~8 new Fly secrets | Rule 3 | Not done, not documented (R-2, R-3) |
| Auth-logic edits (session authority, magic-link verify, rate-limit store, XFF removal) | Rule 3 | Implemented; R-4 regression |
| Stripe fulfilment outbox, credit reservations, webhook dedup order | Rule 6 | Implemented; M-1..M-3 |
| `sharp` 0.34 → 0.35 (breaking) to clear audit + Trivy | Rule 5 | Not done |
| `happy-dom` devDependency in scanner-app | Rule 5 | Done, ledger claims approval |
| Two working routes retired to 410 | Rule 8 | Done, not acknowledged |
| Fly health probe `/health` → `/ready` | Rule 4 adjacent | Done; fails closed until R-1..R-3 resolved |

## Rollback

Nothing has been applied anywhere. Rolling back this review is `git rm` of this file. Rolling back the PR is
closing it; `main` is untouched. If the owner later applies the migrations, the reverse-safe point is *before*
0121: 0114–0120 are additive and leave the app on `main` working; 0121/0122 change roles and RLS and need the
new login in place.

## Confidence

| Dimension | Score | Basis |
| --- | --- | --- |
| Design | 70% | Direction (fail-closed readiness, outboxes, RLS, numbered migrations) is right; deploy sequencing was not designed |
| Implementation | 55% | Blocker in 0121, two admin regressions, one durability regression; large clean core |
| Verification | 45% | tsc/lint/freeze run by me; test evidence from CI logs only; no Neon, no browser, no live secrets inspected |
| Deployment | 10% | Cannot deploy: R-1, R-2, R-3 |

Proof level reached by this review: **Local proof** for gates I ran; **Design only** for anything about live
Neon, Fly secrets or browsers.

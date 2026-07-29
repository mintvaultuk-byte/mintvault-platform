# Phase 1 — Architecture map (Super Admin Partner Master Dashboard)

Baseline `6f182624`. Compiled from 5 read-only reviewer reports, each load-bearing claim
re-verified personally by the Lead (commands + file:line cited inline).

## 1. What exists and is MOUNTED today

Three admin partner routers, registered at `server/routes.ts:2784-2786`, all on disjoint bases:

| Base | File | Purpose | Guard |
|---|---|---|---|
| `/api/super-admin/grading-partners` | `server/partner/admin-routes.ts:169` | Phase-1 control shell (orgs, locations, users, sessions, audit, security, suspend, flags, emergency stop) | `requireAdmin` |
| `/api/super-admin/connector-ops` | `server/partner/connector-admin-routes.ts:262` | G4 connector operations, manual-review + reconciliation queues, worker status | `requireAdmin` |
| `/api/super-admin/partner-management` | `server/partner/partner-management-routes.ts:338` | G5 CRM: profiles, contacts, branding, notes, activity, statistics, audit | `requireAdmin` |

Data path: `partnerAdminQuery()` / `withPartnerAdminTransaction()` (`server/partner/db.ts:107-134`) —
a privileged, NON-RLS pool explicitly built for "super-admin control-shell reads of partner data
across tenants". Tenant scoping is by explicit `WHERE tenant_id = $1` in every query.

## 2. What exists but is NOT mounted / NOT wired

| Thing | State | Evidence (Lead-verified) |
|---|---|---|
| Partner portal app | **Not mounted.** `createPartnerApp()` has no caller outside tests | `grep -rn createPartnerApp server/` → only its own definition at `app.ts:58` |
| G6A wallet service | **Dead code at runtime** | `grep -rn partner-wallet-service server/ client/ shared/` → no hits |
| G6B reservation service | **Dead code at runtime** | same grep → no hits |
| G6C admin credit service | **Dead code at runtime** — this is the approved manual-adjustment path | same grep → no hits |
| Connector producer/worker | **No caller.** `ensureConnectorRecordForHandoff`, `runConnectorWorkerPool` invoked only by tests | reviewer grep, spot-checked |
| Partner submissions ↔ credits | **Not integrated on main** | `grep -c "reservation\|credit\|wallet" server/partner/submission-service.ts` → **0** |

## 3. Data-availability verdicts (drives what the dashboard may render)

### AVAILABLE NOW — real data, safe to display
- Partner orgs: `legal_name`, `public_ref`, `status`, `created_at`
- Status ladder (app-enforced, **no DB CHECK**): `PENDING | ACTIVE | SUSPENDED | REVOKED`
  (`server/partner/partner-management-errors.ts:151`)
- CRM: `partner_profiles` (trading name, kind, address, onboarding_date, internal_tier, health_note),
  `partner_contacts`, `partner_branding`, `partner_internal_notes`
- Staff: `partner_users` — `email, status, mfa_enabled, last_login_at, failed_login_count, locked_until`
- Sessions: `partner_sessions` — `last_seen_at, ip, created_at, revoked_at`
- Partner submissions: `partner_submissions.status`, ladder **`draft | submitted_to_mintvault | cancelled`**
  ONLY (`migrations/0007_partner_submissions.sql:76-77`, Lead-verified)
- Connector records: 11-state ladder (`migrations/0011:23`) — the real operational pipeline
- Audit: `partner_audit_events`, `partner_security_events`, `partner_management_audit`,
  `partner_connector_admin_actions`
- Wallet (schema + service exist, 0016/0017 applied on STAGING): `partner_credit_availability`
  view → `ledger_balance, active_reserved, available_balance, consumed_reservations`
  (Lead-verified at `migrations/0017_partner_credit_reservations.sql:257`)

### DERIVABLE
- Counts per partner: locations, users, submissions, connector-states (precedent
  `partner-management-service.ts:599-628`)
- Wallet available/reserved: from the append-only ledger via the existing views — **never** from UI state

### DOES NOT EXIST — MUST NOT BE FABRICATED
| Brief section | Verdict |
|---|---|
| **F. Partner Quality Rating** (all 11 metrics) | **No table, no column, no computation, no UI.** Not derivable: `certificates` has no tenant/partner column and Phase-1 forbids adding one (`migrations/0007` header). Existing grader analytics are keyed on MintVault staff (`certificates.assigned_grader_id`), not partners. |
| **G. Devices / approved Macs / scanner telemetry** | **No device table exists.** `partner_audit_events.device_id` is written NULL by 100% of call sites; `partner_device_enforcement_enabled` flag has exactly one reference (its declaration). Scanner identifies by operator email header only — no machine id, no heartbeat. |
| **D. Stripe credit purchases** | **No purchase path.** `entry_type='purchase'` / `source='stripe'` are permitted constants written by zero code. |
| **Grading origin ("Graded by [Shop]")** | **Not implemented.** Issuer is the hard-coded literal `"Graded by MintVault UK"` (`server/routes.ts:4409`, Lead-verified). No per-cert origin column, no address snapshot. |
| `partner_organisations.health` / `.accreditation_level` | **Dead columns** — no write site anywhere; will read the default forever. Lead-verified: repo-wide grep finds no partner write. |
| Per-partner certificate/graded counts | Permanently `null` by design (`partner-management-service.ts:624-627`) — the existing code's honest precedent. |

## 4. Decisions this forces
1. **Guard = `requireSuperAdmin`** (`server/auth.ts:200`), NOT the `requireAdmin` the three existing
   partner routers use. New surface is the highest-privilege cross-tenant read in the app.
2. **Reuse, do not duplicate:** `listPartners`, `getStatistics`, `getActivity`, `getPartnerAudit`
   (G5); `getOperationalHealth`, `getManualReviewQueue`, `getReconciliationQueue` (G4);
   `getWalletSummary`, `listLedgerEntries` (G6C); `getCreditPosition` (G6B).
3. **Read-only v1.** No manual credit-adjustment control: exposing `addCredits`/`removeCredits`
   would be the FIRST HTTP write surface over the credit ledger and deserves its own hostile
   review. Deferred with explicit unblock criteria.
4. **Validate UUIDs → 400**, don't let a malformed id reach Postgres and 500 (existing gap).
5. **Rate-limit the new read endpoints** — `/api/super-admin/*` inherits neither
   `adminIpAllowlist` nor `adminRateLimit` (both mounted on the `/api/admin` prefix only,
   `server/index.ts:156,256` — Lead-verified).
6. **Render honest empty/unavailable states** mirroring `unavailable: [...]`, never a fake zero.

---

# 5. Remediation pass (post hostile review) — cross-tenant READ visibility

## The requirement this branch now makes explicit

**The Partner Master Dashboard requires an approved cross-tenant database read path.**

Every tenant-scoped partner table is created with `ENABLE` **and `FORCE`** ROW LEVEL SECURITY
(`migrations/0001_partner_foundation.sql`, `0016_partner_wallet_ledger.sql`,
`0017_partner_credit_reservations.sql`). `FORCE` removes the owner exemption, so:

> A role without `SUPERUSER` or `BYPASSRLS` **cannot** read the FORCE-RLS partner tables, even
> when it OWNS them.

`partnerAdminQuery` sets no tenant context (a Super Admin read is cross-tenant by definition), so
under such a role every dashboard query returns zero rows. The danger is that this is **silent**:
`count(*)` still returns one row containing `0`, and `SUM(...)` still returns one row containing
`NULL → 0`. The dashboard would have rendered "0 shops / 0 credits / no alerts / partner not
found" as fact.

The repository already encodes this requirement elsewhere:
`migrations/0006_partner_definer_role.sql` REFUSES to apply unless an elevated role can create the
`BYPASSRLS` `partner_definer` role.

## How the dashboard now fails closed

`server/partner/dashboard-visibility.ts` probes the **catalogue**, not the data, and classifies
four distinct conditions:

| Condition | Detection | Result |
|---|---|---|
| Genuine empty network | visibility OK, queries return 0 rows | **Real zeros**, HTTP 200 |
| RLS-invisible role | `relrowsecurity` AND NOT (`rolsuper` OR `rolbypassrls`) AND (`relforcerowsecurity` OR owner ≠ current_user) | HTTP 503 `PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE` |
| Missing schema | a `REQUIRED_RELATIONS` entry absent from `pg_class` | HTTP 503 `PARTNER_ADMIN_SCHEMA_UNAVAILABLE` |
| Database error | probe throws | HTTP 500, **not cached** |

Applied as router-level middleware, so it covers **every** endpoint uniformly — no section can
report zeros while another reports unavailable. Wallet relations (0016/0017) are checked
separately and degrade to `MetricUnavailable` without blocking the rest of the dashboard.

**Deliberately NOT done:** RLS is not weakened or disabled; no tenant context is fabricated; no
`SECURITY DEFINER` function is added; no privilege is granted.

## Deployment verification requirement (OPEN)

Production and staging role configuration **remains a deployment verification requirement**. Before
this dashboard is trusted in an environment, confirm the role behind
`PARTNER_ADMIN_DATABASE_URL` (or `MINTVAULT_DATABASE_URL`) satisfies the visibility precondition.
If it does not, the dashboard now says so plainly instead of showing zeros — but the underlying
capability still has to be provisioned, and the same question applies to the pre-existing G4/G5
partner admin surfaces, which share the pool and have no equivalent guard.

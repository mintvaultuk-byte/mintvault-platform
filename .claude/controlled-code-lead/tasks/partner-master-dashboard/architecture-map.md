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

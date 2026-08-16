# PARTNER NETWORK / ONBOARDING CONSOLIDATION — PLANNING BACKLOG

**Status: PLANNING ONLY. Nothing here is implemented, and nothing here may be implemented during the
current staging re-proof.** Recorded 2026-08-15/16 from the owner's manual staging Super Admin
walkthrough plus a read-only code inventory.

Feeds the next phase: ChatGPT planning → Fable hostile planning → ChatGPT reconciliation →
Opus/Terra implementation.

## The commercial rule this exists to satisfy

A normal shop launch must be operable entirely through **the MintVault website + MintVault Scanner**.
It must not require Terminal, SQL, Claude, Codex, UUID lookups, hand-built API requests, copied
public keys, environment edits, exported station private keys, or any developer intervention.

The Terminal/API work in the current staging proof is **engineering evidence only**. It is explicitly
not the shape of the product.

Target effort for a new Partner: **~5 minutes** of Super Admin work (company + first location), then
Partner self-service (invitation → password → MFA → Scanner sign-in → Register This Mac), then one
Super Admin **Approve Station**, then Partner buys credits → **READY TO GRADE**.

## The security rule that constrains every simplification

We are simplifying the **human workflow**, never the authority underneath it. All of the following
must survive consolidation unchanged: tenant isolation · location isolation · RBAC · MFA · Partner
step-up · Super Admin step-up · station identity · Keychain-held private key · station approval ·
suspension/revocation · shared (fleet-wide) rate limiting · append-only audited credit authority ·
server-authoritative grading · Card Job lineage · existing QA/output controls.

---

## FINDING F-1 (HIGH) — two readiness rows are hard-coded placeholders that pre-date the systems they describe

The owner observed *"Credits configured — Credit accounting is not enabled yet."* on the staging
Partner detail page and asked whether that is stale UI, stale readiness computation, fixture state,
or a genuine backend inconsistency.

**Answer: stale CLIENT-SIDE readiness computation.** Not a backend inconsistency, not fixture state.

`client/src/pages/admin/partner-management-helpers.ts` hard-codes both rows and never asks the server:

```ts
{ key: "device",  label: "Scanner station",     state: "unavailable",
  hint: "Set up in MintVault Scanner: …" },
{ key: "credits", label: "Credits configured",  state: "unavailable",
  hint: "Credit accounting is not enabled yet." },
```

Both statements are now false. The authorities exist and are proven by the pinned gate:
`partner-wallet-service.ts`, `partner-credit-reservation-service.ts`, `credit-purchase-service.ts`,
`partner-credit-admin-service.ts`, `station-service.ts`, `station-admin-routes.ts`,
`station-identity.ts`.

**This also explains the 83%.** `checklistPercent()` counts only items that are not `unavailable`, so
the denominator is the six achievable rows (company, owner, invitation, location, profile, branding).
With branding incomplete that is 5/6 = **83%** — exactly what the owner saw.

**Consequence, and why this is HIGH rather than cosmetic:** the percentage *excludes the two most
operationally decisive gates* — does this shop have credits, and does it have an approved station.
A Partner can read 83% and be unable to grade a single card. The number overstates readiness by
construction.

**Also confirmed:** `server/partner/partner-management-service.ts` does not carry wallet or station
state in its detail payload at all. So this is **wiring, not building** — the authorities exist, the
detail endpoint simply never surfaced them.

**Owner decision needed:** should the percentage be over *all* gates (so it drops when credits or
station are missing), or should the headline become a state machine (`ONBOARDING → READY TO GRADE`)
with the percentage retired? The second is likely better and is what the "READY TO GRADE" target implies.

## FINDING F-2 (HIGH) — readiness has no single authoritative source

Related to F-1 but broader. Readiness is currently assembled client-side from whatever the detail
payload happens to include, with placeholders filling the gaps.

**Rule for the next phase: every readiness label must be computed server-side from authoritative
state and returned as data.** The client renders it; it never decides it. That is the same principle
already enforced for grading (server-authoritative) and for the schema contract.

Canonical panel (owner's list, to be server-computed):
company created · owner invited · invitation accepted · password configured · MFA configured ·
location active · wallet active · grading credits available · scanner installed · station enrolled ·
station approved · scanner connected · partner portal enabled → **READY TO GRADE**.

Every failed row must carry an **action**, not just a state: *password not configured → resend setup
link*; *no station → show request state/instructions*; *no credits → add startup credits / Partner
buy credits*; *MFA not configured → exact owner action*.

## FINDING F-3 (MEDIUM) — the staging Partner shows contradictory onboarding states

Observed together on one page: setup checklist 83% · AWAITING PASSWORD SETUP · password configured =
no · MFA configured = **yes** · invitation **consumed** · **no valid invitation available** · no
approved station · branding incomplete.

"MFA configured = yes" with "password configured = no" is the pair worth resolving first: it implies
either a real credential-lifecycle inconsistency, or two labels reading different sources (one from
`partner_users`, one from the MFA tables). "Invitation consumed" + "no valid invitation available" is
the same shape — one row describing history, the next describing current availability, with no
wording distinguishing them.

**Not changed now, deliberately.** Planning must first establish which source each label reads and
which is authoritative. Candidate root cause is the same as F-1: labels assembled from mixed sources.

## FINDING F-4 (MEDIUM) — Super Admin Partner surfaces are fragmented

Four separate admin surfaces exist today, reachable by four routes, with no canonical Partner record:

| Route | Page |
| --- | --- |
| `/admin/partner-network` | `partner-network.tsx` |
| `/admin/partner-network/partners` | `partner-management.tsx` |
| `/admin/partner-network/partners/:partnerId` | `partner-management-detail.tsx` |
| `/admin/partners/dashboard` | `partner-dashboard.tsx` |

Plus Station Fleet, Wallet/Credits controls and Connector surfaces reached from elsewhere. The
information exists; the navigation between it does not.

**Target (owner's, recorded verbatim in intent):** ONE primary **Partner Network** with
Overview · Shops · Credits · Stations · Staff · Alerts/Exceptions · Connectors; selecting a shop
opens ONE canonical Partner workspace with Overview · Onboarding · Credits · Staff · Locations ·
Stations · Cards · Corrections/FIX · Connectors · Activity/Audit.

**Explicitly NOT a Dashboard V2.** Consolidate the proven surfaces; do not add a fifth.

## FINDING F-5 (MEDIUM) — operational counts are dead ends

Counts render as text with no drill-through. Required behaviour: every meaningful count is a link to
the thing it counts.

`98 Credits` → wallet/ledger · `4 Reserved` → the Card Jobs holding them · `2 Devices` → that
Partner's stations · `3 Staff` → that Partner's users · `1 Submission` → the card/job ·
`1 Alert` → the exact condition · `Pending Station` → the approval · `FIX Required` → the correction ·
`QA Review` → the QA card · `Connector` → the connector record · Partner name → the canonical record.

The operator should never have to search a second page for something they were just shown.

## FINDING F-6 (HIGH, process) — station enrolment is currently developer-only

The current staging proof enrols a station via Terminal + a hand-built API call + a manually derived
public key + a UUID looked up with SQL. **That is exactly the workflow the commercial target
forbids.** It is acceptable as engineering evidence and must not become the product path.

Target, unchanged in authority: operator opens MintVault Scanner → signs in with their Partner
account → completes MFA → selects location → **Register This Mac**. The Scanner creates its identity
locally, the private key stays in the macOS Keychain, and only the public enrolment payload is sent,
creating a PENDING request. Super Admin sees **NEW STATION AWAITING APPROVAL** with partner,
location, device info, request time, operator, app version and readiness/security state, and can
Approve or Reject behind the existing Super Admin step-up.

The Scanner already has the client half (`scripts/scanner-app/lib/station-identity.js` — Keychain
storage, refuses plaintext fallback, signs requests), and the server half exists
(`station-routes.ts` enrol, `station-admin-routes.ts` approve/reject/suspend). **The gap is the
Scanner UI flow and the Super Admin approval queue presentation, not the authority.**

## Route / page inventory (current, for consolidation boundaries)

**Super Admin (4 surfaces):** `/admin/partner-network`, `/admin/partner-network/partners`,
`/admin/partner-network/partners/:partnerId`, `/admin/partners/dashboard`.
Helpers: `partner-network-helpers.ts`, `partner-management-helpers.ts`, `partner-dashboard-helpers.ts`.

**Partner Portal (18 pages):** login · invite · forgot-password · reset · dashboard · submissions
(+new, +detail) · customers · grading · users · locations · billing · certificates · supplies ·
orders · public-profile · help · security. (`supplies`, `orders`, `public-profile` are
`coming-soon`/`workflow-placeholder` surfaces — confirm before consolidating.)

**Server route modules (13):** `routes.ts` · `admin-routes.ts` · `partner-management-routes.ts` ·
`dashboard-routes.ts` · `station-routes.ts` · `station-admin-routes.ts` · `grading-routes.ts` ·
`submission-routes.ts` · `customer-routes.ts` · `catalogue-routes.ts` · `public-routes.ts` ·
`connector-admin-routes.ts` · `flag-admin-routes.ts`.

## Backend authority inventory — REUSE, DO NOT REBUILD

The consolidation is a presentation and navigation change. Every authority below is proven by the
70-suite pinned gate and must be reused as-is:

**Identity/authz:** `auth.ts` · `session.ts` · `permissions.ts` · `mfa-service.ts` · `mfa.ts` ·
`step-up.ts` · `../lib/admin-step-up.ts` · `definer-guard.ts` · `admin-capability.ts`
**Credits:** `partner-wallet-service.ts` · `partner-credit-reservation-service.ts` ·
`credit-purchase-service.ts` · `partner-credit-admin-service.ts` ·
`partner-submission-credit-lifecycle.ts` · `connector-credit-lifecycle-audit.ts`
**Stations:** `station-service.ts` · `station-identity.ts` (+ the Scanner's Keychain half)
**Card lineage / grading:** `card-job-authority.ts` · `card-job-lifecycle.ts` ·
`card-job-grading-bridge.ts` · `card-job-reconciliation.ts` · `fix-authority.ts` ·
`grading-lease-service.ts` · `print-eligibility.ts`
**Tenancy/ops:** `partner-management-service.ts` · `team-service.ts` · `location.ts` ·
`dashboard-service.ts` · `dashboard-operations-service.ts` · `portal-view-service.ts` ·
`audit.ts` · `flags.ts` · `emergency.ts` · `schema-contract.ts` · `rate-limit.ts` ·
`rate-limit-store-pg.ts`
**Connectors (do not force onto Scanner-native Partners):** the `connector-*` family.

## Proposed consolidation boundaries (for the planning phase to challenge)

1. **Readiness becomes a server-computed resource.** One endpoint returns every gate with state +
   remedy action. Client renders only. Closes F-1, F-2, F-3.
2. **One canonical Partner record** at `/admin/partner-network/partners/:partnerId`, with the
   workspace tabs as sub-routes. The other three admin surfaces become entry points into it, not
   parallel truths. Closes F-4.
3. **Counts become links** by making each aggregate return its drill-through target id(s) alongside
   the number. Closes F-5.
4. **Station approval queue** as a first-class Super Admin surface fed by existing station state, and
   **Register This Mac** as a Scanner flow over the existing enrol endpoint. Closes F-6.
5. **Create Partner wizard** (company → owner → location → security → wallet → station) orchestrating
   existing services only; wallet provisioning via `ensureWallet`, never SQL.

## Owner decisions required before implementation

1. **Readiness headline:** percentage over all gates, or retire the percentage for an
   `ONBOARDING → READY TO GRADE` state machine? (F-1)
2. **Startup/promotional credits:** is an audited Super Admin credit grant in scope for launch, or is
   Stripe purchase the only path? (Step 5 of the target workflow implies the former, "where permitted".)
3. **The three placeholder Portal pages** (`supplies`, `orders`, `public-profile`) — build, hide, or
   leave as coming-soon for the pilot?
4. **Connector visibility:** confirm connectors are hidden entirely for Scanner-native Partners
   rather than shown empty.
5. **Legal/company fields** (company number, registered address) — required at creation, or
   completable later without blocking READY TO GRADE?

## Walkthrough log — to be extended during the remaining manual review

Record here: dead ends · duplicate pages · stale statuses · misleading labels · non-clickable
operational numbers · developer-only actions · unnecessary steps · missing actions · confusing
transitions.

| # | Type | Surface | Observation |
| --- | --- | --- | --- |
| 1 | stale label | Partner detail | "Credits configured — Credit accounting is not enabled yet." Hard-coded; the credit authority exists. (F-1) |
| 2 | stale label | Partner detail | "Scanner station" permanently `unavailable`; station enrolment/approval exists. (F-1) |
| 3 | misleading number | Partner detail | 83% excludes credits and station — the two gates that decide whether the shop can grade. (F-1) |
| 4 | contradictory state | Partner detail | password configured = no, MFA configured = yes; invitation consumed **and** no valid invitation available. (F-3) |
| 5 | duplicate surface | Super Admin | four parallel Partner surfaces, no canonical record. (F-4) |
| 6 | dead end | Super Admin | operational counts render as text with no drill-through. (F-5) |
| 7 | developer-only | Station Fleet | station enrolment currently requires Terminal + SQL + hand-built API call. (F-6) |

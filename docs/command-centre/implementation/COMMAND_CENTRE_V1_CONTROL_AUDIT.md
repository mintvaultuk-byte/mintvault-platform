# MintVault Command Centre V1 — live control audit

> **Historical artifact record.** This inventory applies to staging artifact `60b9e268`. The repaired-candidate viewport, keyboard, view, filter and zero-dead-UI evidence is reconciled in [`COMMAND_CENTRE_V1_OVERNIGHT_RELEASE_ASSURANCE.md`](./COMMAND_CENTRE_V1_OVERNIGHT_RELEASE_ASSURANCE.md). It is not an exact-candidate Pilot-Flag proof.

**Environment:** staging `mintvault-v2` version `532`
**Artifact:** `60b9e2683c6866a385496d14de1a780615858468`
**Method:** authenticated Super Admin DOM inventory and interaction on 2026-08-19; no browser storage, credentials or production state inspected.

## Counting rule and result

The previous evidence claimed 52 controls without a ledger. The live rendered page contains **68 controls**, not 52: 40 Command Centre page controls, 27 inherited Admin-shell navigation links, and one inherited session control. This ledger records the actual count rather than preserving a false total. Dynamic “Open canonical workspace” links only appear after a details control is opened; their destinations are already represented by the page-level links and were included in destination verification.

| Group | Count | Outcome |
|---|---:|---|
| Inherited Admin-shell navigation | 27 | Rendered and available to the authenticated Super Admin; not changed by this release except the conditional Command Centre entry. |
| Inherited session control | 1 | Rendered. Not invoked because logging out would end the acceptance session. |
| Command Centre content controls | 40 | All rendered; every in-page stateful control exercised. |
| **Total rendered controls** | **68** | **Audited** |

## A. Inherited shell navigation — 27 controls

| ID | Visible control | Destination/outcome |
|---|---|---|
| S01 | Overview | `/admin` |
| S02 | Certificates | `/admin?tab=certs` |
| S03 | Printing | `/admin?tab=printing` |
| S04 | Print Queue | `/admin?tab=print-queue` |
| S05 | Staff | `/admin/staff` |
| S06 | Security | `/admin/security` |
| S07 | Partner Network | `/admin/partners` |
| S08 | Vault Quest | `/admin/vault-quest` |
| S09 | Card Factory | `/admin/vault-quest/card-factory` |
| S10 | Growth Command | `/admin/growth` |
| S11 | AI Learning | `/admin?tab=learning` |
| S12 | AI Divergence | `/admin?tab=divergence` |
| S13 | Grading | `/admin?tab=grading` |
| S14 | Capture Health | `/admin?tab=capture-health` |
| S15 | Command Centre | `/admin/command`; disappears while the persisted Pilot Flag is OFF and returns ON. |
| S16 | Promotions | `/admin?tab=promotions` |
| S17 | MVGS Calibration | `/admin/mvgs-calibration` |
| S18 | Transfers | `/admin?tab=transfers` |
| S19 | Scans | `/admin?tab=scans` |
| S20 | Sets | `/admin/sets` |
| S21 | Social Studio | `/admin/social-studio` |
| S22 | Capacity | `/admin?tab=capacity` |
| S23 | Advanced Reel Pipeline | `/admin/weekly-reel` |
| S24 | Pricing | `/admin?tab=pricing` |
| S25 | Intake | `/admin?tab=intake` |
| S26 | Submissions | `/admin?tab=submissions` |
| S27 | Catalogue Manager | `/admin/catalogue` |

`Log out` is the one inherited session control (S28-equivalent). It was deliberately not invoked because authentication persistence was necessary to finish the authorised acceptance. It is outside the changed Command Centre behaviour.

## B. Page-level controls — 40 controls

| ID | Control | Observed result |
|---|---|---|
| C01 | Admin breadcrumb | `/admin` rendered. |
| C02 | Period selector | Changed Today → Month to date; selected value persisted in the page. |
| C03 | Refresh | Refetched snapshot successfully; snapshot timestamp updated. |
| C04 | Partner network state KPI | Source-labelled link to `/admin/partners`; destination reached. |
| C05 | Blocked Partner onboarding KPI | Source-labelled link to `/admin/partners`; destination reached. |
| C06 | Partner credit projection KPI | Explicit `UNAVAILABLE` / `PARTNER_WALLET_UNAVAILABLE`; `/admin/partners` destination reached. |
| C07 | Station lifecycle state KPI | Aggregate-only station lifecycle values; `/admin/partners/stations` reached. |
| C08 | Connector exceptions KPI | `/admin/partners/infrastructure` reached. |
| C09 | Non-terminal submissions KPI | Explicit `UNKNOWN` / `SUBMISSION_STATUS_VOCABULARY_UNKNOWN`; `/admin?tab=submissions` reached. |
| C10 | Scan queue backlog KPI | `/admin?tab=scans` reached. |
| C11 | Grading queue backlog KPI | `/admin?tab=certs` reached. |
| C12 | Grades awaiting review KPI | `/admin?tab=certs` reached. |
| C13 | Print batch exceptions KPI | `/admin?tab=print-queue` reached. |
| C14 | Ownership transfer exceptions KPI | `/admin?tab=transfers` reached. |
| C15 | Paid submissions recorded KPI | `/admin?tab=submissions` reached. |
| C16 | Print-batch attention | `/admin?tab=print-queue` reached. |
| C17 | Partner-onboarding attention (five rendered records) | Each rendered canonical Partner onboarding URL was reached: five unique destination records. |
| C18 | Grade-review attention | `/admin?tab=certs` reached. |
| C19 | Unassigned-scan attention | `/admin?tab=submissions` reached. |
| C20 | Explorer collapse/expand | Both states worked and exposed the expected `aria-expanded` state. |
| C21 | Capability search | `station` produced exactly one matching capability. |
| C22 | Department selector | `finance` with `paid` search produced exactly one matching capability. |
| C23 | KPI-status selector | `UNAVAILABLE` produced exactly Partner credit projection. |
| C24 | Details: Partner network state | Opened; `aria-expanded=true`. |
| C25 | Details: blocked Partner onboarding | Opened; `aria-expanded=true`. |
| C26 | Details: Partner credit projection | Opened; source label visible; template destination intentionally withheld. |
| C27 | Details: station lifecycle | Opened; `aria-expanded=true`. |
| C28 | Details: connector exceptions | Opened; `aria-expanded=true`. |
| C29 | Details: operational submissions | Opened; `aria-expanded=true`. |
| C30 | Details: scan queue backlog | Opened; `aria-expanded=true`. |
| C31 | Details: grading queue backlog | Opened; `aria-expanded=true`. |
| C32 | Details: grades awaiting decision | Opened; `aria-expanded=true`. |
| C33 | Details: print exceptions | Opened; `aria-expanded=true`. |
| C34 | Details: disputed ownership transfer | Opened; `aria-expanded=true`. |
| C35 | Details: paid submissions recorded | Opened; `aria-expanded=true`. |
| C36 | Details: deterministic attention policy | Opened; `aria-expanded=true`. |
| C37 | Dynamic canonical workspace links | Revealed only for concrete safe paths; every unique page-level destination they duplicate was reached. |
| C38 | Disabled Pilot Flag route state | `/admin/command` rendered an unavailable state while OFF. |
| C39 | Enabled Pilot Flag route state | `/admin/command` rendered 12 KPI cards and 13 registry items after ON restoration. |
| C40 | Accessibility/readability contract | Labels, headings, roles, source/status text and focusable native controls were present in the rendered DOM; the scoped layout used responsive grid classes without a global stylesheet override. |

## C. Pilot Flag acceptance

The persisted Super Admin Partner Pilot Control `super_admin_command_centre_enabled` completed ON → OFF → ON:

1. **ON baseline:** Command Centre navigation, dashboard and authenticated Super Admin surface rendered.
2. **OFF:** Pilot Controls displayed `Disabled`; a notification confirmed it; Command Centre navigation was absent and the direct route rendered the generic unavailable state.
3. **ON restored:** Pilot Controls displayed `Enabled`; notification confirmed it; navigation and 12-card/13-registry dashboard returned.

No production UI or production flag was opened.

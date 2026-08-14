# WP0 P14 reconciliation boundary

## Evidence map

| ID | Claim |
|---|---|
| WP0-P14-01 | Committed Partner HEAD is `d44a2c53`; prompt lineage through P9 is ancestral. |
| WP0-P14-02 | Active Partner worktree contains 9 modified + 3 untracked P10-style authority files and was not modified by this campaign. |
| WP0-P14-03 | Durable acceptance evidence ends at P9; final P14 artifacts/frozen authority are unavailable. |
| WP0-P14-04 | During WP0 the active branch advanced to `73b2072e6e876b582098ae02e01991afdc1270e7` and its dirty inventory changed to one modified grading UI file, proving the worktree is moving and must not be used as Scanner source. |

## Observed Partner state (read-only)

- Worktree: `/Users/cornelius/mintvault-partner-pilot-pass2`
- Branch: `codex/partner-pilot-pass2`
- Committed HEAD: `d44a2c5363e702bb5aeb54157d7ad6a2af30546c`
- Upstream/local remote state: 30 ahead, 1 behind local `origin/main` `9cd9804d199138502487824ca40e10261bba64d3`
- Dirty state: 9 modified tracked files and 3 untracked files, including protected grading and new Card Job grading/lifecycle authority
- Durable evidence: ends at P9; no committed P10-P14 closeout; Phase-14 tenant matrix/RTM/invariant/runbook artifacts absent; AT-23 remains staging-topology blocked
- Drift observation: later in the same WP0 pass the active HEAD became `73b2072e` (31 ahead / 1 behind) with `client/src/components/grading/grading-panel.tsx` modified. This later state was observed only to prove movement; it is not imported or treated as frozen P14.

## Safe-base decision

`d44a2c53` is accepted only as an immutable Scanner implementation seed because
it contains all named Partner commits through P9 and does not copy dirty WIP.
It is explicitly not a release base or final Partner authority.

## Authority that Scanner must consume, never duplicate

| Domain | Committed Partner surface |
|---|---|
| Human auth/MFA/session | `server/partner/auth.ts`, `public-routes.ts`, `mfa-service.ts`, `session.ts`, `step-up.ts` |
| RBAC | `server/partner/permissions.ts`; migrations `0085`, `0086` |
| Location | `server/partner/location.ts`, `session.ts`, Partner management routes; migration `0084` |
| Station | `station-identity.ts`, `station-service.ts`, `station-routes.ts`, `station-admin-routes.ts` |
| Card Job/NEW | migrations `0080`-`0082`, `card-job-authority.ts`, `station-routes.ts` |
| Grading Credit | `partner-credit-reservation-service.ts`, `credit-purchase-service.ts`, webhook branch |
| FIX | `fix-authority.ts`, `station-routes.ts` |
| Evidence | migration `0047`, `scanner-capture-service.ts`, staging/finalisation services and server routes |

## Final reconciliation gate (R-9)

1. Wait for an explicitly frozen, clean P14 Partner HEAD; never request or copy its dirty WIP.
2. Record its exact SHA/status/origin and compare to `d44a2c53` by semantic surface, not bulk merge.
3. Reconcile only minimal Partner-owned server extensions required by Scanner contracts.
4. Reconcile against then-current canonical main separately.
5. Run Partner critical/acceptance suite and Scanner suite against the same candidate SHA.
6. Reopen every proof invalidated by changed auth/RBAC/location/station/Card Job/credit/NEW/FIX/evidence dependencies.

Until all six steps pass, R-9 remains `BLOCKED_EXTERNAL` and the Scanner release
cannot pass WP12, while independent Scanner implementation continues.

# Change manifest — Command Centre V1 overnight assurance

## Frozen objective

Repair only reproduced V1 release defects. No new capability, workflow execution, AI, Graphify, business mutation, migration, dependency, secret, payment, grading or production change.

## Allowed implementation surfaces

- Command Centre server adapters/composition/routes and their tests.
- Command Centre page, shared Admin shell/navigation, existing Pilot Flag invalidation seam, reduced-motion styling and tests.
- Existing Partner read services only where a bounded aggregate is required; preserve RLS and read-only semantics.
- Local runtime harness lifecycle and tests.
- Command Centre evidence, rollout and rollback documents plus controlled-code task records.
- Staging build default for the already-built Partner consolidation destinations, with exact artifact verification.

## Planned deltas

1. Make protected Command Centre queries refetch on mount and evict on logout, auth/flag denial, unmount and Pilot OFF.
2. Convert London period boundaries to the UTC-naive storage representation.
3. Normalise connector timestamps at the adapter boundary.
4. Refuse authoritative onboarding counts when the bounded source is incomplete; eliminate per-Partner readiness fan-out from the dashboard path.
5. Bound core SQL concurrency and apply database-side statement deadlines that end work after timeout.
6. Implement route-aware 401/403/404 states, grouped freshness semantics, Work Tree hierarchy/detail accessibility, and the owner-required Command Centre navigation group using only the 13 locked registry entries.
7. Ensure canonical Partner destinations exist in the release build, add reduced-motion/contrast compliance, and label aggregate zeros truthfully.
8. Make the disposable runtime harness signal/failure cleanup awaited and idempotent.
9. Replace the unusable rollback instruction with an exact captured-image procedure.

## Explicit exclusion

The earlier parser-only `req.ip` approval expired when its trust-proxy precondition failed. The owner has now separately authorised a Fly-aware **Admin client-network identity only** repair for `CC-OA-001`. The authorised surface is limited to the Admin allowlist, protected Admin/Super Admin rate-limit keys, a shared validated client-IP resolver, their adversarial tests, and temporary non-secret staging topology instrumentation that must be removed before the final candidate.

The repair may not change password/passphrase, PIN, MFA/TOTP, sessions, cookies, roles, permissions, Super Admin identity, Partner authentication, customer/staff authentication, grading, payments, migrations, secrets, or production configuration.

## Protected invariants

- No login, password/passphrase, PIN, MFA/TOTP, session, cookie, role, Super Admin permission, Partner auth or customer/staff auth UX change.
- No grading/certificate write-path change.
- No Partner RLS bypass or identifier disclosure.
- Command Centre remains GET-only/read-only, flag-gated, Super Admin-only and bounded.
- No production access.

## Required proof

Targeted regressions per issue, protected auth/grading/Partner matrices, typecheck/lint/build, runtime harness residue zero, independent hostile retest, exact staging SHA on both machines, ON/OFF/ON, zero-dead-UI, 320/768/desktop, deep links, controlled concurrency/load/log/recovery, current-main drift and rollback readiness.

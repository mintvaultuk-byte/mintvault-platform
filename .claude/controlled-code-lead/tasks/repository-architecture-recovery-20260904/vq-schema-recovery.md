# Vault Quest schema recovery packet

## Authority and baseline

2026-09-05: baseline `c712e4647bf8cd01732370e10e0282e8e454ded1`, feature branch
`fix/resource-hardening-staging-20260827`, pushed draft PR336. The only unrelated
dirty path is `docs/planning/vault-worlds/`; preserve it without inspection or staging.
Standing `owner-approval-record.md` authorises this repair and wave-end WIP commit
and non-force push. No deploy, shared migration, provider, credential access,
historical SQL rewrite, main merge, destructive cleanup or frozen grading change.
HY-SECURITY remains UNKNOWN; do not route its investigation through this wave.

Vault Quest is already mounted. The behavior-preserving owner choice is **required
and enabled**, not silent removal to make readiness pass. Existing source and SQL,
not historical deployment comments, are the authority for the local repair.

## Staged manifest and recovery

S1 authorises only `scripts/db/migrate.ts`,
`tests/vq-migration-authority.test.ts`, this packet, existing graph/task/engineering
issue/proof records, and exact generated architecture/test-inventory updates if
the added test changes their counts. No diagnostic waiver, baseline adoption or
historical migration modification. Reuse the current runner through a closed
`main | vault-quest` choice, with separate directories, journals and advisory locks.
Keep main defaults and endpoint/dedicated-backend/identity/checksum/destructive
guards unchanged. No arbitrary SQL identifier or journal may be selected by CLI.
Root is sole writer; Terra/Sol provide bounded read-only independent proof.

S1 proof: disposable PostgreSQL17.10; dry-run creates no journal; overlapping
numeric identities in separate estates; replay/checksum/inconsistent-state refusal;
same-estate lock exclusion; scoped execution cannot cross journals. Re-run existing
main migration regressions. S1 does not assert all sixteen VQ files converge, ship
in the image, or satisfy runtime readiness. Ordinary preflight is CRITICAL/HOSTILE;
final Opus hostile and immutable candidate/CI gates remain OPEN.

S1 exact inventory extension: `scripts/ci/typecheck-baselines/tests.json` changes
only tracked-file count/hash for the new test, never diagnostic allowances.
`scripts/architecture/legacy-authority.json` transfers the existing runner's exact
query identities: remove twelve obsolete keys, add nine renamed dynamic-query keys
under the same unresolved ARCH-AUTHORITY-001 disposition. The existing extractor
cannot resolve the closed table projection; this is NOT proof of resolved SQL
ownership. No new broad owner rule, extractor relaxation or adoption command.
`scripts/architecture/generated/architecture-authority.json` is regenerated normally.

S1 rollback: revert only this feature-branch foundation if its namespace regression
fails. No shared database has been modified; synthetic helper-owned clusters are
torn down by their existing helper. There is no database down-migration to run.

S2/S3 remain planned, not authorised for implementation by this manifest until the
exact source/SQL and compatibility contract are added here and independently
checked: preserve all sixteen historical SQL files; distinguish fresh execution
from read-only attestation of an unjournalled historical estate; never mark old SQL
as executed when it was not. Define additive convergence before applying anything,
ship the VQ inventory, replace raw CI SQL loops, and integrate explicit namespaced
readiness. Missing/partial schema must refuse admission. Retire fleet-unsafe
in-memory export fallback only with durable lifecycle and caller proof. Reserve
the next unused SQL identity and reconcile the export-lifecycle graph before use.
No historical estate has been inspected or migrated in this wave.

Mixed-version/recovery boundary: S1 adds an opt-in runner profile and changes no
web runtime, image, schema or route mount. Later readiness must be delivered only
with a proven schema cut; it must not deploy an enabled feature into a missing
schema. Disabling a component is not the selected product choice or a substitute
for repair. Any later failed cut retains durable data and requires forward repair,
not replayed historical SQL or a restored in-memory fallback.

## Evidence

S1 local implementation complete; not full VQ closure. Root78/78 across five
migration suites; independent Sol31/31 across VQ/identity/scoped suites, zero skips.
Final clean exact-lock six-suite105/105 includes architecture27; Vitest4.1.7,
Node20.20.2, helper-owned PostgreSQL17.10. Root Vitest4.1.11 is separate evidence.
Clean build PASS3366 modules including newly bundled migrate.cjs; actual bundled
invalid-estate invocation exits1 before credential resolution. Sol's compiled
directory projection check is simulated argv, not sixteen-file image execution.
TypeScript PASS; scoped lint0errors/0warnings; test345/script11 diagnostic ratchets
unchanged. Architecture8310 records (pricing1576), exact12 removals/9 transfers.
No skipped test or adopted waiver. Initial independent sandbox listener EPERM is
an environment failure, not counted; approved disposable rerun is authoritative.

Source SHA256:
```text
ba13b039ca6ead33f5de5387386d3cd9b4045ed0f83ae81fd00a56eb10b2b7c2 scripts/db/migrate.ts
4bf2f5133932c1d5c3447c6427b1f2acbfcb1fc948d91367051f1eaa568cc7d9 tests/vq-migration-authority.test.ts
```
Parent recovery approval is explicitly for S1; S2/S3 must extend this packet before
their writes. Repair/final proof/release vetoes stay open. Baseline c712 exact CI
33995549546 is in progress; governance33995549588/33995547327 failed. Not green;
restricted security causes remain UNKNOWN and are not investigated by this lane.
Ordinary postflight remains red on managed-CLAUDE drift, npm egress, preserved
dirty WIP and branch-wide protected review, with graph REBUILD_REQUIRED warning.
No --accept-protected or final completion override. Parent101/nested34 structural
validation passes, NOT READY. These vetoes are retained for integration.

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

## S2a exact fresh-estate / disposable-CI checkpoint

Baseline `d7e957de51ec9b5138fe3eb9b42883223db8bcc6` pushed. Preflight remains
CRITICAL/HOSTILE. Main agent has read all sixteen immutable SQL files. S2a writes
only existing `tests/vq-migration-authority.test.ts`,
`scripts/ci/prepare-engineering-governance-db.mjs`, `.github/workflows/ci.yml`,
`scripts/ci/verify-ci-topology.mjs`, `tests/ci-proof-topology.test.ts`,
`scripts/ci/migration-reference-policy.json` (exact synthetic S1 references), this
packet and existing graph/task/issue/proof records, and generated architecture
inventory if source locations change. No Docker/shipping/readiness/history writes
yet: these require S2b's exact extension and retain their release vetoes.

Fresh proof must execute the actual TS CLI against a newly owned empty cluster,
journal all16 exact checksums, replay with zero effects, verify important durable
constraints and retain existing rows. Disposable CI supplies migration authority
only to the runner child, derived from its already-validated test URL. No inherited
live alias is permitted locally. No broad --allow-destructive option or SQL edit.
The original SQL remains immutable including historical comments; comments do not
grant external execution authority. CI failure must remain blocking. Synthetic
filenames in S1 get exact test-reference classification, never shipped identities.

Recovery: revert CI wiring only if necessary while preserving SQL/history and S1
namespace code. No shared schema changed, no backfill/adoption attested. Root sole
writer and independent Sol proof; S2b/S3 remain open with no idle owner pause.

S2a proof: root VQ9/9 and CI16/16; independent Sol25/25; final clean exact-lock
52/52 (VQ9, CI16, architecture27), zero skips. The preliminary targeted red was
1 failing newly required topology case with15 test-filter exclusions, not final
proof. Final complete suites do not skip. Actual TS CLI executes all16 exact SQL
files in owned PG17.10, dry-run creates no journal, replay applies0, durable rows
remain identical, active idempotency/nonnegative attempts/bounded IDs still refuse
invalid writes. No main journal created. Child env contains only owned migration
URL, runtime PATH/locale and test mode. Independent child-authority review CLEAN.
Architecture8310 PASS; test345 diagnostic ratchet unchanged; scoped lint0/0;
JS syntax67 and migration references127 PASS. Four synthetic S1 names now have
exact non-shipped classification. No snapshot/policy ownership relaxation.
S1 production bundle is unchanged; its clean build remains scoped evidence, not
new S2 image-shipping proof. Entire governance helper/PG16 hosted execution is
not claimed; exact-SHA CI remains its own gate. Parent101/nested34 structurally
valid NOT READY; ordinary postflight retains known unwaived vetoes.

S2a independently verified SHA256:
```text
267dd3e4244340fcb2bbf9bf98b8d1d639d617212d8984995dd25e45a8900370 .github/workflows/ci.yml
4d9c94aaedc1bbdaf5f1ffc14a034af002ff6f15a5cf5d604edc6f0424d31e9d scripts/ci/migration-reference-policy.json
93c7641d1bce92d3a497f9f3d227affacb361d2a14ace52e446564ca2b872d80 scripts/ci/prepare-engineering-governance-db.mjs
59107c9ad9fb7dec6316f873d4ad04f730b249195f4e9fc875e44922abaed74d scripts/ci/verify-ci-topology.mjs
19ae0e6d40256c41923c181c331b8bd9c96b174e537ad61f5cd77bc495029fe7 tests/ci-proof-topology.test.ts
625daf5c42bf1d3e7097048ee3e12b7e4c47cfcb0759cd231d67cbf61a308a34 tests/vq-migration-authority.test.ts
```

## S2b catalog foundation manifest

Baseline `4d25602cc67d1dc87a00abf6f7b687dfe5413e27` pushed, exact draftPR336 verified;
CI33996842266/governance33996842214/33996840294 in progress. S2b starts with a
read-only foundation, not historical writes: add exactly
`server/lib/vq-schema-contract.ts` and `tests/vq-historical-baseline.test.ts`.
The former owns a deterministic public VQ catalog projection/fingerprint with no
connection, filesystem, provider or environment access. Include columns/types/
defaults/nullability, constraint definitions/validation, indexes/validity, sequence
configuration/ownership and triggers; exclude only the exact migration journal/
baseline receipt metadata. Do not fingerprint row content or secrets.

Existing16 immutableSQL applied to helper-owned PG17.10 supplies baseline evidence;
missing/partial/altered shapes must differ, data changes must not. Pin source-file
hashes and observed structural fingerprint after review, not a duplicated DDL or
large schema fixture. This helper alone grants no historical adoption/readiness.
Add exact file ownership in `scripts/architecture/authority-policy.json`, normal
generated architecture inventory, and test/app inventory count/hash only in
`scripts/ci/typecheck-baselines/tests.json` and `scripts/ci/typecheck-baselines/architecture.json`. Existing
graph/task/issue/proof records may update. No legacy allowlist/diagnostic waiver.
Rollback is removal of an unused pure helper/test, with no shared database change.

Further S2b writes require another exact extension after independent design review:
new0016 baseline receipt and namespaced historical mode, runtime classification/
grants matching immutable0121, shipping and required readiness. Main0121 must run
before VQ metadata exists on a fresh full image; never edit/replay its immutable
classification list. VQ metadata gets read-only runtime grants, not wider money/
auth/Partner powers. Later export migration reservation must move0016→0017 before
the0016receipt is authored. These are plans, not executed changes or closed gates.

Catalog scope is the current26 business relations and their owned sequences, not
every possible future VQ standalone sequence/function/type. Actual0000–0015 SQL
creates no such standalone object. Grants, data-seeding, migration execution and
historical adoption are expressly outside this foundation. Terra independently
verified16/16 and exact26/source-digest/schema-fingerprint plus narrow owner rule;
no extractor/legacy/adoption change. Root separately observed identical catalog
hash on newly owned PG16.13 and17.10. Temporary clusters were stopped and their
own synthetic data directories removed by their lifecycle, with no user data.

Final clean-lock68/68 (catalog16, VQ runner9, CI16, architecture27), zero skips.
Root TypeScript and scoped lint0/0 pass; architecture8310 unchanged, no generated
snapshot diff needed because the unused pure SQL helper adds no executable query
site. Inventory507tests/820app files changes counts/hashes only; existing diagnostic
allowances are untouched. Initial UNPROVEN fingerprint refusal was deliberate
baseline measurement, not a software defect or permission to auto-adopt future
schema changes. Full Opus/candidate/readiness/history/grant gates remain OPEN.
Final test345/architecture3 diagnostic ratchets pass, no additions or baseline
fingerprint allowances. Ordinary postflight retains the same managed-CLAUDE/npm
egress/dirty/protected-review vetoes and graph warning; no acceptance override.
Source SHA256:
```text
37e9b557a5fb39c0bfdc95f521b6f68093f36b59baab67e74fbf9c2e44addb11 server/lib/vq-schema-contract.ts
27ffd83e40554a3005d07bb04d4a503e0e21d46bd71f0ee402f53e4c7ca95c57 tests/vq-historical-baseline.test.ts
```
The next metadata design is evaluating an existing migration-only schema to avoid
0121's public-table classification conflict. No namespace change has been applied;
the earlier ordering proposal is not an irrevocable implementation decision.

## S2b metadata compatibility correction

Baseline `5e8140bb441f5432a6592c07b6d5047a2e4c105a` is pushed.
The new public VQ journal conflicts with immutable main0121's explicit public
table inventory. Resolve this narrow unreleased integration defect by using the
already-known `drizzle` metadata schema for `drizzle.vq_schema_migrations` and the
future `drizzle.vq_schema_baselines`. Do not modify ORM `__drizzle_migrations`,
main's `public.schema_migrations`, any0000–0015SQL, or main0121SQL. No new schema
registry allowance is needed: `drizzle` already denotes migration metadata.

Exact writes: `scripts/db/migrate.ts`, existing `tests/vq-migration-authority.test.ts`,
`scripts/db/schema-registry.ts` (existing schema reason only, no acceptance expansion),
`server/lib/vq-schema-contract.ts`, `tests/vq-historical-baseline.test.ts`, this
packet and existing task/graph/issue/proof records, plus exact renamed runner
query identities in legacy/generated architecture inventories if required.
No new files, owner rules, baseline count/diagnostic allowances or broad extractor
change. Profile uses a closed qualified identifier. Dry-run never creates a schema.
Old public control state is refused without adopting, deleting or copying rows.
All prior S1/S2 proof limits stand; newer namespaced proof supersedes their table
location, not their claims about business data or absence of deployment.

Proof: reproduce old0121 conflict, then execute immutable0121 after actual16 VQSQL
without losing rows; preserve main runner regressions, full/scoped VQ journal/
lock/checksum/replay and catalog fingerprint. Metadata ACL/readiness/history are
still later0016 work. The root is sole writer, Sol independently reviews this exact
namespace decision. Rollback may not restore public metadata as a release target;
keep the unused feature-branch runner unavailable if this compatibility proof fails.
No shared databases have the new S1 journal from this work, and no external
migration is performed or inferred. New local metadata is only helper-owned.

## Metadata correction proof

Metadata correction final root proof (baseline5e8140bb + exact WIP): original
immutable0121 regression reproduced `unclassified public relation(s): vq_schema_migrations`;
fixed path passes real0121 after all16 VQ files, retains durable rows and the same
catalog fingerprint. Refuses public journal, receipt and orphan serial sequence
without copy/adoption/deletion/schema creation. Main defaults stay unchanged.
Root97/97 before the added residue/race cases; final clean-lock127/127 across seven
complete suites, zero skips, explicitly executed from the clean-copy working
directory. Build PASS3366 modules, including migrate.cjs; clean copy has no Git HEAD
so build identity fallback warning is not candidate provenance. TypeScript/lint0/0;
test345/script11 ratchets unchanged. Architecture8310 with one exact old-query-key
transfer, unchanged disposition/expiry; schema registry reason only, no allowance.
Independent Sol30/30 and held-out interleaving now PASS. Sol reproduced a scoped
preflight/lock race: legacy public journal could appear before lock acquisition,
then target SQL executed. Root's new regression was red (applied=true, two journal
rows), then fixed by checking legacy state again under the lock before any writes.
Held-out rerun refuses, preserves the journal byte-for-byte and adds no column.
The targeted red's12 filtered tests are not final proof; full30/127 have zero skips.
Sol agrees existing drizzle is narrower than adding another accepted schema.
0016 must require the existing main runtime role, never journal skipped grants;
runtime must prove metadata USAGE/SELECT and denied mutation. These remain next-wave
requirements, not completed proof. Ordinary postflight remains unwaived red for
managed-CLAUDE drift, npm egress, preserved dirty WIP and branch protected review.
Exact5e8140bb draftPR336 verified; CI33997559856/governance33997559854/33997557543
running at observation. Prior4d256 primary cancelled, one governance failure and
one success; no all-green claim or restricted-lane investigation.

Metadata correction source SHA256:
```text
160e47abcff3867ad2125953aa0ddeeb7cd7519474cc7af377380019f4491148 scripts/db/migrate.ts
38a9a39eef533f77116dca9d839e02de18081ef8dcdc243fcd0c4dee3e419ef7 scripts/db/schema-registry.ts
2d671e11e20b8c059aad4da1388f5c4221f4a26404539d4560253b6f111a68c8 server/lib/vq-schema-contract.ts
998f63db2ccd90157d840b8fee1c28f40b03218c1470901b49be80b05509d0e2 tests/vq-migration-authority.test.ts
fe3c154f75fcdff815d314f125fdf191a748d4d54aff16db0cb8ce5401f84a1f tests/vq-historical-baseline.test.ts
```

### Original S1 checkpoint proof (historical)

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

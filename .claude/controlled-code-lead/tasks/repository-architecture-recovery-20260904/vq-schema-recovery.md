# Vault Quest schema recovery packet

## Current position (2026-09-06)

S2c checkpoint `ecdac32562fa81c3d1cc6f3e633adb403aea169a` is pushed and
verified as the existing draft PR336 head. Continue S3a below without owner pause.

## S3a namespaced readiness foundation manifest

Baseline ecdac325; preflight CRITICAL/HOSTILE. Root alone edits exactly
`server/lib/component-readiness-registry.ts`,
`scripts/architecture/check-architecture.mjs`, existing
`tests/architecture-authority.test.ts`, and this packet plus existing graph/task/
engineering issue/proof records. Regenerate the existing architecture snapshot
only if these source changes alter its exact records. No new files, dependencies,
SQL, component activation, image, runtime database query or diagnostic allowance.

Migration entries gain an optional closed `estate: main | vault-quest`, with
omission meaning main. Compile explicit immutable estate/name requirements while
preserving the legacy main-only requiredMigrations projection and every existing
requirement order. Reject unknown estates, extra keys, same-estate duplicates and
order gaps; identical names in different estates are distinct identities. The
architecture gate must resolve required migrations by estate, never let a main
file satisfy a VQ requirement, and still reject VQ as unshipped until actual image
wiring lands. Namespaced acceptance is not runtime readiness or shipping proof.

Sol independently reviews the bounded contract and runs regression/held-out proof.
Existing main readiness projections must remain exact. Rollback is a feature-
branch code revert of this unused foundation; no database action or historical
replay. Next S3b extends the manifest for actual image inventory/runner proof,
then required VQ runtime admission and durable-only fallback. All existing final
candidate, Opus, restricted-security and external vetoes remain OPEN.

S3a final proof: root30/30; independent Sol30/30 plus held-out estate/immutability/
order checks; clean exact-lock47/47 architecture+CI tests, zero skips, build3366
modules PASS. TypeScript and scoped lint0/0 PASS; test345/script11 debt unchanged.
Architecture8349 unchanged; no snapshot/adoption/owner/diagnostic allowance edits.
Migration references127 unchanged using existing classified synthetic fixtures.
Root's first edit missed two main-lineage set lookups; existing regressions caught
both and main-qualified lookup repair passes, with original lineage SQL untouched.
Final fixture-only rename independently confirmed equivalent by Sol. No DB access
needed for this pure foundation. Exact ecdac325 CI33999865052 and governance
33999864997/33999862748 in progress at observation, not green. Ordinary postflight
retains known unwaived vetoes. Clean-copy build lacks Git identity and is build
compatibility proof only, not an exact candidate image claim.

S3a SHA256:
```text
6e348e1046a9b2b1138e3a3a4ef93fc23fe92a3b2c0ce8555199c73963aa0cec server/lib/component-readiness-registry.ts
f37110cc7494adee9f358d6616b202aea77be7ae323202998772eadb39cd9e63 scripts/architecture/check-architecture.mjs
46215c29dbe16405f6ceb9c59276d7ab7df2e5e11383f887c99b0b80984833b8 tests/architecture-authority.test.ts
```

S3b pre-existing shipping gap is source-confirmed: Docker copies only main SQL.
Terra also reproduced the new recovery module's missing exact `.dockerignore`
admission (Docker context suite7pass/1fail). Both are accepted in-scope work under
ARCH-SCHEMA-001, not external blockers; next image wave must repair and prove them.

S1/S2 metadata and historical recovery are locally independently proven; current
wave baseline97a88450, final source hashes below. The dated sections retain
historical proof, not competing rollout instructions. Required VQ shipping,
runtime readiness, durable-only fallback and candidate/hostile gates remain OPEN.
No shared database has been migrated and no deployment is authorised.

## S2c final evidence

Root focused64/64; independent Sol64/64 plus held-out concurrency/refusal probes;
subsequent CI-helper invalid-row preflight independently Terra15/15. Final clean
exact-lock ten-suite168/168 and build3366 modules PASS, zero skips. Native owned
PG16.13 additionally proves fresh17 executed/0 attested, historical1 executed/16
attested, both0 pending and exact baseline fingerprint. PG17.10 tests include
actual TS CLI and same-owner sequence locks; no state/owner/dependency/counter
changes, peer ALTER SEQUENCE/CREATE INDEX fail55P03 at final catalog observation.

Same-pass reproduced and fixed: empty qualified journal hid unjournalled business
state; lost receipt exposed old files as pending; pre-lock receipt checks could
become stale; weak table/sequence locks did not protect observed schema; historical
CLI accepted extraneous flags; CI helper could upgrade invalid metadata before
refusal. Each retains a regression or independent held-out proof. Discarded
locking experiments are recorded below and excluded from accepted proof.

New0016 preserves immutable0000–0015/main0121 and records observation separately.
It requires restricted non-owning main role, converges3append/23mutable grants,
revokes column-level leftovers, and grants only metadata SELECT/USAGE. No wallet,
payment or tenant authority changes. The shared test-only prerequisite journals
only actually executed0121; independent Terra source check found no shared-PG16
consumer subsequently applying the full main backlog. Invalid helper row now
refuses before any journal DDL. Expected child refusal output is a passing negative
test, not an ignored process failure. Future0017 evolution is synthetic proof,
not an authored/shipped export migration. Seed contents remain outside attestation.

TypeScript/scoped lint PASS; test345/script11 diagnostic debt unchanged. Script
inventory53 and JS inventory68 update exact count/hash only. Architecture8349
records with two exact new-module owners; no main legacy adoption or broad owner
rule. Three additional pricing-category records are SQL-placeholder extraction,
not changed commercial prices. Migration reference inventory127, VQ17 still
explicitly UNSHIPPED. Ordinary postflight retains managed-CLAUDE drift/npm egress/
dirty/protected-review vetoes; parent101/nested34 remain NOT READY. Exact97a88450
draftPR336 verified; CI33998335858 and governance33998335909/33998332934 terminal
FAILURE, not green. Restricted security causes remain UNKNOWN, not re-investigated.

Source SHA256 (invalidate proof on change):
```text
27c94f64d9677034d6c4e7f9af810e09e1bcaeaf1ed3b38f775bcf4d36bd451a scripts/db/migrate.ts
580339f87ae31861707562555828700cddef155ea096ae4d44695b50a9ec0a11 scripts/db/vq-schema-recovery.ts
2ee33f1331aff5c02b2369a3872cfdb520e183eda194d77e2e4810a723e0be6c scripts/ci/prepare-vq-test-db.mjs
fbc741ee9356f7c30f44bee7d4e99ce8f0a1048d5522aa2be7130349abc175c6 migrations-vq/0016_schema_baseline_authority.sql
826416eb779417a02add2d32838af6df645ac6a7aee540bb9dd329deb43abe8b server/lib/vq-schema-contract.ts
ce4ecf95efd115da6caa52253f87639bcd44df5cbc9c48725f06e6b0cd8c2589 tests/vq-migration-authority.test.ts
29d71cd9441866e8a2b10ae8a9c2a98887443dfc6dcd18179cdb9850b84f0a40 tests/vq-historical-baseline.test.ts
d1558f451c9b193288c3868f814a02a759eb5124542e4e2c023986fe9f501a11 tests/ci-proof-topology.test.ts
```

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

## S2c exact history/permission implementation manifest

Baseline `97a8845069042a2ef47f1107f3103b5459ca2cc7` pushed. Preflight
CRITICAL/HOSTILE. Extend only existing runner/catalog/runner+catalog tests, add
`migrations-vq/0016_schema_baseline_authority.sql`; existing CI workflow/helper/
`scripts/ci/prepare-vq-test-db.mjs` adds one shared closed test-only main0121
prerequisite using the existing runner API and dedicated-backend check. It accepts
only the exact loopback disposable DB, no query overrides or foreign main lineage.
This avoids a new production CLI fixture bypass. Both CI consumers invoke it.
topology tests and validator may wire the main-role prerequisite on their fresh
disposable fixtures. Existing graph/proof/task records, exact architecture and
SQL reference inventories may update without wider ownership or diagnostic waivers.
Reserve later export lifecycle identity0017, not0016. Historical0000–0015/main0121
stay immutable. No shared migration/deploy/provider/credential operation.

Fresh execution and historical observation are distinct: fresh journals all files
and has no receipt. Explicit historical-baseline-v1 is VQ-only and apply-only;
admission requires no VQ control objects, exact immutable16 source-set digest and
exact26-table structural hash. Ordinary apply must refuse existing unjournalled
business schema before creating control metadata. Hold existing VQ advisory lock
and transaction plus closed table locks through final fingerprint and0016/receipt/
journal writes. Never insert0000–0015 execution rows. Roll back the complete new
control/grant state on failure and preserve all business rows.

0016 requires main-owned mintvault_app before work; never conditionally skip grants.
Converge exact3append/23mutable privileges and their owned sequences from0121;
revoke existing PUBLIC/group powers on those exact objects first. Metadata is
USAGE/SELECT-only, no writes or sequence access. Receipt constrains fixed version,
source digest and schema hash and records observation, not prior SQL execution.
No seed-content attestation. Historical plans explicitly report attested-not-applied;
receipt and complete forward checksums must validate. Baseline hash is admission
evidence, not a permanent ban on approved0017 evolution. Each forward cut needs
its own schema/readiness proof. Required runtime/shipping/fallback gates stay OPEN.

Independent sequence/index DDL interleaving disproved ACCESS SHARE/serializable
alone as atomic shape protection. Strengthen the exact26 table locks to SHARE ROW
EXCLUSIVE and acquire owned-sequence DDL locks by reasserting their verified current
owner (`ALTER SEQUENCE public.<verified-name> OWNER TO <same-owner>`). Parent table
locks prevent ownership transfer; an owned sequence cannot change owner independently.
This is an intentional no-op DDL lock: never nextval/setval or changing owner/parameters.
Read fingerprint before and after sequence locks, hold through receipt/journal commit.
Root PG17 owned-serial experiment proves concurrent ALTER fails55P03 and last_value/
log_cnt/is_called remain identical. No-option ALTER was syntax-invalid; SET SCHEMA
worked only on unowned sequences and independent actual-owned proof rejected it.
Neither discarded primitive remains in implementation or accepted final proof.
Real rollout additionally requires exclusive migration authority/quiescent operator
DDL, including creation of new objects; the advisory lock coordinates approved
runners, not a claim to constrain an arbitrary superuser ignoring governance.
This exact locking extension is authorised only on owned synthetic proof databases
in this wave. Shared execution remains expressly forbidden.

Root alone implements; Terra design and Sol bounded execution proof are independent.
Keep the new VQ-specific recovery/attestation functions in one focused
`scripts/db/vq-schema-recovery.ts` module, not in the already-large main runner.
It receives the existing lock/journal mechanics and owns no connection or CLI.
Exact ownership rules for that module and the CI helper identify their bounded
owners; do not relabel the main runner's pre-existing unresolved legacy inventory.
Update scripts file inventory count/hash only if required, never diagnostics.
Recovery is feature-branch code revert before any shared activation; no downgrade
that replays historical SQL, erases receipts or restores unsafe memory fallback.

### Prior metadata checkpoint

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

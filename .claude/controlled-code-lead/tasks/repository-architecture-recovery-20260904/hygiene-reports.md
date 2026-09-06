# Bounded hygiene investigations — 2026-09-05 launch

Execution baseline: `80a20611ff5e8928fd6380961ca6bd420abe4727`.
These are concise Lead-retained reports from actual read-only agents, with adjudication
notes where their initial wording exceeded the evidence. They are investigations, not
independent repair certification. No report author changed repository or provider state.

## HY-GIT — FAIL / ownership and enforcement remain incomplete

Observer: `/root/hy_git`; model: `gpt-5.6-luna`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Observed 97 worktrees, seven detached, 31 dirty at launch. The increase from the prior
30 includes this checkout's new planning changes, not evidence of unrelated drift.
`git for-each-ref --contains` finds remote-reference containment for 51 worktree HEADs
and none for 46. These are cached-ref observations, not proof that every possible GitHub
backup was examined. Last-commit authors/dates are known; active task/process ownership,
ignored-data disposition and retention intention remain UNKNOWN. None is cleared to delete.

Authenticated PR reads retain draft PR336 at remote `2913bcb1`, base `01d5e4da`, red checks
and no approving review. Main protection has five required contexts, zero approvals,
no code-owner/admin enforcement; repository rulesets are empty. Recovery-branch protection
lookup reports unprotected. Only PR336/287 map directly to registered branch names; this
is not proof other PRs lack useful work. Existing IDs: REM-GH-001, EXTERNAL-GITHUB.

Lead correction: CodeQL analysis success must not be conflated with the separate failing
CodeQL result check. Require exact candidate/check identities and an enforced negative
control before a protection claim. Next: retained per-worktree inventory, safe integration
queue and reviewed controls manifest; no bulk closure/deletion or force-push.

## HY-DOCS — FAIL / current and historical authority conflict

Observer: `/root/hy_docs`; model: `gpt-5.6-luna`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Verified stale all-routes/IStorage prescriptions in CLAUDE.md and README.md, legacy Claude
lead language versus managed Codex lead, and old pending-dependency approval in the
controlled-code-lead index despite the Sep4 approval record. Current dispatch validation
passes. Existing IDs: ARCH-AUTHORITY-001, REPAIR-AUTHORITY-CONTROLS.

Minimal packet: one engineering/INDEX.md, thin root links, corrected current architectural
and role paragraphs while retaining Golden Rules, explicit supersession for current
misleading status, generated-artifact ownership/retention, no file moves yet. Retain
existing task/graph paths and immutable evidence. Lead correction: a dated historical
“not pushed” note about a different release is not automatically a current contradiction;
only current-authority consumers are corrected. No additional specialist skill needed.

## HY-CI — FAIL / current image and governance work; old failures partly repaired

Observer: `/root/hy_ci`; model: `gpt-5.6-terra`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Run33912428226 at pushed2913bcb1 failed architecture on obsolete legacy-authority entries;
ordinary tests did not run, so five missing-report execution-floor errors were cascades.
Current80 architecture (8,621 records), CI topology and TypeScript pass in narrow local
checks; do not re-repair them or call them hosted-proven. Run33912428170 also had the old
PDFDocument.destroy typing and architecture/unit-test failures; exact80 hosted result absent.

Image job101151680201 built and passed native/module checks, then failed because `tsx`
was shipped. Dockerfile/lock/package are unchanged since2913; current lock classifies tsx
devOptional. Root `npm ls --omit=dev tsx` being empty does not prove the container clean.
Keep the negative require.resolve gate. Investigate production dependency graph/pruning
semantics and repair Docker dependency packaging narrowly, then rebuild/retest the image.

Main versus managed workflow diverges in Node and pinned refs; integration_test is empty,
test reports are not retained like SBOM, no supported MinIO/browser aggregate exists.
Packet: managed-source reconciliation, aggregate harness, stronger topology/dispatch
coverage and always-upload sanitized reports. Existing IDs: ARCH-CI-001,
REPAIR-CI-TOPOLOGY, REM-SUPPLY-001, WAA-GATE-001. No full suite/build/provider operations.

## HY-DB — FAIL / disposable harness and VQ convergence incomplete

Observer: `/root/hy_db`; model: `gpt-5.6-terra`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Source establishes atomic same-database/separate-role accounting, transaction-local tenant
context and runtime-role readiness. Pool acquisition/statement/lock budgets and aggregate
capacity need the existing ARCH-POOL-001 packet. VQ routes are mounted while migrations-vq
has separate CI/manual lineage, no registered readiness manifest and missing-schema fallback;
retain ARCH-SCHEMA-001 and current print proof rather than duplicate findings.

Matrix loopback checks do not prove owned service/run/port/database identity. Preparer env
does not propagate into a subsequent local shell. Proposed packet: parent-owned scrubbed
environment/service lifecycle, test ownership/allowlist guard, parent-child env contract,
fresh/historical migration proof and separate restricted-role assertions. Preserve suite
isolation and existing matrix. Numbered/VQ migration authoring must use an explicit reviewed
compatibility/lineage manifest; never renumber applied SQL.

Lead corrections: installed PostgreSQL is not capability proof; the initial scrubbed
native17 startup failed and was subsequently diagnosed as missing LC_ALL on macOS. Do not
disable functioning VQ globally to make readiness green: preserve enabled behavior where
its authoritative schema is present and use explicit availability semantics when absent.
Provider capacity/deployed schema remain UNKNOWN; no shared DB was inspected or changed.

## HY-CONTRACTS — FAIL / three existing contract repairs; prior repairs need proof

Observer: `/root/hy_git` (reused slot); model: `gpt-5.6-luna`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Source confirms mount.ts218–221 places legacy plural supplies before paid-commerce router;
both register GET /supplies/orders. Existing access tests exercise routers independently,
not combined dispatch. Packet: retain paid orders on their canonical route; give retained
legacy request/history a distinct route namespace and update its consumers, preserving
both histories. Require mounted real HTTP/tenant/role proof. ARCH-SUPPLY-001 unchanged.

Admin Pricing consumes snake_case while Drizzle/read/write contracts are camelCase. Align
the typed client with canonical service data and prove render plus public display/quote/
charge parity; a UI-only spelling fix does not close full ARCH-PRICING-001. Server
SCANNER_OPERATOR is absent from client role/choice/edit contracts; shared canonical role
projection plus real invite/edit and negative capability tests owns ARCH-ROLE-001.

Repaired Admin session/print/legacy tombstones require existing candidate-bound proof,
not redesign. Happy-dom component tests are reusable but not a real-browser substitute.
Retain owner-approved price/tax/address snapshots, Stripe paid/refund authority, Finance
read-only and post-dispatch manual exception rules. No behavioral/provider test ran here.

## HY-SECURITY — UNKNOWN / platform access restriction

Observer: `/root/hy_security`; model: `gpt-5.6-sol`, high.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

The assigned worker errored before returning an investigation: "This content was
flagged for possible cybersecurity risk." The platform directed authorized users to
Trusted Access for Cyber. This is a system-access restriction, not a product finding
or a successful review. No conclusions about alerts, token remediation or credentials
are inferred. Do not reroute the blocked investigation through another model/provider.
Dependent security verification stays UNKNOWN and release-gated. Independent functional,
documentation and build-reliability work may continue within their existing scope.

## HY-RUNTIME — FAIL / retained known functional reliability backlog

Observer: `/root/hy_runtime`; model: `gpt-5.6-terra`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Source confirms the existing WAA-IMAGE-001/002/003 packets: stale expected-state across
sequential two-side finalization, mixed named-object/audit descriptors, and phone upload
writing an object without persisting its certificate pointer. Reuse certificate-update-route,
certificate-image-upload-audit and manual-certificate-image-object-write PG17 harnesses.
Manifest: server/routes.ts and server/lib/certificate-image-persistence.ts; coordinator
changes only if batch finalization requires them. Preserve migration0122 and create-only
revision identities; prove replay, race, failure and forward recovery, not fictional
cross-store atomicity.

WAA-CREDIT-001 retains session-local date casts against a UTC reservation day in
server/estimate-credit-consumption.ts. Repair all reserve/refund/recovery paths together
and prove non-UTC midnight plus concurrency using estimate-credit-recovery-lifecycle.
The existing startup/five-minute credit sweep is wired; do not reinvent it.

ARCH-VQ-EXPORT-001 retains missing expiry/reclaim/scheduler behavior and memory fallback;
use export-job-store/export-jobs/index with two-machine/restart/persistence-failure tests.
Expiry does not authorize object deletion. ARCH-SOCIAL-001 retains provider-success/DB-
unknown ambiguity and long advisory-lock hold; require durable intent, short claims and
reconciliation, never blind republish after an unknown provider outcome.

ARCH-CYCLE-001/ARCH-PROXY-001 retain root-helper imports and request mutation/app.handle
redispatch. Extract typed leaf-safe commands only with mounted-route parity proof.
Security behavior was outside this functional inventory and remains UNKNOWN. These
reports confirm source locations, not fresh behavioral reproductions or repair closure.

## HY-SCANNER — FAIL / packaging and operational authority gaps

Observer: `/root/hy_scanner`; model: `gpt-5.6-luna`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Accepted scanner source is unchanged. package-macos.js recursively copies node_modules
excluding Electron but not happy-dom; verify-package.js does not assert the complete
lock-derived production set. SFAP-007 packet: those two scripts plus the existing
scanner-packaging test. Do not redesign capture/evidence. Scanner tests returned 171 pass
and four listen-EPERM environment failures; neither a scanner defect nor a full-suite pass.

Signed-package guidance conflicts with source-install scripts and active-looking watcher
runbooks (ARCH-LEGACY-OPS-001/SFAP-009). Retain historical source and make documentation
authority explicit. Lead correction: do not disable legacy installers merely on this
inventory; replacement, rollback and retirement prerequisites must pass first, in the
existing graph order. No package was built, distributed, signed or deleted.

Developer ID signing/notarization, clean-Mac install, physical scanner/V850, printer,
NFC and unavailable current-browser hardware checks remain external gates. Source/package
checks cannot discharge physical acceptance.

## HY-STRUCTURE — FAIL / bounded extraction and consumer reconciliation remain

Observer: `/root/hy_structure`; model: `gpt-5.6-luna`, medium.
SHA: `80a20611ff5e8928fd6380961ca6bd420abe4727`.

Architecture check passes 8,621 records; unreachable ratchet passes with three retained
diagnostics, not zero debt. App.tsx has 173 Route elements and multiple reachable home/
pricing variants. Size/clone inventory prioritizes extraction but proves no semantic
equivalence or safe deletion. ARCH-ADMIN-TAB-001: admin.tsx accepts sets but dashboard
has no sets branch; preserve canonical /admin/sets and explicitly redirect the old deep link
with navigation proof. ARCH-DEAD-001 retains unreachable watcher bodies behind deliberate
retirement returns; preserve target-bound scanner authority before any removal.

routes.ts remains 12,701 lines, storage.ts 4,021; transfers/stolen/embedding/pre-grade
retain root back-import exceptions. Extract leaf-safe helpers and bounded commands only
with route/import/parity proof. Generated snapshot and legacy ledger have actual policy,
test and CI consumers; retain until regeneration/equivalence proof. Historical clone
counts are prioritization data, not new HIGHs or a deletion warrant. Runtime/browser,
bundle, extraction equivalence and safe retirement proof remain UNKNOWN.

## Lead local substrate evidence (not an independent lane report)

A clean disposable pinned Node20 Linux container reproduced tsx in an omit-dev install.
npm explain established tailwindcss-animate (runtime dependency) -> Tailwind peer ->
postcss-load-config -> optional tsx peer. The only source consumer of tailwindcss-animate
is tailwind.config.ts:110, a build-time plugin. Candidate packet: move its unchanged
version to devDependencies, regenerate the lock using pinned npm, retain existing image
exclusion checks and prove build/native modules. Installation used ignore-scripts for
dependency-graph diagnosis only; it is not native-module/application image proof.

Pinned Node20.20.2: the frozen-MVGS verifier passed all ten hashes; ci-proof-topology,
legacy-ai-route-tombstone and dockerignore-build-context passed 25 tests across three
files. This is narrow local proof only, not the full suite or hosted exact-SHA CI.

With a scrubbed child environment, native PG17.10 failed startup with “postmaster became
multithreaded”; its own hint required LC_ALL. Repeating the existing helper with LC_ALL=C
and LANG=C passed real connection/version/database query and stopped/removed only the
newly allocated test directory. No existing database/credential was used.

A new Colima profile `mintvault-remediation-20260905` (4CPU/4GiB/20GiB sparse disk) was
successfully created separately from the stopped default profile. It supports arm64 and
amd64 emulation; emulated local builds do not replace native hosted AMD64 proof. Colima
selected its new Docker context on startup; Lead restores the prior `colima` context and
uses `--context colima-mintvault-remediation-20260905` explicitly for owned test operations.
This is local disposable infrastructure, not a staging/production deployment.

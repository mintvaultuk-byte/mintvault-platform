# Admin print/reprint change manifest

**Graph node:** `REPAIR-ADMIN-PRINT`
**Owner-directed pre-wave checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave tracked dirty-diff SHA-256:** `12dda2cf31173444a33347dcf5a763788084e530381e11dfe042e5c2ee45c04c`
**Pre-wave untracked aggregate SHA-256:** `6a4c86f18e3e23551d6ba6c65b728349ccd7de9b84de74cf4db11972d4d869e2`
**Candidate:** owner-directed wave-end WIP checkpoint commit (self); not pushed, deployed, migrated, or released

## Contract implemented

- The mounted Certificate Browser retains Reprint only for already-produced states and
  delegates to the canonical direct-artifact command. A reason is collected before the
  request; the client sends normalized certificate IDs and consumes verified JSON artifact
  URLs. The removed raw blob route remains absent.
- Direct and workflow reprint commands require a bounded `Idempotency-Key`. Per-intent keys
  survive transport/unknown-outcome retries; concurrent and interleaved requests retain the
  correct key. Success and known terminal abandonment retire only that intent's key.
- Workflow receipts are durable, actor/payload-bound, advisory-lock serialized, and use only
  SELECT/INSERT on append-only `audit_log`. Exact retries replay one result, changed payloads
  conflict, and rollback leaves no state/event/log/receipt residue.
- Direct verified finalization commits each advertised per-certificate `audit_log` row in the
  same database transaction as the batch/event/cache projections. The response reports only
  rows actually committed. Failed evidence insertion cannot produce false success.
- A committed command replay is immutable and returned before fresh mutable preflight. Every
  later artifact download independently rechecks current output eligibility for every member
  from authoritative `print_batches.cert_ids`; mutable `label_prints` pointers cannot authorize
  legacy or partial membership.
- The print component is release-required. Readiness binds migration 0022, all runtime print
  relations and consumed columns, unique identities/indexes, generated IDs, validated primary
  keys, exact owned sequences/defaults, omitted insert defaults, and exact runtime-role table
  and sequence authority.

## Executable proof

- Final unified print matrix: 9 files, 155 passed, 2 intentionally skipped.
- Client/printability contract: 54 passed, 2 intentionally skipped.
- Focused service/route/readiness/runtime-role/Partner/full-HTTP matrix: 6 files, 73 passed.
- Final readiness plus full-route hostile mutations: 2 files, 19 passed.
- Architecture authority: 8,627 records; drift check green; 25/25 hostile authority tests pass.
- Root TypeScript, test/script/architecture ratchets, migration references, CI topology,
  Graphify freshness, whitespace check, and the production build pass. The architecture
  ratchet carries 3 existing diagnostics, reduced from the prior 5; no new diagnostic was
  accepted.
- Three independent read-only hostile lanes returned CLEAN after repairs. Their accepted
  findings included interleaved intent keys, canonical body ordering, append-only runtime ACL,
  deterministic coordinator errors, rolling legacy intent compatibility, current artifact
  gating, legacy subset-membership bypass, generated/default drift, exact ACLs, and sequences.

These are local implementation proofs. `PROOF-ADMIN-PRINT` remains candidate-bound and
release-vetoing until the exact matrix is independently rerun on the immutable candidate.

## Boundaries

`admin-print-file-manifest.md` binds all functional, authority, and focused-proof bytes in
this wave. Governance records are validated by the graph/register controller and are not
self-bound in that manifest.

No migration SQL was authored or applied. No dependency, grade/MVGS rule, label geometry,
claim-code format, payment/credit/tenant contract, provider, secret, object, production,
staging, package, deployment, push, publish, or release state was changed. Build output and
Graphify output are excluded from the checkpoint.

# Admin identity/session change manifest

**Graph node:** `REPAIR-ADMIN-CONTRACTS`
**Owner-directed checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave dirty-diff SHA-256:** `e612faf38358956b1a0b485d365f545293359cbd440c9c631a28a7d7cc613633`
**Candidate:** local dirty WIP; no immutable candidate SHA exists

## Contract implemented

- `AdminSessionProvider` is the single route-dominant browser authority for protected
  Admin identity. It blocks protected children until identity is confirmed, represents
  unavailable and unauthenticated states explicitly, preserves the full return path,
  and owns focus, cross-tab, expiry, retry, and logout transitions.
- Logout is one idempotent POST-only command. A successful logout cancels protected work,
  resets mounted observers, removes the former principal's protected queries, clears
  mutations, and then publishes the logged-out state. A failed POST preserves the
  principal and cache because the server may still own a valid session.
- Protected cache identity is normalized Admin email plus Super Admin role. Same-email
  role changes are principal transitions. Public keys are an exact reviewed set and
  remain shared; all other queries are protected by default while an Admin principal is
  active.
- Transition sequencing prevents stale A→B→C work or same-principal verification from
  deleting or publishing over newer identity/logout state.
- Protected untagged 401s publish typed session revalidation. Wrong-secret endpoints
  return `admin_credential_rejected`; credential forms handle that code locally while a
  real untagged expiry on the same endpoint still revalidates centrally. Native response
  bodies remain readable by legacy form code.
- `/admin/login` and `/admin/cert/:id` are explicit public Admin-path exceptions. The
  public certificate page does not mount Admin tabs, actions, or protected queries.
- Admin identity responses are private and non-cacheable. Existing session schema,
  cookie, lifetime, roles, IP allowlist, persistence, login/PIN flow, and temporary
  `/api/admin/clear-session` compatibility remain unchanged.

## Executable authority and proof

- The architecture model records each query's public/protected cache scope, classifier,
  hash authority, and runtime principal binding. Exact AST/control-flow checks reject a
  dead classifier reference, inverted public exception, missing role hash, or public-key
  drift.
- Focused client/session/step-up/architecture proof passes 56/56.
- The approved mocked Admin server-auth suite passes 18/18 outside the listener-restricted
  sandbox; the same suite's sandbox failure was solely a denied loopback listener.
- TypeScript, architecture regeneration/check, graph validation, hostile graph
  mutations, and whitespace checks pass on the local WIP.
- Production build, all three TypeScript diagnostic ratchets, lint with zero errors,
  script syntax, migration-reference classification, CI topology, and the broader
  six-file Admin UI suite (158/158) pass. Engineering OS postflight remains explicitly
  fail-closed on repository-state and external-policy conditions recorded in the ledgers.
- Independent server, client, and data/runtime hostile lanes are CLEAN on the final
  behavior. This is WIP evidence only; `PROOF-ADMIN-CONTRACTS` remains open until the
  matrix is rerun on one immutable candidate.

## Exact boundaries

`admin-session-file-manifest.md` contains the current SHA-256 for every functional,
authority, and focused-proof file in this wave. Governance records are intentionally
not self-bound there; their current truth is validated by the graph and issue-register
checks.

The Admin print/reprint defect is excluded and has separate owner, recovery, repair, and
proof nodes. Grading semantics, payments, pricing, Partner order authority, roles,
schema/migrations, provider/object behavior, secrets, packaging, deployment, release,
and external systems are also excluded.

No dependency was added, migration authored or applied, provider called, secret changed,
artifact packaged, code pushed, system deployed, or release performed in this wave.

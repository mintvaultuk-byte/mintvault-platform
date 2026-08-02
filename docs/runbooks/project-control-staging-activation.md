# Project Control — staging activation runbook

**Status: NOT ACTIVATED. Nothing in this document has been executed.**

Branch `codex/project-control-truth-reconciliation`. Every step is owner-gated. Steps 11 and 17
require secrets, which only the owner may set.

---

## The one thing to understand first

The dashboard distinguishes four authorities and never lets one stand in for another:

| Authority | Answers | Does **not** answer |
|---|---|---|
| GitHub | what is committed, merged, CI-passing | what is deployed |
| Application `/api/version` | what commit is running | whether its migrations are applied |
| Database `schema_migrations` | what is applied **here** | whether the feature is switched on |
| Programme ledger | structure, decisions, manual evidence | anything discoverable from the three above |

Missing evidence renders as **UNKNOWN / STALE / UNAVAILABLE** — never as zero, complete or
deployed. If a step below returns "unknown", that is a valid outcome, not a failure to fix by
typing a value in.

---

## Preflight (read-only)

1. **Release commit.** `git -C /Users/cornelius/mintvault-pc-truth rev-parse HEAD`. Record it.
2. **Drift.** `git rev-list --count origin/main..HEAD` and `...HEAD..origin/main`. The branch must
   be **0 behind**. If it is behind, rebase and re-run the suite before anything else.
3. **Suite green.** `LC_ALL=C LANG=C npx vitest run $(ls tests/*project-control* | tr '\n' ' ')`.
   Without `LC_ALL=C` the local PostgreSQL 17 cluster refuses to start and DB-backed files skip.
4. **Database backup.** Take a Neon branch/snapshot of the **staging** database. Migration 0030 is
   additive, but this is the first activation and a snapshot costs nothing.
5. **Migration 0030 state.** `MINTVAULT_DATABASE_URL=<staging> npm run db:migrate` — **no
   `--apply`**. The dry-run is proven read-only: `planMigrations` returns an empty journal map
   without creating the table. Record the pending list verbatim.

**Stop conditions.** Any of these halts the activation:
- pending migrations other than the ones you planned for;
- any `checksum-mismatch` or non-`applied` journal row;
- a destructive-SQL finding (0030 is additive; a block means something changed);
- `origin/main` has moved since step 2.

---

## Migration

6. **Dry run** — step 5 output, reviewed by the owner.
7. **Apply 0030 to staging only.**
   ```
   MINTVAULT_DATABASE_URL=<staging> npm run db:migrate -- --apply
   ```
   Never `--allow-destructive`. Never against production in this pass.
8. **Verify the schema, do not trust the journal.** A journal row saying `applied` is not proof the
   objects exist:
   ```sql
   SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE 'pc_%' ORDER BY 1;
   ```
   Expect nine `pc_*` tables.

### Migration 0039 — durable live evidence

**This package now adds one migration: `0039_project_control_live_evidence.sql`.** Four additive
`pc_*` tables (sync runs, leases, checkpoints, append-only evidence snapshots), one trigger, seven
indexes. It touches nothing outside the `pc_` namespace and does not alter 0030.

0039 rather than one of the gaps at 0025/0027–0029: the runner applies present files in numeric
order and has **no monotonicity check**, so a number below the applied watermark would run *after*
migrations numbered above it on a database already ahead. 0039 is verified free across every local
and remote ref.

Apply it the same way as step 7, and verify with the catalogue rather than the journal:

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('pc_sync_runs','pc_sync_leases','pc_sync_checkpoints','pc_evidence_snapshots')
 ORDER BY 1;
SELECT tgname FROM pg_trigger WHERE tgname='trg_pc_evidence_snapshots_append_only';
```

Expect four tables and one trigger. **If the trigger is absent, stop** — evidence history is
unprotected and a failed sync could overwrite a good observation.

`rollback-0039-project-control-live-evidence.sql` drops only those four objects and asserts 0030's
tables survive. It destroys evidence history, which no future sync can recover (a sync observes
only the present). Export first if that history matters — the rollback file carries the exact
`\copy` commands.

---

## Seed reconciliation

9. **Dry run** the programme seed and read the diff. The seed is `onConflictDoNothing`, so it will
   never correct a row that already exists — it establishes structure, it does not refresh status.
10. **Apply** via `POST /seed`. Seeded rows carry `owner_statement` confidence, the weakest positive
    tier, and nothing is seeded as production-verified. The seed is an honest starting position,
    not a progress claim.

---

## Configuration (owner only)

11. **GitHub credential.** Set on `mintvault-v2`, by name:
    - `PROJECT_CONTROL_GITHUB_TOKEN` — read-only, fine-grained, scoped to this repository only.
      Contents: Read; Metadata: Read; Pull requests: Read; Actions: Read. Nothing else.
    - `PROJECT_CONTROL_GITHUB_REPO` — e.g. `mintvaultuk-byte/mintvault-platform`.

    **Do not reuse the local `gh` keyring token.** It is user-scoped, not least-privilege, and not
    available to the Fly runtime. Until this is set, repository evidence reads **UNAVAILABLE** and
    the dashboard says so — which is the designed behaviour, not a fault.

12. **Initial durable sync.** `POST /api/admin/project-control/sync/github`. Expect **202** with a
    `syncId` and `accepted: true`. The request returns immediately — it does not hold open for the
    scan.

    Poll `GET /api/admin/project-control/sync/{syncId}` until `state` leaves QUEUED/RUNNING.

    | `state` | Meaning |
    |---|---|
    | `SUCCEEDED` | full scan stored |
    | `PARTIAL` | evidence stored, but a collection was truncated or refused — read `warnings` |
    | `RATE_LIMITED` | quota exhausted; previous evidence retained |
    | `UNAVAILABLE` | no credential, or GitHub unreachable; previous evidence retained |
    | `FAILED` | persistence failed; the transaction rolled back and the checkpoint still stands |
    | `EXPIRED` | abandoned by a dead process and reaped |

13. **Verify the run, checkpoint and snapshots** — this is what proves durability rather than a
    cache:
    ```sql
    SELECT sync_id, state, trigger_type, actor, counts FROM pc_sync_runs ORDER BY requested_at DESC LIMIT 5;
    SELECT resource_key, cursor_value, observed_at FROM pc_sync_checkpoints;
    SELECT source_type, entity_type, count(*) FROM pc_evidence_snapshots GROUP BY 1,2 ORDER BY 1,2;
    ```
    A `SUCCEEDED` run with **no** checkpoint row would mean the ordering rule was violated — stop
    and investigate rather than re-running.

14. **Duplicate refresh.** POST twice quickly. The second must return `alreadyRunning: true` with
    the SAME `syncId`. Two different ids would mean two scans against a rate-limited API.

15. **Unavailable recovery.** Temporarily unset `PROJECT_CONTROL_GITHUB_TOKEN` and POST again.
    Expect `unavailable: true` and an `UNAVAILABLE` run — and confirm the PREVIOUS evidence is
    still queryable. A failure must add an observation, never replace one.

16. **Application and flag evidence.**
    ```
    POST /api/admin/project-control/sync/applications
    POST /api/admin/project-control/sync/flags
    ```
    Both return 202 with a `syncId`; poll with the same status routes.

    Verify staging and production were probed independently:
    ```sql
    SELECT environment, entity_id, commit_sha, freshness, observed_at
      FROM pc_evidence_snapshots
     WHERE source_type='application' ORDER BY observed_at DESC LIMIT 10;
    ```
    Expect one row per environment with the deployed SHA. **Production's SHA should differ from
    staging's** — production is behind, and the dashboard must show that as drift, not an error.

17. **Prove last-known-good.** This is the step that distinguishes a durable ledger from a cache.
    Probe once successfully, then make an environment unreachable and probe again:
    ```sql
    -- newest row: records the outage
    SELECT freshness, commit_sha FROM pc_evidence_snapshots
     WHERE source_type='application' AND environment='staging'
     ORDER BY observed_at DESC LIMIT 1;
    -- newest USABLE row: still the real deployed SHA
    SELECT freshness, commit_sha FROM pc_evidence_snapshots
     WHERE source_type='application' AND environment='staging' AND freshness IN ('CURRENT','STALE')
     ORDER BY observed_at DESC LIMIT 1;
    ```
    If the second query returns nothing after a successful probe, **stop** — the last-known-good
    guarantee is not holding and the dashboard would blank during an outage.

18. **Database evidence.** `POST /api/admin/project-control/sync/databases`, then:
    ```sql
    SELECT environment, status, freshness, payload->'foreignKeys'->>'intact' AS fks_intact,
           payload->>'appliedCount' AS applied, jsonb_array_length(payload->'pendingFilenames') AS pending
      FROM pc_evidence_snapshots
     WHERE source_type='database' ORDER BY observed_at DESC LIMIT 3;
    ```
    Expect `fks_intact = true` once 0030 is applied. **If it is false, read
    `payload->'foreignKeys'->'missing'` — it names exactly which of the nine constraints is
    absent.** All nine are required; the old "at least seven" rule is gone.

    `freshness = CONTRADICTORY` is a real finding, not an outage: Project Control tables present
    with no journal, or a journal row not in `applied` state. Investigate before activating.

    `freshness = UNAVAILABLE` with an EMPTY pending list means the database could not be read.
    That is correct — it must never report every migration as pending, because "could not look"
    is not "outstanding".

    The route is not parameterised by environment: a staging process observes staging only.
    Production evidence requires a production process.

19. **Flag evidence is scoped to this process.** Confirm every row carries the environment the
    process runs in and no other. A staging process cannot observe production's variables, and a
    row claiming otherwise means the environment resolution is wrong.

---

## Activation

13–16. **Probes.** With the flag still off, confirm via the route above: staging and production
`/api/version` both answer, migration evidence reports the connected environment only, and flag
evidence lists every tracked name with its state.

17. **Enable the dashboard.** Set on `mintvault-v2` only:
    `SUPER_ADMIN_PROJECT_CONTROL_ENABLED=true`
    Fail-closed and affirmative-only: absent, empty or malformed all read as disabled.

18. **Navigation.** Sign in as Super Admin, open `/admin/project-control`. Note
    `SUPER_ADMIN_EMAILS` is unset on both apps, so membership falls back to the single
    `ADMIN_EMAIL`. That is a separation-of-duty gap, not an access blocker — decide it explicitly
    before a second operator needs access.

---

## Verification (what "working" means)

19. GitHub default-branch SHA matches `git ls-remote origin refs/heads/main`.
20. Staging deployed SHA matches what `curl https://mintvault-v2.fly.dev/api/version` returns.
21. Production SHA is reported and **differs** from main — production is behind; the dashboard must
    show that as drift, not as an error.
22. Migration status names the **connected** environment only. It must not claim knowledge of
    production from a staging process.
23. Partner roadmap renders from the programme tree with no dead branch names.
24. Workflow tree renders; cycles and orphans are surfaced, not swallowed.
25. Pilot readiness excludes permanent backlog.
26. Manual refresh starts a sync; a second click within the cooldown coalesces rather than
    re-querying GitHub.
27. Scheduled refresh — **not yet implemented**, see handover. Note the durable lease that a
    scheduler will need is now in place and proven, so the remaining work is the schedule itself,
    not the coordination.
28. **Stale handling — the important one.** Temporarily unset `PROJECT_CONTROL_GITHUB_TOKEN` and
    confirm repository evidence reads UNAVAILABLE with the env-var name in the remedy, and that no
    number silently becomes zero or complete.
29. Audit ledger records the actor and trigger for each refresh.

---

## Rollback

30. **Disable the flag.** `SUPER_ADMIN_PROJECT_CONTROL_ENABLED=false`. Every route 404s again. This
    is the first and cheapest lever, and it is complete — the dashboard writes nothing to any
    pre-existing table.
31. **Application rollback.** `fly deploy --image <previous> -c fly.v2.toml --app mintvault-v2`.
    Capture the current image ref **before** deploying; `safe-deploy.sh` prints it on failure.
32. **Migration rollback limits.** `rollback-0030-project-control.sql` drops only the nine `pc_*`
    tables. It does not undo any programme data entered through the UI, so export first if that
    data matters. Nothing outside `pc_*` is touched.
33. **Before production is even proposed:** staging verified end to end; the GitHub token proven
    least-privilege; the flag exercised on and off; and a decision recorded on `SUPER_ADMIN_EMAILS`.
    Production is 102 commits behind main and needs its own migration plan — that is a separate
    release, not a continuation of this one.

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

**This package adds no new migration.** The live-evidence work so far is read-only: GitHub, the
application probes and the flag evidence are all computed per request and stored nowhere. A
migration becomes necessary only when sync runs, checkpoints and evidence snapshots are persisted
— see the handover.

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

12. **Initial sync.** `GET /api/admin/project-control/live-evidence?refresh=true`. Expect a
    `github.snapshot` with a `defaultBranchSha`, `applications` for both environments, and
    `featureFlags`. A rate-limit or access failure is reported with a distinct message; they need
    different fixes.

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
27. Scheduled refresh — **not yet implemented**, see handover.
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

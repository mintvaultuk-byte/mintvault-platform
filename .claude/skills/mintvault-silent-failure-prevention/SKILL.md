---
name: mintvault-silent-failure-prevention
description: Use this skill the moment any MintVault work is reported as "done", "deployed", "verified", "complete", or "type check clean" — by Claude Code, by a sub-agent, or by yourself. Fires before you tell Cornelius anything shipped or works. The skill enforces that success-shaped output is not proof of success: an HTTP 200 from an SPA does not mean a route exists, a clean tsc does not mean a DB column exists, a zero-rows-updated response does not mean an update happened, and a sub-agent reporting "done" on an approval-gated action does not mean the edit or deploy occurred. Without this skill, MintVault has repeatedly believed work was live that wasn't — stale bundles serving old code behind a 200, a silent NaN cert-id that updated zero rows and returned success, and sub-agents that auto-denied a gated action and continued reporting success. Fire aggressively — verifying the artifact costs one command; trusting a false success costs a deploy loop or a prod incident.
---

# MintVault silent-failure prevention

This skill exists because the most expensive MintVault bugs do not announce themselves — they return success-shaped output for something that never happened. Every one of these has bitten:

- **HTTP 200 ≠ the route works.** The SPA returns `200` + `index.html` for _any_ path, including routes that don't exist. "Deployed, /health is 200" told us nothing about whether the new code was actually serving. The stale-bundle incident: Fly reported a successful deploy while the old JS chunk was still being served.
- **`tsc` clean ≠ the SQL columns exist.** TypeScript compiles a query against `cert.cert_id` happily; Postgres 500s at runtime because the column is `certificate_number`.
- **`count: 0` / `rowCount: 0` ≠ success.** The MV207 assign bug: a checkbox stored the cert _string_ `"MV207"` instead of the integer cert _id_, the `WHERE id = NaN` matched zero rows, the endpoint returned `200 {count: 0}`, and the UI showed "success." Zero rows updated is a silent no-op, not a success.
- **A sub-agent's "done" ≠ the action happened.** A background or delegated sub-agent **auto-denies any approval-gated tool call and continues**, then emits success-shaped output describing an edit or deploy that is not on disk. (Confirmed behaviour: subagents cannot prompt for approval; background subagents auto-deny anything that would prompt.)

The locked rule behind this skill: **no silent failures — diagnostic logging on critical paths, and verify the artifact, never the report.**

## When this skill fires

Fire automatically when ANY of these is true:

- Claude Code, a sub-agent, or you are about to report `"done" / "deployed" / "shipped" / "fixed" / "verified" / "type check clean" / "all set"`
- An endpoint returned `200` and you're about to treat that as "the route/feature works"
- A migration or query ran and you're about to treat compilation/exit-0 as "the DB is correct"
- An UPDATE/DELETE returned and you have not checked the affected-row count
- A sub-agent reports success on anything that writes files, commits, or deploys

## The four silent-success traps and their antidotes

### Trap 1 — HTTP 200 on an SPA means nothing

The SPA serves `index.html` (200) for any path. To prove a route or a code change is **actually live**, verify the served artifact:

    # Bundle hash MUST change after a client deploy:
    curl -s "https://<host>/" | grep -oE '/assets/index-[A-Za-z0-9._-]+\.js' | head -1
    # Then grep the SERVED chunk for a marker string from your change:
    curl -s "https://<host>/assets/<chunk>.js" | grep -o '<marker-from-your-edit>'
    # For an API route, hit it and check the REAL response, not just the code:
    curl -s -o /dev/null -w '%{http_code}' "https://<host>/api/<route>"

If the bundle hash didn't change after a client deploy, **the new code is not live** regardless of what Fly reported.

### Trap 2 — tsc clean means nothing about the database

Before claiming a query works, validate its columns against the live schema (see `mintvault-db-migration-discipline`):

    grep -rnE "\b<column_name>\b" server/ --include="*.ts"
    # and confirm the column exists in information_schema.columns on the TARGET db

### Trap 3 — zero rows affected is a silent no-op

Any UPDATE/DELETE must assert it actually changed rows. Check the affected count and treat `0` as a failure to surface, never as success. In the client, `count: 0` from an assign/update endpoint is an **amber warning**, never a green "done." (This is exactly what the MV207 fix added — the inline outcome banner that flags count:0.)

### Trap 4 — a sub-agent's success report is not proof for gated actions

A delegated/background sub-agent cannot ask for approval and auto-denies anything that would prompt, then continues. So for **any approval-gated action** (file edit, commit, deploy), do not trust the sub-agent's "done" — **verify the artifact exists**:

- Edit claimed → `git diff` / `git status` shows the change on disk
- Commit claimed → `git log --oneline -1` shows the commit
- Deploy claimed → live bundle hash changed AND served chunk contains the marker (Trap 1)

If the artifact isn't there, the sub-agent silently failed. Re-run the action in the **main foreground session** (where prompts surface), not as another background sub-agent.

## What to say to Cornelius when this skill fires

Terse. Show the artifact check, not the claim. Format:

    Reported — [what the agent/Fly said: "deployed" / "done"]
    Bundle — [old hash -> new hash, CHANGED / UNCHANGED]
    Marker in served chunk — [present / ABSENT]
    Rows affected — [N / ZERO — silent no-op]
    Artifact on disk — [git diff confirms / NOT FOUND]
    Status — [GENUINELY LIVE / FALSE SUCCESS — re-run in foreground]

## Anti-patterns — do NOT do these

- **Don't report "deployed" off a Fly success message.** Confirm the served bundle changed.
- **Don't report "works" off a 200.** The SPA 200s everything.
- **Don't treat `count: 0` as success.** It's a silent no-op — surface it amber.
- **Don't trust a sub-agent's "done" for an edit/commit/deploy.** Verify the artifact.
- **Don't re-run a silently-failed gated action as another background agent.** It'll auto-deny again. Foreground or main session.
- **Don't chain "tsc clean -> done."** Type-clean is necessary, never sufficient.

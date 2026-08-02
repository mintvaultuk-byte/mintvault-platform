# Project Control live evidence — hostile-review handover

**Branch:** `codex/project-control-truth-reconciliation`
**Base:** `origin/main` @ `372a98f3` — 0 behind, merges clean.
**Reviewer brief:** attack the honesty claim. This package exists to stop the dashboard converting
missing evidence into success. Find a path where it still does.

---

## What landed, and what did not

**Built and tested**

| Area | Where | Tests |
|---|---|---|
| GitHub snapshot model, freshness verdict | `shared/project-control-github.ts` | 31 |
| GitHub transport (ETag, pagination, rate limits, redaction) | `server/project-control/github-scan.ts` | 14 |
| Application version probes + drift comparison | `server/project-control/app-probe.ts` | 13 |
| Feature-flag evidence | `server/project-control/flag-evidence.ts` | 9 |
| Migration ledger scan | `server/project-control/migration-scan.ts` | pre-existing |
| Composed view `GET /live-evidence` | `server/routes/admin/project-control.ts` | inventory-guarded |

Project Control suite: **544 passed / 19 files**, TypeScript clean.

**Now built (this pass)**

| Area | Where | Tests |
|---|---|---|
| Migration 0039 + rollback (4 tables, append-only trigger) | `migrations/0039_*.sql` | 11 |
| Durable cross-machine lease | `server/project-control/sync-lease.ts` | 13 |
| Evidence repository (runs, checkpoints, snapshots) | `server/project-control/evidence-repository.ts` | — |
| Checkpointed GitHub orchestration | `server/project-control/github-sync-service.ts` | 13 |

Project Control suite: **584 passed / 22 files**. Wider repo: 3,916 passed, 0 failed, twice.

**NOT built — do not review as if it exists**
- **No HTTP refresh routes.** `beginGitHubSync`/`runGitHubSync` exist and are proven, but nothing
  exposes them — there is no `POST /sync/github` and no pollable status endpoint yet.
- **No scheduled refresh.** The durable lease a scheduler needs is in place and proven; the
  schedule itself is not written. A scheduler must be multi-machine safe (advisory
  lock or durable lease); production runs two machines, so an in-process timer is not sufficient.
- **No UI.** The route returns the composed evidence; no page consumes it yet.
- **No seed reconciliation / supersede mechanism.** Stale seed rows are still stale.
- **No readiness-engine integration.** `computeReadiness` does not yet consume machine evidence, so
  the gates (merged-not-deployed, deployed-migration-pending, deployed-flag-disabled) are not
  enforced.
- **Partner roadmap ownership** — undecided; still more than one source of truth.

---

## Where to attack first

1. **Attack the ordering rule.** `scan -> persist -> advance checkpoint -> close run`. The
   checkpoint must never move on a run that did not store what it claims. DUR1 and DUR6 cover the
   obvious breaks; look for a path where `persistSnapshot` partially fails yet the checkpoint still
   advances — the snapshot loop is not wrapped in a transaction, so a mid-loop failure leaves some
   entities stored and some not, and the run is still closed as SUCCEEDED. **I consider this the
   most likely real defect in the package.**

2. **`getLatestGoodSnapshot` treats STALE as usable.** That is deliberate — STALE means "a real
   answer, just old". But it means any writer that mislabels a contentless observation as STALE
   rather than UNAVAILABLE reintroduces the null-head bug this pass fixed. Audit every freshness
   assignment for that confusion.

3. **The process caches still exist** as an optimisation in front of the durable layer. They are no
   longer authoritative, but confirm no read path can serve a process cache in preference to the
   database after a restart.

2. **`compareDeployment` is tri-state — try to break it.** The rule is that an unknown side yields
   `null`, never `false`. Mutation LIVE13 confirms two tests fail when `null` becomes `false`. Look
   for a consumer that treats `null` as falsy and renders "drifted".

3. **Redaction.** Two mutations survived my first pass here. `safeErrorMessage` covers `ghp_`-style
   and `github_pat_` tokens and userinfo URLs. What about a token in a *response body* that gets
   quoted into a warning? What about `x-ratelimit` headers echoed verbatim?

4. **The probe allowlist.** `PROBE_TARGETS` is frozen and there is no path from a request body to a
   hostname — verify that. Note `mintvaultuk.com` is deliberately absent (CNAME onto production;
   probing it would double-count one environment).

5. **Flag evidence reads `process.env` only.** Partner flags live in a DB row and are deliberately
   not read here. Confirm nothing in the composed view implies otherwise — reporting a DB-authority
   flag from the environment would be exactly the authority-blending this package forbids.

6. **`GET /live-evidence` fans out to three external calls** behind `gatedExpensive`. Check the
   limiter is tight enough that a Super Admin holding down refresh cannot exhaust the GitHub quota
   — the 10s forced-refresh cooldown is inside `scanGitHub`, but the probes have no equivalent.

7. **Prompt injection.** Branch names, PR titles and workflow names are attacker-influenceable text
   from GitHub. They are stored and will be rendered. I did **not** add fencing, escaping or length
   bounds at the render layer, because there is no render layer yet. Flag this before any UI lands.

---

## Mutation results (all applied, exit-code driven, restored byte-identical)

| ID | Mutation | Exit | RED |
|---|---|---|---|
| LIVE1 | outage poisons the snapshot cache | 1 | 1 |
| LIVE4 | SPA 200 counts as deployed | 1 | 1 |
| LIVE8 | drop the probe allowlist | 1 | 1 |
| LIVE9 | remove token-shaped redaction | 1 | 1 |
| LIVE10 | remove ETag conditional request | 1 | 1 |
| LIVE13 | unknown comparison reads as mismatch | 1 | 2 |
| FLAG | absent collapses into disabled | 1 | 3 |

LIVE1 and LIVE9 **survived the first run** and are the honest headline: the suite was green while
a bare token could leak and while a transient outage could stick for a full TTL. Both are now
covered. Assume the same class of gap exists elsewhere and hunt for it.

Not run (the code they target does not exist): LIVE2, LIVE3, LIVE5–LIVE7, LIVE11, LIVE12,
LIVE14–LIVE20.

---

## Standing constraint

**Staging activation is blocked until a read-only server-side GitHub credential is configured.**
`PROJECT_CONTROL_GITHUB_TOKEN` is set on neither Fly app. Until it is, repository evidence reads
UNAVAILABLE — correctly, and visibly. The local `gh` keyring token must not be used: it is
user-scoped, not least-privilege, and not available to the Fly runtime.

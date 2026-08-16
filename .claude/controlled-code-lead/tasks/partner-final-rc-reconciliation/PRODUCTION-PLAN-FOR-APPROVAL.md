# Production migration + deploy plan — PREPARED, NOT APPROVED, NOT EXECUTED

**Status: awaiting owner approval. Nothing in this document has been run.**
Prepared 2026-08-14 by task `partner-final-rc-reconciliation` for RC `e4d3bf5d`.

This is the "owner-approved production migration/deploy plan" step of the agreed sequence
(FINAL RC → **this** → production rollout → Pilot Shop 0 → Partner #1). It is written so you can
approve, amend, or reject it as a whole. Every protected action is listed explicitly.

---

## 0. Two things to settle BEFORE this plan can be approved

**(a) The RC has never been pushed.** `git ls-remote origin refs/heads/codex/partner-pilot-pass2`
returns nothing. That means no CI has ever run on this code, there is no PR to review, and the only
copy is one directory on one Mac. It also means the existing deploy guards would not catch it:
`safe-deploy` GUARD 1/1L/1M compare against `origin/main` and the live commit, both of which are
ancestors of the RC, so an unpushed RC passes all three. **Recommend: push the branch and open a PR
at the exact RC SHA, and let CI run, before approving anything below.**

**(b) One protected-grading guard is red.** `tests/structured-variant-persistence.test.ts` test 22
fails because signature G was registered in only one of two identical `server/grader.ts`
founder-signature guards (commit `90fc4290` touched one file). The authorisation exists; it was not
propagated. **This needs your explicit word** — either "yes, the Card Job → grading bridge change is
the one I authorised at 90fc4290, propagate signature G", or "revert the grader delta". I have not
touched it, because self-granting a founder signature on protected grading is exactly what the
guard exists to prevent.

---

## 1. Reconcile reality FIRST — production moved twice in one afternoon

Production was deployed by concurrent sessions on 2026-08-12 (v1079–v1082) and again on 2026-08-14
(v1083), including once *during* the reconciliation pass. **Any SHA written down goes stale fast.**

Run these and paste the output into this file before proceeding:

```bash
fly releases --app mintvault | head -5 && curl -s https://mintvaultuk.com/api/version
```

**As last verified (2026-08-14 ~16:3x UTC):** v1083 / `067ed0c6`, machines `683720eb5127d8` and
`83d479c745d0d8`, both started 1/1. Live production is byte-identical to `origin/main`.

**Abort condition:** if `/api/version` no longer reports `067ed0c6`, STOP and re-run the whole
reconciliation — the RC's containment of live production is what makes it safe to deploy, and a new
concurrent deploy can invalidate it.

Confirm containment (must exit 0):

```bash
git merge-base --is-ancestor $(curl -s https://mintvaultuk.com/api/version | sed 's/.*"commit":"\([^"]*\)".*/\1/') HEAD
```

---

## 2. Migrations MUST precede the deploy

Twelve migrations sit between production's code-side high-water (0078) and the RC (0090):

`0079` admin password lockout · `0080` partner card jobs · `0081` card-job ↔ certificate binding ·
`0082` card-job op keys · `0083` credit packs · `0084` location management · `0085` scanner operator
role · `0086` session step-up · `0087` grading edit lease · `0088` NFC binding integrity ·
`0089` shared rate-limit buckets · `0090` scanner lineage convergence

The PR #258 precedent is explicit: **migrations first, or the feature 503s.** Four of these
(`0080`–`0083`) back money and certificate-identity state.

### 2a. Production's pending set must be established independently

**Staging's successful run is NOT evidence for production.** The three declarations in
`migrations/lineage-exclusions.json` name *staging's* journal occupants
(`0044_partner_submission_lifecycle_and_location_snapshot.sql`,
`0046_partner_mfa_pending_lifecycle.sql`, `0047_partner_owner_invariant_tenants_rls.sql`).
`partitionIdentityConflicts` matches on the exact `(incoming, occupant)` pair, so on production
those will correctly **not** match — and 0090 is a documented no-op there.

Read production's actual plan with a **dry run** (no `--apply`; this is the runner's read path):

```bash
fly ssh console --app mintvault --machine 683720eb5127d8 -C "node /app/dist/migrate.cjs"
```

⚠️ This connects to the production database and takes the runner's advisory lock. It is read-only
with respect to schema and journal, but it is still a production touch — **it needs your go-ahead**,
which is why I did not run it during the RC pass.

Expected: `0079`–`0090` pending, `0 inconsistent`, `0 checksum-mismatch`, and **no** exclusions
reported. Anything else — especially a checksum mismatch or an unexpected exclusion — is an abort.

### 2b. Known ordering hazard, and why it should not fire on production

`0075_partner_station_single_active_capture` indexes `scanner_capture_sessions` with no
`to_regclass` guard and sorts ~15 files before 0090. On a *staging-lineage* host where 0090 is what
delivers that table, an unscoped run dies at 0075. **Production is not that lineage** — it applied
the scanner trio at its own 0045/0046/0047, so the table already exists and 0075 is already applied.
Pinned by `tests/lineage-convergence-0090.test.ts`. Confirm from the 2a dry-run that 0075 is not
pending before relying on this.

### 2c. Apply (PROTECTED — requires explicit approval)

```bash
fly ssh console --app mintvault --machine 683720eb5127d8 -C "node /app/dist/migrate.cjs --apply"
```

Run against **one** machine only — the runner takes an advisory lock and a second runner refuses by
design. Capture the full output. Then re-run the dry run and confirm `0 pending`.

**Reverse path:** additive-only, but six of the twelve (`0080`–`0083`, `0088`, `0089`) have no
rollback script and `0090` is deliberately forward-only. **A code rollback after this step lands an
older release against a newer schema.** That tolerance is unproven and is the single biggest
unquantified risk in this plan.

---

## 3. Deploy (PROTECTED — requires explicit approval)

Only via the wrapper, never a raw `fly deploy`:

```bash
scripts/safe-deploy.sh prod
```

Never pass `--allow-behind` or any force flag. If GUARD 1L fires, the RC does not contain what is
live — that means a concurrent session deployed again; go back to step 1.

---

## 4. Post-deploy verification — a health check proves nothing here

`/health` returned 200 throughout the entire period when the release records were 23 commits wrong.
Verify the things this release actually changes:

1. **Exact SHA on EVERY machine**, not just through the load balancer — the LB will happily mask one
   stale machine:
   ```bash
   for m in 683720eb5127d8 83d479c745d0d8; do
     curl -s -H "fly-force-instance-id: $m" https://mintvaultuk.com/api/version; echo;
   done
   ```
   (A bogus instance id returns 400, which is how you know the pin is real.)
2. **Migration high-water on the production journal is 0090** — re-run the 2a dry run, expect `0 pending`.
3. **One authenticated read per new subsystem** returning a real payload, not a 200 shell: a Card Job
   read, a credit-pack read, a grading-lease read.
4. **Partner surface**: `/api/partner/me` already returns 401 on production today (router mounted).
   Confirm the flag state deliberately rather than inferring it from a status code.

**What no probe can undo:** issued certificate identities, accepted physical evidence, printed
labels, and any credit/Stripe mutation. Those need their own audited remediation.

---

## 5. Complete list of protected actions in this plan

None have been performed. Each needs your explicit go-ahead, individually:

| # | Action | Step |
| --- | --- | --- |
| 1 | `git push` of the RC branch + PR | §0(a) |
| 2 | Propagate founder signature G (or revert the grader delta) | §0(b) |
| 3 | Production migration **dry run** (connects to prod DB, takes advisory lock) | §2a |
| 4 | Production migration **apply** | §2c |
| 5 | Production **deploy** | §3 |
| 6 | Production `STRIPE_WEBHOOK_SECRET` | separate |
| 7 | Staging Stripe test-key rotation (AT23S-F1) | separate, non-blocking |

---

## 6. What this plan does NOT cover

- **5,000-shop scale: NOT RUN.** No load test exists for this RC. Concurrency *correctness* is
  proven; *throughput* is not. If the pilot is expected to demonstrate scale, that is separate work.
- **AT-23 against the final RC.** The matrix was validated at `e6fd6c5f`; the RC adds PR #299's UI
  changes (separately reviewed and already live on production). If you want the matrix to hold
  end-to-end on the exact RC, redeploy staging to it and re-run the UI-touching sections first.
- **Pilot Shop 0 and Partner #1 onboarding** — downstream of a successful rollout.

# MVGS v2 — Prod Launch Runbook

**Status:** DRAFT — written 2026-06-03 after the D2-ST = −0.5 engine fix on staging
revealed that the full MVGS v2 release has never been merged to main or shipped to
prod. This runbook is the ordered sequence to get the whole v2 release safely live.
The earlier internal spec (`docs/MVGS-v2-spec.md` §2 + §7) lays out the rule this
runbook operationalises: **the v2 engine + band table + re-grade + reprint go to
prod TOGETHER as one bundle, never piecemeal**, so physical slabs and the verify
page never disagree.

**Source branch:** `feat/mvgs-v2-engine` at `aaa9506` (engine fix + alignment

- backlog note on top of the full Phase 1 → Phase 3 stack from `fe0d60c`).

**Out of scope tonight:** all six steps below. This runbook is the plan, not the
execution. Nothing here runs until the corresponding step is explicitly approved.

---

## Pre-flight — read before every step

### The §2 bundling rule (in writing, owned by Cornelius)

From `docs/MVGS-v2-spec.md` §2:

> "Prod sequencing constraint (because the bands moved): the v2 band table
> reaches prod ONLY bundled with the re-grade + reprint of the existing certs —
> never before — so physical slabs and the verify page always agree. No
> standalone band-table deploy."

The new band table is stricter than v1 (Pristine now requires 99+, was ≥96).
Deploying the engine WITHOUT re-grading existing certs means: a 97-graded card
on an existing prod slab still says "Pristine 10P" physically, but the verify
page would say "Gem Mint 10". That's the divergence §2 forbids. Steps 2, 3, 4,
5 below must land in one operational window — not separate releases.

### Rollback contract

Every step below has a documented rollback. Rollbacks are reversible without
data loss when followed in order. The single irreversible action in this
runbook is **Step 4 (physical slab reprint)** — once a new slab is produced
and shipped, the physical artefact exists. Step 4 is gated on Step 3 (re-grade)
audit-log review.

### Branch state at runbook activation

- `feat/mvgs-v2-engine` at `aaa9506` — staging, never deployed to prod
- `content/legal/grading-standards.md` on the branch carries the stain-table
  addition. **Excluded from every step below except Step 6**, which is gated
  on written legal sign-off from Adam J. Steps 1-5 ship engine + app + data
  changes only; the public legal page stays the current main version
  throughout.

### Blast-radius numbers — must be re-run on prod before activation

Run this against prod (not staging — staging is essentially empty) before
starting Step 1. Copy/paste the SQL into a prod `psql` session:

```sql
SELECT
  COUNT(*) AS total_certs,
  COUNT(*) FILTER (WHERE status = 'active') AS active_certs,
  COUNT(*) FILTER (WHERE grade_approved_at IS NOT NULL) AS approved_certs,
  COUNT(*) FILTER (WHERE jsonb_array_length(defects) > 0) AS certs_with_pins,
  COUNT(*) FILTER (WHERE defects @> '[{"mvgsCode":"ST"}]'::jsonb) AS certs_with_any_st,
  COUNT(*) FILTER (WHERE defects @> '[{"mvgsCode":"ST","tier":"D2"}]'::jsonb) AS certs_with_d2_st,
  COUNT(*) FILTER (WHERE defects @> '[{"mvgsCode":"ST","tier":"D1"}]'::jsonb) AS certs_with_d1_st,
  COUNT(*) FILTER (WHERE jsonb_array_length(whitening_lines) > 0) AS certs_with_whitening_lines,
  COUNT(*) FILTER (WHERE crease_span_pct IS NOT NULL) AS certs_with_crease
FROM certificates
WHERE deleted_at IS NULL;
```

Record the result in this file (replace the placeholders) before Step 1 starts.

| Metric                               | Staging proxy (2026-06-03) | PROD (fill in) |
| ------------------------------------ | -------------------------- | -------------- |
| Total certs                          | 7                          | TBD            |
| Active certs                         | 7                          | TBD            |
| Approved certs                       | 0                          | TBD            |
| Certs with any pins                  | 1                          | TBD            |
| Certs with any ST pin                | 0                          | TBD            |
| Certs with D2-ST pin (tonight's fix) | 0                          | TBD            |
| Certs with D1-ST pin                 | 0                          | TBD            |
| Certs with whitening_lines           | 1                          | TBD            |
| Certs with crease measurement        | 1                          | TBD            |

Staging is too sparse to use as a blast-radius proxy. The prod numbers are what
sizes Step 3 (re-grade) and Step 4 (reprint) operationally. If the prod number
of approved certs is more than Cornelius's reprint queue capacity, Step 4
needs to be batched.

---

## Step 1 — Prod DB schema migration

**What it does:** add the MVGS v2 columns to the `certificates` table so the
new engine can read measurement data. The staging branch already has these;
prod is still on the pre-v2 schema. Without this step, the engine crashes on
first cert load.

**Columns added (all default-empty, optional):**

| Column                  | Type         | Default | Source migration                                 |
| ----------------------- | ------------ | ------- | ------------------------------------------------ |
| `whitening_lines`       | jsonb        | `'[]'`  | `migrations/add-mvgs-v2-measurements.sql`        |
| `crease_lines`          | jsonb        | `'[]'`  | `migrations/add-mvgs-v2-crease-lines.sql`        |
| `crease_span_pct`       | numeric(4,1) | NULL    | `migrations/add-mvgs-v2-measurements.sql`        |
| `wrinkle_severity`      | text         | NULL    | `migrations/add-mvgs-v2-measurements.sql`        |
| `tear_severity`         | text         | NULL    | `migrations/add-mvgs-v2-measurements.sql`        |
| `centering_outer_front` | jsonb        | NULL    | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `centering_inner_front` | jsonb        | NULL    | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `centering_outer_back`  | jsonb        | NULL    | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `centering_inner_back`  | jsonb        | NULL    | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `centering_method`      | text         | `'ai'`  | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `dark_border_front`     | bool         | `false` | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `dark_border_back`      | bool         | `false` | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `eye_appeal_modifier`   | int          | `0`     | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `grade_strength_score`  | int          | NULL    | `migrations/add-mvgs-v2-columns-prod.sql`        |
| `verified_defects`      | jsonb        | `'[]'`  | (already on prod from earlier work — skip if so) |

A new row in `pipeline_settings` for `mvgs.calibration` (the §6 Calibration
panel defaults). Idempotent: `INSERT … ON CONFLICT (key) DO NOTHING`.

**Dependencies:** prod DB writable. Maintenance window (no operator
mid-grading). Backup taken IMMEDIATELY before — Neon point-in-time recovery
must be confirmed enabled for the prod branch (`ep-wispy-morning-ab6f4o08`).

**Idempotency:** every `ALTER TABLE … ADD COLUMN` uses `IF NOT EXISTS`. Re-runs
are safe.

**Dry run first:**

```sql
BEGIN;
-- paste the contents of migrations/add-mvgs-v2-columns-prod.sql
--   + migrations/add-mvgs-v2-measurements.sql
--   + migrations/add-mvgs-v2-crease-lines.sql
\d certificates
ROLLBACK;
```

Inspect the column list after the BEGIN, confirm all 14 new columns + the
pipeline_settings row are present, then ROLLBACK. No state change.

**Real run:** same statements without BEGIN/ROLLBACK. Wrap in a single
transaction so a partial failure rolls back:

```sql
BEGIN;
-- paste all three migrations
COMMIT;
```

**Rollback:** if Step 1 lands but a later step fails:

```sql
BEGIN;
ALTER TABLE certificates DROP COLUMN IF EXISTS whitening_lines;
ALTER TABLE certificates DROP COLUMN IF EXISTS crease_lines;
-- … repeat for each added column …
DELETE FROM pipeline_settings WHERE key = 'mvgs.calibration';
COMMIT;
```

Safe ONLY if no rows have v2 data yet — once Step 3 runs, dropping these
columns drops the measurement data. After Step 3, rollback uses
point-in-time recovery instead.

**Verify:**

1. `SELECT COUNT(*) FROM certificates;` matches the pre-migration count.
2. `\d certificates` shows the 14 new columns.
3. `SELECT key, value FROM pipeline_settings WHERE key = 'mvgs.calibration';`
   returns the default calibration row.
4. Spot-check 3 existing certs — `SELECT cert_id, whitening_lines, crease_lines
FROM certificates LIMIT 3;` — all show empty defaults, no data loss.

---

## Step 2 — Engine + app deploy

**What it does:** deploy `feat/mvgs-v2-engine` minus `content/legal/grading-
standards.md` to prod via `fly deploy -c fly.toml`. The branch carries the
new engine (`shared/mvgs-scoring.ts`), input builder, calibration panel,
Phase 3 display work, alignment fix, ST D2 fix, AI-pin stamping,
checkbox-mirror, print-batch 5-up redesign.

**Critical exclusion:** the customer-facing `content/legal/grading-standards.md`
file must NOT be in this deploy. Excluded via the mechanism in Step 6's
"Pre-launch state" sub-section below.

**Dependencies:**

- Step 1 complete and verified
- Staging has run with the same code for ≥48h with no crash reports
- Adam J has reviewed the engine math change (separate from the public
  standard doc) — confirm in writing

**Deploy command:**

```
git checkout main
git merge --no-ff feat/mvgs-v2-engine
git checkout main -- content/legal/grading-standards.md   # restore main version
git commit -m "merge MVGS v2 engine + app (legal text held back)"
fly deploy -c fly.toml
```

**Rollback:** `fly releases rollback -c fly.toml` to the previous prod release.
This reverts the deployed image but does NOT reverse Step 1's schema
migration — leaving the new columns in place is harmless (default-empty).

**Verify:**

1. `curl -sI https://mintvaultuk.com/health` returns 200.
2. `fly releases -c fly.toml | head -3` shows the new version, status `complete`.
3. Open an existing cert (e.g. `/cert/MV33`) — page renders without crash, grade
   displayed matches the pre-deploy grade (engine reads columns from Step 1 as
   empty, so grade is computed from the existing `defects` array using the new
   engine; if Step 1's columns are empty, the result should match what the old
   engine would have produced for the same pins).

   ⚠️ **CRITICAL CHECK — confirm the §2 bundling intent**: if the new engine
   computes a DIFFERENT grade for an existing cert than the old engine did
   (because the band table is stricter or D2-ST now deducts), the verify page
   will now show that different grade. The physical slab still shows the old
   grade. This is the §2 divergence. Step 3 closes it.

4. Open `/admin/mvgs-calibration` (Cornelius logged in) — Calibration panel
   loads, current values shown from `pipeline_settings`.

---

## Step 3 — Re-grade all existing certs under v2

**What it does:** scripted re-run of `computeMvgsScore` on every approved cert.
For each cert, compare the existing stored grade against the new engine output.
**Write a row to `audit_log` for every cert**, recording: cert_id, old grade,
new grade, old score, new score, timestamp, actor (`mvgs-v2-launch`),
diff_reason (which deduction changed). Then UPDATE `grade` +
`grade_strength_score` per cert. Never silent — every change traces.

**Blast radius:** TBD — fill in from the pre-flight query above. The relevant
columns are `certs_with_d2_st` (these will move per tonight's ST fix), and any
cert whose grade was near a v2 band boundary (these may re-label even without
ST pins, because the band table is stricter).

**Dependencies:**

- Steps 1 + 2 complete and verified for ≥1 hour with no crash reports
- Backup confirmed at the start of Step 1 — provides full pre-launch state
- Operational window: no operator mid-grading (the script writes to `grade`
  - `audit_log` for every approved cert; concurrent grader writes would
    conflict)

**Script:** `scripts/run-mvgs-v2-regrade.ts` (to be written — does not exist
yet). Pseudo-code:

```
for each cert WHERE status='active' AND grade_approved_at IS NOT NULL:
  oldGrade = cert.grade
  oldScore = cert.grade_strength_score
  input = buildMvgsInput(cert.defects, cert.whitening_lines, cert.crease_lines,
                         cert.centering_*, cert.dark_border_*, cert.eye_appeal_modifier,
                         cert.surface_values.hasCrease, cert.surface_values.hasTear)
  result = computeMvgsScore({...input, calibration: loadMvgsCalibration()})
  newGrade = gradeFromMvgsScore(result.score)
  newScore = result.score
  if (newGrade !== oldGrade || newScore !== oldScore):
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
    VALUES ('certificate', cert.cert_id, 'mvgs_v2_regrade', 'mvgs-v2-launch',
            {oldGrade, newGrade, oldScore, newScore, deductions: result.deductions}, NOW());
    UPDATE certificates SET grade = newGrade, grade_strength_score = newScore,
                            updated_at = NOW()
    WHERE cert_id = cert.cert_id;
```

**Dry-run mode (mandatory before live run):** the script accepts `--dry-run`
which performs every read + computation + audit-row construction but skips
the UPDATEs and INSERTs. Outputs a CSV of (cert_id, old, new, delta) for
review. Cornelius eyeballs the CSV before authorising the live run.

**Rollback:** each audit_log row carries the pre-change grade. A reverse-script
reads `audit_log WHERE action = 'mvgs_v2_regrade'` and UPDATEs each cert back
to its `oldGrade`/`oldScore`. Use only if Step 4 has not yet started — once
slabs are reprinted, the physical reality has caught up with the new grade.

**Verify:**

1. Audit log row count = number of certs that changed grade. Print this number.
2. Spot-check 5 known certs from the dry-run CSV (e.g. MV33 if it moved):
   confirm `/cert/:id/report` now shows the new grade and `/cert/:id` agrees.
3. `SELECT grade, COUNT(*) FROM certificates WHERE status = 'active' GROUP BY
grade ORDER BY grade DESC;` — distribution shift looks plausible (more
   density at lower half-grades than before, given the band table tightened).
4. **§2 divergence still exists at this point** — every cert whose grade
   changed now has a verify page that disagrees with the physical slab. The
   re-grade is reversible until Step 4 starts.

---

## Step 4 — Slab + insert reprint (the irreversible §2 bundle)

**What it does:** for every cert that re-graded in Step 3, produce a new
physical slab + claim insert with the v2 grade. Old slabs are recovered + the
new slab ships to the registered owner (or held in inventory for unclaimed
certs). This is the operational step that closes the §2 divergence.

**Dependencies:**

- Step 3 complete + audit-log reviewed by Cornelius
- Step 3's dry-run CSV reviewed and signed off — every grade change is
  expected and accepted
- Print queue capacity: Cornelius's Cricut + guillotine workflow can produce
  N slabs/day. Step 4's batch size depends on the count from Step 3.
- Reholder / re-slab fulfilment: customer-comms for any claimed certs whose
  slab is being recalled and replaced (legal + customer-service step,
  separate skill if a `vault-reholder-policy` exists)

**Per-cert flow:**

1. Identify candidate certs: `SELECT cert_id FROM audit_log WHERE action =
'mvgs_v2_regrade' AND details->>'oldGrade' != details->>'newGrade';`
2. For each: trigger `/admin/print-batch` (5-up A4 — already on the branch) to
   produce the new slab label + claim insert
3. Print, cut, slab, recall old physical slab from operator inventory (for
   unclaimed certs) or queue customer-comms for reholder (for claimed certs)
4. Log per-cert reprint to `audit_log` with action `'mvgs_v2_reprint'`

**Rollback:** physical irreversibility. Once a new slab exists and is shipped,
this step cannot be reversed via software. Recovery would require recalling
the new slab + reprinting the old grade. Don't start Step 4 until Step 3's
dry-run CSV is approved.

**Verify:**

1. Audit-log count of `'mvgs_v2_reprint'` rows = audit-log count of
   `'mvgs_v2_regrade'` rows where grade changed. (Equality, not less than.)
2. Spot check 5 reprinted certs: physical slab grade text matches
   `/cert/:certId` verify page exactly.
3. Customer-comms send-rate for claimed-cert recalls = expected count from
   step 1's query, no silent drops.

---

## Step 5 — Band table go-live (the explicit acknowledgement)

**What it does:** the v2 band table is already in the engine code from Step 2.
This step is the explicit acknowledgement that with Steps 3 + 4 complete, the
new bands are now the published, physically-backed reality. Nothing to deploy
here — this is a documentation + comms step.

**Dependencies:** Steps 3 + 4 complete and verified.

**Actions:**

1. Update `docs/MVGS-v2-spec.md` line near §2 noting the launch date.
2. Email + in-app notice to customers whose grade changed (template TBD with
   Adam J): "Following the publication of the MVGS v2 grading standard on
   <date>, your certificate <cert_id> has been re-graded from X to Y to align
   with the new methodology. Your physical slab has been reprinted and is
   <shipped / awaiting shipment / available for pickup>."
3. Public registry page (`/registry`) refreshes — total count, grade
   distribution.

**Rollback:** there isn't one. Once customers are notified of their new grade

- have new physical slabs, the v2 bands are the live reality. To reverse
  would require Step 4's reverse-physical-reprint, which isn't operationally
  feasible at scale.

**Verify:**

1. Customer comms send-list matches Step 4's reprint list.
2. `/registry` page renders with new grade distribution.
3. Spot-check 3 customers' email inboxes (Cornelius's test accounts) — comms
   received, copy matches Adam J template.

---

## Step 6 — Customer-facing standard publish

**What it does:** merge `content/legal/grading-standards.md` (the stain-table
addition + version bump v1.0 → v1.1) to main. This is the customer-facing
legal text that describes the v2 surface deduction table including the new
D2-ST = −0.5 and D3-ST = 0 rows.

**Dependencies:**

- Written legal sign-off from Adam J on the exact text in
  `content/legal/grading-standards.md` as it sits on `feat/mvgs-v2-engine`.
  Sign-off must be on the rendered text (not just the source file) — preview
  via the `/standard` page on staging first.
- Steps 1-5 complete (the published standard must match the live engine
  - the physical slabs in customer hands).
- `lastUpdated` and `effectiveFrom` frontmatter dates filled in (currently
  placeholders `[TO BE INSERTED AT GO-LIVE]`).
- Version frontmatter bumped from `v1.1-draft` to `v1.1`.
- Status frontmatter changed from "Draft" to "Live".

**Pre-launch state (held throughout Steps 1-5):**
`content/legal/grading-standards.md` on `main` stays at v1.0. On
`feat/mvgs-v2-engine` it carries the v1.1-draft. Whenever the branch is
merged into main (Step 2), `content/legal/grading-standards.md` is reset
to main's v1.0 in the same merge commit. This keeps the legal text
unchanged on prod until this step explicitly publishes it.

**Deploy command:**

```
# After Adam J written sign-off, on a clean main:
git checkout main
git checkout feat/mvgs-v2-engine -- content/legal/grading-standards.md
# Edit the frontmatter: version=v1.1, status=Live, dates filled
git add content/legal/grading-standards.md
git commit -m "docs(standard): publish MVGS v2 surface deduction table (Adam J approved <date>)"
fly deploy -c fly.toml
```

**Rollback:** `git revert <commit>` then redeploy. The legal text returns to
v1.0. (Defensible only if there's a material error in the published text
that legal flags within hours of publish — material grade computation has
already moved per Steps 2-5 and isn't reversible by this step.)

**Verify:**

1. `https://mintvaultuk.com/standard` renders the new table with the stain
   row.
2. Version footer shows `v1.1`, `effectiveFrom` date matches today.
3. Internal link audit: every reference to grading-standards.md elsewhere
   in the site / app resolves and shows the new content.

---

## Summary — operational picture

| Step | Reversible?  | Blast radius                               | Owner                              |
| ---- | ------------ | ------------------------------------------ | ---------------------------------- |
| 1    | Yes (PIT)    | Prod DB (default-empty columns)            | Cornelius                          |
| 2    | Yes (FB)     | Prod app (engine + UI render)              | Cornelius                          |
| 3    | Yes (audit)  | Every approved cert's grade column         | Cornelius                          |
| 4    | **NO**       | Physical slabs + claim inserts             | Cornelius                          |
| 5    | No           | Customer comms — public position published | Cornelius                          |
| 6    | Yes (revert) | /standard page text                        | Adam J approves; Cornelius deploys |

PIT = Neon point-in-time recovery. FB = Fly `releases rollback`. Audit = the
audit_log-driven reverse-script described in Step 3. The single hard
irreversibility is Step 4's physical reprint.

**Activation criteria:** all of (a) blast-radius numbers measured on prod
(pre-flight query), (b) staging cleanly run for ≥48h with the same engine
code, (c) backup confirmed enabled on the prod Neon branch, (d) Adam J
engine-math review signed for Step 2, (e) Adam J customer-facing text
review signed for Step 6, (f) Cornelius's print queue capacity sized
against Step 4's count.

Nothing in this runbook runs without those six. Engine fix stays on staging
(`feat/mvgs-v2-engine` @ `aaa9506`, mintvault-v2 v221) until then.

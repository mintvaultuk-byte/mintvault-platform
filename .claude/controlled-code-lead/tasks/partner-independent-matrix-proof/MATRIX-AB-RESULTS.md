# Independent Matrix A/B — results

Two runs of the complete critical Partner assurance matrix, from two environments that share no
state, against the frozen PR #288 tree (`f6b840fe`, plus the evidence-only mutation-matrix commit).

---

## What each matrix run is

Two passes, because either alone is incomplete. **Order is load-bearing** — see the note at the end.

| Pass | What it is |
| --- | --- |
| **1 — full repository suite** | `npx vitest run` under the complete CI `check`-job environment, byte-for-byte reproduced from `.github/workflows/ci.yml` (see below), followed by **all six execution-floor assertions**. This is what CI runs. |
| **2 — per-suite Partner matrix** | `scripts/ci/run-partner-suite.mjs --all` — every critical Partner suite as its OWN vitest process with only its own database pinning, each on a freshly dropped-and-created database. A skip or an environment abort in any of them is a hard failure. |

### The environment is DERIVED from ci.yml, not transcribed

`harness/derive-env.mjs` parses the `check` job's `env:` block (69 variables) and rewrites only the
*coordinates* — pg17 port, database-name prefix, superuser login, MinIO port. Every variable name
and every non-URL value is verbatim. A hand-copied environment drifts silently the moment `ci.yml`
changes, and a drifted environment that goes green proves nothing.

---

## Environment identifiers

| | **Matrix A** | **Matrix B** |
| --- | --- | --- |
| pg16 container | `mvmx-a-pg16` (`pgvector/pgvector:pg16`) | `mvmx-b-pg16` (same image) |
| pg16 `system_identifier` | `7671234363192156197` | `7671236245242359845` |
| pg17 container | `mvmx-a-pg17` (`postgres:17.10`) | `mvmx-b-pg17` (same image) |
| pg17 `system_identifier` | `7671234363701538853` | `7671236245777305638` |
| pg17 port | `55443` | `55453` |
| superuser / admin login role | `mxadmin_a` | `mxadmin_b` |
| database-name prefix | `mxa_` | `mxb_` |
| partner databases provisioned | 37 | 37 |
| MinIO container / port | `mvmx-a-minio` / `9020` | `mvmx-b-minio` / `9030` |
| tenants used by the pre-test RLS proof | `80b22d58-…` / `b056e8e1-…` | `7d5a8b24-…` / `4a761123-…` |
| every customer / submission / certificate / location | created inside the run | created inside the run |

**Shared identity between A and B: none.** Verified mechanically by `harness/compare.mjs`.

### What could NOT differ, and why (stated rather than papered over)

- **`127.0.0.1:55432/mintvault_vq_phase10_local`.** 27 test files hard-*refuse* any other host,
  port or database name (`REFUSED: TEST_DATABASE_URL must be the local throwaway DB`). A and B
  therefore reuse that coordinate — but never at the same time and never the same cluster: A's
  container **and its volume** were destroyed before B's were created, and the two clusters report
  different `system_identifier`s.
- **The partner role names** (`partner_runtime`, `pn_migrator`, `partner_definer`,
  `partner_app_test_*`) are created by migration 0001 and by the test helper, and several suites
  assert on them by name. In A and B these are distinct role *objects* in distinct clusters; only
  the names coincide. The admin/superuser login, which the harness does control, differs.
- **The storage bucket name** `partner-real-r2-proof`. `tests/helpers/partner-test-storage.ts`
  builds fixture buckets as `${BUCKET}-${suffix}` and validates the result against
  `/^partner-real-r2-proof-[a-z0-9]{1,16}$/`, so any prefix makes every fixture bucket illegal.
  Namespace separation is achieved with a separate MinIO **server** instead.

### Pre-test runtime safety, proven in BOTH environments before any suite ran

Run by `harness/prove-runtime-safety.mts` on its own database, using the same role helper the suites
use — so the model proven is the model the suites run under:

| Claim | A | B |
| --- | --- | --- |
| effective role is `partner_runtime` | PROVEN | PROVEN |
| `is_superuser = off` | PROVEN | PROVEN |
| `rolbypassrls = false` | PROVEN | PROVEN |
| `row_security = on` | PROVEN | PROVEN |
| **absent tenant context sees 0 rows (fails CLOSED)** | PROVEN | PROVEN |
| tenant A's context sees only tenant A's row | PROVEN | PROVEN |
| tenant GUC is transaction-local, no leak past ROLLBACK | PROVEN | PROVEN |
| admin role has CREATEDB + CREATEROLE + BYPASSRLS (provisioning only, as in CI) | asserted | asserted |
| `partner_runtime` is NOBYPASSRLS across all 37 databases | asserted | asserted |
| MinIO namespace empty at start | 0 objects | 0 objects |

---

## Results — frozen PR #288 tree

| Metric | Matrix A | Matrix B | Equal |
| --- | ---: | ---: | :---: |
| full suite — files | 281 | 281 | ✔ |
| full suite — passed | **5136** | **5136** | ✔ |
| full suite — failed | 0 | 0 | ✔ |
| full suite — skipped | 13 | 13 | ✔ |
| full suite — environment aborts | **0** | **0** | ✔ |
| full suite — exit code | 0 | 0 | ✔ |
| per-suite matrix — suites | 21 | 21 | ✔ |
| per-suite matrix — passed | **423** | **423** | ✔ |
| per-suite matrix — failed | 0 | 0 | ✔ |
| per-suite matrix — skipped | **0** | **0** | ✔ |
| execution floors (all six) | pass | pass | ✔ |
| accidental superuser fallback | none | none | ✔ |
| accidental BYPASSRLS fallback | none | none | ✔ |

**Per-file differences across all 281 files: 0. Per-suite differences: 0.**

> `VERDICT: A and B are IDENTICAL from two independent environments.`

### The 13 skips, accounted for individually

| Suite | Skips | Verdict |
| --- | ---: | --- |
| `tests/printable-grade-safety.test.ts` | 2 | **Correct and deliberate.** `describe.skipIf(!isProdArch)` — the label pixel goldens describe linux/x64, the production architecture; this host is arm64 macOS. They run in CI. |
| `tests/partner-admin-control-shell-integration.test.ts` | 11 | **A genuine finding, not a benign skip.** Its two environment variables have never existed in `ci.yml`, so the file has been `describe.skip` in CI since it was written. See `PRODUCTION-DEFECTS.md` → D-2. Now wired, guarded, floored, and passing 12/12. |

### Storage

Both matrices ended with **exactly 16 orphaned objects** in `partner-real-r2-proof-fpilot`, and 48
after a third run — i.e. growing every build. Identical in A and B, which is what made it a
reproducible finding rather than noise. Diagnosed and fixed (D-3); storage now sweeps to **0**.

---

## Harness ordering — a defect in the harness, recorded rather than hidden

The first Matrix A attempt ran the per-suite matrix *before* the full-repository pass and produced
**3 environment aborts** — `partner-definer-ownership` ("cannot change return type of existing
function"), `partner-management-migration` ("duplicate key value violates unique constraint
`uq_partner_contacts_primary`") and `partner-user-management-migration`.

Cause: the per-suite runner DROPs and CREATEs each suite's database, so it is immune to prior state;
the full-repository pass is not, and inherited the objects the per-suite pass had left behind. All
three suites were GREEN in the per-suite pass, which is what identified it as an ordering artefact of
the harness rather than anything about the source. The order was corrected (full pass first, on
virgin databases, exactly as CI has them) and Matrix A re-run from a **freshly created cluster** — a
different `system_identifier` from the aborted attempt, so no state carried over. The diagnosis
evidence is preserved under `evidence/attempt-1-ordering-diagnosis/`.

---

## Post-change verification (final tree)

After Phase 6 the matrix was re-run from a third fresh environment:

| Metric | Value |
| --- | ---: |
| full suite — files | **282** (+1: the new grading HTTP suite) |
| full suite — passed | **5160** |
| full suite — failed | 0 |
| full suite — skipped | **2** (the arch-gated label goldens only — the 11 control-shell skips are gone) |
| full suite — environment aborts | 0 |
| per-suite matrix — suites | **22** |
| per-suite matrix — passed | **435** |
| per-suite matrix — failed / skipped | 0 / 0 |
| execution floors (all six) | pass |
| storage after | **0 objects** |

### One pre-existing test corrected as part of this (not caused by the change)

`tests/partner-lockout-recovery.test.ts` was 16/16 in BOTH matrices, then failed deterministically a
few hours later on the same machine: `expected 30.00025 to be less than or equal to 30`. The
assertion compared a Postgres-computed `expires_at` against Node's `Date.now()` — two independent
clocks — against an exact boundary. Measured skew at the time of failure: the Docker VM clock was
**111 ms ahead** of the host, so it failed 5 times out of 5.

Corrected to measure the interval **in the database** (`EXTRACT(EPOCH FROM (expires_at - now()))`),
removing the second clock. Verified stable 3/3, and mutation-checked: setting
`RESET_TOKEN_MINUTES = 45` in `server/partner/auth.ts` still turns it RED, and that file was restored
byte-identically. The window is now **narrower** than before (within one second of 30 minutes, versus
"28 to 30 minutes"), so the assertion is stronger, not looser.

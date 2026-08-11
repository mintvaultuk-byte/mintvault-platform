# D-1 — independent reproduction, scope correction, and owner-gate proposal

**Status: REPRODUCED. Larger than reported. Repair requires editing `server/grader.ts` (protected).**

Nothing in this document has been applied. `server/grader.ts` is byte-identical to `origin/main`.

---

## 1. What was reproduced, and how (Phase 2)

The previous pass's proof was `tests/partner-grading-http-routes.test.ts` → `G1b`. That test was
**not reused**. Two fresh, independent proofs were built and run.

### Proof A — the real artifacts (no database, no harness)

Loaded the real `certificates` Drizzle model from `shared/schema.ts` and enumerated exactly what
`db.select().from(certificates)` materialises:

```
certificates Drizzle model column count: 156
  model declares privateNotes      ? -> false
  model declares authStatus        ? -> false
  model declares authNotes         ? -> false
  model declares notes             ? -> true
  model declares gradeExplanation  ? -> true
pick(undefined, cert.privateNotes) = null
pick(undefined, cert.authStatus)   = null
pick(undefined, cert.authNotes)    = null
```

`pick` is copied verbatim from `server/grader.ts:727`. The three columns exist in the live table
(`tests/helpers/partner-realistic-db.ts:622-627` documents them as verified present on live
staging, `text`, with `auth_status` defaulting to `'genuine'`) but are absent from the model, so
`storage.getCertificate()` (`server/storage.ts:999`, a bare `db.select()`) can never return them.

### Proof B — real PostgreSQL 17, real production write path

Disposable PostgreSQL 17 cluster; `certificates` built from the repo's own schema-derived fixture;
one row seeded as an HQ operator would leave it; then the **real, unmodified**
`applyCertGradeDraft` from `server/grader.ts` was called directly. No mocks, no HTTP layer, no
object storage.

```
[BEFORE — admin-internal state as an HQ operator left it]
  private_notes : "ADMIN-ONLY: customer disputes grade, do not disclose"
  auth_status   : "authentic_altered"
  auth_notes    : "Trimmed edges observed under UV"

>>> applyCertGradeDraft(certId, { card_name: "Charizard", overall_grade: "9" })
    returned: true

[AFTER — one ordinary draft save that never mentioned any of those fields]
  private_notes : null
  auth_status   : null
  auth_notes    : null
  card_name     : "Charizard"     <- control: the write really executed
  grade         : "9.0"           <- control: the write really executed
```

**D-1 confirmed.** The controls rule out a vacuous pass (the statement committed; only the three
undeclared columns were destroyed).

---

## 2. Scope correction — this is NOT a partner defect

The previous pass reported D-1 as "a partner grading save erases private fields". A third
reproduction compared the two callers of `applyCertGradeDraft`:

```
=== buildCertGradingPayload() output for a cert STORED as 'authentic_altered' ===
   authStatus   -> "genuine"        (DB holds 'authentic_altered')
   authNotes    -> ""               (DB holds 'UV: trimmed')
   privateNotes -> ""               (DB holds 'HQ NOTE')

=== STAFF grader draft save (server/routes/grader.ts -> applyCertGradeDraft) ===
   AFTER: { private_notes: null, auth_status: "genuine", auth_notes: "" }

=== PARTNER draft save ===
   AFTER: { private_notes: null, auth_status: null,      auth_notes: null }
```

Two facts follow, and both are about code that is **already in production**:

**(a) The grading screen misreports authenticity to every operator.**
`buildCertGradingPayload` (`server/grader.ts:689-696`) computes `authStatus: c.authStatus || "genuine"`.
`c.authStatus` is structurally always `undefined`, so the panel is handed `"genuine"` for every
certificate — including one an HQ operator recorded as Authentic Altered. The operator sees a
verdict the database does not hold.

**(b) The staff save then writes that fabricated verdict back.**
`client/src/components/grading/grading-panel.tsx:1901-1902` sends `auth_status` / `auth_notes` from
that seeded state, so an `authentic_altered` record is silently **downgraded to `genuine`** by an
unrelated staff draft save. The panel deletes `private_notes` in grader mode
(`grading-panel.tsx:2020`), so on the staff path that column is nulled exactly as on the partner path.

`auth_status` also drives grade kind in the panel (`grading-panel.tsx:1857-1858`: `AA` / `NO`), so
this is grading integrity, not cosmetics.

**Provenance.** `server/grader.ts` and `shared/schema.ts` are both byte-identical to `origin/main`.
PR #288 adds a second caller of an already-defective function; it does not create the defect.
This is a **pre-existing production defect in the HQ grading path**, and the release decision for
PR #288 should be made on that basis.

---

## 3. Ownership of the fix — classification E (multiple layers), landing in D

Requested classification (A schema-only / B partner-route sanitisation / C shared storage mapper /
D protected grader path / E multiple layers):

**E — but the only correct minimal repair sits in D.**

| Option | Effect | Verdict |
|---|---|---|
| **B — partner-route sanitisation** | Cannot work. The erasure happens when the field is **absent**, and `partnerGradeBody()` removes it deliberately. To repair here the partner route would have to read `private_notes` and re-inject it into the partner request body — i.e. move admin-internal data into the partner request path to protect it. **Actively harmful. Rejected.** | ✗ |
| **C — shared storage mapper** | `getCertificate()` is a bare `db.select()`; there is no mapper layer to change without changing the model. Collapses into A. | ✗ |
| **A — declare the 3 columns in `shared/schema.ts`** | Would fix both symptoms in one non-protected file: `pick()` finds a real value, and `buildCertGradingPayload` stops fabricating `"genuine"`. **But** it changes what `getCertificate()` returns for **65 call sites**, and it directly contradicts a decision already taken and documented in this codebase. | ⚠ see below |
| **D — `server/grader.ts`, SQL-side preservation** | Matches the precedent the codebase already set for this exact bug class. Six lines, two sites, no read-shape change anywhere. **PROTECTED — owner approval required.** | ✔ recommended |

### Why A is not recommended, despite being the non-protected option

`server/routes.ts:2582-2597` documents this **same root cause**, found earlier on the admin
certificate-update route, in the codebase's own words:

> `auth_status`, `auth_notes` and `private_notes` are REAL database columns that this route writes,
> but shared/schema.ts does not declare them, so Drizzle's `.select()` never materialises them and
> `cert.authStatus` is `undefined` — not null, absent.

The repair chosen and shipped there was **not** to declare the columns. It was SQL-side
preservation, `server/routes.ts:2677-2680`:

```sql
auth_status       = COALESCE(${txt(b.auth_status)}, auth_status, 'genuine'),
auth_notes        = COALESCE(${txt(b.auth_notes)},        auth_notes),
private_notes     = COALESCE(${txt(b.private_notes)},     private_notes),
```

with the comment *"a payload without auth_status must not silently downgrade an
'authentic_altered' record to 'genuine'"* — the precise failure now proven on the grading path.

Declaring the columns would therefore reverse a deliberate, documented decision and widen the read
shape of a 156-column model across 65 call sites. Blast radius checked: the public surface is safe
(`/api/cert/:id` projects through `certToPublic`, a typed allow-list with zero object spreads), and
the whole-certificate `res.json(cert)` responses found are all `requireAdmin`. So A is *probably*
safe — but "probably safe across 65 call sites" is a worse trade than "six lines in the file that
already owns this write", especially when the six-line form is the pattern the owner already
approved for the identical bug.

---

## 4. OWNER APPROVAL REQUIRED — exact proposed protected change

**File:** `server/grader.ts` (protected — NOT edited; this is a proposal only)

### Change 1 of 2 — stop the write erasing the columns

**Function:** `applyCertGradeDraft`
**Lines:** 830, 831, 833 (inside the single `UPDATE certificates SET …` statement)

Current:
```ts
auth_status = ${pick(body.auth_status, cert.authStatus)},
auth_notes  = ${pick(body.auth_notes, cert.authNotes)},
grade_explanation = ${pick(body.grade_explanation, cert.gradeExplanation)},
private_notes     = ${pick(body.private_notes, cert.privateNotes)},
```

Proposed (`grade_explanation` is **unchanged** — it IS declared on the model, so its `pick()` is correct):
```ts
-- These three columns are written here in raw SQL but are NOT declared on the
-- shared/schema.ts certificates model, so `cert.*` is always `undefined` and
-- pick() collapsed to NULL on every save. Preserve at the SQL layer instead —
-- the same repair server/routes.ts:2677-2680 already applies to these exact
-- three columns on the admin update route.
auth_status = COALESCE(${body.auth_status ?? null}, auth_status, 'genuine'),
auth_notes  = COALESCE(${body.auth_notes ?? null}, auth_notes),
grade_explanation = ${pick(body.grade_explanation, cert.gradeExplanation)},
private_notes     = COALESCE(${body.private_notes ?? null}, private_notes),
```

### Change 2 of 2 — stop the read fabricating a verdict

**Function:** `buildCertGradingPayload`
**Lines:** 689-690

Current:
```ts
authStatus: c.authStatus || "genuine",
authNotes: c.authNotes || "",
```

Because `c.authStatus` can never be populated by `storage.getCertificate()`, these must be sourced
from the columns directly. Minimal form: read the three raw-SQL-only columns with one explicit
`SELECT auth_status, auth_notes FROM certificates WHERE id = $1` inside `buildCertGradingPayload`
and use those values, keeping `'genuine'` only as the genuinely-null fallback. `privateNotes: ""`
at line 696 stays exactly as it is — a grader must never receive admin private notes, and that line
is correct today.

**Change 2 is required for correctness of the operator-facing screen, but Change 1 alone stops the
data loss.** They can be approved separately; Change 1 is the smaller and more urgent.

### Why neither change alters grading mathematics

- No file under `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`,
  `shared/mvgs-input-builder.ts`, `server/mvgs-scoring.ts`, `server/lib/cert-pristine.ts` is touched.
- No deduction weight, sub-grade, centering chart, overall formula, Pristine/black-label gate,
  grade bracket, or label rendering is touched.
- `grade`, `grade_type`, all four sub-grade columns and every centering column keep their current
  expressions byte-for-byte.
- `auth_status` is an authenticity verdict, not a score input to MVGS. The change makes it
  *preserved* rather than *overwritten*; it never computes it.
- The approval-lock scoping (`WHERE id = … AND grade_approved_at IS NULL`) is unchanged.

### Required tests before this could be called fixed

1. Rewrite `G1b` in `tests/partner-grading-http-routes.test.ts` from characterisation to
   preservation: assert `private_notes` still equals the sentinel after a partner draft save
   (the existing comment already instructs this).
2. New: partner draft save preserves `auth_status='authentic_altered'` and `auth_notes`.
3. New: **staff** grader draft save preserves `auth_status='authentic_altered'` — the pre-existing
   production regression, which nothing currently covers.
4. New: a save that *does* send `auth_status` still updates it (proves preservation did not become
   an immovable value).
5. New: a brand-new certificate with `auth_status` NULL still lands on `'genuine'`.
6. Mutation proof: revert each COALESCE to the old `pick()` form and confirm each test reddens.
7. Full MVGS regression set green (`mvgs-scoring`, `pristine`, `centering`, `mvgs-input-builder`,
   `mvgs-calibration-validation`) — mandatory for any change inside `server/grader.ts`.

### Counterfactual risk if NOT changed

- Every HQ grading save on live production continues to destroy `private_notes` and to reset any
  `authentic_altered` / `not_original` verdict to `genuine`. This is happening today, before
  PR #288.
- Shipping the partner pilot adds a second population of certificates to the same loss, and adds
  a NULL-`auth_status` variant that the admin route's `COALESCE(..., 'genuine')` does not produce.
- The loss is silent and unrecoverable — there is no audit of the before-value, because
  `server/routes.ts:2596` deliberately marks these three fields **unauditable** for the very same
  reason (the before-value cannot be read).

**Marked: OWNER APPROVAL REQUIRED.**

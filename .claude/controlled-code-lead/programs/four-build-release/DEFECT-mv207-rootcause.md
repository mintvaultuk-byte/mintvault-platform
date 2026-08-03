# RELEASE-BLOCKING DEFECT — MV207 structured-variant clobber — ROOT CAUSE PROVEN
Status: root cause established. NOT implemented. Production planning STOPPED.

## Symptom
MV207 label renders "RARE · MCDONALD'S PROMO · GLITTER HOLO"; intended final state was promo-only.
DB: rarity_code=silver_star_rare, finish_variant=glitter_holo, promo_type=mcdonalds_promo, version=2.

## NOT the cause (proven, so we don't chase them)
- RENDERER: correct. formatVariantLine(promo only)="MCDONALD'S PROMO"; the 3 persisted codes legitimately
  produce the observed line. Renderer faithfully reflects persisted data.
- SERVER PERSISTENCE: correct. EMPIRICALLY PROVEN on disposable cert MV206 (staging):
  * Probe A (all 3 set) -> all persisted.
  * Probe B (rarityCode:"" finishVariant:"" + promo) -> BOTH cleared to NULL, promo preserved. = required behaviour.
  * Probe C (keys omitted, promo present) -> also cleared (group-level opt-in: STRUCTURED_KEYS.some(k=>k in body)).
  MV206 restored to baseline afterwards. MV207 untouched (preserved as evidence).
- CLIENT PAYLOAD BUILDER: correct. buildCertFormData (certificate-form.tsx:1177-1182) appends "" (no truthiness filter).
- Emit path: buildStructuredVariant always emits explicit nulls; picker emit gate correct.
- REFUTED: resync effect re-seeding structured cols (it only touches legacy rarity/variant, L433-488);
  Recently-Used/favourites auto-select (setRarity only in 5 click handlers); catalogue-load re-emit.

## CONFIRMED ROOT CAUSE (Lead-verified line by line)
**Stale-closure replay in the auto-save serialiser — client/src/components/certificate-form.tsx**
- L1274 `async function autoSaveNow()` is a per-render function declaration -> new closure each render capturing that render's `form`.
- L1288 `buildCertFormData()` reads `form` lexically from that closure.
- L1276-1279 a save requested while one is IN FLIGHT returns WITHOUT saving; only sets autoSavePendingRef.
- L1320-1326 `finally { ... if (pending) void autoSaveNow(); }` re-invokes ITS OWN (older) binding -> replays the
  PRE-CLEAR snapshot. The newer state is discarded and never re-scheduled (debounce L1336-1350 only fires on a
  FURTHER form change). If the clear was the last action, the stale snapshot is the LAST WRITE TO THE DB.
- Server then sees all 5 structured keys present -> optedIn -> rewrites the OLD values + stamps version=2.
- refreshSnapshotFromCert is refreshed from that stale response, so the field-scoped stale-tab guard cannot 409.
- ORIGIN: commit 4879694a (2026-07-06) — PRE-DATES #239/#242/#243. NOT a regression from this integration.
- Timing corroboration: 5 autosaves 21:07:21.073/21.814/23.454/24.063/25.237 (gaps 741/1640/609/1174 ms) —
  600ms debounce mixed with longer request-latency gaps = the in-flight/replay pattern.

## CONFIRMED CONTRIBUTING DEFECT (the finish half)
**No usable finish-clear affordance — RarityVariantPicker.tsx**
- Rarity has an explicit "No rarity — clear" button (L613-628, testid rarity-clear) from #239.
- Finish/promo have NO clear button; clearing requires clicking the already-selected pill (L746, L757, L769).
- `glitter_holo` is NOT in QUICK_FINISHES (L68) -> its pill renders ONLY inside the `{showMoreFinish && ...}` block
  (L755-759), collapsed by default (L253). The selected finish is INVISIBLE and unclickable until "More finishes"
  is expanded -> the operator had no visible way to clear it. Search-results path (L635) has no toggle at all.

## OTHER CONFIRMED (do NOT bundle into the hotfix)
- F2 cross-cert leak: admin-dashboard.tsx:452 `<CertificateForm certificate={editingCert}>` has NO `key`; state is
  seeded once at mount; "Next card" swaps the prop without remount -> card 1's structured values can be saved onto
  card 2. Contrast grading-panel.tsx:2295 which IS keyed by certId. NOT the MV207 cause (single-cert session).
- F3 role/adminReview path: grading-panel buildPayload omits structured keys when untouched (`if (x.trim())`), and
  server/grader.ts `pick()` writes '' not NULL; applyCertGradeDraft never refreshes derived columns
  (rarity_label_structured/printed_symbol/region/version). Two writers with different emptiness semantics.
- F5 (Lead-observed): clearing ALL structured fields left structured_variant_version=2 instead of reverting to NULL
  (harmless for rendering — hasStructuredVariant() false -> legacy branch — but inconsistent).
- Evidence gap: audit_log records only setName/cardName/gradeOverall -> structured-field history is NOT reconstructable.

## PROPOSED FIX (minimal, surgical — NOT IMPLEMENTED, awaiting approval)
FIX 1 (the root cause) — certificate-form.tsx, 3 lines:
  a) after L1272: `const autoSaveNowRef = useRef<() => Promise<void>>();`
  b) after the autoSaveNow declaration (L1327): `autoSaveNowRef.current = autoSaveNow;`
  c) L1324: `void autoSaveNow();` -> `void autoSaveNowRef.current?.();`
  Effect: the queued replay builds its FormData from the CURRENT render's form. Same ref pattern the picker already
  uses deliberately (onChangeRef, RarityVariantPicker L323-326). No type/column/API change. #239's contract is
  strengthened, not altered. Watch-item: an image picked before an in-flight save then cleared in onSuccess is no
  longer re-uploaded by the replay (correct, but smoke-test "change image then immediately edit a field").
FIX 2 (the finish half) — RarityVariantPicker.tsx: add an explicit "No finish — clear" control mirroring the rarity
  one (and the same for promo), and/or auto-expand the "More finishes" section when the current selection lives in it.
  Additive UI; no payload-semantics change.
DEFER (separate change, own review): F2 `key={editingCert?.id ?? "new"}`; F3 role-path emptiness contract; F5 version reset.

## REGRESSION TESTS TO ADD (with the fix)
1. Auto-save replay uses CURRENT state: start save, mutate form mid-flight, assert 2nd PUT body carries the mutation.
2. Promo-only round-trip: set promo only -> persists promo, rarity/finish NULL -> label line == "MCDONALD'S PROMO".
3. Independent clearing: clear rarity leaves finish+promo; clear finish leaves rarity+promo.
4. Persistence after reopen: cleared state survives save->reload.
5. Cross-certificate isolation: switching certs never posts cert A's structured values to cert B.

## FIX IMPLEMENTED — PR #245 (2026-07-24), branch fix/structured-variant-persistence @ 711a2741
Worktree /Users/cornelius/mintvault-structured-variant-fix, branched from origin/main f0f4d9df.
Commits: 34d9847f (autosave replay) · a507ddb4 (clear controls) · b8a3dc28 (cert isolation) ·
2ac53214 (review-path NULL + version invariant) · 711a2741 (tests).
Files (6): certificate-form.tsx, RarityVariantPicker.tsx, grading-panel.tsx,
shared/structured-variant-validate.ts, tests/structured-variant-persistence.test.ts (new),
tests/canonical-grading-workstation-architecture.test.ts (C3 pin updated). +590/-60.

KEY DECISION: server/grader.ts was initially edited then REVERTED — the grading-engine guard test
(variant-line-consolidation "no MVGS/grading-CALCULATION engine file was modified") correctly caught it.
The NULL semantics were achieved client-side instead (grading-panel sends null; pick() already maps an
explicit null → SQL NULL). NO protected grading file is modified.

Gates: tsc 0 · lint 0 err · build OK · MVGS 202/202 · local suite 1891 passed/0 failed ·
**CI PR #245: ALL FIVE GREEN, 2297 passed / 0 failed / 420 skipped** (incl. the DB-backed suites).
Regression tests PROVEN to catch the bug (reintroducing the stale replay fails tests 1-4 and 5).
NOT merged. Staging/production untouched; prod remains d5daecbf.

## FOUNDER DECISIONS 1-3 IMPLEMENTED — PR #245 @ 52038f38 (2026-07-25)
1. FULL-CLEAR RULE: consolidatedVariantForLabel gated on `version >= 2` ALONE (was `&& hasStructuredVariant`).
   A v2 cert with every structured field empty renders NO variant line; legacy wording cannot reappear.
   **STICKY VERSION** (found by Lead's own preview/print parity check, not by any test): the earlier
   "honest version invariant" reset version→NULL when nothing structured was set, which sent a fully-cleared
   cert back to the LEGACY renderer and resurrected "HOLO" — defeating rule 1. applyStructuredVariantFromBody
   now takes `currentVersion` (4th param) and never downgrades an already-consolidated row. Passed from the
   PUT route (existing.structuredVariantVersion) and the preview route. Create flow + never-converted certs
   unaffected. Preview==print verified executably for the full-clear case.
2. LEGACY FREE-TEXT WARNING: new pure `legacyFreeTextLostOnConversion()` + a one-time warning that HOLDS the
   save at the conversion boundary. Silent when: no free text / already v2 / save doesn't convert / wording is
   represented / whitespace-only. Cancel dismisses WITHOUT saving; ack is per-cert (reset by isolation effect).
   No schema change, no data rewrite.
3. RELEASE ORDERING — VERIFIED FACTS:
   - 0ee8fd47 (#242 version-2 stamping) IS already an ancestor of origin/main; origin/main already has
     STRUCTURED_VARIANT_VERSION = 2.
   - **STAGING IS ALREADY DEPLOYED AT f0f4d9df** = version-2 stamping WITHOUT the rendering fix. That is the
     exact hazard, and it is how MV207 came to be stamped v2 under fold-inclusive semantics.
   - The fix branch contains ALL of origin/main, so merging #245 satisfies the ordering for every FUTURE deploy.
   - PROD: zero version-2 rows -> no production label affected. Prod still d5daecbf.
   - Residual: staging has 2 v2 rows (MV207 = the target; MV206 = my disposable probe cert, all-structured-null,
     which will render "" instead of legacy "COMMON" after the fix deploys). Both are test certs.

CI on 52038f38: ALL FIVE GREEN — 2316 passed / 0 failed / 420 skipped. 13 files, +1117/-81.
Focused suite 45/45. MVGS 202/202. Full local 1910 passed / 0 failed. NOT merged, nothing deployed.

## PR #245 MERGED (2026-07-25 05:07:56Z, founder-approved)
- Pre-merge verified: head == 9880a34e (the approved commit); MERGEABLE/CLEAN; all five checks green
  (incl. CodeQL); branch contained all of origin/main; nothing deployed in the interim.
- Merge method: merge commit (repo convention).
- **Merge commit: 90b234fda17a64bab47dabeca7bec86e47ab93d6**
- **origin/main: f0f4d9df → 90b234fd**
- 9880a34e confirmed an ancestor of origin/main. `git diff 9880a34e origin/main` = EMPTY
  → the merge introduced nothing beyond the reviewed+approved commit.
- PR #245 state = MERGED.
- PRODUCTION UNTOUCHED: mintvaultuk.com and mintvault.fly.dev both d5daecbf; 2 machines still v1062,
  last updated 2026-07-24T13:22Z (before this work). STAGING also NOT deployed (still f0f4d9df).
- Release-ordering constraint SATISFIED: the rendering fix is now in main ahead of any deploy.
- Deferred follow-ups filed: #246 (F4 legacy summary/print), #247 (F5 era-only partial PUT),
  #248 (F6 Correction Mode structured-variant).
- NEXT (owner-gated, NOT started): staging deployment of merged main 90b234fd.

## STAGING DEPLOYED (2026-07-25, founder-approved) — PROD UNTOUCHED
- origin/main re-confirmed 90b234fd; prod re-confirmed d5daecbf BEFORE deploying.
- DB target double-checked: local .env host == mintvault-v2's own host == ep-purple-voice (staging).
- Migration dry-run BEFORE: 20 total / 20 applied / 0 pending / 0 inconsistent / 0 checksum-mismatch
  (0017/0018/0019 already applied) → NO migration needed for this deploy. AFTER: identical.
- `scripts/safe-deploy.sh staging` → mintvault-v2, machine d8d14d0f34d378, **version 427**, 1/1 checks.
  GUARD 2: "VERIFIED: mintvault-v2 is live on commit 90b234fd (checked the running server)".
  Transient fly rollout WARNING (not listening) self-resolved; machine then passed smoke+health.
- Health: /api/version=90b234fd, /ready 200, /api/health 200, homepage 200. ONE machine configured.
- SERVED-BUNDLE proof (recursive crawl, 212 chunks / 4.24 MB): all F3 markers present
  (paused status, discard gate, Discard/Stay, warning panel+copy), plus finish/promo/rarity clear
  controls and the canonical preview endpoint; the removed duplicate endpoint is ABSENT. Not stale.

### Live verification results
- MV207: operator clear PERSISTED (rarityCode NULL, finishVariant NULL, promo=mcdonalds_promo, ver=2;
  legacy rarity 'Basic Pokémon' / variant 'Holo' PRESERVED in the DB).
  **PRINTED label == PREVIEW == a no-legacy control, all byte-identical (sha fd65aa3c…, 89505 bytes)**
  → proves NO 'BASIC POKÉMON' and NO 'HOLO' on the label; line is exactly "MCDONALD'S PROMO".
  The old defect state renders a DIFFERENT image (81973 bytes), confirming the change took effect.
- MV206 (disposable, v2, all structured empty): renders NO variant line ("") as expected.
- Legacy certs unchanged: variant COSMOS_HOLO → "COSMOS HOLO"; rarity RARE_HOLO → "HOLO RARE".
- Catalogue-only DB code → "TERA HYPER RARE 2026" (never blank).
- Explicit label override on the v2 cert → "1ST EDITION SHADOWLESS" (beats the structured line);
  without an override the same cert → "MCDONALD'S PROMO".
- Canonical preview endpoint only; OLD /api/admin/label-preview = 404.
- PRODUCTION UNTOUCHED THROUGHOUT: mintvaultuk.com + mintvault.fly.dev = d5daecbf; 2 machines v1062
  last updated 2026-07-24T13:22Z; prod DB unchanged (573 NULL / 8 v1 / 18 migration rows).
- NOT verified by me (UI interaction, needs a browser): the conversion-warning click-through
  (Cancel/discard/confirm) — code is served and unit-covered; founder smoke test recommended.
- NEXT: production deployment — NOT started, awaiting separate founder approval.

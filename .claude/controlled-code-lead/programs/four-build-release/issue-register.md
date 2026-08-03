# Issue Register — Four-Build Integration

## Hostile review — Migration safety (database-reviewer) — COMPLETE
Verdict: all 5 Lead facts CONFIRMED. NO Critical/High. 3 pure suites (partner-schema-parity, catalogue, db-migration-safety) = 91 tests pass.
- 0019 used exactly once; rollback non-numbered (runner ignores). 0022 byte-identical to origin/main (sha e24f5e70…) → staging journal checksum matches, no hard-fail.
- 0019 purely additive (CREATE TABLE/INDEX IF NOT EXISTS); rollback clean total reversal.
- 0017/0018 idempotent + lint-clean; deps all ≤0016 (staging has them). No dependency gap.
- partner-schema-parity inventory pin already includes 0019 + 0022 → passes.
- seed-catalogue idempotent (onConflictDoNothing on uq_category_value).

### F1 (LOW / G) — Staging apply is NOT catalogue-only — ELEVATE TO FOUNDER
Applying 0019 forces pending 0017 + 0018 first. 0017 lands the partner credit-reservation engine
(2 tables, 4 triggers incl. a BEFORE-INSERT underfunding-check trigger on partner_credit_ledger,
RLS enable/force + tenant policies + GRANT to partner_runtime). 0018 = concurrent audit_log index.
All additive/idempotent + dormant while partner flags OFF, but materially larger than catalogue.
ACTION: founder signs off the 3-migration apply knowingly (already in staging plan + PR body).

### F2 (LOW / G) — 0018 concurrent-index failure semantics
0018 is CREATE INDEX CONCURRENTLY / no-transaction. A mid-build failure marks the journal row
failed → next run hard-stops until manual resolution (by design). Note so a failed staging run
isn't mistaken for corruption. No action pre-apply.

Reviewer belt-and-suspenders (already satisfied): pre-apply read-only `SELECT filename,checksum,status
FROM schema_migrations` per host. Staging dry-run already showed 0 checksum-mismatch + 0017/0018/0019 pending.

## Hostile review — Preview consolidation (backend-reviewer) — COMPLETE
Verdict: NO Critical/High. ReDoS SAFE, auth fail-closed, no dead code, no 500/corruption.
- F1 ReDoS into PROMO_SUFFIX_RE: SAFE — setName always from capped preview (spread last); saved-cert path can't reintroduce uncapped setName; structured derivation never writes setName; old inline route gone.
- F4 mutation/throw/500: SAFE — cert is fresh copy (saved not mutated); getCatalogueSnapshot try/catch→SEED; inner+outer try/catch; validateStructuredVariant pure.
- F5 auth/IDOR: fail-closed (401 unauth); gate=admin OR can_grade staff; residual = load-any-cert-by-id (front-label surface only, no PII/R2/email; same pattern as ~dozens of existing cert routes). Low/accepted.
- F6 duplicate/dead: CLEAN — 1 route, 1 registration, LabelPreview.tsx deleted, no orphaned imports.
- **F2 (Low) FIXED (commit 921fa1dd):** saved-cert branch now restores ALL Pristine-gate columns (grade/subgrades/centering/darkBorder/eyeAppeal/defects) from the saved row → gate provably 1:1 with print regardless of body. Comment corrected.
- **F3 (Low) DEFERRED:** empty structured opt-in nulls in-memory structured cols. For a preview reflecting an in-progress edit this is CORRECT (shows post-save legacy line) + matches save-route semantics + masked by form hydration. No fix needed.

## Hostile review — RBAC + rarity + cross-cert (security-reviewer) — COMPLETE
Verdict: NO Critical/High. Clean: catalogue RBAC solid (all mutating routes requireSuperAdmin, no client-trusted role); NO SQL injection (Drizzle builder; search/sort in-memory); ReDoS neutralised; #239 emit-guard PRESERVED (emit deps = user-selection primitives not async catalogue; emitMountedRef skips first run; single-select intact; no new cross-cert bleed from #243); preview async race safe (cancelled flag + certificateId in effect key + URL revoke); import 5000-capped + export sheds PII.

### F1 (MEDIUM / B) — DEFERRED to founder (pre-existing, out of scope, unsafe naive fix)
Queue "Next"-without-close swaps editingCert in place; CertificateForm (admin-dashboard L452) has NO key, form resync fills empty fields only → form keeps prior cert's identity; new preview passes fresh certificateId + stale fields → wrong-cert composite; underlying = documented stale-form-clobber (pre-existing).
EVIDENCE it's pre-existing + out of scope: admin-dashboard.tsx UNCHANGED by integration (git diff empty vs debea36b). Naive fix key={editingCert?.id} would RESET form-internal sessionCompleted HUD (line 241) every queue advance = regression. Safe fix = full cert→form resync effect keyed on id, which touches the deliberately-designed "fill empty only / never stomp edits" logic (L433-488).
DISPOSITION: DEFER — recommend a FOCUSED follow-up (resync effect + its own tests), not bundled into this 4-build release. Integration's new preview surfaces it but does not cause it. Common flow (save→close→reopen) remounts and is unaffected.

### F2 (LOW / D) — DEFERRED
Catalogue import UPDATE path (updateCatalogueItem) skips insertCatalogueItemSchema.parse (only create parses) → import-update writes unbounded label/aliases/metadata. Super-admin-only + catalogueMutationLimit + 5000-item cap; values reach label renderer but impact is cosmetic overflow (setName ReDoS path separately capped). Overlaps #243's OWN already-deferred Low ("F5 abbreviation TOCTOU + metadata size"). DISPOSITION: DEFER — carry forward; validate update rows in a focused follow-up.

### F3 (LOW / C) — DEFERRED (accepted)
Preview renders any cert's front label by id (no ownership narrowing beyond admin/can_grade). Front-label surface only (name/set/grade/variant) — no PII/R2/email; cert fronts public via QR once approved; requires authenticated grader; same access pattern as ~dozens of existing cert routes. Matches backend F5. DISPOSITION: DEFER — accepted Low.

## MERGE-GOVERNANCE GATE: no unresolved Critical/High. 1 Medium + 2 Low, all deferred with documented justification (pre-existing / trusted-actor / accepted). F2(preview) Low FIXED in commit 921fa1dd.

## Hostile review — the two founder-approved CI fixes (security-reviewer) — COMPLETE
Verdict: **NO Critical, NO High.** Both claims hold under adversarial testing.
- Commit 1 = net STRENGTHENING, not weakening. `invalid_from` is PROVABLY single-meaning for create_batch
  (nextState is total over 7 states; only `printing` falls through to invalid_from). Cannot mask: seeding bug
  (→not_found/not_approved), garbage state (effectivePrintState normalises → needs_printing), winner corruption
  (caught by the retained stateOf==='printing' + appliedX.length===1 assertions). DB assertions sound: event
  INSERT is in the SAME transaction as the guarded UPDATE (1 row/reserved cert); `cert_ids @> '["MVX"]'::jsonb`
  correct for JSONB column; beforeEach TRUNCATE covers both tables. Test CANNOT pass if both batches reserved.
- Commit 2 equivalence TRUE for EVERY input. Reviewer tried to refute across **426,163 differential cases**
  (whitespace runs 0/1/2/63/64/65/66/100/200 × 17 distinct \s code points, mixed runs, ZWSP/letter injected at
  the 64-boundary, all-whitespace, W=0 edge, case variants, singular/plural, near-misses, 400k randomised) →
  **0 output divergences, 0 match-existence divergences.** Plus a full-Unicode proof that \s and String.trim()
  remove EXACTLY the same character set (1,112,064 code points; sets identical incl. NBSP/U+2028/U+FEFF), and
  that JS `$` without /m rejects a trailing newline for BOTH. Match existence proven identical (a run of N≥65 can
  always start later within the same run). Single caller (labels.ts:950) → byte-identical rendered label.
- ReDoS measurably fixed: OLD quadruples per doubling (2.67→9.99→38.52→148.41→562.91ms) = O(n²); NEW flat
  ~0.018ms at every size (0.03ms @100k, 0.06ms @200k matching). No other super-linear quantifier in labels.ts.
- Blast radius CLEAN: one hunk in labels.ts (-1/+8 = regex + comment); zero grade/subgrade/centering/Pristine/
  MVGS/cert-numbering/dimension change; commit 1 touched only the test file. No auth/secrets/payment surface.
- Test quality adequate: corpus runs a copy BUT L40 pins the SHIPPED literal read from server/labels.ts, and L46
  pins the .trim() precondition → cannot pass while labels.ts ships something different. Timing assertions have
  ~30,000x headroom (0.03ms vs 1000ms) — not flaky.

### Reviewer's 3 "could not verify" items — RESOLVED by Lead-held evidence
1. "Does CodeQL actually clear?" → **YES, PROVEN.** CI CodeQL check PASSED on a90ef0c8; GitHub code-scanning API
   shows ZERO open alerts on labels.ts (22 other pre-existing ReDoS alerts elsewhere on main, none ours).
2. "main @4f6449c9 failure claim unverified" → **VERIFIED by Lead.** Run 30112120950 log shows the identical test
   + identical AssertionError on that commit.
3. "Could not run print-workflow test (sandbox pg_ctl)" → **RAN IN CI:** 2271 passed / 0 failed / 420 skipped.

### Findings F1–F4 — ALL LOW, recommendation-only, NONE blocking
- F1 (H) coverage erosion: no test now DETERMINISTICALLY pins the guarded-UPDATE `already_reserved` branch.
  Mitigated: the 3 product invariants still fail loudly under real contention. Follow-up: add a deterministic test.
- F2 (H) `action='create_batch'` is an overloaded verb (release/reconcile paths reuse it) — the count assertion is
  exact only because the renderer is stubbed to succeed. Pre-existing product note: listPrintQueue batch_id
  sub-select can surface a batch_id for a released cert (pre-existing at 921fa1dd, separate ticket).
- F3 (H) new test uses process.cwd() for source pinning — fails loudly not silently; prefer import.meta.url.
- F4 (A, NOT APPLIED — needs founder OK) shared/label-preview-fields.ts:9 comment still quotes the OLD regex
  (drift from commit 2). Cosmetic today, but could mislead someone into removing a defence-in-depth mitigation
  that is worth KEEPING. One-line comment fix.

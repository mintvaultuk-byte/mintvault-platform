# CodeQL Decision — js/polynomial-redos @ server/labels.ts:406 (FOUNDER DECISION REQUIRED)

**Status:** HELD for founder. NOT dismissed by Lead. labels.ts NOT edited by Lead.

## The alert
- Rule: `js/polynomial-redos`
- File/line: `server/labels.ts:406`
- Exact current line: `const PROMO_SUFFIX_RE = /\s+black star promos?$/i;`
- Used by `splitPromoSuffix(setName)` (labels.ts:409) to split a trailing "… Black Star Promos" off a set name.
- Pre-existing regex (on main since before this release). #243's preview route created a NEW request→regex taint path, which is why CodeQL now flags it on PR #243.

## Why it is runtime-SAFE already (evidence)
- The ONLY untrusted entry (the canonical preview route) passes set name through `buildPreviewFields.str()`
  (shared/label-preview-fields.ts): `v.replace(/\s+/g," ").trim().slice(0,200)` → whitespace runs collapsed
  to ONE space (removes the backtracking fuel) + hard 200-char cap. In the consolidated route, `cert.setName`
  always comes from the capped `preview` object (it spreads AFTER any saved cert), so even the saved-cert
  path cannot reintroduce an uncapped set name into the regex.
- Print/label paths otherwise read set names from the DB (admin-authored, trusted), not attacker input.
- CodeQL is static: it does not treat the collapse+cap as a sanitizer, so the alert persists despite the mitigation.

## Options
**A. Regex hardening (RECOMMENDED) — semantics-preserving, clears CodeQL, but edits PROTECTED labels.ts → needs explicit founder approval.**
- Proposed replacement (one line):
  `const PROMO_SUFFIX_RE = /\s{1,64}black star promos?$/i;`
- Equivalence: every genuine set name has exactly ONE space before "Black Star Promos"
  ("Sword & Shield Black Star Promos", "XY Black Star Promos", "Black Star Promos", "SVP Black Star Promo").
  `\s{1,64}` matches those byte-identically to `\s+`. They differ ONLY on 65+ consecutive whitespace chars
  immediately before the literal — impossible in any real set name and already impossible through the capped
  preview route. Visible label output is identical for all valid values.
- Why it clears CodeQL: a bounded quantifier removes the unbounded backtracking the polynomial-redos query flags.
- Test evidence to add (focused, non-protected): assert splitPromoSuffix() base/suffix outputs are unchanged for
  the four real families + a pathological 100k-space string returns instantly.
- Rollback: one-line revert to `/\s+black star promos?$/i`.

**B. Restructure the taint path (no protected edit).** Add an explicit recognised sanitizer/length-guard on the
  route boundary. Risk: CodeQL taint tracking may still not recognise it → alert may not clear. More code, less certain.

**C. Justified dismissal (no code change).** Dismiss as "won't fix — mitigated by input normalisation" citing the
  200-char cap + whitespace collapse at the only untrusted entry. Defensible; leaves the static alert dismissed with rationale.

## Lead recommendation
**A** — it is the only option that both removes the alert AND leaves a permanently safe regex, with a one-line,
provably-equivalent change. Because labels.ts is protected, the Lead will NOT apply it without the founder's explicit
"yes". If the founder prefers zero protected-code edits, **C** is acceptable given the runtime is already bounded.

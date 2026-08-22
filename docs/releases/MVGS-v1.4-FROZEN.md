# MVGS v1.4 — FROZEN RULESET

**Status: IMMUTABLE. This ruleset is closed. It will not be edited again.**

MVGS v1.4 is a historical protocol version, not ordinary application code.
Roughly 700 certificates — and the physical slabs printed from them, already in
customers' hands — were graded under exactly these rules. A grade is a published
claim about someone else's property; changing v1.4 restates every one of those
claims retrospectively. Future grading policy ships as **v1.5**, alongside.

---

## Identity

| | |
|---|---|
| Rules version | `v1.4` |
| Database identifier | `certificates.mvgs_rules_version = 'v1.4'` |
| Preceding version | `v1.3` (published 24 May 2026) — still stamped on rows graded before the change |
| Published standard | MVGS v1.4, published 22 August 2026, `/standard` |
| Introduced by | PR #330 — made the published grade 9.5 (Mint+) issuable |
| Frozen by | PR #332 (this release) |
| Proven on production | release **v1120**, commit **`320c731a`** |
| Golden corpus version | 1 (97 grade vectors + 50 centering axis rows) |

## What changed in v1.4, and nothing else

v1.3 → v1.4 altered exactly one thing: the floor rule's high-variance threshold
became attainable at the 9 rung, so grade **9.5** could finally be awarded. Under
v1.3 a lowest subgrade of 9 could never reach the fixed 4-point gap — the other
three subgrades top out at 10 — so cards fell 10 → 9 with nothing between, and
0 of 714 live certificates held 9.5. No deduction weight, centering band, grade
bracket, structural ceiling, calibration value or Pristine rule moved.

## Authoritative modules

The dependency closure of the grading authority. Every file below is protected
by SHA-256 in `mvgs-v1_4-freeze.manifest.json`:

| Module | Determines |
|---|---|
| `shared/mvgs-scoring.ts` | deductions, grade brackets, structural ceilings, the floor rule |
| `shared/centering.ts` | front/back band tables, worst-of-four axis rule |
| `shared/pristine.ts` | Pristine 10P / Black Label gate |
| `shared/mvgs-input-builder.ts` | observation → engine input normalisation |
| `shared/grade-presentation.ts` | grade ladder, tier names, grade validation |
| `shared/mvgs/v1_4/calibration.ts` | the six frozen calibration thresholds |
| `shared/mvgs/v1_4/index.ts` | the only supported way to invoke v1.4 |
| `shared/mvgs/registry.ts` | version routing; fails closed on an unknown version |
| `server/lib/draft-grade-authority.ts` | the single server-side grade producer |
| `server/lib/grade-kind.ts` | numeric / NO / AA resolution |

## The calibration that defines v1.4

Previously read from a **mutable** `pipeline_settings` row (`locked: false` in
production), meaning six scoring thresholds could be retuned from an admin screen
without touching a protected byte. Now frozen constants:

```
edgeAffectedPct           10
minorVisibleSplitPct      25
darkBorderMultiplier      1.25
creaseMinorMaxPct         25
creaseHalfMaxPct          50
creaseThreeQuarterMaxPct  75
```

Read from the production database (`ep-wispy-morning`, release v1120) on
2026-08-22; the stored row was written by `mvgs-v2-launch` on 2026-06-04 and is
identical to these values, so pinning changed no grade.

## Equivalence proof

The frozen ruleset was scored against a worktree checked out at `320c731a` — the
exact commit production runs — over the full golden corpus:

```
grade vectors : 97   differences: 0
centering rows: 50   differences: 0
VERDICT: IDENTICAL to production v1120 / 320c731a
```

## How it is held closed

| Lock | Mechanism |
|---|---|
| Cryptographic | SHA-256 over 10 files; `scripts/mvgs/verify-freeze.ts`, run by CI before lint |
| Semantic | 97 golden vectors + 50 centering rows driving the real authority |
| Dependency closure | import walk from the authority; a new behaviour-affecting module fails CI |
| Mutable input | calibration pinned to constants; no grading path reads the database |
| Version routing | `registry.ts` fails closed on an unknown `mvgs_rules_version` |
| Database | grader draft writes scoped `grade_approved_at IS NULL`; kind changes on published rows refused |
| Client boundary | no engine or schema in any browser chunk; source + built-bundle guards |
| Governance | CODEOWNERS on every frozen path; agent instructions in `CLAUDE.md` |
| Published standard | every published centering row and score band asserted against the engine |

Re-sealing requires `scripts/mvgs/reseal-freeze.ts --i-am-changing-a-frozen-ruleset`,
which is deliberately wired into no npm script, no test and no CI job.

## To change grading in future

1. Create `shared/mvgs/v1_5/` with its own frozen calibration.
2. Register it in `shared/mvgs/registry.ts`.
3. Stamp new grades `v1.5`; leave every v1.4 row untouched.
4. Publish the new standard with its own version lock and date.

**Do not edit v1.4 to create a future grading standard.**

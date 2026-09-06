# Scanner Canon LiDE 400 stale Y-origin geometry

- **Date:** 2026-08-27
- **Severity:** HIGH
- **Issue:** SCN-GEOMETRY-001
- **Detected in:** Scanner v1.5.7 against `mintvault-v2` STAGING
- **Server baseline:** `ebcab6dba185a029bf0a22c75934eb1357adda11`
- **Repair implementation:** `72757f47228609d275a127c659647478e2f88aa7`
- **Deployment:** First STAGING image build failed safely before release; corrected candidate pending
  final exact-SHA clearance; production untouched

## Observed failure

The connected Canon LiDE 400 held a real card, but PREVIEW FRONT returned RED
`card_not_detected` and an all-white crop. The exact Pokémon Kings station was
`MV-STN-6DIISWMIEU2IKRG4`; its current VALID calibration
`f7b7fe4f-aefb-423c-a4a5-dc9cec8fabcf` selected
`{x:0,y:167.01,width:100,height:130}` mm.

No FRONT or BACK evidence was admitted from this failed preview. Existing failed/expired Scanner
runs remain visible; no card, reservation, credit, station identity, Keychain identity or Canon
calibration row was deleted or reset.

## Physical coordinate proof

| Acquisition | Driver rectangle / size | Physical result | SHA-256 |
| --- | --- | --- | --- |
| Full platen | `{x:0,y:0,width:215.9,height:297.0107}` mm; 2550 x 3508 at 300 DPI | Real card appears at the raw upper-left | `5b15b8919a4de7cebcdfffac18426bd5f719c4c30f18a70e4fb4fb1429af2f6a` |
| Bounded diagnostic | `{x:0,y:0,width:100,height:130}` mm; 1181 x 1534 at 300 DPI | Complete real card is inside the crop | `24873761c9d2e2bf6087b9782e8dae35e55d8bd89f0563da0476b319281c7a8f` |

The bounded diagnostic measured the card at `x=2.37`, `y=2.29`, `width=63.93`,
`height=88.98` mm. This proves the driver crop origin, but correctly does **not** qualify as a GREEN
placement: the card must be moved inward until every preview margin is at least 5.6 mm.

## Root cause

ImageCaptureCore reports and crops the LiDE 400 from the platen's physical upper-left. The stored
`y=167.01` is the inverted far-end origin: `297.0107 - 130 = 167.0107` mm. It therefore selected the
opposite, blank end of the platen. X origin, 100 x 130 mm dimensions, X/Y axes, portrait acquisition
and hardware rotation were not defective. A separate `{0,0,100,130}` driver request independently
proved the corrected acquisition rectangle; no coordinate was guessed.

## Repair

The incident command is bundled as `dist/repair-canon-lide400-geometry.cjs`, is dry-run by default,
accepts no caller-supplied station, tenant, account, hardware, calibration or coordinate, and refuses
outside the exact `mintvault-v2` STAGING runtime and database identity.

Before writing it requires the exact ACTIVE station, Pokémon Kings tenant/location, Canon hardware
and fingerprints, stale calibration, authorised MFA-passed operator, current credential/idle/location
scope, maintenance permission, emergency state and a quiescent capture/upload boundary. Mutating
modes transaction-lock both the station pointer and its current calibration. Capture arming takes a
shared station lock, so a new session cannot snapshot the pointer across the repair.

Apply appends one new VALID `{x:0,y:0,width:100,height:130}` calibration, derives the centred working
region `{x:5.6,y:5.6,width:88.8,height:118.8}`, repoints only the exact station, and appends one exact
audit event. The old calibration row is never updated or deleted and its complete row digest is
reverified on apply replay and rollback. Rollback is pointer-only, append-audited and permanently
refused once any capture session references the corrected calibration.

## Preserved evidence policy

- Authoritative immutable-master minimum remains exactly **4.0 mm**.
- PREVIEW GREEN remains the derived **5.6 mm** threshold: 4.0 mm plus the existing 1.6 mm uncertainty
  budget.
- No detector, card-size, evidence-admission, FRONT/BACK assignment or production profile rule was
  weakened.

## Regression proof before deployment

| Proof | Result |
| --- | --- |
| Incident-specific unit/security cases | 20/20 PASS |
| Focused Scanner, capture-authority, route and RBAC set | 74/74 PASS |
| Real PostgreSQL 17.10 inspect -> apply -> replay -> rollback | PASS; old row byte-equivalent, two append-only calibration rows, exact pointer/events |
| Protected real PostgreSQL Card Job/grading bridge | 45/45 PASS |
| TypeScript, focused ESLint, production build and Graphify freshness | PASS |
| Docker build-context entrypoint regression | 4/4 PASS; every `scripts/` build entrypoint must be explicitly re-admitted |
| Exact-SHA hostile review before packaging correction | `413f124b60c5f0b916775977e1bef687a1aa9c9c` CLEAR; no actionable BLOCKER/HIGH/MEDIUM |

## Preserved failed STAGING deploy attempt

The authorised safe-deploy attempt for exact candidate
`413f124b60c5f0b916775977e1bef687a1aa9c9c` proved that live STAGING remained at
`ebcab6dba185a029bf0a22c75934eb1357adda11`, that the candidate contained the live commit, and that
the live SHA did not move during preflight. The remote builder then failed before producing or
releasing an image because `.dockerignore` excluded
`scripts/staging/repair-canon-lide400-geometry.ts`. Its automatic retry failed at the same boundary.
No Fly release, machine update, database write or Scanner state change occurred.

The packaging repair re-admits only the exact incident entrypoint while leaving every other
`scripts/staging` tool excluded. The existing Docker-context test now derives every `scripts/`
entrypoint from `script/build.ts` and requires a matching allowlist entry, so this class of local-green
but remote-unbuildable defect fails in CI. The corrected candidate must repeat full postflight,
exact-SHA hostile review and STAGING safe-deploy before the calibration command is invoked.

## Remaining physical acceptance

This issue is code-FIXED, not physically accepted. After exact-SHA clearance and STAGING-only
deployment, the repair must dry-run and apply successfully, the Scanner must re-arm a fresh session
under the new calibration, and the real card must be repositioned to achieve GREEN with the complete
card visible and measured margins at least 5.6 mm. One complete FRONT/BACK Card Job must then prove
DB, R2, orientation/assignment and the single credit reservation transition before the authorised ten
consecutive workflows begin.

## Lesson and proof expiry

A platen transform must be established by a full physical acquisition and an independently bounded
driver crop. Inferring the driver's axis direction from a displayed/rotated preview can select the
opposite end while still producing a syntactically legal rectangle.

Re-open this proof if ImageCaptureCore coordinate semantics, LiDE profile dimensions, the shared
4.0/5.6 mm policy, station/calibration scope, capture-session snapshot/locking, operator-session
authority, database-environment guard or the exact STAGING station/calibration identity changes.

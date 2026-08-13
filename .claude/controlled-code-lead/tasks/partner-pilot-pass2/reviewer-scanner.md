# Reviewer report — scanner product and canonical workstation

**Scope:** Scanner native app, target-bound capture and Partner workstation.
**Authority:** read-only review; received 2026-08-12.

## Evidence

The Scanner app suite was reported passing 35/35 in its source worktree. It is
emulator/unit evidence, not a Canon/R2/PostgreSQL/physical canary.

## Accepted findings

- **PP2-F8 — BLOCKER, B.** The server capture-session endpoint exists but no
  Partner browser surface arms it. Partner intake remains manual upload. Add a
  target-arm step to the canonical Partner workflow that resolves eligible
  approved stations server-side.
- **PP2-F9 — HIGH, B/E.** One-active-target is not enforced per station:
  `server/scanner-capture-service.ts` only has active uniqueness per
  certificate/side and creates an armed session without rejecting an existing
  station target. Add a transactional station-wide active guard and real
  PostgreSQL concurrency proof.
- **PP2-F10 — HIGH, B.** The Scanner returns to idle after accept; there is no
  authoritative paired-completion screen with an explicit `NEXT CARD` gate.
- **PP2-F11 — HIGH, B.** Station admin has no usable pending-request/Reject UI;
  it lacks a client fleet surface and distinct reject action.
- **PP2-F12 — HIGH, B/D.** Unsupported scanner version fails closed but the
  application does not identify the condition as `UPDATE REQUIRED`, and its
  update control runs live git/dependency updates instead of a packaged release
  mechanism.
- **PP2-F13 — commercial-launch blocker / Pilot follow-up.** Application boot
  mutates service-tier pricing. It must be repaired before Partner payments,
  but is not a first-card blocker when the owner uses audited admin-granted
  credits and no prices are changed.

## Clean areas

Signed Keychain station identity, Ed25519 request binding, target-bound
front/back capture, TIFF master preservation and canonical workstation reuse
are present in source. The Partner grading route uses `GradingWorkstation`, not
a second calculator.

## External proof remaining

Fresh-Mac station enrolment, Canon LiDE 400, R2 finalisation, real physical
print and 25/50 capture reliability require owner hardware/operations.

# Governance task / program index

The one place to find current state without grepping the whole repo. Update on every
Stage 0 (new task) and Stage 7 (final report). Programs group multi-phase work.

## Programs

| ID            | Title                      | Status                            | Branch                                   | Baseline   | Latest     | Open High/Crit                                          | Next authorised action                          | Path                      |
| ------------- | -------------------------- | --------------------------------- | ---------------------------------------- | ---------- | ---------- | ------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| vault-quest   | VQ hardening (Phases 1–8A) | staging-substrate; prod unchanged | `main` / `vq-phase8-staging-integration` | `1a2aeac`  | `32f3f2b`  | live-route wiring blocked on deployed 2-machine staging | provision deployed staging, wire routes, verify | `programs/vault-quest/`   |
| partner-pilot | Partner Pilot              | Pass 2 reconciliation in progress | `codex/partner-pilot-pass2`              | `864faded` | `864faded` | Partner runtime 503; Pass 1 not integrated              | verify findings and create reviewed manifest    | `programs/partner-pilot/` |

## Tasks

| ID                                      | Title                                                | Status                                               | Branch                                          | Baseline    | Latest      | Open High/Crit                                                                         | Next authorised action                                              | Path                                             |
| --------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | ----------- | ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| governance-phase-9                      | Governance stabilisation/enforcement/scale           | 9A+9B+9C done (local, unpushed)                      | `governance-phase-9`                            | `6439350`   | (9C commit) | none blocking; restart to fully load ask/deny + non-Bash hook matchers                 | health report + await owner review                                  | `tasks/governance-phase-9/`                      |
| partner-scanner-grading-build           | Partner/scanner/grading current build reconciliation | in progress                                          | `psp/partner-rbac-hybrid`                       | `c782a613e` | local WIP   | MV-PGS-001..003 in progress                                                            | finish build, prove protected MVGS, commit local checkpoint         | `tasks/partner-scanner-grading-build/`           |
| partner-pilot-pass2                     | Partner Pilot Pass 2 reconciliation and integration  | Stage 1/2 in progress                                | `codex/partner-pilot-pass2`                     | `864faded`  | `864faded`  | PP2-F1, PP2-F2                                                                         | verify reviewers; integrate only through reviewed manifest          | `tasks/partner-pilot-pass2/`                     |
| canonical-left-rail-refinement-20260814 | Canonical grading left-rail refinement               | Stage 4 authorised                                   | `codex/canonical-left-rail-refinement-20260814` | `470699f4`  | `470699f4`  | none                                                                                   | capture browser baseline, then implement exactly CLR-01             | `tasks/canonical-left-rail-refinement-20260814/` |
| partner-final-rc-reconciliation         | Terra M-1 reconciliation + FINAL RC freeze           | Stage 7 COMPLETE — FINAL RC frozen, local + unpushed | `codex/partner-pilot-pass2`                     | `e6fd6c5f`  | `e4d3bf5d`  | none in code; RC-F1 stale prod record + RC-F2 RC never pushed are process/record HIGHs | owner decision: push RC + PR, then production migration/deploy plan | `tasks/partner-final-rc-reconciliation/`         |

## Conventions

- Task slug = kebab-case, unique. Program-scoped finding IDs = `<PROG>-P<phase>-F<n>`.
- A task/program is NOT "done"/"closed" until its Definition-of-Proof level is Activated
  (or explicitly owner-accepted as design/substrate). A landed substrate ≠ closed.

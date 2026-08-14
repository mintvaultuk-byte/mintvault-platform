# Definition of Proof — Canonical grading live absorb

## Statuses

| Dimension | Status |
|---|---|
| **Design Status** | reviewed candidate with owner-specified absorb procedure |
| **Implementation Status** | local merge resolved; not yet committed/pushed |
| **Verification Status** | integration-tested locally |
| **Activation Status** | not wired/deployed |

## Evidence

- **What was run:** `npm run check`; `npm run lint` (0 errors; 2,590 pre-existing warnings); `npm run build`; migration SQL lint; 25 focused workstation/authority/scanner/Partner/migration/MVGS files; real PostgreSQL review/CAS files; complete suite against the sanctioned loopback CI database.
- **Observed result:** typecheck and build passed; focused suite `425 passed / 61 skipped`; real review/CAS `18 passed`; full suite `280 files passed / 29 skipped`, `4,554 passed / 771 skipped`. The initial parallel whole-suite run failed only because explicit test-DB suites lacked their URL and disposable clusters collided; the serial sanctioned-DB rerun is the authoritative result.
- **Negative proof:** a temporary second direct `<GradingPanel>` mount failed the architecture guard (3 failures), then passed after exact restoration (47 passed). A temporary MVGS `edgeAffectedPct` change from 10 to 11 failed the scoring assertion, then passed after exact restoration (124 passed). No protected scoring source remains changed.
- **Browser proof:** dev-only fixture harness measured every role at 1280×800 and 1024×768: rail 40%, right pane 60%, preview cap 280px. Back/150%/pan state persisted into Grade; unsaved Review remained gated.
- **Where evidence lives:** this task directory plus command output in the controlled run.

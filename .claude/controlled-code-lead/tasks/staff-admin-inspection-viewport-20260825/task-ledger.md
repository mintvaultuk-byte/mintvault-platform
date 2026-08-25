# Task ledger — Staff Admin grading inspection viewport

## Stage 0 — Baseline (recorded 2026-08-25T04:36:10Z)

- Repository: `/Users/cornelius/mintvault-platform`
- Worktree: `/private/tmp/mintvault-staff-admin-inspection-viewport-20260825`
- Branch: `codex/staff-admin-inspection-viewport-20260825`
- Commit: `01d5e4daab30d58ad53943585ebecc972befaa8a`
- `git status`: clean; ignored `node_modules` reuses the existing dependency tree.
- Production commit: `01d5e4da` via two live `/api/version` reads; uniquely resolves to the full baseline SHA above.
- `origin/main`: freshly fetched and byte-identical to the full production baseline SHA.
- Baseline proof: 13 focused viewer/Card Tool/MVGS files, 330/330 assertions passed.
- Engineering preflight: `CRITICAL`, required mode `HOSTILE`; code-only graph current at 13,935 nodes / 31,385 edges.
- Governance version: 1.2; snapshot recorded in `governance-snapshot.json`.
- Protected systems in play: grading workstation presentation and image-relative annotations. Protected MVGS v1.4 semantics remain frozen.
- Explicit scope: responsive parent geometry; main authoritative card FIT sizing; shared FIT-relative inspection zoom/pan; overlay anchoring; local/browser regressions across grading roles.
- Explicit prohibited actions: grading semantics, Card Tool/Manual Crop math, crop/server evidence provenance, schemas/data/migrations, auth, payments, certificates, claims, NFC, dependencies, push, staging mutation, production deployment.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-25 | production/origin identity and clean isolated tree proven |
| 1 — Review plan | done | 2026-08-25 | owner-routed independent Fable review plus Lead independent code investigation; no Codex subagent authorised |
| 2 — Investigation | done | 2026-08-25 | graph-first/source-verified root causes SIV-001..003 |
| 3 — Lead verification | done | 2026-08-25 | coordinate/data/blast-radius contracts re-read at production baseline |
| 4 — Implementation authorisation | done | 2026-08-25 | owner attachment explicitly authorises the locked presentation scope |
| 5 — Implementation | done | 2026-08-25 | bounded presentation-only viewport, stable shell and regression replacements complete |
| 6 — Regression | partial / release-held | 2026-08-25 | exact local automated gates green; real Chrome and final hostile review blocked/pending |
| 7 — Final report | pending local freeze | 2026-08-25 | report must state staging unsafe and stop before deployment |

## Reviewer status

- No Codex subagent was spawned; current orchestration rules do not authorise delegation.
- The owner independently commissioned Fable review and converted the compared findings into the attached locked implementation decisions.
- Required `HOSTILE` release review remains a Stage 6 gate against the final diff.

## Stage 6 evidence

- `npm run check`: pass.
- `npm run lint`: pass, 0 errors / 2,749 repository warnings.
- `npm run build`: pass; Vite transformed 3,355 modules and server/one-off bundles built.
- Exact final focused/protected matrix: 30 files / 696 assertions passed.
- Near-final broad disposable-DB run: 429 files / 6,860 tests passed / 6 skipped.
- Final broad retry was stopped after the repository's documented monolithic
  Partner `process.env` collision produced skips and two Partner migration
  failures; it is not represented as source-green or as an in-scope viewer
  failure. The final viewer delta has direct mounted regression coverage.
- Graphify code graph refreshed: 13,955 nodes / 31,399 edges; its existing
  parser limitation still flags JSX text containing `&` in `grading-panel.tsx`,
  while TypeScript and production build parse the source successfully.
- Browser control diagnostics: Chrome running, extension ID
  `hehggadaopoacecdllhhajmbjkdcmajg` absent from all inspected profiles; no
  real-browser matrix or screenshot claimed.
- No migration, schema change, defect rewrite, evidence-authority change or
  protected grading-file change.

## Next authorised action

Freeze the local candidate, run the governance postflight, then report and stop.
Browser acceptance requires the owner to install/enable the Chrome control
extension; push, staging mutation, migration and deployment remain unauthorised.

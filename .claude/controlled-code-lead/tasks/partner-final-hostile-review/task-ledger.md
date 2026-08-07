# Task ledger — partner-final-hostile-review

| Field | Value |
|---|---|
| Task ID | `partner-final-hostile-review` |
| Purpose | Final hostile engineering assurance pass before owner-gated staging deploy of PR #288 |
| Repository | `mintvault-platform` |
| Worktree | `/Users/cornelius/mintvault-partner-final-hostile-review` (isolated, created this task) |
| Branch | `opus/partner-final-hostile-review` |
| Baseline SHA | `2ee13763889f6cd3cc2b243de38b4bad81d2baab` |
| PR #288 baseline | `f6b840fe` |
| Governance version | 1.1 |

## Explicit scope

Permitted: read, analyse, run local tests, create LOCAL commits on this branch, spawn read-only reviewers.

Prohibited by owner instruction (restated): no deploy, no merge, no push, no application of
migration 0045 to staging, no production touch, no MVGS scoring change, no weakening of any
existing guard, no new product features, no architecture redesign.

Protected-file rule for this task: **`server/grader.ts` must not be edited.** Any required change
there is returned to the owner as a proposal.

## Stage 0 — freeze (COMPLETE)

- Worktree created fresh from `2ee13763`; `git status --porcelain` empty at creation and after
  every reproduction step (all reproduction scripts were transient and removed).
- `node_modules` provided as a symlink to the primary checkout (gitignored; worktree stays clean).
- Protected MVGS files verified **byte-identical to `origin/main`** (`git hash-object` vs
  `git rev-parse origin/main:<path>`):

| File | Blob SHA | vs origin/main |
|---|---|---|
| `shared/mvgs-scoring.ts` | `ee97bf1bf4b1ff92f3a82a5268e27c25e7155f84` | SAME |
| `shared/centering.ts` | `005170b07d238069584f4859eebac2e6d5c9e00c` | SAME |
| `shared/pristine.ts` | `051710bc820eadf00e49a7e41a429b59f1e52b41` | SAME |
| `shared/mvgs-input-builder.ts` | `71e1a31f7b14bb27d5a2859a33b621ab8d733cad` | SAME |
| `server/mvgs-scoring.ts` | `54ce79e4661fa49cdd7149cc967849ce3249caaa` | SAME |
| `server/grader.ts` | `f52744288c90768f28803ff9a4eea6aedc692717` | SAME |
| `server/lib/cert-pristine.ts` | `0ba60906730bbc4dde8bd6d909c68d739c32aca4` | SAME |
| `server/grading-prompt.ts` | `795f9078e782e32224393c5f6c5dbb9ca5936d50` | SAME |

- `shared/schema.ts` also byte-identical to `origin/main`
  (`3b2fd0b9dbc3a7ffc4b8d56622e8e9299a87315f`). This matters: it establishes that D-1's root
  cause is **pre-existing on `main`**, not introduced by PR #288.
- Migration `0045_partner_grading_work_items.sql` is present in the branch and **not applied**
  anywhere by this task. No database other than disposable local PostgreSQL clusters was contacted.
- Staging and production: **not contacted at all** by this task.

## Stage 1 — review plan (COMPLETE)

Ten read-only reviewers, non-overlapping scopes, per owner instruction. See
`reviewer-status.md`.

## Stage 2/3 — see `issue-register.md` and `D1-REPRODUCTION.md`.

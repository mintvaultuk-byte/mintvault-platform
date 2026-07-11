# Protected systems — MintVault (live reference)

Seeded from `.claude/skills/controlled-code-lead/templates/protected-systems.md`
on 2026-07-11. This is the live, shared copy every Stage 0 baseline checks —
update it in place when a new protected system is identified; don't fork
another copy.

Systems that require heightened caution (explicit approval, extra
verification, or an owner-approval gate per [[mvgs-grading-protected]]/CLAUDE.md)
before any change lands.

| System | Files/area | Why protected | Gate |
|---|---|---|---|
| MVGS grading logic | `client/src/components/grading/`, `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`, `shared/mvgs-input-builder.ts`, `server/grader.ts`, `server/routes/grader.ts`, `server/grading-prompt.ts`, `server/mvgs-scoring.ts`, `server/lib/cert-pristine.ts`, `server/labels.ts`, `server/certificate-document.ts` | Core business logic; owner has stated it works and must not change without explicit per-change approval | [[mvgs-grading-protected]] — stop before Stage 1 |
| Stripe payments | `server/stripeClient.ts`, `/api/stripe/webhook`, checkout/PaymentIntent flow | Revenue; webhook must stay registered before `express.json()` | CLAUDE.md golden rule 6 — full explanation required |
| Admin/staff auth | `server/routes.ts` admin/staff login+PIN, `mv.sid` session cookie | Only the owner should have admin access; session cookie shared with staff/grader (see [[project_session_cookie_clobber]]) | CLAUDE.md golden rule 3 |
| R2 image storage | `server/r2.ts`, presigned URL signing | Customer photos must never become long-term public | CLAUDE.md golden rule; never change URL signing logic |
| cert_counter / certificate_number | `cert_counter` table, `normalizeCertId()` | Desync causes a 500 on next cert allocation | [[mintvault-db-migration-discipline]] Check 4 |
| Vault Quest DB | `shared/vq-schema.ts`, `drizzle-vq.config.ts` | Separate config on purpose so a whole-DB diff can't propose changes to grading tables | Always push with `--config drizzle-vq.config.ts`, staging first; never plain `drizzle-kit push` |
| Environment/secrets | `ADMIN_PASSWORD`, `ADMIN_PIN`, `SESSION_SECRET`, `SIGNED_URL_SECRET`, R2/Resend/Stripe keys | CLAUDE.md golden rule 3 | Never change without confirming first |
| Production database | Neon host `ep-wispy-morning-ab6f4o08` | Live customer data | Confirm host before any mutation; see [[project_db_branches]] |

## How to update this list
When a task uncovers a new protected system (a subsystem where a "helpful"
change would silently corrupt data or break trust), add a row here as part
of that task's Stage 7 report, not as an afterthought later.

# Issue register — Partner Pilot auth and onboarding

| ID | Severity | Evidence | Resolution | Proof |
|---|---|---|---|---|
| AO-1 | HIGH | Readiness reported `READY TO LOG IN` without the login flag, MFA completion, or an eligible location. | Server-owned lifecycle states and condition facts; admin rendering uses the state. | Real PostgreSQL/HTTP onboarding matrix. |
| AO-2 | HIGH | Admin Users lacked password-reset and MFA-reset controls despite secure service endpoints. | Reason-confirmed, audited controls; reset delivery status is shown truthfully. | UI/static checks and HTTP matrix. |
| AO-3 | HIGH | `/api/super-admin/partner-management` used `requireAdmin`, permitting the grader-proxy bypass. | Router-wide `requireSuperAdmin`. | Capability authorization suite. |
| AO-4 | HIGH | Initial readiness eligibility treated only Owners as organisation-wide, unlike runtime sessions. | Readiness matches the runtime Owner/Manager/Finance org-wide role set. | Real PostgreSQL Manager login + `/me` matrix. |
| AO-5 | HIGH | Multiple current reset links could remain usable. | One-live-token index plus serialized issue/consume transactions. | Real PostgreSQL older-link rejection. |
| AO-6 | HIGH | Passwords above bcrypt's 72 UTF-8-byte input boundary were accepted. | Shared server-side byte policy on invite and reset. | Real PostgreSQL 73-byte rejection. |
| AO-7 | HIGH | Legacy password hashes could not be distinguished from partner-owned credentials. | Additive `password_set_at`; only a fresh reset/invite establishes credential provenance. | Migration + reset/login matrix. |
| AO-8 | HIGH | `/api/partner/me` had no authenticated source route. | Stable `/me` alias over MFA-safe identity handler. | Real PostgreSQL authenticated response and MFA-pending non-disclosure proof. |

No open in-scope BLOCKER/HIGH remains in the local release candidate.

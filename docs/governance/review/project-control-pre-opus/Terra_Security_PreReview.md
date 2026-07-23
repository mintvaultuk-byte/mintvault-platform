# Internal security pre-review (requested Terra label)

Executed on the Codex GPT-5 surface; independent Opus security review remains pending.

Server authorization is the control: every PCD endpoint is under `requireSuperAdmin`; client navigation is not treated as a security boundary. Direct API tests prove 401 for unauthenticated/expired/revoked sessions, 403 for normal or malformed authority and disabled flag, and 200 only for an enabled actual Super Admin. The env flag accepts exactly `"true"`; missing, false and malformed values deny. A missing runtime override leaves the explicitly enabled environment flag effective; a false database override disables and a DB error denies. The override is restrictive, not a way to bypass Super Admin authorization.

Scanner safeguards include fixed inputs, no shell, command timeout, bounded response/payload depth, redaction of sensitive keys and query credentials, relative source locators, and generic route failures. No PCD endpoint can deploy, modify Git, enable a flag, mutate an application database, or run a migration. Focused authorization, flag, governance, route and migration tests pass.

`npm audit` finished with 0 critical and 0 high findings. The direct runtime `sharp` high advisory was fixed by upgrading to 0.35.3 and correcting only its three affected type annotations. Remaining low findings are documented in the dependency triage.

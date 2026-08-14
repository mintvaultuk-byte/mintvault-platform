# Scanner invariant register

Every implementation and test maps to these invariants. Server means MintVault
Partner authority; Mac means the packaged Scanner application and signed helpers.

| ID | Invariant |
|---|---|
| INV-01 | Tenant, location, station and human are distinct identities; no field substitutes for another. |
| INV-02 | Every privileged physical mutation requires a current authenticated human and current ACTIVE approved station at the server. |
| INV-03 | Renderer is sandboxed with `contextIsolation=true`, `nodeIntegration=false` and has no token/key/filesystem/network/business authority. |
| INV-04 | Main coordinates only; server owns Partner/location/station status, RBAC, credits, Card Jobs, NEW/FIX, evidence acceptance, profile authority, minimum version and rollback policy. |
| INV-05 | Only bundled signed arm64 helpers execute; helper signature, bundle identity and Team ID are checked before spawn; runtime compiler/source is absent from the installed app. |
| INV-06 | Ed25519 station key is generated/wrapped/signed inside the identity helper; at rest only SE-bound ciphertext/locator metadata exists, stored device-only/non-sync. |
| INV-07 | Copying app, preferences, Application Support, Time Machine/Migration Assistant or a disk clone to another Mac grants no station authority. |
| INV-08 | Same Mac + intact Secure Enclave/Keychain recovers the same identity; lookup failure never silently creates a second station. |
| INV-09 | Sequence protects replay only; semantic operation ID controls business idempotency and is persisted before first I/O. |
| INV-10 | Operation ID binds endpoint/type, actor, station, tenant, location, canonical payload fingerprint and original result; changed scope/payload is a conflict. |
| INV-11 | Replay/stale requests are rejected and audited, never auto-suspend; desync uses a bootstrap-independent one-time signed challenge and new epoch. |
| INV-12 | Scanner refresh is station-bound; a copied session cannot refresh elsewhere; shift change logs out the human immediately without reattributing queued evidence. |
| INV-13 | Enrolment state is fail-closed and audited; rejected/cancelled/expired credentials retire and a new tenant always gets a fresh key. |
| INV-14 | Setup preview creates no job, credit, MV, upload or evidence and cannot become authoritative. |
| INV-15 | Every authoritative capture uses an immutable server-approved capture profile revision and locked Canon LiDE 400 1200-DPI RGB lossless TIFF settings. |
| INV-16 | NEW atomically reserves exactly one credit and creates exactly one Card Job; retry/restart returns the original result. |
| INV-17 | CANCEL before first accepted side releases the reservation exactly once; after evidence it is rejected. |
| INV-18 | FIX is server-derived, consumes zero ordinary credit even at zero balance, preserves Card Job/MV/lineage and adds immutable evidence revisions only for authorised sides. |
| INV-19 | Before each physical side scan, server mints an immutable, expiring, server-time capture authorisation bound to tenant/location/station/original operator/role/job/side/revision/profile/purpose. |
| INV-20 | Mac clock cannot extend capture authority; finalisation proves exact authorisation, digest, size, MIME and provenance binding. |
| INV-21 | Plain TIFF is app-private and short-lived: validate/hash, encrypt into durable queue before network ambiguity, then unlink; startup sweeps abandoned plaintext into encryption/quarantine. |
| INV-22 | Queue artifacts use authenticated encryption under a device-bound SE-wrapped key; metadata tampering or key loss fails closed to quarantine. |
| INV-23 | Queue stores no durable upload URL; every attempt obtains a fresh short-lived grant and server disposition controls resolution. |
| INV-24 | Unresolved evidence is never timer-deleted; corrupt/unmatched evidence is quarantined; disk pressure blocks NEW capture. |
| INV-25 | Already-authorised delivery may retry without a human only while station/authorisation remain valid; every new physical capture requires current human + station. |
| INV-26 | Evidence keeps the original operator across logout/shift change/retry; historical accepted evidence is immutable. |
| INV-27 | Replacement atomically revokes old + activates new; no failure state leaves dual-active stations and no queue/grant/key is inherited. |
| INV-28 | Replacement preserves central jobs/credits/MV/accepted evidence; missing sides use canonical recovery/FIX with no second ordinary credit. |
| INV-29 | Same-tenant location transfer needs Super Admin approval and clean unresolved-capture state; cross-tenant move is revoke + fresh enrolment; history never changes. |
| INV-30 | Update/install trusts signed/notarised/stapled artifacts and pinned policy; a static feed cannot authorise downgrade. |
| INV-31 | `UPDATE_REQUIRED` blocks new physical operations but preserves identity/queue/central state and offers update/reinstall recovery. |
| INV-32 | Package contains no source, Git/npm/Node installer, runtime compiler, env secrets, API keys or DB URLs and installs at `/Applications/MintVault Scanner.app`. |
| INV-33 | Logs and renderer IPC exclude secrets, grants, tokens, keys and sensitive image paths. |
| INV-34 | Protected MVGS maths/weights/thresholds/brackets/centering/pristine/Black Label semantics remain byte/behavior stable unless separately owner-authorised. |
| INV-35 | WP13 legacy authority/canonical-process cutover and every staging/production mutation require explicit owner authorisation. |

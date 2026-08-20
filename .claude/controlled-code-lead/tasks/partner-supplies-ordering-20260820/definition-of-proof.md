# Definition of proof — Partner supplies ordering

The local proof bar is met only when all are measured:

- server owns product codes/labels, quantity validation, tenant/user/location/contact/address snapshot, status and operations inbox;
- duplicate replay returns one order, altered intent under the same tenant key conflicts, and the same key in another tenant does not collide;
- tenant A cannot read, write, update, transition or reference tenant B data, including direct database pivot attempts;
- an order survives Resend unavailable/uncertain outcomes; retry/restart reuses its provider key and does not create a second order; stale delivery uncertainty remains visibly reconciliation-required and is never resent outside the conservative provider-key window;
- status state machine permits only owner-approved transitions and writes append-only event/audit evidence;
- neither automatic nor manual notification work can send once the canonical order is no longer `RECEIVED`;
- Partner has no status-mutation path; ordinary Admin is refused; Super Admin transitions are server-attributed;
- account/location/profile changes do not rewrite stored order snapshots;
- the five primary Partner navigation items remain exact; Supplies/My Orders appear only in responsive More; every new CTA resolves;
- staging uses the exact guarded candidate SHA, migration and release; browser acceptance measures the requested three-product order and status projection.

No unit, integration or source test alone is staging E2E proof.

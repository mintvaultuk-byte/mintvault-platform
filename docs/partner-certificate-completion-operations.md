# Partner certificate, label and NFC completion operations

## Scope

Partner users need a usable, tenant-scoped view of their completed certificates and a safe way to
carry out the ordinary post-approval fulfilment steps. This surface deliberately reuses the
existing certificate, label-PDF, print-ledger and NFC state machines; it is not a second grading,
certificate or print implementation.

The Partner portal now provides `/partner/certificates` with search and filters for the safe
certificate summary: certificate number, card, grade, approval, origin location, print state,
NFC state and completion state. It never serialises private notes, evidence paths, customer data,
wallet data or an NFC UID.

Authorised users can prepare the complete immutable-origin certificate set for a submitted item,
open the short-lived generated PDF URL, explicitly confirm physical printing, then record, verify
and lock an NFC tag. Once every certificate in that server-derived set is printed and NFC-locked,
they can record the final slab/seal completion without routine HQ intervention. The server derives
certificate membership and all authority; the browser does not supply grades, batch membership,
object keys or lifecycle state.

## Security and lifecycle rules

- Immutable `origin_partner_id` and `origin_location_id` are the ownership source of truth.
- Cross-tenant certificates return not-found. Location-scoped users fail closed outside their
  selected location.
- A Partner batch is created and confirmed under the distinct `partner_print` actor role, so the
  append-only ledger does not misattribute shop work to MintVault HQ.
- An existing batch is reused only if every certificate has the same immutable Partner origin and,
  for a location-scoped user, the exact same location. The comparison is null-safe.
- Approval, printable-grade and settlement checks occur before label preparation. NFC cannot be
  recorded before an explicit printed confirmation; tag replacement and clearing are refused.
- UID values remain server-side and are redacted from the register and audit output. NFC mutations
  write durable Partner audit events.
- Partner completion is all-or-nothing across the derived submission set, and its actual writes
  repeat the immutable tenant/location fence. The established completion cascade retains its
  paid-per-unit settlement gate and append-only `print_events` audit trail.

## Local proof

`tests/partner-grading-http-routes.test.ts` runs the mounted production Partner routes against a
fresh PostgreSQL 17 cluster and disposable MinIO. It proves a signed PDF can be fetched from
MinIO, rejects cross-tenant print/completion attempts, rejects premature/duplicate/wrong NFC
operations, refuses a partially NFC-locked submission without partial completion, then proves the
real paid-per-unit completion cascade and ledger attribution. It also rejects a deliberately
malformed mixed-location batch without changing either certificate.

The local browser proof exercises the new guarded portal route with deterministic local-only
Partner credentials. Browser-side NFC hardware access is intentionally not claimed: the portal
uses reader/writer-provided UID values, while physical reader/writer qualification remains an
external hardware gate.

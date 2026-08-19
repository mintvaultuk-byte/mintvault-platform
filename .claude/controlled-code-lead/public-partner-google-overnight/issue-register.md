# Issue register — Public Partner Network + Google Partner Presence

| ID | Summary | Source | Severity | Class | Lead-verified | Planned resolution | Status |
|---|---|---|---|---|---|---|---|
| PPN-001 | No explicit public publication authority | A/B/C | BLOCKER | B | yes | Existing exact per-location opt-in flag plus independent global kill switch; absent/error fail closed | PROVEN |
| PPN-002 | No human slug | A/B/C | BLOCKER | B | yes | Use existing globally unique, immutable, non-internal `partner_locations.public_ref` at `/partners/location/:publicRef`; human slug deferred | PROVEN |
| PPN-003 | Admin Partner DTOs contain private/internal data | A/B | HIGH | B | yes | Separate explicit SQL and response allowlist | PROVEN |
| PPN-004 | Existing flag writer accepts cross-tenant location ID | A | HIGH | B | yes | Require active location ownership before scoped flag write | PROVEN |
| PPN-005 | Stored websites are not server-safe for public links | B | HIGH | B | yes | Strict public projection URL sanitizer; omit invalid | PROVEN |
| PPN-006 | Client-only routes become 404/noindex and sitemap is static | A/C | HIGH | B | yes | DB-aware dynamic SSR metadata/404 and sitemap entries | PROVEN |
| PPN-007 | Global customer navigation lacks discovery entry | C | HIGH | A | yes | Add Find a Partner links; preserve application funnel | PROVEN |
| PPN-008 | Indexed near-me copy contradicts local Partner discovery | C | HIGH | B | yes | Truthful flag-aware copy and structured-data parity | PROVEN |
| PPN-009 | Partner public-profile surface is a placeholder | A/C | HIGH | A | yes | Real readiness/visibility surface using canonical location/flag APIs | PROVEN |
| PPN-010 | Revoked public data could remain in an infinite client cache | C | HIGH | A | yes | Revalidate flag/list/profile on remount, focus and bounded interval; hide stale rows on refetch error | PROVEN |
| PPN-011 | Admin/Partner could report Live without an approved display name | C | HIGH | B | yes | Shared server readiness, blocking reasons and fail-closed publication writer | PROVEN |
| PPN-012 | Search Enter key did not submit in controlled browser | lead browser | MEDIUM | A | yes | Explicit Enter handling on the labelled search input | PROVEN |
| GBP-001 | No Google identity/credential/cache authority | A/B | BLOCKER | E/F | yes | Explicit additive migration with separate identity, snapshot, credential/state authorities | PROVEN locally; application deferred |
| GBP-002 | No secure OAuth state/PKCE/replay boundary | B | BLOCKER | F | yes | One-use hashed state, PKCE S256, session/actor/tenant/location binding and atomic consume | PROVEN |
| GBP-003 | No duplicate/cross-tenant binding constraints | B | BLOCKER | E | yes | Composite tenant/location FK and unique current Google resource/place bindings | PROVEN |
| GBP-004 | Partner audit redaction insufficient for provider payloads | B | HIGH | B/F | yes | Recursive redaction and safe allowlisted provider errors/audits | PROVEN |
| GBP-005 | Optional Google failure could be coupled to portal gates | B | HIGH | F | yes | Google-local positive env/schema/flag gate only | PROVEN |
| GBP-007 | OAuth callback could mutate after freeze/stale step-up | D | HIGH | F | yes | Callback mutation guard plus exact target-location checks before state/provider/persistence | PROVEN |
| GBP-008 | Non-owner status could expose unbound Google candidates | B | HIGH | F | yes | Structurally skip candidate query/projection for non-owners | PROVEN |
| GBP-006 | Live external prerequisites absent | production evidence | BLOCKER external | F | yes | Disabled/unavailable UX; no fabricated live completion | EXTERNAL_BLOCKER |

## Rejected findings

- “A new publication column and slug migration are mandatory” — rejected for minimal v1. `partner_locations.public_ref` is already a stable public identifier, and the canonical scoped flag table can hold an exact location opt-in without global fallback. Human slugs/per-field consent remain future schema enhancements.

## Deferred findings

- Google migration application, secrets, real OAuth callback and pilot — require explicit owner approval plus Google Cloud/GBP prerequisites.
- Human-readable slug/redirect history, opening hours, services, coordinates, reviews and ratings — no current authority; deliberately omitted.

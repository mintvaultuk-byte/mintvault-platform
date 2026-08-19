# Google Partner Presence v1 — handoff

## Current working v1

- Partner identity is the existing `partner_organisations.id` UUID.
- Location identity is the existing tenant-scoped `partner_locations.id` UUID.
- The canonical location service persists the existing formatted single-string `address` value.
- Partner Workspace Locations renders an accessible, encoded external Google Maps address-search link only when an address exists.

## Future target

Build a separate Google Business Profile connection programme in which a Partner authorises MintVault to link, not own, its existing listing. Its bounded contract should record the Partner UUID and location UUID alongside the authorised Google Business Profile account/location identifiers, Google Place ID, exact listing URL, connection and verification status, display name, business phone, website, opening hours, and permitted business photos.

That later programme may use the exact business-listing URL for Maps navigation and, subsequently, a public Find a MintVault Partner directory/map. It must not rename, keyword-stuff, or otherwise take ownership of the Partner's Google listing.

## Locked boundary

No Google OAuth, Google API credential, Places SDK, geocoding service, schema field, or public directory/map is introduced by Partner Network v1.

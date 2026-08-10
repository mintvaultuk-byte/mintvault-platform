# Change manifest — mintvault-public-shop-map

| Area                           | Change                                                                                                             | Classification | Recovery                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------- |
| Public map component           | Render coordinate-bearing public shops as accessible, selectable pins; retain coordinate-less list entries.        | D              | Revert the component and its two callers. |
| Shop finder                    | Pair the existing result list with the new map and add outbound Google Maps/direction choices to selected results. | D              | Revert finder-only wiring.                |
| Shop profile                   | Show one approved-coordinate map panel with distinct Google Maps and directions links.                             | D              | Revert profile-only wiring.               |
| Focused UI tests/docs/register | Pin no-coordinate, selection, link, and responsive proof expectations.                                             | A/D            | Revert with the client surface.           |

No API, database, RLS, public projection, Super Admin coordinate writer, geocoding provider, live
credential, customer location, payment, or auth code is changed.

# GB-06 Authority MVP

The existing `/population` surface is the authority MVP; no new doorway or mass-generated route was created.

- Source: active MintVault certificates with an approved numeric grade.
- Global publication threshold: 20 approved certificates.
- Card-group threshold: 5 approved certificates; smaller groups are absent, not rounded or shown as zero.
- Output: bounded 200-group response, 60-second public cache, 300-second stale allowance, 60 requests/minute/IP and at most 100 in-memory filter keys per machine.
- Search: stable self-canonical `/population`, existing sitemap entry and server-injected Dataset JSON-LD in the initial HTML.
- Privacy: no customer, email, address, Partner, draft, unpublished grade or grading-evidence data.
- Data quality: `INSUFFICIENT_DATA` is explicit when the global threshold is not met.

Search Console remains a separate `NOT_CONNECTED` provider; no SERP scraping or fabricated visibility metric substitutes for it.

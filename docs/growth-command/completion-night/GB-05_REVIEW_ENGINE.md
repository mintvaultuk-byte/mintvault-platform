# GB-05 Neutral Review Engine

Eligibility is exactly one paid, non-deleted submission with a verified payment intent/timestamp/currency whose return is shipped, operationally completed and then carrier-confirmed through `delivered_at`. Grade, sentiment, marketing consent and customer response are never inputs.

Migration `0101` adds one request per submission, append-only delivery attempts, per-submission suppression and privacy-minimised conversion events. Review rows never copy email/name/address data; the worker joins the canonical submission only at send time. Delivery confirmation queues the request atomically after a 72-hour delay. Clearing an incorrect confirmation cancels an unsent request. Resend uses the deterministic `growth-review-<id>-v1` idempotency key and at most three bounded attempts.

Sending is `NOT_CONFIGURED` unless all of these server-only values are valid:

- `REVIEW_DESTINATION_URL` — owner-approved HTTPS destination;
- `REVIEW_DESTINATION_ALLOWED_HOSTS` — exact comma-separated hostname allowlist;
- `REVIEW_TOKEN_SECRET` — independent high-entropy secret of at least 32 bytes;
- `APP_URL` — explicit canonical HTTPS origin used for signed capability links (no fallback is allowed);
- existing `RESEND_API_KEY` and `RESEND_DOMAIN_VERIFIED=true`.

The email is neutral, contains no incentive, welcomes positive/neutral/critical feedback, provides an explicit confirmation page for suppression, and records only provider acceptance plus signed-link requests. Link requests may include email security scanners and are never labelled as a human review. Public rating/review counts remain `NOT_CONNECTED` until an approved provider API exists.

No historical delivery is auto-backfilled by the migration. That avoids releasing a backlog of unsolicited requests when configuration is first enabled; any bounded historical backfill requires a separately reviewed owner decision.

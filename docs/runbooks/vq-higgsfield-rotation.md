# Runbook — Vault Quest / Higgsfield token rotation (P6-R3-01)

> **Owner:** the founder (only holder of the Higgsfield login).
> **Scope:** Vault Quest AI artwork generation only. Grading / certificates /
> payments are never affected — VQ fails open at boot and fails closed only for
> the generation feature.

## Why this exists (root cause)

`HIGGSFIELD_API_KEY` holds a **short-lived OAuth _access_ token** (prefix `oat_`)
minted by hand with the `higgsfield auth token` CLI. It is **designed to expire**
(hours–days). The server has **no refresh token and no refresh flow** — it cannot
self-renew. So every expiry needs a human to re-mint the token and update the Fly
secret. This is architectural, not a bug in the app's token handling.

A proper long-lived credential **does exist** (Higgsfield's official Cloud API at
`platform.higgsfield.ai` uses a long-lived `Key KEY_ID:KEY_SECRET`) — but adopting
it is a rewrite of `server/vault-quest/ai/higgsfield.ts` (different endpoints /
model ids / request shape, and it is unconfirmed whether it exposes `nano_banana` +
`image_references`). That migration is a separate ticket. Until then, use this
manual rotation.

## Cadence

- **Proactively re-mint on a fixed calendar** — weekly is a safe default for a
  short-lived `oat_` token.
- **Immediately** whenever the admin Studio shows Higgsfield status
  `authentication_invalid_or_expired`, or a `401` appears in logs.
- **Never** fire a paid generation "to test" a suspect token — check status first
  (status uses a zero-cost account read / the last observed outcome, no credits).

## Rotate (steps)

1. **Confirm target.** Note which Fly app / prod you are pointing at and the current
   live commit (`fly status`, `/api/version`) so you can prove the restart took.
2. **Mint a fresh token** on your machine:
   ```
   higgsfield auth token
   ```
   If the CLI session itself has expired, run `higgsfield auth login` first (opens
   a browser device-flow). **Do not paste the token into chat, a log, or a commit.**
   It has an `oat_` prefix.
3. **Set the Fly secret** (this triggers a rolling restart across both machines, so
   the new token propagates automatically — the app reads it fresh per call):
   ```
   fly secrets set HIGGSFIELD_API_KEY=<oat_…> -a <app>
   ```
   Leave `HIGGSFIELD_WORKSPACE_ID` untouched — the workspace id is stable across
   token rotations.
4. **Wait for the rolling restart** to finish: `fly status -a <app>` shows all
   machines updated.

## Verify (do not trust the restart — verify the artifact)

5. In the admin Studio AI panel, Higgsfield status should read **connected** (this
   uses a zero-cost account read / cached last-outcome — no credits spent). If it
   still reads `authentication_invalid_or_expired`, the secret did not propagate —
   re-check the app name and machine list.
6. Optional zero-cost confirmation: the "Test connection" button (an account read),
   **not** a generation.

## Rollback

7. If the new token is bad and the old one has not yet expired:
   ```
   fly secrets set HIGGSFIELD_API_KEY=<previous oat_…> -a <app>
   ```
   to restore, then re-mint. Keep the previous token value only until the new one
   verifies, then discard it.

## "Do not generate" safe state

While status is `not_configured` / `authentication_invalid_or_expired` /
`provider_unavailable`, the admin UI shows the non-green state and the generate
buttons surface the reason instead of firing a paid create that will 401. Grading
is unaffected throughout.

## Application behaviour (implemented / designed)

- **Implemented (pure, Phase 7C):** `classifyHiggsfieldStatus` (401/403→auth,
  402→credits, 429→rate, 5xx→unavailable) and `deriveHiggsfieldStatus`
  (`not_configured` / `configured_but_unverified` / `connected` /
  `authentication_invalid_or_expired` / `provider_unavailable`) —
  `server/vault-quest/ai/provider-status.ts`. `connected` is **only** claimed after
  a real successful outcome, never from "the env var is set".
- **Deferred (Category A/B — staging-verifiable, designed in the Phase 7 report):**
  wire `HiggsfieldError { kind }` into the create/poll throw sites and
  `resolveWorkspaceId`; record a module-level `lastOutcome` on each provider call;
  switch `artworkErrorResponse` and `imageProviders()`/`artwork-cost` from
  regex/env-presence to the typed status (fixes the current
  "shows connected for an expired token" bug); render the 5-state enum + a
  zero-cost "Test connection" button in the admin panel.

## Longer-term fix (separate ticket, Category F/D)

Migrate to the official Higgsfield Cloud API long-lived `Key KEY_ID:KEY_SECRET`
(`platform.higgsfield.ai`), which eliminates rotation entirely. Confirm first that
the Cloud API exposes the models + `image_references` identity-lock the pipeline
depends on, then rewrite `higgsfield.ts` against the official SDK. This ends the
recurring-expiry class of incident.

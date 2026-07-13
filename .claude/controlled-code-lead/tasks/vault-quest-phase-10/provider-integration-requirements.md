# Cloud/Legacy provider integration — mandatory requirements (tracked, not yet implemented)

Recorded 2026-07-13 per owner approval of the `fix/vq-higgsfield-cloud-key` concurrent-
branch reconciliation review. These bind the LATER integration task (when
`fix/vq-higgsfield-cloud-key`'s dual-provider work is eventually merged/ported into a
Phase 10A(+) branch) — not the current 10A-6/7/8 work, which does not touch the provider
layer. Do not action any of the below until that dedicated task starts.

## Status quo (unchanged by this note)
- `eee735e`, `4683fa8`, `7972a38` stay isolated and intact on `fix/vq-higgsfield-cloud-key`.
  No merge, cherry-pick, or manual port has happened or is authorised yet.
- `@higgsfield/client` is NOT approved for `vault-quest-phase-10` or `main` (Golden Rule 5).
- Cloud is NOT activated, NOT funded, NOT test-called. No Higgsfield Cloud contact of any kind.
- No reconciliation branch has been created.

## Mandatory requirements for the later integration task

1. **One canonical shared provider-status type.** Do not maintain both `AdapterStatus`
   (their `shared/vq-provider.ts`) and `HiggsfieldStatus` (`server/vault-quest/ai/
   provider-status.ts`, Phase 10A-3/D6) as separate identical unions. Pick one source of
   truth (recommended: re-export the existing `HiggsfieldStatus` from a `shared/`-safe
   location rather than authoring a second identical union) before any adapter is wired
   to a route.
2. **One canonical shared generation-state type.** Same rule for `GenerationState`
   (theirs) vs `VqGenerationState` (`server/vault-quest/lib/generation-idempotency.ts`,
   Phase 7B/D10) — reconcile to one type before wiring.
3. **Keep the live kill switch name: `VQ_GENERATION_DISABLED`.** Already wired into all 4
   paid routes (Phase 10A-4, `vq-feature-flags-store.ts` / `vqFeatureGateOrRespond`).
4. **Do NOT introduce `VQ_DISABLE_PAID_GENERATION`** as a second, parallel operational
   switch. If `provider-adapter.ts`'s `paidGenerationHardOff()` is ever wired, it must
   read the SAME `VQ_GENERATION_DISABLED` flag, not a new name.
5. **Thread every future Cloud provider call through the existing D10 idempotency
   reservation** (`server/vault-quest/lib/generation-idempotency-store.ts`,
   `reserveOrDecide`/`finalizeSuccess`/`finalizeFailure`) — a Cloud create must reserve
   before charging, exactly like the Legacy path does today.
6. **Thread every future Cloud provider call through the existing spend ceilings and
   actual-call accounting** (`server/vault-quest/lib/generation-guard.ts`,
   `checkGenerationSpend` + `effectiveCreditsPerImage`-equivalent actual-model pricing).
   No Cloud call may bypass the spend gate.
7. **Legacy remains the default provider.** `DEFAULT_PROVIDER_MODE = "legacy"` (already
   correct in `shared/vq-provider.ts` on their branch) — do not flip this default during
   integration.
8. **Cloud must never auto-activate or operate as a hidden fallback.** Presence of Cloud
   credentials alone must never select Cloud (already correct in `resolveProviderMode` —
   preserve this invariant through integration). No automatic cross-provider fallback
   except the narrow, already-designed `decideFallback` proven-pre-acceptance case, and
   only when explicitly enabled.
9. **Cloud must remain blocked at zero balance.** `cloudActivationStatus()`'s `balance
   <= 0 → blocked` behaviour must survive integration unchanged.
10. **Cloud activation requires explicit founder approval.** `founderApproved` must stay
    a real, owner-set gate condition — never defaulted to true, never inferred.
11. **Runtime balances must never be hardcoded.** Balances are always a live, queried
    value passed in by the caller (already correct in `CloudReadiness.balance: number |
    null` — preserve this through integration, including any admin-panel display code).
12. **Identity-lock/reference-image capability requires a staging proof before Cloud can
    be considered production-capable.** Their own runbook (`docs/runbooks/vq-higgsfield-
    cloud-migration.md`) already flags this as unverified (no confirmed reference-image
    mechanism on the official `text-to-image` endpoint). Do not switch any card/character
    generation to Cloud until a staging render proves identity holds across evolution
    stages.

## Reference
Full analysis: session reconciliation report, 2026-07-13 (14-section review of
`fix/vq-higgsfield-cloud-key` @ `7972a38` vs `vault-quest-phase-10` @ `7f58a92`).
Merge-tree proof: the two branches' only shared file (`server/vault-quest/ai/
higgsfield.ts`) merges automatically with zero conflicts; no other file overlap.

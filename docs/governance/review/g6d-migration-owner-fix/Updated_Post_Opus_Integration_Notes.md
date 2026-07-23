# Updated Post-Opus Integration Notes

The focused owner-role correction does not change the lineage audit's integration order:

1. Approve and integrate the authoritative G6D source plus this owner-role test correction.
2. Replay the checksum-verified frozen Project Control candidate without changing 0020.
3. Resolve only the two known shared-test conflicts manually:
   - retain G6D numeric cleanup of numbered migrations above 0017 in
     `tests/partner-credit-reservation-service.test.ts`;
   - enumerate every numbered migration from 0001 through 0020, including 0019 then 0020, in
     `tests/partner-schema-parity.test.ts`.
4. Re-run the disposable owner-split migration proof from the clean integration worktree, reading
   0019 and 0020 from that worktree rather than the frozen candidate path.

This correction adds no conflict with Project Control files: it touches the G6D realistic role helper,
G6D upgrade test, migration runbook, isolated audit script, and governed review documentation.

Before any non-disposable migration, re-fetch the approved base, verify the frozen candidate manifest,
verify the actual migration-owner identity, obtain the maintenance/recovery approvals, and leave the
Project Control feature flag default-off.

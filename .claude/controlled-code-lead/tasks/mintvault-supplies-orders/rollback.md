# Rollback — mintvault-supplies-orders

1. Stop the local app process.
2. Remove only containers labelled `mintvault.local-proof=mintvault-supplies-orders`.
3. For a disposable migration proof, apply `migrations/rollback-0069-partner-supply-orders.sql` only after confirming no later numbered migration journal row exists and no supply orders/payments/refunds contain historical evidence.
4. Revert the bounded source change as one commit if implementation itself must be abandoned.

Orders, payments and refunds are never removed to simulate cancellation or refund.

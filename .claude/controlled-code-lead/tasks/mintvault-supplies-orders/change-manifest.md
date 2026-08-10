# Change manifest — mintvault-supplies-orders

## Owner-authorised local operations

| Operation                                       | Scope                                                                                   | Classification | Rollback                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Start disposable PostgreSQL/MinIO and local app | Task-labelled loopback-only containers/processes and generated credentials              | D/F            | Stop/remove only task-labelled containers/processes.                                                 |
| Apply/reverse migration                         | Fresh disposable database only                                                          | E              | Apply reviewed `rollback-0069-partner-supply-orders.sql` after later numbered migrations are absent. |
| Stripe contract/webhook proof                   | Local mock/client stubs and signed handler-level fixtures only; no provider credentials | D              | Process exit.                                                                                        |

## Proposed source changes before implementation

| Area                                            | Change                                                                                                                                                      | Classification | Rollback                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `migrations/0069_*`, rollback, migration tests  | Add isolated supply tables/RLS/grants, seed locked product definitions, immutable snapshot/audit constraints and safe rollback.                             | E              | Reviewed descending rollback.                                            |
| `shared/partner-supply-products.ts`             | Canonical product codes/pack quantities and fixed slab price only.                                                                                          | A              | Revert source after migration rollback.                                  |
| `server/partner/*supply*`, webhook mount/routes | Server-authoritative checkout, webhook fulfilment/replay protection, refund/cancellation/fulfilment service and protected routes.                           | A              | Revert source; never delete orders/payments.                             |
| Partner/Admin client screens and router         | Product, order status and authorised operations UI only.                                                                                                    | D              | Revert client surface.                                                   |
| Partner dashboard alerts                        | Surface dispatched/completed refund/cancellation requests as a real Needs Attention condition, without adding a workflow state or automatic payment action. | A/D            | Revert alert/query surface; immutable events remain historical evidence. |
| Focused tests/docs/index/register               | Encode security, SQL, migration, HTTP, browser and proof expectations.                                                                                      | D/E            | Revert with implementation.                                              |

No live credentials, `.env` files, deployed resources, grading mechanisms, customer records, or wallet ledgers are changed.

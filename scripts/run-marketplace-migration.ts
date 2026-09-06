/**
 * RETIRED: marketplace schema is owned by numbered migration 0115.
 *
 * The former standalone writer imported the removed runtime DDL module and
 * could bypass the migration journal. It must never connect or mutate a
 * database. Use `npm run db:migrate` through the governed release workflow.
 */

throw new Error("run-marketplace-migration.ts is retired; marketplace schema is numbered-migration-owned (0115).");

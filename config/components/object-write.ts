export const OBJECT_WRITE_COMPONENT = {
  schemaVersion: 1,
  id: "object-write",
  owner: "object-durability-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["server/r2.ts", "server/b2.ts", "server/lib/object-write-coordinator.ts"],
  requirements: {
    migrations: [{ name: "0122_object_write_intent_reconciliation.sql", order: 12 }],
    relations: [
      { name: "public.object_write_operations", order: 15 },
      { name: "public.object_write_items", order: 16 },
    ],
    triggers: [
      { name: "trg_object_write_operation_guard", relation: "public.object_write_operations", order: 5 },
      { name: "trg_object_write_item_guard", relation: "public.object_write_items", order: 6 },
    ],
    environment: [
      { name: "R2_ENDPOINT", order: 7 },
      { name: "R2_ACCESS_KEY_ID", order: 8 },
      { name: "R2_SECRET_ACCESS_KEY", order: 9 },
      { name: "R2_BUCKET_NAME", order: 10 },
      { name: "B2_ENDPOINT", order: 11 },
      { name: "B2_KEY_ID", order: 12 },
      { name: "B2_APPLICATION_KEY", order: 13 },
      { name: "B2_BUCKET", order: 14 },
    ],
    runtimeSignals: [{ name: "object_write_reconciliation_runtime", order: 1 }],
  },
} as const;

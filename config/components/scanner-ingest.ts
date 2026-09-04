export const SCANNER_INGEST_COMPONENT = {
  schemaVersion: 1,
  id: "scanner-ingest",
  owner: "scanner-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["scripts/scanner-app/", "server/scan-ingest-service.ts", "server/lib/scanner-evidence-persistence.ts"],
  requirements: {
    migrations: [
      { name: "0088_nfc_binding_integrity.sql", order: 1 },
      { name: "0090_lineage_convergence_scanner.sql", order: 3 },
      { name: "0116_nfc_physical_lock_integrity.sql", order: 6 },
      { name: "0118_nfc_lock_intent_reconciliation.sql", order: 8 },
    ],
    relations: [
      { name: "public.scanner_processing_jobs", order: 5 },
      { name: "public.certificate_image_evidence", order: 6 },
      { name: "public.scanner_capture_sessions", order: 7 },
      { name: "public.scanner_evidence_staging", order: 8 },
    ],
    triggers: [
      { name: "trg_nfc_locked_binding_immutable", relation: "public.certificates", order: 3 },
      { name: "trg_nfc_lock_intent_guards_binding", relation: "public.certificates", order: 4 },
    ],
    environment: [],
    runtimeSignals: [],
  },
} as const;

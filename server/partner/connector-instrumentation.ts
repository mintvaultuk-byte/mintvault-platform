/**
 * Trusted Intake Connector — G3F: test-only instrumentation + deterministic fault injection.
 *
 * PRODUCTION IS UNAFFECTED. No hook is ever registered outside a test, so every `connectorHook(...)`
 * call below reduces to a single `if (activeHook === null) return;` — one predictable branch, zero
 * behavioural change, no allocation. The setter/clearer are deliberately named with a leading `__`
 * and documented as test-only; nothing in server/ (routes, worker, importer) ever calls the setter.
 *
 * The hook lets a test throw at a labelled point INSIDE the importer's single transaction to simulate
 * a crash there — the enclosing `withConnectorTx` then rolls the whole transaction back, which is
 * exactly the recovery behaviour under test (see FAILURE-INJECTION-MATRIX.md). It also lets a test
 * observe timing/ordering without changing behaviour.
 *
 * No customer PII is ever passed into the hook context — only ids, states and counts.
 */

export type ConnectorHookPoint =
  | "before_validation_recheck"
  | "after_validation_recheck"
  | "before_reservation"
  | "after_reservation"
  | "after_owner_resolution"
  | "after_submission_insert"
  | "during_item_insert"
  | "after_items"
  | "before_mapping_completion"
  | "after_mapping_completion"
  | "before_connector_imported"
  | "before_commit";

/** Minimal query surface — lets a fault hook run SQL on the importer's OWN transaction connection
 * (e.g. to terminate its backend and prove connection-death recovery). Typed loosely to avoid a pg
 * dependency in this module. */
export interface HookClient {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

export interface ConnectorHookContext {
  connectorId: string;
  claimant: string;
  /** The importer's transaction client (test-only use). */
  client?: HookClient;
  /** Set once known within the attempt; safe ids/counters only, never PII. */
  mappingId?: string;
  destinationSubmissionId?: number;
  itemIndex?: number;
}

export type ConnectorHook = (point: ConnectorHookPoint, ctx: ConnectorHookContext) => void | Promise<void>;

let activeHook: ConnectorHook | null = null;

/** TEST-ONLY. Registers a fault/observation hook. Never called by production code. */
export function __setConnectorHook(hook: ConnectorHook): void {
  activeHook = hook;
}

/** TEST-ONLY. Removes any registered hook, restoring the production no-op default. */
export function __clearConnectorHook(): void {
  activeHook = null;
}

/**
 * Called at each labelled point in the importer. In production `activeHook` is null and this is a
 * single branch returning immediately. Under a test hook, the hook may throw (to simulate a crash at
 * this point — the caller's transaction then rolls back) or run an observation and return.
 */
export async function connectorHook(point: ConnectorHookPoint, ctx: ConnectorHookContext): Promise<void> {
  if (activeHook === null) return;
  await activeHook(point, ctx);
}

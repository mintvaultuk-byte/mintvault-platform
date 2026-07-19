/**
 * Trusted Intake Connector — Phase G2: deterministic validation engine.
 *
 * Reads directly from the trusted database (never from a request body or any browser-supplied
 * copy). See .claude/controlled-code-lead/tasks/partner-network-connector-g2-g5/VALIDATION-CONTRACT.md
 * for the exhaustive rule set this file implements, and SOURCE-FINGERPRINT.md for the staleness
 * mechanism. Validation writes (the run + its findings) and the connector's state transition happen
 * in ONE transaction — never two — so a crash between "recorded valid" and "connector says
 * ready_for_import" is structurally impossible.
 */
import type pg from "pg";
import { withConnectorTx, connectorQuery } from "./connector-db";
import { resolveGlobalFlag } from "./flags";
import { ConnectorError, toConnectorError } from "./connector-errors";
import {
  calculateSourceFingerprint,
  SOURCE_FINGERPRINT_VERSION,
  type FingerprintSource,
} from "./connector-fingerprint";
import type { ConnectorState } from "./connector-service";

const MAX_CARDS_PER_SUBMISSION = 200;
const MAX_QUANTITY = 1000; // matches server/partner/submission-routes.ts's MAX_QUANTITY exactly
const MAX_DECLARED_VALUE_PENCE = 100_000_000; // matches submission-routes.ts's MAX_DECLARED_VALUE_PENCE exactly

export const VALIDATION_OUTCOMES = ["valid", "invalid", "stale", "cancelled", "failed"] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export const VALIDATION_SEVERITIES = ["warning", "blocking"] as const;
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

export const VALIDATION_FINDING_CODES = [
  "organisation_missing",
  "organisation_inactive",
  "organisation_suspended",
  "location_missing",
  "location_inactive",
  "tenant_mismatch",
  "submission_missing",
  "submission_not_final",
  "submission_cancelled",
  "submission_superseded", // checked — see the supersededRes query in validateConnectorRecord
  "handoff_missing",
  "handoff_not_ready",
  "handoff_mismatch",
  "customer_missing",
  "customer_invalid",
  "customer_invalid_email",
  "service_tier_missing",
  "service_tier_inactive",
  "service_tier_unauthorised", // RESERVED (G3+): no per-tenant tier authorisation list exists yet; never pushed
  "service_tier_unmapped", // RESERVED (G3+): no Partner-tier -> MintVault-service mapping table exists yet; never pushed
  "service_price_mismatch",
  "no_cards",
  "too_many_cards",
  "card_invalid_quantity",
  "card_invalid_declared_value",
  "card_missing_required_field",
  "card_tenant_mismatch",
  "totals_mismatch",
  "source_version_mismatch",
  "source_fingerprint_mismatch",
  "already_imported", // RESERVED (G3+): no import-mapping schema exists yet; never pushed
  "unknown_validation_error",
] as const;
export type ValidationFindingCode = (typeof VALIDATION_FINDING_CODES)[number];

export interface ValidationFinding {
  severity: ValidationSeverity;
  code: ValidationFindingCode;
  entityType: string;
  safeEntityReference: string | null;
  safeFieldName: string | null;
  safeMetadata: Record<string, unknown>;
}

export interface ValidationRunResult {
  id: string;
  connectorRecordId: string;
  outcome: ValidationOutcome;
  blockingErrorCount: number;
  warningCount: number;
  sourceFingerprint: string | null;
  sourceFingerprintVersion: number | null;
  findings: ValidationFinding[];
}

/** Exported for the same reason as loadValidationRows above. */
export interface ConnectorRow {
  id: string;
  tenant_id: string;
  partner_submission_id: string;
  handoff_id: string;
  state: string;
  claimed_by: string | null;
  version: number;
  attempt_count: number;
}

async function assertConnectorActive(): Promise<void> {
  const [stopped, enabled] = await Promise.all([
    resolveGlobalFlag("partner_emergency_stop"),
    resolveGlobalFlag("partner_connector_enabled"),
  ]);
  if (stopped) throw new ConnectorError("emergency_stop", "The connector is stopped.");
  if (!enabled) throw new ConnectorError("feature_disabled", "The connector is disabled.");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw toConnectorError(err);
  }
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim().length === 0;
}

/**
 * Load every trusted row the validation rules need, in one tenant-scoped transaction. `client`
 * must already have the tenant GUC set (see connector-db.ts's withConnectorTx tenantId param) —
 * every table read here is FORCE ROW LEVEL SECURITY, so a caller-claimed tenantId that doesn't
 * match the real row's tenant_id yields zero rows, never another tenant's data.
 */
/**
 * Exported (not just internal) so the G3 importer's mandatory pre-import fingerprint recheck reuses
 * the EXACT SAME loader and field mapping validation used — reimplementing a second, parallel loader
 * would risk the two drifting apart, which would silently defeat the staleness check's own purpose.
 */
export async function loadValidationRows(client: pg.PoolClient, connector: ConnectorRow) {
  const orgRes = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM partner_organisations WHERE id = $1`,
    [connector.tenant_id]
  );
  const submissionRes = await client.query<{
    id: string;
    tenant_id: string;
    location_id: string;
    customer_id: string | null;
    service_tier_code: string | null;
    estimated_price_pence: number | null;
    card_count: number;
    status: string;
    version: number;
  }>(`SELECT * FROM partner_submissions WHERE id = $1`, [connector.partner_submission_id]);
  const handoffRes = await client.query<{ id: string; submission_id: string; status: string }>(
    `SELECT id, submission_id, status FROM partner_submission_handoffs WHERE id = $1`,
    [connector.handoff_id]
  );

  const submission = submissionRes.rows[0] ?? null;

  const locationRes = submission
    ? await client.query<{ id: string; status: string }>(`SELECT id, status FROM partner_locations WHERE id = $1`, [
        submission.location_id,
      ])
    : { rows: [] as { id: string; status: string }[] };

  const customerRes = submission?.customer_id
    ? await client.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
        `SELECT id, full_name, email, phone FROM partner_customers WHERE id = $1`,
        [submission.customer_id]
      )
    : { rows: [] as { id: string; full_name: string; email: string | null; phone: string | null }[] };

  const tierRes = submission?.service_tier_code
    ? await client.query<{
        id: string;
        tenant_id: string | null;
        tier_code: string;
        price_per_card_pence: number;
        is_active: boolean;
      }>(
        `SELECT id, tenant_id, tier_code, price_per_card_pence, is_active
           FROM partner_service_tiers
          WHERE tier_code = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
          ORDER BY tenant_id NULLS LAST
          LIMIT 1`,
        [submission.service_tier_code, connector.tenant_id]
      )
    : {
        rows: [] as {
          id: string;
          tenant_id: string | null;
          tier_code: string;
          price_per_card_pence: number;
          is_active: boolean;
        }[],
      };

  const cardsRes = await client.query<{
    id: string;
    tenant_id: string;
    sequence_number: number;
    card_name: string | null;
    game: string | null;
    card_set: string | null;
    card_number: string | null;
    year: number | null;
    variant: string | null;
    language: string | null;
    declared_value_pence: number | null;
    quantity: number;
  }>(
    `SELECT id, tenant_id, sequence_number, card_name, game, card_set, card_number, year, variant, language, declared_value_pence, quantity
       FROM partner_submission_cards
      WHERE submission_id = $1 AND removed_at IS NULL
      ORDER BY sequence_number ASC`,
    [connector.partner_submission_id]
  );

  return {
    organisation: orgRes.rows[0] ?? null,
    location: locationRes.rows[0] ?? null,
    submission,
    handoff: handoffRes.rows[0] ?? null,
    customer: customerRes.rows[0] ?? null,
    serviceTier: tierRes.rows[0] ?? null,
    cards: cardsRes.rows,
  };
}

export type LoadedRows = Awaited<ReturnType<typeof loadValidationRows>>;

/** Pure rule evaluation over already-loaded rows — no I/O, fully unit-testable. */
function evaluateRules(connector: ConnectorRow, rows: LoadedRows): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const push = (f: ValidationFinding) => findings.push(f);

  // ORGANISATION
  if (!rows.organisation) {
    push({
      severity: "blocking",
      code: "organisation_missing",
      entityType: "organisation",
      safeEntityReference: connector.tenant_id,
      safeFieldName: null,
      safeMetadata: {},
    });
  } else {
    if (rows.organisation.status === "SUSPENDED") {
      push({
        severity: "blocking",
        code: "organisation_suspended",
        entityType: "organisation",
        safeEntityReference: rows.organisation.id,
        safeFieldName: "status",
        safeMetadata: {},
      });
    } else if (rows.organisation.status !== "ACTIVE") {
      push({
        severity: "blocking",
        code: "organisation_inactive",
        entityType: "organisation",
        safeEntityReference: rows.organisation.id,
        safeFieldName: "status",
        safeMetadata: { status: rows.organisation.status },
      });
    }
  }

  // SUBMISSION + HANDOFF (must exist before anything downstream can be checked meaningfully)
  if (!rows.submission) {
    push({
      severity: "blocking",
      code: "submission_missing",
      entityType: "submission",
      safeEntityReference: connector.partner_submission_id,
      safeFieldName: null,
      safeMetadata: {},
    });
  } else {
    if (rows.submission.tenant_id !== connector.tenant_id) {
      push({
        severity: "blocking",
        code: "tenant_mismatch",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: "tenant_id",
        safeMetadata: {},
      });
    }
    if (rows.submission.status === "draft") {
      push({
        severity: "blocking",
        code: "submission_not_final",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: "status",
        safeMetadata: {},
      });
    }
    if (rows.submission.status === "cancelled") {
      push({
        severity: "blocking",
        code: "submission_cancelled",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: "status",
        safeMetadata: {},
      });
    }

    // LOCATION
    if (!rows.location) {
      push({
        severity: "blocking",
        code: "location_missing",
        entityType: "location",
        safeEntityReference: rows.submission.location_id,
        safeFieldName: null,
        safeMetadata: {},
      });
    } else if (rows.location.status !== "ACTIVE") {
      push({
        severity: "blocking",
        code: "location_inactive",
        entityType: "location",
        safeEntityReference: rows.location.id,
        safeFieldName: "status",
        safeMetadata: { status: rows.location.status },
      });
    }

    // CUSTOMER
    if (!rows.submission.customer_id || !rows.customer) {
      push({
        severity: "blocking",
        code: "customer_missing",
        entityType: "customer",
        safeEntityReference: rows.submission.customer_id,
        safeFieldName: null,
        safeMetadata: {},
      });
    } else {
      if (isBlank(rows.customer.full_name)) {
        push({
          severity: "blocking",
          code: "customer_invalid",
          entityType: "customer",
          safeEntityReference: rows.customer.id,
          safeFieldName: "full_name",
          safeMetadata: {},
        });
      }
      if (rows.customer.email && !isEmail(rows.customer.email)) {
        push({
          severity: "blocking",
          code: "customer_invalid_email",
          entityType: "customer",
          safeEntityReference: rows.customer.id,
          safeFieldName: "email",
          safeMetadata: {},
        });
      }
    }

    // SERVICE TIER
    if (!rows.submission.service_tier_code || !rows.serviceTier) {
      push({
        severity: "blocking",
        code: "service_tier_missing",
        entityType: "service_tier",
        safeEntityReference: rows.submission.service_tier_code,
        safeFieldName: null,
        safeMetadata: {},
      });
    } else {
      if (!rows.serviceTier.is_active) {
        push({
          severity: "blocking",
          code: "service_tier_inactive",
          entityType: "service_tier",
          safeEntityReference: rows.serviceTier.id,
          safeFieldName: "is_active",
          safeMetadata: {},
        });
      }
      const activeCards = rows.cards;
      const totalQuantity = activeCards.reduce((sum, c) => sum + c.quantity, 0);
      const expectedPrice = rows.serviceTier.price_per_card_pence * totalQuantity;
      if (rows.serviceTier.is_active && rows.submission.estimated_price_pence !== expectedPrice) {
        push({
          severity: "blocking",
          code: "service_price_mismatch",
          entityType: "service_tier",
          safeEntityReference: rows.serviceTier.id,
          safeFieldName: "estimated_price_pence",
          safeMetadata: { storedPence: rows.submission.estimated_price_pence, expectedPence: expectedPrice },
        });
      }
    }

    // CARDS
    if (rows.cards.length === 0) {
      push({
        severity: "blocking",
        code: "no_cards",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: null,
        safeMetadata: {},
      });
    }
    if (rows.cards.length > MAX_CARDS_PER_SUBMISSION) {
      push({
        severity: "blocking",
        code: "too_many_cards",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: null,
        safeMetadata: { count: rows.cards.length },
      });
    }
    for (const card of rows.cards) {
      if (card.tenant_id !== connector.tenant_id) {
        push({
          severity: "blocking",
          code: "card_tenant_mismatch",
          entityType: "card",
          safeEntityReference: card.id,
          safeFieldName: "tenant_id",
          safeMetadata: {},
        });
      }
      if (!Number.isInteger(card.quantity) || card.quantity < 1 || card.quantity > MAX_QUANTITY) {
        push({
          severity: "blocking",
          code: "card_invalid_quantity",
          entityType: "card",
          safeEntityReference: card.id,
          safeFieldName: "quantity",
          safeMetadata: {},
        });
      }
      if (
        card.declared_value_pence != null &&
        (card.declared_value_pence < 0 || card.declared_value_pence > MAX_DECLARED_VALUE_PENCE)
      ) {
        push({
          severity: "blocking",
          code: "card_invalid_declared_value",
          entityType: "card",
          safeEntityReference: card.id,
          safeFieldName: "declared_value_pence",
          safeMetadata: {},
        });
      }
      if (isBlank(card.card_name)) {
        push({
          severity: "blocking",
          code: "card_missing_required_field",
          entityType: "card",
          safeEntityReference: card.id,
          safeFieldName: "card_name",
          safeMetadata: {},
        });
      }
    }

    // TOTALS
    const totalQuantity = rows.cards.reduce((sum, c) => sum + c.quantity, 0);
    if (rows.submission.card_count !== totalQuantity) {
      push({
        severity: "blocking",
        code: "totals_mismatch",
        entityType: "submission",
        safeEntityReference: rows.submission.id,
        safeFieldName: "card_count",
        safeMetadata: { storedCount: rows.submission.card_count, computedCount: totalQuantity },
      });
    }
  }

  // HANDOFF
  if (!rows.handoff) {
    push({
      severity: "blocking",
      code: "handoff_missing",
      entityType: "handoff",
      safeEntityReference: connector.handoff_id,
      safeFieldName: null,
      safeMetadata: {},
    });
  } else {
    if (rows.handoff.submission_id !== connector.partner_submission_id) {
      push({
        severity: "blocking",
        code: "handoff_mismatch",
        entityType: "handoff",
        safeEntityReference: rows.handoff.id,
        safeFieldName: "submission_id",
        safeMetadata: {},
      });
    }
    if (rows.handoff.status !== "pending") {
      push({
        severity: "blocking",
        code: "handoff_not_ready",
        entityType: "handoff",
        safeEntityReference: rows.handoff.id,
        safeFieldName: "status",
        safeMetadata: { status: rows.handoff.status },
      });
    }
  }

  return findings;
}

/** Exported for the same reason as loadValidationRows above. */
export function toFingerprintSource(rows: LoadedRows): FingerprintSource {
  return {
    submission: {
      locationId: rows.submission?.location_id ?? "",
      customerId: rows.submission?.customer_id ?? null,
      serviceTierCode: rows.submission?.service_tier_code ?? null,
      estimatedPricePence: rows.submission?.estimated_price_pence ?? null,
      cardCount: rows.submission?.card_count ?? 0,
      status: rows.submission?.status ?? "",
    },
    customer: rows.customer
      ? { fullName: rows.customer.full_name, email: rows.customer.email, phone: rows.customer.phone }
      : null,
    serviceTier: rows.serviceTier
      ? {
          tierCode: rows.serviceTier.tier_code,
          pricePerCardPence: rows.serviceTier.price_per_card_pence,
          isActive: rows.serviceTier.is_active,
        }
      : null,
    cards: rows.cards.map((c) => ({
      sequenceNumber: c.sequence_number,
      cardName: c.card_name,
      game: c.game,
      cardSet: c.card_set,
      cardNumber: c.card_number,
      year: c.year,
      variant: c.variant,
      language: c.language,
      declaredValuePence: c.declared_value_pence,
      quantity: c.quantity,
    })),
  };
}

/** Read-only. Available even when the connector is OFF/stopped, matching getConnectorStatus's precedent. */
export async function getLatestValidationRun(connectorRecordId: string): Promise<ValidationRunResult | null> {
  return guarded(async () => {
    const { rows } = await connectorQuery<{
      id: string;
      connector_record_id: string;
      outcome: string;
      blocking_error_count: number;
      warning_count: number;
      source_fingerprint: string | null;
      source_fingerprint_version: number | null;
      completed_at: string | null;
    }>(
      `SELECT id, connector_record_id, outcome, blocking_error_count, warning_count, source_fingerprint, source_fingerprint_version, completed_at
         FROM partner_connector_validation_runs
        WHERE connector_record_id = $1 AND completed_at IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [connectorRecordId]
    );
    if (rows.length === 0) return null;
    const run = rows[0];
    const findings = await listValidationFindings(run.id);
    return {
      id: run.id,
      connectorRecordId: run.connector_record_id,
      outcome: run.outcome as ValidationOutcome,
      blockingErrorCount: run.blocking_error_count,
      warningCount: run.warning_count,
      sourceFingerprint: run.source_fingerprint,
      sourceFingerprintVersion: run.source_fingerprint_version,
      findings,
    };
  });
}

/** Read-only. */
export async function listValidationFindings(validationRunId: string): Promise<ValidationFinding[]> {
  return guarded(async () => {
    const { rows } = await connectorQuery<{
      severity: string;
      code: string;
      entity_type: string;
      safe_entity_reference: string | null;
      safe_field_name: string | null;
      safe_metadata: Record<string, unknown> | null;
    }>(
      `SELECT severity, code, entity_type, safe_entity_reference, safe_field_name, safe_metadata
         FROM partner_connector_validation_findings
        WHERE validation_run_id = $1
        ORDER BY created_at ASC`,
      [validationRunId]
    );
    return rows.map((r) => ({
      severity: r.severity as ValidationSeverity,
      code: r.code as ValidationFindingCode,
      entityType: r.entity_type,
      safeEntityReference: r.safe_entity_reference,
      safeFieldName: r.safe_field_name,
      safeMetadata: r.safe_metadata ?? {},
    }));
  });
}

/**
 * Run validation for a record currently held `validating` by `claimant`. Requires the SAME
 * claim/version guard as every other G1 state-changing function. On completion, atomically (same
 * transaction): writes the run + all findings, and transitions the connector record to
 * `ready_for_import` (valid), `rejected` (invalid), `cancelled` (submission was cancelled), or
 * `failed` (stale source / internal error) — never leaves validation "complete" with the connector
 * record still saying `validating`.
 */
export async function validateConnectorRecord(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  tenantId?: string;
}): Promise<ValidationRunResult> {
  await assertConnectorActive();
  const { connectorId, claimant, expectedVersion, tenantId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (connector.state !== "validating") {
        throw new ConnectorError(
          "invalid_state_transition",
          `Cannot validate a record in state ${connector.state}; must be validating.`
        );
      }
      if (connector.claimed_by !== claimant) {
        throw new ConnectorError("stale_claim", "Only the current claimant may validate this record.");
      }
      if (connector.version !== expectedVersion) {
        throw new ConnectorError("stale_claim", "Record changed since last read.");
      }

      // withConnectorTx only sets the app.tenant_id GUC when a tenantId is known BEFORE the
      // transaction opens — but here the connector's tenant is only known after reading the
      // (non-RLS'd) connector record above. Set it now, transaction-local, before touching any of
      // the FORCE-RLS'd tables loadValidationRows reads (organisations, locations, customers,
      // service tiers, cards) — without this, every one of those reads would return zero rows
      // regardless of the WHERE clause (RLS resolves partner_current_tenant() to NULL and no row's
      // tenant_id ever equals NULL), making every validation appear to reference missing entities.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [connector.tenant_id]);

      // Do ALL the work first — load, fingerprint, evaluate — then write the run ONCE with its
      // final values. partner_connector_validation_runs is granted SELECT+INSERT only (no UPDATE),
      // matching "immutable after completion": there is no half-written row to ever update, so
      // there is nothing to reconcile if the process crashes before the single INSERT commits.
      let outcome: ValidationOutcome;
      let findings: ValidationFinding[] = [];
      let fingerprint: string | null = null;
      let sourceSubmissionVersion = 0;
      let sourceHandoffStatus = "unknown";

      try {
        const rows = await loadValidationRows(client, connector);
        sourceSubmissionVersion = rows.submission?.version ?? 0;
        sourceHandoffStatus = rows.handoff?.status ?? "unknown";

        if (rows.submission?.status === "cancelled") {
          outcome = "cancelled";
        } else {
          // Staleness check: compare against the immediately-prior COMPLETED run, if any.
          const priorRes = await client.query<{ source_submission_version: number; source_fingerprint: string | null }>(
            `SELECT source_submission_version, source_fingerprint FROM partner_connector_validation_runs
              WHERE connector_record_id = $1 AND completed_at IS NOT NULL
              ORDER BY created_at DESC LIMIT 1`,
            [connectorId]
          );
          const prior = priorRes.rows[0] ?? null;
          fingerprint = calculateSourceFingerprint(toFingerprintSource(rows));

          if (prior && prior.source_submission_version !== sourceSubmissionVersion) {
            outcome = "stale";
            findings = [
              {
                severity: "blocking",
                code: "source_version_mismatch",
                entityType: "submission",
                safeEntityReference: connector.partner_submission_id,
                safeFieldName: "version",
                safeMetadata: {},
              },
            ];
          } else if (prior && prior.source_fingerprint !== null && prior.source_fingerprint !== fingerprint) {
            outcome = "stale";
            findings = [
              {
                severity: "blocking",
                code: "source_fingerprint_mismatch",
                entityType: "submission",
                safeEntityReference: connector.partner_submission_id,
                safeFieldName: null,
                safeMetadata: {},
              },
            ];
          } else {
            findings = evaluateRules(connector, rows);
            // submission_superseded: defence in depth against another connector record existing for
            // the same Partner submission. Migration 0008's UNIQUE(handoff_id) already makes this
            // structurally impossible under the current schema (one handoff -> at most one connector
            // record, and a submission cannot produce two live 'pending' handoffs) — this check exists
            // for the day that invariant is weakened by a future migration or a bug elsewhere, not
            // because it currently fires in practice.
            const supersededRes = await client.query<{ id: string }>(
              `SELECT id FROM partner_connector_records
                WHERE partner_submission_id = $1 AND id != $2 AND state NOT IN ('rejected','cancelled')
                LIMIT 1`,
              [connector.partner_submission_id, connector.id]
            );
            if (supersededRes.rows.length > 0) {
              findings.push({
                severity: "blocking",
                code: "submission_superseded",
                entityType: "submission",
                safeEntityReference: connector.partner_submission_id,
                safeFieldName: null,
                safeMetadata: {},
              });
            }
            outcome = findings.some((f) => f.severity === "blocking") ? "invalid" : "valid";
          }
        }
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        outcome = "failed";
        findings = [
          {
            severity: "blocking",
            code: "unknown_validation_error",
            entityType: "connector_record",
            safeEntityReference: connectorId,
            safeFieldName: null,
            safeMetadata: {},
          },
        ];
      }

      const blockingCount = findings.filter((f) => f.severity === "blocking").length;
      const warningCount = findings.filter((f) => f.severity === "warning").length;

      const runRes = await client.query<{ id: string }>(
        `INSERT INTO partner_connector_validation_runs
           (connector_record_id, validation_attempt, source_submission_version, source_handoff_status,
            source_fingerprint, source_fingerprint_version, outcome, blocking_error_count, warning_count, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         RETURNING id`,
        [
          connectorId,
          connector.attempt_count,
          sourceSubmissionVersion,
          sourceHandoffStatus,
          fingerprint,
          fingerprint ? SOURCE_FINGERPRINT_VERSION : null,
          outcome,
          blockingCount,
          warningCount,
        ]
      );
      const runId = runRes.rows[0].id;
      for (const f of findings) {
        await client.query(
          `INSERT INTO partner_connector_validation_findings
             (validation_run_id, severity, code, entity_type, safe_entity_reference, safe_field_name, safe_metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            runId,
            f.severity,
            f.code,
            f.entityType,
            f.safeEntityReference,
            f.safeFieldName,
            JSON.stringify(f.safeMetadata ?? {}),
          ]
        );
      }

      const toState: ConnectorState =
        outcome === "valid"
          ? "ready_for_import"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "invalid"
              ? "rejected"
              : "failed";
      const nextRetryClause = toState === "failed" ? `now() + interval '300 seconds'` : "NULL";
      const errorCategory = toState === "failed" ? (outcome === "stale" ? "stale_source" : "validation_error") : null;
      const errorCode = toState === "failed" ? (findings[0]?.code ?? "unknown_validation_error") : null;

      const upd = await client.query<{ state: string }>(
        `UPDATE partner_connector_records
            SET state = $1, version = version + 1, updated_at = now(),
                last_error_category = $2, last_error_code = $3,
                next_retry_at = ${nextRetryClause}
          WHERE id = $4 AND version = $5 AND state = 'validating'
          RETURNING state`,
        [toState, errorCategory, errorCode, connectorId, expectedVersion]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");

      await client.query(
        `INSERT INTO partner_connector_events
           (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
         VALUES ($1,'validating',$2,'validated',$3,$4,'system',$5)`,
        [
          connectorId,
          toState,
          connector.attempt_count,
          JSON.stringify({ outcome, blockingCount, warningCount }),
          claimant,
        ]
      );

      return {
        id: runId,
        connectorRecordId: connectorId,
        outcome,
        blockingErrorCount: blockingCount,
        warningCount,
        sourceFingerprint: fingerprint,
        sourceFingerprintVersion: fingerprint ? SOURCE_FINGERPRINT_VERSION : null,
        findings,
      };
    })
  );
}

/**
 * Move a `ready_for_import` or retryable `failed` record back to `validating` for a fresh
 * validation run. Refuses on `rejected`/`cancelled`/`imported` (terminal) — those need a genuinely
 * new Partner submission, not a re-check of the same one.
 */
export async function requestConnectorRevalidation(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  tenantId?: string;
}): Promise<void> {
  await assertConnectorActive();
  const { connectorId, claimant, expectedVersion, tenantId } = params;
  await guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (rec.state !== "ready_for_import" && rec.state !== "failed") {
        throw new ConnectorError("invalid_state_transition", `Cannot revalidate a record in state ${rec.state}.`);
      }
      if (rec.claimed_by && rec.claimed_by !== claimant) {
        throw new ConnectorError("stale_claim", "Only the current claimant may request revalidation.");
      }
      const fromState = rec.state as ConnectorState;
      // Claim the record for THIS caller as part of the same transition — otherwise a subsequent
      // validateConnectorRecord() call (which requires claimed_by === claimant) would fail even
      // though this caller just legitimately requested the revalidation.
      const upd = await client.query(
        `UPDATE partner_connector_records
            SET state = 'validating', claimed_by = $4, claimed_at = now(),
                claim_expires_at = now() + interval '300 seconds',
                attempt_count = attempt_count + 1, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND state = $3
          RETURNING attempt_count`,
        [connectorId, expectedVersion, fromState, claimant]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");
      await client.query(
        `INSERT INTO partner_connector_events (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
         VALUES ($1,$2,'validating','revalidation_requested',$3,'{}','system',$4)`,
        [connectorId, fromState, upd.rows[0].attempt_count, claimant]
      );
    })
  );
}

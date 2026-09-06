/**
 * Narrow cross-authority reads used by the MintVault application.
 *
 * Main-runtime code must never query operational Partner relations through
 * `server/db.ts`: migration 0121 deliberately revokes those grants.  Every
 * function in this module returns a bounded, typed fact through the distinct
 * Partner-admin credential.  Callers keep all MintVault reads and writes on
 * the main pool and compose only the minimum Partner fact they need.
 */
import { partnerAdminQuery, withPartnerAdminReadBudget, withPartnerAdminTransaction } from "./db";
import { resolveAuthoritativeAcquisitionRegion, type AcquisitionRegionMm } from "../lib/lide400-capture-authority";
import type { PoolClient } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uniqueUuids(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && UUID_RE.test(value)))];
}

type ConnectorLineageLockScope = {
  destinationSubmissionId: number;
  tenantId: string;
  locationId: string;
  partnerSubmissionId?: string;
};

/**
 * Connector import/reconciliation already owns the canonical lock order:
 * record -> import. Keep operational readers on that order, then lock the two
 * remaining provenance rows. A joined FOR SHARE lets the planner choose a
 * conflicting order and can deadlock with reconciliation.
 */
async function lockConnectorLineage(client: PoolClient, scope: ConnectorLineageLockScope): Promise<boolean> {
  const candidate = await client.query<{
    import_id: string;
    record_id: string;
    partner_submission_id: string;
    handoff_id: string;
  }>(
    `SELECT imported.id::text AS import_id,
            imported.connector_record_id::text AS record_id,
            imported.partner_submission_id::text AS partner_submission_id,
            imported.partner_handoff_id::text AS handoff_id
       FROM public.partner_connector_imports imported
      WHERE imported.destination_submission_id=$1
        AND imported.partner_organisation_id=$2::uuid
        AND imported.partner_location_id=$3::uuid
        AND ($4::uuid IS NULL OR imported.partner_submission_id=$4::uuid)
        AND imported.state IN ('completed','imported')`,
    [scope.destinationSubmissionId, scope.tenantId, scope.locationId, scope.partnerSubmissionId ?? null]
  );
  if (candidate.rows.length !== 1) return false;
  const row = candidate.rows[0];

  const record = await client.query(
    `SELECT 1 /* connector operational authority: lock record first */
       FROM public.partner_connector_records
      WHERE id=$1::uuid
        AND tenant_id=$2::uuid
        AND partner_submission_id=$3::uuid
        AND handoff_id=$4::uuid
        AND state='imported'
      FOR SHARE`,
    [row.record_id, scope.tenantId, row.partner_submission_id, row.handoff_id]
  );
  if (record.rows.length !== 1) return false;

  const imported = await client.query(
    `SELECT 1
       FROM public.partner_connector_imports
      WHERE id=$1::uuid
        AND connector_record_id=$2::uuid
        AND destination_submission_id=$3
        AND partner_organisation_id=$4::uuid
        AND partner_location_id=$5::uuid
        AND partner_submission_id=$6::uuid
        AND partner_handoff_id=$7::uuid
        AND state IN ('completed','imported')
      FOR SHARE`,
    [
      row.import_id,
      row.record_id,
      scope.destinationSubmissionId,
      scope.tenantId,
      scope.locationId,
      row.partner_submission_id,
      row.handoff_id,
    ]
  );
  if (imported.rows.length !== 1) return false;

  const submission = await client.query(
    `SELECT 1
       FROM public.partner_submissions
      WHERE id=$1::uuid AND tenant_id=$2::uuid AND location_id=$3::uuid
      FOR SHARE`,
    [row.partner_submission_id, scope.tenantId, scope.locationId]
  );
  if (submission.rows.length !== 1) return false;

  const handoff = await client.query(
    `SELECT 1
       FROM public.partner_submission_handoffs
      WHERE id=$1::uuid AND tenant_id=$2::uuid AND submission_id=$3::uuid
      FOR SHARE`,
    [row.handoff_id, scope.tenantId, row.partner_submission_id]
  );
  return handoff.rows.length === 1;
}

export async function countActivePartners(): Promise<number> {
  return withPartnerAdminReadBudget(async () => {
    const result = await partnerAdminQuery<{ active_count: number | string }>(
      "SELECT count(*)::int AS active_count FROM public.partner_organisations WHERE status='ACTIVE'"
    );
    return Number(result.rows[0]?.active_count ?? 0);
  });
}

export async function readPartnerOrganisationNames(
  partnerIds: readonly (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ids = uniqueUuids(partnerIds);
  if (ids.length === 0) return new Map();
  return withPartnerAdminReadBudget(async () => {
    const result = await partnerAdminQuery<{ id: string; legal_name: string }>(
      `SELECT id::text AS id, legal_name
         FROM public.partner_organisations
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    return new Map(result.rows.map((row) => [row.id, row.legal_name]));
  });
}

export async function isDestinationSubmissionPartnerLinked(destinationSubmissionId: number): Promise<boolean> {
  if (!Number.isSafeInteger(destinationSubmissionId) || destinationSubmissionId < 1) {
    throw new Error("destination submission id must be a positive integer");
  }
  return withPartnerAdminReadBudget(async () => {
    const result = await partnerAdminQuery(
      `SELECT 1
         FROM public.partner_connector_imports
        WHERE destination_submission_id=$1
        LIMIT 1`,
      [destinationSubmissionId]
    );
    return result.rows.length === 1;
  });
}

export type PartnerQaAuthority = {
  operatorName: string | null;
  operatorEmail: string | null;
  stationCodes: string[];
  approvedStationIds: Set<string>;
};

export async function readPartnerQaAuthority(input: {
  tenantId: string;
  locationId: string;
  operatorId?: string | null;
  stationIds: readonly string[];
}): Promise<PartnerQaAuthority> {
  if (!UUID_RE.test(input.tenantId) || !UUID_RE.test(input.locationId)) {
    throw new Error("Partner QA authority requires valid tenant and location ids");
  }
  const stationIds = uniqueUuids(input.stationIds);
  const operatorId = input.operatorId && UUID_RE.test(input.operatorId) ? input.operatorId : null;
  return withPartnerAdminReadBudget(async () => {
    // withPartnerAdminReadBudget intentionally binds one PostgreSQL client and
    // snapshot. Do not issue concurrent client.query calls: pg currently queues
    // them with a deprecation warning and pg 9 will reject that usage.
    const operator = operatorId
      ? await partnerAdminQuery<{ operator_name: string | null; operator_email: string | null }>(
          `SELECT NULLIF(concat_ws(' ', first_name, last_name), '') AS operator_name,
                    email AS operator_email
               FROM public.partner_users
              WHERE id=$1::uuid AND tenant_id=$2::uuid
              LIMIT 1`,
          [operatorId, input.tenantId]
        )
      : { rows: [] as Array<{ operator_name: string | null; operator_email: string | null }> };
    const stations =
      stationIds.length > 0
        ? await partnerAdminQuery<{ id: string; station_code: string; approved: boolean }>(
            `SELECT id::text AS id, station_code, approved_at IS NOT NULL AS approved
               FROM public.partner_stations
              WHERE id = ANY($1::uuid[])
                AND tenant_id=$2::uuid
                AND location_id=$3::uuid`,
            [stationIds, input.tenantId, input.locationId]
          )
        : { rows: [] as Array<{ id: string; station_code: string; approved: boolean }> };
    const operatorRow = operator.rows[0];
    return {
      operatorName: operatorRow?.operator_name ?? null,
      operatorEmail: operatorRow?.operator_email ?? null,
      stationCodes: [...new Set(stations.rows.map((row) => row.station_code))].sort(),
      approvedStationIds: new Set(stations.rows.filter((row) => row.approved).map((row) => row.id)),
    };
  });
}

export type PartnerPrintAuthorityFact = {
  certificateNumber: string;
  isCardJob: boolean;
  mappingValid: boolean;
  cardJobValid: boolean;
  qaComplete: boolean;
  printStateAllowsOutput: boolean;
  creditSettled: boolean;
  captureComplete: boolean;
};

export async function readPartnerPrintAuthority(
  certificateNumbers: readonly string[]
): Promise<Map<string, PartnerPrintAuthorityFact>> {
  const requested = [...new Set(certificateNumbers.filter((value) => typeof value === "string" && value !== ""))];
  if (requested.length === 0) return new Map();
  return withPartnerAdminReadBudget(async () => {
    const result = await partnerAdminQuery<{
      certificate_number: string;
      is_card_job: boolean;
      mapping_valid: boolean;
      card_job_valid: boolean;
      qa_complete: boolean;
      print_state_allows_output: boolean;
      credit_settled: boolean;
      card_job_credit_settled: boolean;
      capture_complete: boolean;
      card_job_capture_complete: boolean;
    }>(
      `SELECT c.certificate_number,
              (job.id IS NOT NULL) AS is_card_job,
              (
                pci.id IS NOT NULL AND pcr.id IS NOT NULL AND ps.id IS NOT NULL
                AND c.origin_partner_id=pci.partner_organisation_id
                AND c.origin_location_id=pci.partner_location_id
              ) AS mapping_valid,
              (
                job.id IS NOT NULL AND job.cancelled_at IS NULL AND job.mv_number IS NOT NULL
                AND job.certificate_id=c.id
                AND c.origin_partner_id=job.tenant_id
                AND c.origin_location_id=job.location_id
                AND job.status IN ('APPROVED', 'PRINTABLE', 'COMPLETED')
              ) AS card_job_valid,
              (
                c.grader_status='approved' AND c.review_required=true
                AND c.grade_approved_at IS NOT NULL AND c.grade_approved_by IS NOT NULL
              ) AS qa_complete,
              c.print_state IN ('needs_printing','reprint_required','printing','printed','reprinted')
                AS print_state_allows_output,
              COALESCE((
                SELECT count(*)=ps.card_count
                   AND count(*) FILTER (WHERE reservation.status='consumed')=ps.card_count
                  FROM public.partner_credit_reservations reservation
                 WHERE reservation.tenant_id=pci.partner_organisation_id
                   AND reservation.source='portal'
                   AND reservation.submission_reference=pci.partner_submission_id::text
              ), false) AS credit_settled,
              COALESCE((
                SELECT reservation.status='consumed'
                  FROM public.partner_credit_reservations reservation
                 WHERE reservation.id=job.reservation_id AND reservation.tenant_id=job.tenant_id
              ), false) AS card_job_credit_settled,
              COALESCE((
                SELECT count(DISTINCT evidence.side)=2
                  FROM public.certificate_image_evidence evidence
                  JOIN public.scanner_capture_sessions session
                    ON session.id=evidence.capture_metadata ->> 'captureSessionId'
                   AND session.certificate_id=evidence.certificate_id
                   AND session.side=evidence.side
                   AND session.state='captured'
                  JOIN public.partner_stations station
                    ON station.id=session.station_id
                   AND station.tenant_id=pci.partner_organisation_id
                   AND station.location_id=pci.partner_location_id
                   AND station.approved_at IS NOT NULL
                 WHERE evidence.certificate_id=c.id
                   AND evidence.is_current=true
                   AND evidence.evidence_class='NEW_IMMUTABLE_MASTER'
                   AND evidence.format='tiff'
              ), false) AS capture_complete
              ,COALESCE((
                SELECT count(DISTINCT evidence.side)=2
                  FROM public.certificate_image_evidence evidence
                  JOIN public.scanner_capture_sessions session
                    ON session.id=evidence.capture_metadata ->> 'captureSessionId'
                   AND session.certificate_id=evidence.certificate_id
                   AND session.side=evidence.side
                   AND session.state='captured'
                  JOIN public.partner_stations station
                    ON station.id=session.station_id
                   AND station.tenant_id=job.tenant_id
                   AND station.location_id=job.location_id
                   AND station.approved_at IS NOT NULL
                 WHERE evidence.certificate_id=c.id
                   AND evidence.is_current=true
                   AND evidence.evidence_class='NEW_IMMUTABLE_MASTER'
                   AND evidence.format='tiff'
              ), false) AS card_job_capture_complete
         FROM public.certificates c
         LEFT JOIN public.partner_card_jobs job ON job.certificate_id=c.id AND job.cancelled_at IS NULL
         LEFT JOIN public.submission_items si ON si.id=c.submission_item_id
         LEFT JOIN public.submissions s ON s.id=si.submission_id
         LEFT JOIN public.partner_connector_imports pci
           ON pci.destination_submission_id=s.id
          AND pci.state IN ('completed','imported')
          AND c.origin_partner_id=pci.partner_organisation_id
          AND c.origin_location_id=pci.partner_location_id
         LEFT JOIN public.partner_connector_records pcr
           ON pcr.id=pci.connector_record_id
          AND pcr.tenant_id=pci.partner_organisation_id
          AND pcr.partner_submission_id=pci.partner_submission_id
          AND pcr.handoff_id=pci.partner_handoff_id
          AND pcr.state='imported'
         LEFT JOIN public.partner_submissions ps
           ON ps.id=pci.partner_submission_id
          AND ps.tenant_id=pci.partner_organisation_id
          AND ps.location_id=pci.partner_location_id
        WHERE c.certificate_number=ANY($1::text[]) AND c.origin_type='PARTNER'`,
      [requested]
    );
    return new Map(
      result.rows.map((row) => [
        row.certificate_number,
        {
          certificateNumber: row.certificate_number,
          isCardJob: row.is_card_job === true,
          mappingValid: row.mapping_valid === true,
          cardJobValid: row.card_job_valid === true,
          qaComplete: row.qa_complete === true,
          printStateAllowsOutput: row.print_state_allows_output === true,
          creditSettled: row.is_card_job === true ? row.card_job_credit_settled === true : row.credit_settled === true,
          captureComplete:
            row.is_card_job === true ? row.card_job_capture_complete === true : row.capture_complete === true,
        },
      ])
    );
  }, 1_200);
}

export type PartnerGradingWriteAuthority = {
  lineage: "card_job" | "connector";
  certificateId: number;
  tenantId: string;
  locationId: string;
  cardJobId?: string | null;
  partnerSubmissionId: string;
  destinationSubmissionId?: number | null;
};

/**
 * Hold the authoritative Partner lineage rows stable while a main-pool CAS
 * mutation runs.  This avoids both a forbidden cross-authority main query and
 * a check-then-write race across the two credentials targeting the same DB.
 */
export async function withPartnerGradingWriteAuthority<T>(
  input: PartnerGradingWriteAuthority,
  operation: () => Promise<T>
): Promise<T> {
  if (
    !Number.isSafeInteger(input.certificateId) ||
    input.certificateId < 1 ||
    !UUID_RE.test(input.tenantId) ||
    !UUID_RE.test(input.locationId) ||
    !UUID_RE.test(input.partnerSubmissionId)
  ) {
    throw new Error("Partner grading write authority received invalid immutable scope");
  }
  return withPartnerAdminTransaction(async (client) => {
    if (input.lineage === "card_job") {
      if (!input.cardJobId || !UUID_RE.test(input.cardJobId)) {
        throw new Error("Partner card-job write authority requires a card job id");
      }
      const locked = await client.query(
        `SELECT 1
           FROM public.partner_card_jobs
          WHERE id=$1::uuid
            AND certificate_id=$2
            AND tenant_id=$3::uuid
            AND location_id=$4::uuid
            AND cancelled_at IS NULL
            AND status='GRADING'
          FOR SHARE`,
        [input.cardJobId, input.certificateId, input.tenantId, input.locationId]
      );
      if (locked.rows.length !== 1) throw new Error("Partner card-job write authority changed");
    } else {
      if (
        input.destinationSubmissionId == null ||
        !Number.isSafeInteger(input.destinationSubmissionId) ||
        input.destinationSubmissionId < 1
      ) {
        throw new Error("Partner connector write authority requires a destination submission");
      }
      const locked = await lockConnectorLineage(client, {
        destinationSubmissionId: input.destinationSubmissionId,
        tenantId: input.tenantId,
        locationId: input.locationId,
        partnerSubmissionId: input.partnerSubmissionId,
      });
      if (!locked) throw new Error("Partner connector write authority changed");
    }
    return operation();
  });
}

export type ScannerCaptureMainAnchor = {
  certificateId: number;
  cardId: number | null;
  submissionItemId: number | null;
  destinationSubmissionId: number | null;
  originType: string | null;
  originPartnerId: string | null;
  originLocationId: string | null;
};

export type ScannerCaptureOperationalAuthority = {
  stationId: string;
  stationCode: string;
  tenantId: string;
  locationId: string;
  lineage: "connector" | "card_job";
  calibrationId: string;
  acquisitionRegion: AcquisitionRegionMm;
};

/** Hold station, calibration, and lineage rows stable through the main arm transaction. */
export async function withScannerCaptureOperationalAuthority<T>(
  input: {
    stationId: string;
    workstationId: string;
    scannerProfileVersion: string;
    anchor: ScannerCaptureMainAnchor;
  },
  operation: (authority: ScannerCaptureOperationalAuthority) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(input.stationId)) throw new Error("Scanner station id is invalid");
  return withPartnerAdminTransaction(async (client) => {
    const stationResult = await client.query<Record<string, unknown>>(
      `SELECT station.id, station.station_code, station.tenant_id, station.location_id,
              calibration.id AS calibration_id, calibration.station_id,
              calibration.health_status, calibration.scanner_profile_version,
              calibration.calibration_version, calibration.acquisition_region
         FROM public.partner_stations station
         JOIN public.partner_station_calibrations calibration
           ON calibration.id=station.current_calibration_id
        WHERE station.id=$1::uuid AND station.status='ACTIVE'
        LIMIT 1
        FOR SHARE OF station, calibration`,
      [input.stationId]
    );
    const station = stationResult.rows[0];
    if (!station || String(station.station_code) !== input.workstationId) {
      throw new Error("Scanner workstation does not match the active station authority");
    }
    const tenantId = String(station.tenant_id);
    const locationId = String(station.location_id);
    if (
      input.anchor.originType !== "PARTNER" ||
      input.anchor.originPartnerId !== tenantId ||
      input.anchor.originLocationId !== locationId
    ) {
      throw new Error("Certificate is not bound to this station's tenant and location");
    }
    const acquisitionRegion = resolveAuthoritativeAcquisitionRegion(
      {
        id: station.calibration_id == null ? null : String(station.calibration_id),
        stationId: station.station_id == null ? null : String(station.station_id),
        healthStatus: station.health_status == null ? null : String(station.health_status),
        scannerProfileVersion: station.scanner_profile_version == null ? null : String(station.scanner_profile_version),
        calibrationVersion: station.calibration_version == null ? null : String(station.calibration_version),
        acquisitionRegion: station.acquisition_region,
      },
      { stationId: input.stationId, scannerProfileVersion: input.scannerProfileVersion }
    );

    let lineage: "connector" | "card_job" | null = null;
    const walkIn = input.anchor.cardId == null && input.anchor.submissionItemId == null;
    if (!walkIn && input.anchor.destinationSubmissionId != null) {
      const connector = await lockConnectorLineage(client, {
        destinationSubmissionId: input.anchor.destinationSubmissionId,
        tenantId,
        locationId,
      });
      if (connector) lineage = "connector";
    }
    if (!lineage) {
      const cardJob = await client.query(
        `SELECT 1
           FROM public.partner_card_jobs
          WHERE certificate_id=$1
            AND tenant_id=$2::uuid
            AND location_id=$3::uuid
            AND cancelled_at IS NULL
          FOR SHARE`,
        [input.anchor.certificateId, tenantId, locationId]
      );
      if (cardJob.rows.length === 1) lineage = "card_job";
    }
    if (!lineage) throw new Error("Certificate is not bound to this station's tenant and location");
    if (walkIn && lineage !== "card_job") {
      throw new Error("Walk-in scanner capture requires an active card-job binding");
    }
    return operation({
      stationId: input.stationId,
      stationCode: input.workstationId,
      tenantId,
      locationId,
      lineage,
      calibrationId: String(station.calibration_id),
      acquisitionRegion,
    });
  });
}

export const REQUIRED_PARTNER_OPERATIONAL_READ_RELATIONS = [
  "certificate_image_evidence",
  "certificates",
  "partner_card_jobs",
  "partner_connector_imports",
  "partner_connector_records",
  "partner_credit_reservations",
  "partner_organisations",
  "partner_station_calibrations",
  "partner_stations",
  "partner_submission_handoffs",
  "partner_submissions",
  "partner_users",
  "scanner_capture_sessions",
  "submission_items",
  "submissions",
] as const;

export const REQUIRED_PARTNER_OPERATIONAL_LOCK_RELATIONS = [
  "partner_card_jobs",
  "partner_connector_imports",
  "partner_connector_records",
  "partner_station_calibrations",
  "partner_stations",
  "partner_submission_handoffs",
  "partner_submissions",
] as const;

/** Execute bounded no-row probes so readiness proves relation authority, not just role flags. */
export async function partnerOperationalReadAuthorityReady(): Promise<boolean> {
  try {
    return await withPartnerAdminReadBudget(async () => {
      for (const relation of REQUIRED_PARTNER_OPERATIONAL_READ_RELATIONS) {
        await partnerAdminQuery(`SELECT 1 FROM public.${relation} WHERE false`);
      }
      // PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE even
      // though the adapter never mutates these rows. Prove the exact lock
      // capability that grading and scanner concurrency depend on. The
      // readiness budget itself is READ ONLY, so inspect ACLs rather than
      // attempting a row-locking statement inside that transaction.
      for (const relation of REQUIRED_PARTNER_OPERATIONAL_LOCK_RELATIONS) {
        const privilege = await partnerAdminQuery<{ can_lock: boolean }>(
          "SELECT has_table_privilege(current_user, $1, 'UPDATE') AS can_lock",
          [`public.${relation}`]
        );
        if (privilege.rows[0]?.can_lock !== true) return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

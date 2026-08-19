import { createHash } from "node:crypto";
import {
  COMMAND_CENTRE_CONTRACT_VERSION,
  COMMAND_CENTRE_KPI_IDS,
  type CommandCentreAttentionItem,
  type CommandCentreDashboardResponse,
  type CommandCentreKpiEnvelope,
  type CommandCentreKpiId,
  type CommandCentrePeriod,
  type CommandCentreSourceId,
} from "../../shared/command-centre";
import { serialiseCommandCentreRegistryForBrowser } from "./registry";
import { readCoreOperationalSnapshot } from "./core-read-adapter";
import { readPartnerDashboard } from "./partner-read-adapter";

type SourceConfig = {
  source: CommandCentreSourceId;
  deepLink: string;
  freshnessSeconds: number;
};

const config: Record<CommandCentreKpiId, SourceConfig> = {
  "partner-network-state": { source: "partner-dashboard-summary", deepLink: "/admin/partners", freshnessSeconds: 300 },
  "partner-onboarding-blocked": { source: "partner-operational-readiness", deepLink: "/admin/partners", freshnessSeconds: 300 },
  "partner-credit-projection": { source: "partner-wallet-projection", deepLink: "/admin/partners", freshnessSeconds: 60 },
  "station-lifecycle-state": { source: "partner-station-service", deepLink: "/admin/partners/stations", freshnessSeconds: 300 },
  "connector-exception-count": { source: "partner-connector-operations", deepLink: "/admin/partners/infrastructure", freshnessSeconds: 300 },
  "non-terminal-submissions": { source: "submissions-operational-state", deepLink: "/admin?tab=submissions", freshnessSeconds: 60 },
  "scan-queue-backlog": { source: "submissions-scan-queue", deepLink: "/admin?tab=scans", freshnessSeconds: 60 },
  "grading-queue-backlog": { source: "certificates-grading-queue", deepLink: "/admin?tab=certs", freshnessSeconds: 60 },
  "grade-review-awaiting-decision": { source: "certificates-review-queue", deepLink: "/admin?tab=certs", freshnessSeconds: 60 },
  "print-batch-exceptions": { source: "print-batches", deepLink: "/admin?tab=print-queue", freshnessSeconds: 60 },
  "ownership-transfer-exceptions": { source: "transfer-verifications", deepLink: "/admin?tab=transfers", freshnessSeconds: 300 },
  "paid-submissions-recorded": { source: "submissions-paid-recorded", deepLink: "/admin?tab=submissions", freshnessSeconds: 300 },
};

function success(
  id: CommandCentreKpiId,
  value: number | Record<string, number>,
  asOf: string,
): CommandCentreKpiEnvelope {
  const item = config[id];
  if (typeof value === "number" && value === 0) {
    return { status: "ZERO", value: 0, authoritativeZero: true, asOf, source: item.source, deepLink: item.deepLink, freshnessSeconds: item.freshnessSeconds };
  }
  return { status: "VALUE", value, asOf, source: item.source, deepLink: item.deepLink, freshnessSeconds: item.freshnessSeconds };
}

function failed(
  id: CommandCentreKpiId,
  status: "UNKNOWN" | "UNAVAILABLE" | "ERROR",
  reasonCode: string,
): CommandCentreKpiEnvelope {
  const item = config[id];
  return { status, reasonCode, source: item.source, deepLink: item.deepLink };
}

function opaque(ruleId: string, rawId: string): string {
  return createHash("sha256").update(ruleId + ":" + rawId).digest("hex").slice(0, 24);
}

function makeAttention(
  ruleId: string,
  rawId: string,
  title: string,
  reason: string,
  severity: CommandCentreAttentionItem["severity"],
  source: CommandCentreSourceId,
  deepLink: string,
  asOf: string,
  freshnessSeconds: number,
): CommandCentreAttentionItem {
  return { ruleId, itemId: opaque(ruleId, rawId), title, reason, severity, source, asOf, freshnessSeconds, deepLink };
}

function withinDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("TIMEOUT"));
    }, milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function composeDashboard(
  period: CommandCentrePeriod,
): Promise<CommandCentreDashboardResponse> {
  const asOf = new Date().toISOString();
  const [partnerResult, coreResult] = await Promise.allSettled([
    withinDeadline(readPartnerDashboard(), 1_500),
    withinDeadline(readCoreOperationalSnapshot(period), 1_500),
  ]);
  const kpis = {} as Record<CommandCentreKpiId, CommandCentreKpiEnvelope>;
  const attentionItems: CommandCentreAttentionItem[] = [];

  if (partnerResult.status === "rejected" || !partnerResult.value.available) {
    const reasonCode = partnerResult.status === "rejected"
      ? "PARTNER_ADAPTER_ERROR"
      : !partnerResult.value.available
        ? partnerResult.value.reasonCode
        : "PARTNER_ADAPTER_ERROR";
    const failureStatus = partnerResult.status === "rejected"
      ? "ERROR"
      : !partnerResult.value.available
        ? partnerResult.value.failureStatus
        : "ERROR";
    for (const id of [
      "partner-network-state",
      "partner-onboarding-blocked",
      "partner-credit-projection",
      "station-lifecycle-state",
      "connector-exception-count",
    ] as const) {
      kpis[id] = failed(id, failureStatus, reasonCode);
    }
    if (partnerResult.status === "fulfilled" && !partnerResult.value.available && partnerResult.value.visibilityFailure) {
      attentionItems.push(
        makeAttention(
          "ATT-PARTNER-VISIBILITY",
          "partner-source",
          "Partner source unavailable",
          "The cross-tenant Partner source cannot truthfully be read.",
          "CRITICAL",
          "partner-dashboard-summary",
          "/admin/partners",
          asOf,
          10,
        ),
      );
    }
  } else {
    const partner = partnerResult.value;
    kpis["partner-network-state"] = partner.network
      ? success("partner-network-state", partner.network, asOf)
      : failed("partner-network-state", "UNAVAILABLE", partner.networkReasonCode ?? "PARTNER_NETWORK_UNAVAILABLE");
    kpis["partner-onboarding-blocked"] = partner.onboardingBlocked
      ? success("partner-onboarding-blocked", partner.onboardingBlocked.length, asOf)
      : failed("partner-onboarding-blocked", "UNAVAILABLE", partner.onboardingReasonCode ?? "PARTNER_ONBOARDING_UNAVAILABLE");
    kpis["partner-credit-projection"] = partner.wallet
      ? success("partner-credit-projection", partner.wallet, asOf)
      : failed("partner-credit-projection", "UNAVAILABLE", "PARTNER_WALLET_UNAVAILABLE");
    kpis["station-lifecycle-state"] = partner.station
      ? success("station-lifecycle-state", partner.station.PENDING + partner.station.ACTIVE + partner.station.SUSPENDED + partner.station.REVOKED === 0 ? 0 : partner.station, asOf)
      : failed("station-lifecycle-state", "UNAVAILABLE", partner.stationReasonCode ?? "PARTNER_STATION_UNAVAILABLE");
    kpis["connector-exception-count"] = partner.connectorCount === null
      ? failed("connector-exception-count", "ERROR", partner.connectorReasonCode ?? "PARTNER_CONNECTOR_ADAPTER_ERROR")
      : success("connector-exception-count", partner.connectorCount, asOf);

    for (const candidate of partner.onboardingBlocked ?? []) {
      attentionItems.push(makeAttention("ATT-PARTNER-ONBOARDING-BLOCKED", candidate.id, "Partner onboarding blocked", "A canonical readiness gate says the Partner cannot operate.", "HIGH", "partner-operational-readiness", "/admin/partners/" + candidate.id + "/onboarding", candidate.timestamp || asOf, 300));
    }
    for (const candidate of partner.connectorCandidates) {
      attentionItems.push(makeAttention("ATT-CONNECTOR-EXCEPTION", candidate.id, "Connector exception requires review", "A connector record needs a human in its canonical console.", "HIGH", "partner-connector-operations", "/admin/partners/infrastructure", candidate.timestamp || asOf, 300));
    }
    if (partner.station && partner.station.PENDING > 0) {
      attentionItems.push({
        ruleId: "ATT-STATION-PENDING",
        itemId: "station-lifecycle-pending",
        title: "Station lifecycle pending",
        reason: "Station lifecycle work requires attention.",
        severity: "MEDIUM",
        source: "partner-station-service",
        asOf,
        freshnessSeconds: 300,
        deepLink: "/admin/partners/stations",
      });
    }
  }

  if (coreResult.status === "rejected") {
    for (const id of [
      "non-terminal-submissions",
      "scan-queue-backlog",
      "grading-queue-backlog",
      "grade-review-awaiting-decision",
      "print-batch-exceptions",
      "ownership-transfer-exceptions",
      "paid-submissions-recorded",
    ] as const) {
      kpis[id] = failed(id, "ERROR", "CORE_ADAPTER_ERROR");
    }
  } else {
    const core = coreResult.value;
    kpis["non-terminal-submissions"] = "value" in core.submissions
      ? core.submissions.value.unknownStatus
        ? failed("non-terminal-submissions", "UNKNOWN", "SUBMISSION_STATUS_VOCABULARY_UNKNOWN")
        : success("non-terminal-submissions", core.submissions.value.nonTerminal, asOf)
      : failed("non-terminal-submissions", "ERROR", core.submissions.error);
    kpis["scan-queue-backlog"] = "value" in core.scan
      ? success("scan-queue-backlog", core.scan.value.queue, asOf)
      : failed("scan-queue-backlog", "ERROR", core.scan.error);
    kpis["grading-queue-backlog"] = "value" in core.grading
      ? success("grading-queue-backlog", core.grading.value, asOf)
      : failed("grading-queue-backlog", "ERROR", core.grading.error);
    kpis["grade-review-awaiting-decision"] = "value" in core.review
      ? success("grade-review-awaiting-decision", core.review.value.count, asOf)
      : failed("grade-review-awaiting-decision", "ERROR", core.review.error);
    kpis["print-batch-exceptions"] = "value" in core.print
      ? success("print-batch-exceptions", core.print.value.count, asOf)
      : failed("print-batch-exceptions", "ERROR", core.print.error);
    kpis["ownership-transfer-exceptions"] = "value" in core.transfer
      ? success("ownership-transfer-exceptions", core.transfer.value.count, asOf)
      : failed("ownership-transfer-exceptions", "ERROR", core.transfer.error);
    kpis["paid-submissions-recorded"] = "value" in core.submissions
      ? core.submissions.value.paid.nonGbp > 0
        ? failed("paid-submissions-recorded", "UNKNOWN", "NON_GBP_PAYMENT_PRESENT")
        : success("paid-submissions-recorded", { count: core.submissions.value.paid.count, amount: core.submissions.value.paid.amount }, asOf)
      : failed("paid-submissions-recorded", "ERROR", core.submissions.error);
    for (const candidate of "value" in core.scan ? core.scan.value.candidates : []) {
      attentionItems.push(makeAttention("ATT-SCAN-UNASSIGNED", candidate.id, "Received submission awaits scan assignment", "A received, non-deleted submission still has no scan assignment.", "MEDIUM", "submissions-scan-queue", "/admin?tab=submissions", candidate.timestamp || asOf, 60));
    }
    for (const candidate of "value" in core.review ? core.review.value.candidates : []) {
      attentionItems.push(makeAttention("ATT-GRADE-REVIEW-PENDING", candidate.id, "Grade review awaits canonical decision", "A certificate has entered the existing review queue.", "HIGH", "certificates-review-queue", "/admin?tab=certs", candidate.timestamp || asOf, 60));
    }
    for (const candidate of "value" in core.print ? core.print.value.candidates : []) {
      attentionItems.push(makeAttention("ATT-PRINT-BATCH-EXCEPTION", candidate.id, "Print batch failed or partial", "A canonical print batch is failed or partially completed.", "HIGH", "print-batches", "/admin?tab=print-queue", candidate.timestamp || asOf, 60));
    }
    for (const candidate of "value" in core.transfer ? core.transfer.value.candidates : []) {
      attentionItems.push(makeAttention("ATT-OWNERSHIP-DISPUTE", candidate.id, "Ownership transfer disputed", "An unresolved canonical transfer dispute requires use of the existing transfer workspace.", "HIGH", "transfer-verifications", "/admin?tab=transfers", candidate.timestamp || asOf, 300));
    }
  }

  const severityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  const attention = attentionItems
    .sort((left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.asOf.localeCompare(right.asOf) ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.itemId.localeCompare(right.itemId),
    )
    .slice(0, 8);
  const partialSourceIds = COMMAND_CENTRE_KPI_IDS
    .map((id) => kpis[id])
    .filter((kpi) => ["UNKNOWN", "UNAVAILABLE", "ERROR", "STALE"].includes(kpi.status))
    .map((kpi) => kpi.source)
    .filter((source, index, all) => all.indexOf(source) === index);

  return {
    contractVersion: COMMAND_CENTRE_CONTRACT_VERSION,
    asOf,
    period,
    kpis,
    attention,
    registry: serialiseCommandCentreRegistryForBrowser(),
    partialSourceIds,
  };
}

/** The dashboard has a fixed end-to-end server budget in addition to source budgets. */
export function composeCommandCentreDashboard(
  period: CommandCentrePeriod,
): Promise<CommandCentreDashboardResponse> {
  return withinDeadline(composeDashboard(period), 2_000);
}

/**
 * Static MintVault Command Centre V1 metadata.
 *
 * This file carries navigation metadata only. It does not carry authority,
 * live values, query text, source rows, credentials, prompts or actions.
 */
export const COMMAND_CENTRE_CONTRACT_VERSION = "1.0.0";

export const COMMAND_CENTRE_DEPARTMENTS = [
  {
    id: "partner-network",
    displayName: "Partner Network",
  },
  {
    id: "grading-operations",
    displayName: "Grading Operations",
  },
  {
    id: "customer",
    displayName: "Customer",
  },
  {
    id: "finance",
    displayName: "Finance",
  },
] as const;

export const COMMAND_CENTRE_KPI_IDS = [
  "partner-network-state",
  "partner-onboarding-blocked",
  "partner-credit-projection",
  "station-lifecycle-state",
  "connector-exception-count",
  "non-terminal-submissions",
  "scan-queue-backlog",
  "grading-queue-backlog",
  "grade-review-awaiting-decision",
  "print-batch-exceptions",
  "ownership-transfer-exceptions",
  "paid-submissions-recorded",
] as const;

export const COMMAND_CENTRE_SOURCE_IDS = [
  "partner-dashboard-summary",
  "partner-operational-readiness",
  "partner-wallet-projection",
  "partner-station-service",
  "partner-connector-operations",
  "submissions-operational-state",
  "submissions-scan-queue",
  "certificates-grading-queue",
  "certificates-review-queue",
  "print-batches",
  "transfer-verifications",
  "submissions-paid-recorded",
  "deterministic-attention-policy",
] as const;

export type CommandCentreDepartmentId =
  (typeof COMMAND_CENTRE_DEPARTMENTS)[number]["id"];
export type CommandCentreKpiId = (typeof COMMAND_CENTRE_KPI_IDS)[number];
export type CommandCentreSourceId = (typeof COMMAND_CENTRE_SOURCE_IDS)[number];

type CommonDescriptor = {
  id: string;
  version: typeof COMMAND_CENTRE_CONTRACT_VERSION;
  displayName: string;
  departmentId: CommandCentreDepartmentId;
  outcome: string;
  visibility: "SUPER_ADMIN_ONLY";
  canonicalSourceRefs: readonly CommandCentreSourceId[];
  kpiIds: readonly CommandCentreKpiId[];
  safeInternalLinks: readonly string[];
  status: "ACTIVE" | "DEFERRED";
};

export type CommandCentreCapabilityDescriptor = CommonDescriptor & {
  kind: "CAPABILITY";
  automation: "HUMAN";
};

export type CommandCentrePolicyDescriptor = CommonDescriptor & {
  kind: "POLICY";
  automation: "SYSTEM_DETERMINISTIC";
};

export type CommandCentreDescriptor =
  | CommandCentreCapabilityDescriptor
  | CommandCentrePolicyDescriptor;

export const COMMAND_CENTRE_REGISTRY: readonly CommandCentreDescriptor[] = [
  {
    id: "partners.network-health-review",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review Partner Network state",
    departmentId: "partner-network",
    outcome: "Direct a Super Admin to the existing network overview for source-labelled review.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["partner-dashboard-summary"],
    kpiIds: ["partner-network-state"],
    safeInternalLinks: ["/admin/partners"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "partners.onboarding-readiness-review",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review blocked Partner onboarding",
    departmentId: "partner-network",
    outcome: "Open the relevant Partner readiness workspace.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["partner-operational-readiness"],
    kpiIds: ["partner-onboarding-blocked"],
    safeInternalLinks: ["/admin/partners/{partnerId}/onboarding"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "partners.credit-exposure-review",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review Partner credit projection",
    departmentId: "partner-network",
    outcome: "Open the canonical Partner wallet workspace for a safe projection summary.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["partner-wallet-projection"],
    kpiIds: ["partner-credit-projection"],
    safeInternalLinks: ["/admin/partners/{partnerId}/credits"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "partners.station-lifecycle-review",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review station lifecycle",
    departmentId: "partner-network",
    outcome: "Open the authoritative fleet view for aggregate lifecycle states.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["partner-station-service"],
    kpiIds: ["station-lifecycle-state"],
    safeInternalLinks: ["/admin/partners/stations"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "partners.connector-exception-triage",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review connector exceptions",
    departmentId: "partner-network",
    outcome: "Open canonical connector operations for manual-review exceptions.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["partner-connector-operations"],
    kpiIds: ["connector-exception-count"],
    safeInternalLinks: ["/admin/partners/infrastructure"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "grading.submission-status-triage",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review operational submissions",
    departmentId: "grading-operations",
    outcome: "Open canonical submission work for non-terminal records.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["submissions-operational-state"],
    kpiIds: ["non-terminal-submissions"],
    safeInternalLinks: ["/admin?tab=submissions"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "grading.scan-queue-triage",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review scan queue backlog",
    departmentId: "grading-operations",
    outcome: "Open the existing scan workspace.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["submissions-scan-queue"],
    kpiIds: ["scan-queue-backlog"],
    safeInternalLinks: ["/admin?tab=scans"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "grading.grading-queue-triage",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review grading queue backlog",
    departmentId: "grading-operations",
    outcome: "Open existing certificate and grading work.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["certificates-grading-queue"],
    kpiIds: ["grading-queue-backlog"],
    safeInternalLinks: ["/admin?tab=certs"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "grading.grade-review-queue",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review grades awaiting decision",
    departmentId: "grading-operations",
    outcome: "Open the existing certificate review workspace.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["certificates-review-queue"],
    kpiIds: ["grade-review-awaiting-decision"],
    safeInternalLinks: ["/admin?tab=certs"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "grading.print-queue-review",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review print exceptions",
    departmentId: "grading-operations",
    outcome: "Open the canonical print queue for failed or partial batches.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["print-batches"],
    kpiIds: ["print-batch-exceptions"],
    safeInternalLinks: ["/admin?tab=print-queue"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "customer.ownership-claim-support",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review disputed ownership transfer",
    departmentId: "customer",
    outcome: "Open the existing transfer workspace for an exception.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["transfer-verifications"],
    kpiIds: ["ownership-transfer-exceptions"],
    safeInternalLinks: ["/admin?tab=transfers"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "finance.paid-submission-summary",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "CAPABILITY",
    displayName: "Review paid submissions recorded",
    departmentId: "finance",
    outcome: "Review the narrowly named, period-bounded paid-submission total.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["submissions-paid-recorded"],
    kpiIds: ["paid-submissions-recorded"],
    safeInternalLinks: ["/admin?tab=submissions"],
    status: "ACTIVE",
    automation: "HUMAN",
  },
  {
    id: "policy.deterministic-attention",
    version: COMMAND_CENTRE_CONTRACT_VERSION,
    kind: "POLICY",
    displayName: "Deterministic Attention Policy",
    departmentId: "partner-network",
    outcome: "Place bounded, explainable exceptions before informational status.",
    visibility: "SUPER_ADMIN_ONLY",
    canonicalSourceRefs: ["deterministic-attention-policy"],
    kpiIds: [],
    safeInternalLinks: ["/admin/command"],
    status: "ACTIVE",
    automation: "SYSTEM_DETERMINISTIC",
  },
];

export const COMMAND_CENTRE_PERIODS = ["today", "month_to_date"] as const;
export type CommandCentrePeriod = (typeof COMMAND_CENTRE_PERIODS)[number];

export type CommandCentreKpiStatus =
  | "VALUE"
  | "ZERO"
  | "UNKNOWN"
  | "UNAVAILABLE"
  | "STALE"
  | "ERROR"
  | "NOT_AUTHORISED";

export type CommandCentreKpiValue = number | Record<string, number>;

type CommandCentreKpiBase = {
  status: CommandCentreKpiStatus;
  source: CommandCentreSourceId;
  deepLink: string;
  asOf?: string;
};

export type CommandCentreKpiEnvelope =
  | (CommandCentreKpiBase & {
      status: "VALUE";
      value: CommandCentreKpiValue;
      asOf: string;
      freshnessSeconds: number;
    })
  | (CommandCentreKpiBase & {
      status: "ZERO";
      value: 0;
      authoritativeZero: true;
      asOf: string;
      freshnessSeconds: number;
    })
  | (CommandCentreKpiBase & {
      status: "UNKNOWN" | "UNAVAILABLE" | "ERROR";
      reasonCode: string;
    })
  | (CommandCentreKpiBase & {
      status: "STALE";
      lastValue: CommandCentreKpiValue;
      asOf: string;
      staleAfterSeconds: number;
    })
  | (CommandCentreKpiBase & {
      status: "NOT_AUTHORISED";
    });

export type CommandCentreAttentionItem = {
  ruleId: string;
  itemId: string;
  title: string;
  reason: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  source: CommandCentreSourceId;
  asOf: string;
  freshnessSeconds: number;
  deepLink: string;
};

export type CommandCentreDashboardResponse = {
  contractVersion: typeof COMMAND_CENTRE_CONTRACT_VERSION;
  asOf: string;
  period: CommandCentrePeriod;
  kpis: Record<CommandCentreKpiId, CommandCentreKpiEnvelope>;
  attention: readonly CommandCentreAttentionItem[];
  registry: readonly CommandCentreDescriptor[];
  partialSourceIds: readonly CommandCentreSourceId[];
};

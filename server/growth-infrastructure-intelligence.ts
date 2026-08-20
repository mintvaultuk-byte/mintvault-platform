/**
 * Growth infrastructure intelligence is deliberately a read/recommendation
 * boundary. It contains no provider client, credential lookup or mutation
 * method. Provider adapters can populate these DTOs only after a separate
 * least-privilege approval.
 */
import type {
  CapacityStatus,
  HealthStatus,
  IntelligenceMetric,
  IntelligenceState,
} from "./growth-intelligence-service";

export type FlyMachineSnapshot = {
  machineRef: string;
  status: HealthStatus;
  region: string;
  cpu: IntelligenceMetric;
  memory: IntelligenceMetric;
  requestRate: IntelligenceMetric;
  p95Latency: IntelligenceMetric;
  fiveXErrorRate: IntelligenceMetric;
  deployedVersion: IntelligenceMetric;
  deployedSha: IntelligenceMetric;
};

export type ProviderCostSnapshot = {
  provider: "Fly" | "Neon" | "R2" | "Resend";
  state: Exclude<IntelligenceState, "REAL"> | "REAL";
  status: HealthStatus;
  period: "MONTH_TO_DATE";
  sourceCurrency: string | null;
  amountMajor?: number;
  reason?: string;
  lastUpdated: string | null;
};

export type InfrastructureIntelligence = {
  overallStatus: HealthStatus;
  control: {
    currentMode: "MANUAL";
    currentAuthority: "MONITOR_DETECT_RECOMMEND";
    mutationEnabled: false;
    automaticScalingEnabled: false;
    futureMode: "GUARDED_AUTO_REQUIRES_SEPARATE_APPROVAL";
    futureModeAvailable: false;
    safetyBoundary: string;
  };
  fly: {
    connection: IntelligenceMetric;
    overallStatus: HealthStatus;
    machines: FlyMachineSnapshot[];
    expectedMachineFields: string[];
  };
  neon: {
    availability: IntelligenceMetric;
    connectionPressure: IntelligenceMetric;
    latency: IntelligenceMetric;
    compute: IntelligenceMetric;
    storage: IntelligenceMetric;
    pointInTimeRecovery: IntelligenceMetric;
    mutationEnabled: false;
  };
  costs: {
    period: "MONTH_TO_DATE";
    providers: ProviderCostSnapshot[];
    trend: IntelligenceMetric;
    normalisedTotalGBP: IntelligenceMetric;
    costPerPaidCardGBP: IntelligenceMetric;
    costPerPaidOrderGBP: IntelligenceMetric;
    currencyPolicy: string;
  };
  budget: {
    state: "NOT_CONFIGURED";
    status: "UNKNOWN";
    monthlyBudgetPence: null;
    automaticShutdownEnabled: false;
    automaticSpendEnabled: false;
    reason: string;
  };
  lastUpdated: string;
};

export type CampaignReadiness = {
  status: HealthStatus;
  label: "READY" | "CAUTION" | "NOT_READY" | "INSUFFICIENT_TELEMETRY";
  recommendation: string;
  evidence: string[];
  advisoryOnly: true;
  definition: string;
};

export type IncidentMode =
  | {
      status: "ACTIVE";
      severity: "RED";
      priorityKey:
        | "PAYMENTS"
        | "SUBMISSION_CHECKOUT"
        | "DATABASE"
        | "APPLICATION_ERRORS"
        | "CAPACITY"
        | "FLY_MACHINES"
        | "PARTNER_APPLICATIONS";
      title: string;
      detail: string;
      recommendation: string;
    }
  | {
      status: "CLEAR";
      severity: null;
      priorityKey: null;
      title: string;
      detail: string;
      recommendation: string;
    };

export type RevenueVelocity = {
  window: "60m";
  minimumPaidSample: 3;
  paidSubmissionsPerHour: IntelligenceMetric;
  paidCardsPerHour: IntelligenceMetric;
  revenuePencePerHour: IntelligenceMetric;
  comparison: IntelligenceMetric;
  definition: string;
  lastUpdated: string;
};

type ReadinessInput = {
  site: IntelligenceMetric;
  payments: IntelligenceMetric;
  database: IntelligenceMetric;
  fiveXErrorRate: IntelligenceMetric;
  flyMachines: IntelligenceMetric;
  capacity: CapacityStatus;
};

type IncidentInput = ReadinessInput & { partnerApi: IntelligenceMetric };

function unavailable(state: Exclude<IntelligenceState, "REAL">, source: string, reason: string): IntelligenceMetric {
  return { state, status: "UNKNOWN", source, reason, lastUpdated: null };
}

export function deriveRevenueVelocity(
  values: { paidSubmissions: number; paidCards: number; revenuePence: number },
  now: string
): RevenueVelocity {
  const source = "Rolling 60-minute verified GBP Stripe payment_timestamp window";
  const enoughData = values.paidSubmissions >= 3;
  const metric = (value: number, unit: string): IntelligenceMetric =>
    enoughData
      ? { state: "REAL", status: "GREEN", value, unit, source, lastUpdated: now }
      : {
          state: "INSUFFICIENT_DATA",
          status: "UNKNOWN",
          source,
          reason: `At least 3 verified paid submissions are required; ${values.paidSubmissions} observed.`,
          lastUpdated: now,
        };
  return {
    window: "60m",
    minimumPaidSample: 3,
    paidSubmissionsPerHour: metric(values.paidSubmissions, "paid submissions/hour"),
    paidCardsPerHour: metric(values.paidCards, "cards/hour"),
    revenuePencePerHour: metric(values.revenuePence, "GBP pence/hour"),
    comparison: unavailable(
      "NOT_INSTRUMENTED",
      "MintVault revenue velocity",
      "A like-for-like previous-window comparison is not instrumented."
    ),
    definition:
      "Exact activity in the rolling 60-minute window, not a forecast. Revenue includes only verified GBP paid submissions. Tiny paid samples are withheld.",
    lastUpdated: now,
  };
}

export function deriveCampaignReadiness(input: ReadinessInput): CampaignReadiness {
  const signals = [
    ["Site readiness", input.site.status, input.site.state],
    ["Payment authority", input.payments.status, input.payments.state],
    ["Database availability", input.database.status, input.database.state],
    ["5xx error rate", input.fiveXErrorRate.status, input.fiveXErrorRate.state],
    ["Fly machine health", input.flyMachines.status, input.flyMachines.state],
    ["Capacity", input.capacity.status, input.capacity.status === "UNKNOWN" ? "NOT_CONNECTED" : "REAL"],
  ] as const;
  const red = signals.filter(([, status]) => status === "RED");
  if (red.length) {
    return {
      status: "RED",
      label: "NOT_READY",
      recommendation: "Resolve the red revenue-path condition before increasing campaign traffic.",
      evidence: red.map(([label]) => `${label} is red.`),
      advisoryOnly: true,
      definition:
        "Deterministic site, payment, database, error, machine-health and capacity readiness; never starts or stops a campaign.",
    };
  }
  const unknown = signals.filter(([, status, state]) => status === "UNKNOWN" || state !== "REAL");
  if (unknown.length) {
    return {
      status: "UNKNOWN",
      label: "INSUFFICIENT_TELEMETRY",
      recommendation: "Connect the missing revenue-path telemetry before treating the system as campaign-ready.",
      evidence: unknown.map(([label]) => `${label} is unavailable or incomplete.`),
      advisoryOnly: true,
      definition:
        "Deterministic site, payment, database, error, machine-health and capacity readiness; never starts or stops a campaign.",
    };
  }
  const amber = signals.filter(([, status]) => status === "AMBER");
  if (amber.length) {
    return {
      status: "AMBER",
      label: "CAUTION",
      recommendation: "Review the amber signals and owner-approved capacity plan before increasing traffic.",
      evidence: amber.map(([label]) => `${label} is amber.`),
      advisoryOnly: true,
      definition:
        "Deterministic site, payment, database, error, machine-health and capacity readiness; never starts or stops a campaign.",
    };
  }
  return {
    status: "GREEN",
    label: "READY",
    recommendation: "No infrastructure caution is indicated by the connected readiness signals.",
    evidence: ["All required connected readiness signals are green."],
    advisoryOnly: true,
    definition:
      "Deterministic site, payment, database, error, machine-health and capacity readiness; never starts or stops a campaign.",
  };
}

export function deriveIncidentMode(input: IncidentInput): IncidentMode {
  const priority = [
    {
      key: "PAYMENTS",
      title: "Payment infrastructure incident",
      status: input.payments.status,
      detail: input.payments.reason ?? `${input.payments.source} reported a red condition.`,
    },
    {
      key: "SUBMISSION_CHECKOUT",
      title: "Submission or checkout service incident",
      status: input.site.status,
      detail: input.site.reason ?? `${input.site.source} reported a red condition.`,
    },
    {
      key: "DATABASE",
      title: "Database availability incident",
      status: input.database.status,
      detail: input.database.reason ?? `${input.database.source} reported a red condition.`,
    },
    {
      key: "APPLICATION_ERRORS",
      title: "Application error-rate incident",
      status: input.fiveXErrorRate.status,
      detail: input.fiveXErrorRate.reason ?? `${input.fiveXErrorRate.source} reported a red condition.`,
    },
    {
      key: "CAPACITY",
      title: "Capacity incident",
      status: input.capacity.status,
      detail: input.capacity.evidence.join(" ") || "The correlated capacity model reported a red condition.",
    },
    {
      key: "FLY_MACHINES",
      title: "Fly machine-health incident",
      status: input.flyMachines.status,
      detail: input.flyMachines.reason ?? `${input.flyMachines.source} reported a red condition.`,
    },
    {
      key: "PARTNER_APPLICATIONS",
      title: "Partner application service incident",
      status: input.partnerApi.status,
      detail: input.partnerApi.reason ?? `${input.partnerApi.source} reported a red condition.`,
    },
  ] as const;
  const active = priority.find((signal) => signal.status === "RED");
  if (!active) {
    return {
      status: "CLEAR",
      severity: null,
      priorityKey: null,
      title: "No connected red revenue-path incident",
      detail: "Unknown and unconnected signals remain unknown; this is not an all-systems-healthy claim.",
      recommendation: "Continue monitoring connected authorities.",
    };
  }
  return {
    status: "ACTIVE",
    severity: "RED",
    priorityKey: active.key,
    title: active.title,
    detail: active.detail,
    recommendation: "Prioritise this revenue-path incident before ordinary Growth insights or campaign changes.",
  };
}

export function buildInfrastructureIntelligence(
  input: {
    database: IntelligenceMetric;
    databasePressure?: IntelligenceMetric;
    databaseLatency?: IntelligenceMetric;
    capacity: CapacityStatus;
  },
  now: string
): InfrastructureIntelligence {
  const flyReason = "A least-privilege server-side Fly telemetry authority is not connected.";
  const neonReason = "A least-privilege server-side Neon telemetry authority is not connected.";
  const costReason = "Authoritative provider billing data is not connected; no cost is estimated.";
  const notConnected = (source: string, reason: string) => unavailable("NOT_CONNECTED", source, reason);
  return {
    overallStatus: input.capacity.status,
    control: {
      currentMode: "MANUAL",
      currentAuthority: "MONITOR_DETECT_RECOMMEND",
      mutationEnabled: false,
      automaticScalingEnabled: false,
      futureMode: "GUARDED_AUTO_REQUIRES_SEPARATE_APPROVAL",
      futureModeAvailable: false,
      safetyBoundary:
        "No Fly or Neon mutation is available. A future guarded mode requires approved machine, capacity, budget, cooldown, sustained-window, confirmation, audit and rollback controls.",
    },
    fly: {
      connection: notConnected("Fly fleet telemetry", flyReason),
      overallStatus: input.capacity.status,
      machines: [],
      expectedMachineFields: [
        "status",
        "region",
        "cpu",
        "memory",
        "requestRate",
        "p95Latency",
        "fiveXErrorRate",
        "deployedVersion",
        "deployedSha",
      ],
    },
    neon: {
      availability: input.database,
      connectionPressure:
        input.databasePressure ?? notConnected("Current application PostgreSQL pool counters", neonReason),
      latency: input.databaseLatency ?? notConnected("Current application database readiness query", neonReason),
      compute: notConnected("Neon telemetry", neonReason),
      storage: notConnected("Neon telemetry", neonReason),
      pointInTimeRecovery: notConnected("Neon telemetry", neonReason),
      mutationEnabled: false,
    },
    costs: {
      period: "MONTH_TO_DATE",
      providers: (["Fly", "Neon", "R2", "Resend"] as const).map((provider) => ({
        provider,
        state: "NOT_CONNECTED",
        status: "UNKNOWN",
        period: "MONTH_TO_DATE",
        sourceCurrency: null,
        reason: costReason,
        lastUpdated: null,
      })),
      trend: notConnected("Provider billing authorities", costReason),
      normalisedTotalGBP: notConnected(
        "Approved provider billing and FX authority",
        "No approved, traceable FX conversion authority is connected, so no GBP-normalised total is shown."
      ),
      costPerPaidCardGBP: notConnected("Provider billing authorities", costReason),
      costPerPaidOrderGBP: notConnected("Provider billing authorities", costReason),
      currencyPolicy:
        "Each connected provider cost remains in its authoritative source currency. GBP normalisation requires an approved, traceable FX source.",
    },
    budget: {
      state: "NOT_CONFIGURED",
      status: "UNKNOWN",
      monthlyBudgetPence: null,
      automaticShutdownEnabled: false,
      automaticSpendEnabled: false,
      reason:
        "No owner-approved monthly infrastructure budget is configured; no shutdown or spend action is automated.",
    },
    lastUpdated: now,
  };
}

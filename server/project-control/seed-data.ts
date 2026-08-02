/**
 * Project Control — canonical seed DATA.
 *
 * Deliberately separated from seed.ts so the founder-facing programme definition can be unit
 * tested without importing a database connection. Nothing in this file performs I/O.
 */

import { LAUNCH_GATE_KEYS } from "@shared/project-control-launch";

import type { AcceptanceCriterion, IssueClass, RequiredTest, RiskLevel, WorkStatus } from "@shared/project-control";

export interface SeedNode {
  key: string;
  parentKey: string | null;
  name: string;
  description: string;
  sortOrder: number;
}

export const NODES: SeedNode[] = [
  {
    key: "mintvault",
    parentKey: null,
    name: "MintVault",
    description: "Everything MintVault builds and runs.",
    sortOrder: 0,
  },

  {
    key: "core-platform",
    parentKey: "mintvault",
    name: "Core Platform",
    description: "Grading engine, admin shell, auth, database, deployment substrate.",
    sortOrder: 10,
  },
  {
    key: "scanner",
    parentKey: "mintvault",
    name: "Scanner",
    description: "Capture pipeline: scanner Macs, ingestion, crop, image derivatives.",
    sortOrder: 20,
  },
  {
    key: "printing",
    parentKey: "mintvault",
    name: "Printing",
    description: "Approval → Printing → Printed lifecycle, label render, print batches.",
    sortOrder: 30,
  },
  {
    key: "certificates",
    parentKey: "mintvault",
    name: "Certificates",
    description: "Certificate records, public lookup, QR/NFC verification, logbook.",
    sortOrder: 40,
  },
  {
    key: "set-library",
    parentKey: "mintvault",
    name: "Set Library",
    description: "Set data, set-name editing, TCGdex-derived set information.",
    sortOrder: 50,
  },
  {
    key: "catalogue",
    parentKey: "mintvault",
    name: "Catalogue",
    description: "Database-backed classification catalogue replacing hard-coded lists.",
    sortOrder: 60,
  },

  {
    key: "partner-network",
    parentKey: "mintvault",
    name: "Partner Network",
    description: "The partner shop programme: onboarding, portal, credits, pilot, launch.",
    sortOrder: 70,
  },

  // ---- The APPROVED Shop Launch sequence, 1–10. Order is load-bearing and test-asserted. ----
  {
    key: "pn-g5",
    parentKey: "partner-network",
    name: "G5 — Partner Management",
    description: "Partner organisation records and super-admin management.",
    sortOrder: 10,
  },
  {
    key: "pn-g6a",
    parentKey: "partner-network",
    name: "G6A — Wallet and immutable ledger",
    description: "Partner wallet and append-only credit ledger.",
    sortOrder: 20,
  },
  {
    key: "pn-g6b",
    parentKey: "partner-network",
    name: "G6B — Reserve, consume and release credits",
    description: "Credit reservation lifecycle against submissions.",
    sortOrder: 30,
  },
  {
    key: "pn-g6c",
    parentKey: "partner-network",
    name: "G6C — Super Admin credit management",
    description: "Super-admin credit issuance and adjustment, fully audited.",
    sortOrder: 40,
  },
  {
    key: "pn-g6d",
    parentKey: "partner-network",
    name: "G6D — Submission and grading integration",
    description: "Wiring credit consumption into submission and grading.",
    sortOrder: 50,
  },
  {
    key: "pn-auth",
    parentKey: "partner-network",
    name: "Partner authentication, invitations and RBAC",
    description: "Partner login, invitation flow, MFA, role-based access control.",
    sortOrder: 60,
  },
  {
    key: "pn-portal",
    parentKey: "partner-network",
    name: "Basic Partner Portal",
    description: "The isolated partner-facing application.",
    sortOrder: 70,
  },
  {
    key: "pn-stripe-credits",
    parentKey: "partner-network",
    name: "Stripe credit packages and idempotent fulfilment",
    description: "Buying grading credits through Stripe, fulfilled exactly once.",
    sortOrder: 80,
  },
  {
    key: "pn-pilot",
    parentKey: "partner-network",
    name: "Pilot with one or two shops",
    description: "First live partner shops under supervision.",
    sortOrder: 90,
  },
  {
    key: "pn-launch",
    parentKey: "partner-network",
    name: "Pilot fixes and wider opening",
    description: "Fix what the pilot exposes, then open partner sign-up more widely.",
    sortOrder: 100,
  },

  // ---- The remaining approved backlog. Present as FUTURE work, never as cancelled. ----
  {
    key: "pn-backlog",
    parentKey: "partner-network",
    name: "G7–G20 backlog",
    description:
      "Approved partner-network work beyond the pilot. Not started, not cancelled — carried so programme readiness is measured against the real scope.",
    sortOrder: 110,
  },

  {
    key: "vault-quest",
    parentKey: "mintvault",
    name: "Vault Quest",
    description: "The collectible game programme: character bible, card studio, production studio.",
    sortOrder: 80,
  },
  {
    key: "future-features",
    parentKey: "mintvault",
    name: "Future Features",
    description: "Planned work not yet started.",
    sortOrder: 90,
  },
  {
    key: "technical-debt",
    parentKey: "mintvault",
    name: "Technical Debt",
    description: "Known defects, hardening, and cleanup carried forward.",
    sortOrder: 100,
  },
];

export interface SeedPackage {
  key: string;
  nodeKey: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  classification: IssueClass;
  businessValue: number;
  engineeringRisk: number;
  remainingWork: string;
  tags?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  requiredTests?: RequiredTest[];
}

/** Standard gate set for any code-bearing work package. */
const STANDARD_TESTS: RequiredTest[] = [
  { id: "tsc", name: "TypeScript compiles", kind: "typescript" },
  { id: "vitest", name: "Full Vitest suite passes", kind: "vitest" },
  { id: "lint", name: "ESLint clean on touched files", kind: "lint" },
];

const criterion = (id: string, text: string): AcceptanceCriterion => ({ id, text, met: false, evidenceRef: null });

/** A backlog gate that has not been started. Deliberately uniform and deliberately empty of claims. */
function backlogPackage(key: string, title: string, summary: string, businessValue = 3): SeedPackage {
  return {
    key,
    nodeKey: "pn-backlog",
    title,
    summary,
    risk: "moderate",
    classification: "H",
    businessValue,
    engineeringRisk: 3,
    remainingWork:
      "Not started. Scope, acceptance criteria and sequencing to be agreed with the founder before any build begins.",
    tags: ["shop-launch", "backlog"],
    requiredTests: STANDARD_TESTS,
  };
}

export const PACKAGES: SeedPackage[] = [
  {
    key: "core-grading-engine",
    nodeKey: "core-platform",
    title: "MVGS grading engine",
    summary:
      "Scoring, sub-grades, centering, Pristine gate, approve-lock. Protected system — changes need founder approval.",
    risk: "critical",
    classification: "A",
    businessValue: 5,
    engineeringRisk: 5,
    remainingWork:
      "None outstanding. This system is protected: no change without explicit founder approval. Production verification is recorded as unproven here because the dashboard holds no production check for it yet — that is a gap in the evidence, not in the product.",
    tags: ["protected"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [criterion("mvgs-regression", "The full MVGS regression suite passes on the current commit.")],
  },
  {
    key: "certificate-lookup",
    nodeKey: "certificates",
    title: "Certificate lookup and verification",
    summary: "Public cert lookup by ID, QR and NFC verification path.",
    risk: "high",
    classification: "A",
    businessValue: 5,
    engineeringRisk: 3,
    remainingWork: "Record a production check so the production category can be evidenced rather than assumed.",
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "print-workflow-lifecycle",
    nodeKey: "printing",
    title: "Approval → Printing → Printed lifecycle",
    summary: "Print state machine, print batches, append-only print event ledger. Migration 0022.",
    risk: "high",
    classification: "E",
    businessValue: 4,
    engineeringRisk: 4,
    remainingWork:
      "Confirm the full lifecycle end to end in production, and set up at least one account holding the print capability.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("print-lifecycle", "A certificate moves approval → printing → printed in production."),
      criterion("print-capability", "At least one staff account holds the print capability."),
    ],
  },
  {
    key: "set-library-migration-ownership",
    nodeKey: "set-library",
    title: "Set Library migration ownership",
    summary: "Removed runtime DDL from the Set Library path so schema changes come only from numbered migrations.",
    risk: "high",
    classification: "E",
    businessValue: 3,
    engineeringRisk: 4,
    remainingWork: "Record the production check that proved the Set Library serving correctly after the release.",
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "catalogue-manager",
    nodeKey: "catalogue",
    title: "Catalogue Manager",
    summary: "Database-backed classification catalogue replacing hard-coded arrays.",
    risk: "moderate",
    classification: "E",
    businessValue: 3,
    engineeringRisk: 3,
    remainingWork:
      "Verify catalogue CRUD, RBAC and archive behaviour against a real environment. Migration and deployment state are read from the live ledger and recorded deployments, not asserted here.",
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "scanner-pipeline",
    nodeKey: "scanner",
    title: "Scanner capture pipeline",
    summary: "Multi-scanner ingestion, race hardening, self-update, operations pack.",
    risk: "high",
    classification: "D",
    businessValue: 4,
    engineeringRisk: 4,
    remainingWork: "Manual pull on each scanner Mac, then confirm each station is on the current build.",
    tags: ["scanner"],
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "scanner-crop-integrity",
    nodeKey: "scanner",
    title: "Front-crop integrity gate",
    summary: "Guard against a bad front crop reaching the display image and the printed label.",
    risk: "high",
    classification: "C",
    businessValue: 4,
    engineeringRisk: 4,
    remainingWork: "Complete the review, then prove the gate on staging with real captures before deploying.",
    tags: ["scanner"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("crop-gate", "A deliberately bad crop is rejected before it reaches a printed label."),
    ],
  },
  {
    key: "partner-network-g5",
    nodeKey: "pn-g5",
    title: "Partner management (G5)",
    summary: "Partner organisation records, accreditation, super-admin management surface.",
    risk: "moderate",
    classification: "E",
    businessValue: 4,
    engineeringRisk: 3,
    remainingWork: "Feature flags remain off and the portal is unmounted — verify behind the flag before enabling.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "partner-wallet-g6a",
    nodeKey: "pn-g6a",
    title: "Partner wallet and immutable ledger (G6A)",
    summary: "The append-only credit ledger every later credit feature depends on.",
    risk: "high",
    classification: "E",
    businessValue: 5,
    engineeringRisk: 4,
    remainingWork: "Review, then apply the ledger migration on staging and prove balances reconcile.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("ledger-append-only", "The ledger cannot be updated or deleted, only appended."),
      criterion("balance-reconciles", "Wallet balance equals the sum of its ledger entries."),
    ],
  },
  {
    key: "partner-credit-reservations-g6b",
    nodeKey: "pn-g6b",
    title: "Reserve, consume and release credits (G6B)",
    summary: "Reserving credits so a submission cannot spend the same credit twice.",
    risk: "high",
    classification: "E",
    businessValue: 5,
    engineeringRisk: 4,
    remainingWork: "Review and prove the reservation cannot double-spend under concurrent submissions.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [criterion("no-double-spend", "Two concurrent submissions cannot consume the same credit.")],
  },
  {
    key: "partner-admin-credits-g6c",
    nodeKey: "pn-g6c",
    title: "Super Admin credit management (G6C)",
    summary: "Super-admin issuing and adjusting partner credits, with audit.",
    risk: "moderate",
    classification: "B",
    businessValue: 4,
    engineeringRisk: 3,
    remainingWork: "Review, then verify every adjustment writes an audit entry.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("credit-audit", "Every credit adjustment writes an audit entry naming the actor and reason."),
    ],
  },
  {
    key: "partner-submission-credits-g6d",
    nodeKey: "pn-g6d",
    title: "Submission and grading integration (G6D)",
    summary: "Consuming reserved credits when a partner submission is accepted.",
    risk: "critical",
    classification: "E",
    businessValue: 5,
    engineeringRisk: 5,
    remainingWork:
      "Resolve the migration numbering collision, complete the review, then prove credit consumption is bound to the credit owner and not to a submission email.",
    tags: ["shop-launch", "money"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("owner-binding", "Credit consumption is bound to the credit owner, never to a submission email."),
    ],
  },
  {
    key: "partner-auth-rbac",
    nodeKey: "pn-auth",
    title: "Partner authentication, invitations and RBAC",
    summary: "Partner login, invitation flow, MFA, role-based access control.",
    risk: "critical",
    classification: "C",
    businessValue: 5,
    engineeringRisk: 5,
    remainingWork: "Security review, then staging proof that a partner can never reach admin data.",
    tags: ["shop-launch", "security"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("no-cross-tenant", "A partner session cannot read another tenant's or the admin's data."),
    ],
  },
  {
    key: "partner-portal",
    nodeKey: "pn-portal",
    title: "Basic Partner Portal",
    summary: "The separate partner-facing app with its own session and API namespace.",
    risk: "high",
    classification: "C",
    businessValue: 5,
    engineeringRisk: 4,
    remainingWork:
      "Prove tenant isolation on staging: a partner session must never reach another tenant's data or any admin surface. Whether the portal is currently mounted is read from live evidence, not asserted here.",
    tags: ["shop-launch"],
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "partner-stripe-credits",
    nodeKey: "pn-stripe-credits",
    title: "Stripe credit packages and idempotent fulfilment",
    summary: "Partner credit purchase through Stripe, fulfilled exactly once. Money path — highest care.",
    risk: "critical",
    classification: "F",
    businessValue: 5,
    engineeringRisk: 5,
    remainingWork:
      "Design the purchase flow on top of the wallet ledger. Nothing may touch the existing webhook without approval.",
    tags: ["shop-launch", "money"],
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [criterion("exactly-once", "A repeated webhook delivery credits the wallet exactly once.")],
  },
  {
    key: "partner-pilot",
    nodeKey: "pn-pilot",
    title: "Pilot with one or two shops",
    summary: "A small number of real shops using the system under supervision.",
    risk: "high",
    classification: "G",
    businessValue: 5,
    engineeringRisk: 3,
    remainingWork: "Cannot start until credits, authentication and the portal are all verified in production.",
    tags: ["shop-launch"],
  },
  {
    key: "partner-public-launch",
    nodeKey: "pn-launch",
    title: "Pilot fixes and wider opening",
    summary: "Fix what the pilot exposes, then open partner sign-up more widely.",
    risk: "high",
    classification: "G",
    businessValue: 5,
    engineeringRisk: 4,
    remainingWork: "Depends entirely on a successful pilot.",
    tags: ["shop-launch"],
  },

  // ---- G7–G20: approved backlog, carried as future work, never cancelled ----
  backlogPackage(
    "partner-g7-submission-intake",
    "G7 — Partner submission intake at volume",
    "Bulk intake from partner shops, batching and labelling.",
    4
  ),
  backlogPackage(
    "partner-g8-shipping-logistics",
    "G8 — Shipping and logistics",
    "Inbound and outbound shipping, tracking, insured movement.",
    4
  ),
  backlogPackage(
    "partner-g9-partner-reporting",
    "G9 — Partner reporting and statements",
    "Per-partner throughput, spend, and statement generation.",
    3
  ),
  backlogPackage(
    "partner-g10-sla-turnaround",
    "G10 — SLA and turnaround management",
    "Turnaround commitments, ageing, and breach handling.",
    3
  ),
  backlogPackage(
    "partner-g11-pricing-tiers",
    "G11 — Partner pricing tiers",
    "Tiered partner pricing and volume discounts.",
    3
  ),
  backlogPackage(
    "partner-g12-dispute-handling",
    "G12 — Dispute and claim handling",
    "Damage, loss and grading disputes with partners.",
    4
  ),
  backlogPackage(
    "partner-g13-partner-onboarding",
    "G13 — Self-service partner onboarding",
    "Application, accreditation and automated onboarding.",
    3
  ),
  backlogPackage(
    "partner-g14-partner-support",
    "G14 — Partner support tooling",
    "Support queue and partner-facing help.",
    2
  ),
  backlogPackage(
    "partner-g15-fraud-controls",
    "G15 — Fraud and abuse controls",
    "Detecting abusive submission and credit patterns.",
    4
  ),
  backlogPackage(
    "partner-g16-capacity-planning",
    "G16 — Capacity planning at partner scale",
    "Grading capacity forecasting for many shops.",
    3
  ),
  backlogPackage(
    "partner-g17-partner-api",
    "G17 — Partner API",
    "Programmatic submission and status for larger partners.",
    3
  ),
  backlogPackage(
    "partner-g18-multi-region",
    "G18 — Multi-region partner operations",
    "Operating partners outside the initial region.",
    2
  ),
  backlogPackage(
    "partner-g19-partner-analytics",
    "G19 — Partner analytics",
    "Cohort, retention and value analytics across partners.",
    2
  ),
  backlogPackage(
    "partner-g20-partner-marketplace",
    "G20 — Partner marketplace integration",
    "Connecting graded inventory to marketplace listings.",
    2
  ),

  {
    key: "vault-quest-studio",
    nodeKey: "vault-quest",
    title: "Vault Quest production studio",
    summary: "Character bible, creature designer, card factory, export pipeline.",
    risk: "moderate",
    classification: "F",
    businessValue: 2,
    engineeringRisk: 3,
    remainingWork: "Infrastructure separation (its own database and storage) is designed but not provisioned.",
    requiredTests: STANDARD_TESTS,
  },
  {
    key: "project-control-dashboard",
    nodeKey: "core-platform",
    title: "Super Admin Project Control Dashboard",
    summary: "This dashboard: the permanent engineering control centre.",
    risk: "low",
    classification: "E",
    businessValue: 4,
    engineeringRisk: 2,
    remainingWork:
      "Second hostile review, then apply migration 0030 on an isolated database, verify, enable the flag on staging, and only then consider production.",
    requiredTests: STANDARD_TESTS,
    acceptanceCriteria: [
      criterion("pc-flag-closed", "The dashboard is unreachable when the activation flag is absent or false."),
      criterion("pc-append-only", "The audit ledger rejects UPDATE and DELETE at the database."),
      criterion("pc-no-secret-leak", "No generated prompt can carry a credential."),
    ],
  },
  {
    key: "debt-payment-toctou",
    nodeKey: "technical-debt",
    title: "Payment race conditions",
    summary: "Two known timing races on the payment path (credit double-spend, promotion over-redemption).",
    risk: "critical",
    classification: "H",
    businessValue: 5,
    engineeringRisk: 5,
    remainingWork: "Both are identified and unfixed. Any fix touches payment code and needs explicit founder approval.",
    tags: ["money", "security"],
  },
  {
    key: "debt-preflight-pooler-leak",
    nodeKey: "technical-debt",
    title: "Read-only setting leaking through the connection pooler",
    summary: "A schema preflight sets a read-only flag and never resets it; the pooler leaks it to later connections.",
    risk: "high",
    classification: "D",
    businessValue: 3,
    engineeringRisk: 3,
    remainingWork: "Reset the setting before disconnecting, or point the preflight at the direct database endpoint.",
  },
];

/**
 * The approved Shop Launch sequence.
 *
 * RECONCILED AT INTEGRATION. Two branches independently declared this same ten-key list — once
 * here and once in `@shared/project-control-launch` — with nothing tying them together. Two
 * hardcoded copies of one owner decision is precisely the drift this programme exists to remove:
 * change one and the other silently disagrees, and the dashboard starts reporting a launch order
 * that does not match the one it gates on.
 *
 * `LAUNCH_GATE_KEYS` is now the single declaration. It lives in shared/ because BOTH the client
 * (which numbers and gates the phases) and the seed (which orders the nodes) need it, and shared/
 * is the only place both can reach. This re-export is kept so existing consumers and the
 * inventory test keep working under the name they already use.
 */
export const APPROVED_SHOP_LAUNCH_SEQUENCE = LAUNCH_GATE_KEYS;

export const SEED_NODES = NODES;
export const SEED_PACKAGES = PACKAGES;

/** Topological order by parent link so foreign keys are satisfiable on insert. */
export function orderNodesParentFirst(nodes: SeedNode[]): SeedNode[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const out: SeedNode[] = [];
  const placed = new Set<string>();

  const place = (node: SeedNode, guard: Set<string>) => {
    if (placed.has(node.key) || guard.has(node.key)) return;
    guard.add(node.key);
    if (node.parentKey) {
      const parent = byKey.get(node.parentKey);
      if (parent) place(parent, guard);
    }
    if (!placed.has(node.key)) {
      placed.add(node.key);
      out.push(node);
    }
  };

  for (const n of nodes) place(n, new Set());
  return out;
}

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { EvidenceClassification, LifecycleState, ProjectRequirement } from "./types";

const MATRIX_PATH = join(process.cwd(), "docs/governance/06_Requirements_Traceability_Matrix.md");

function safeSourceLocator(matrixPath: string): string {
  const rel = relative(process.cwd(), resolve(matrixPath));
  return rel && !rel.startsWith("..") ? rel : "docs/governance/06_Requirements_Traceability_Matrix.md";
}

const EVIDENCE_VALUES = new Set<EvidenceClassification>([
  "Locked Founder Requirement",
  "Proven from repository",
  "Proven from production",
  "Proven from database",
  "Proven by tests",
  "Proven by human review",
  "Reported but Unverified",
  "Assumption",
  "Future Roadmap",
  "Open Question",
  "Unknown",
  "Stale Evidence",
  "Contradiction",
  "Superseded Decision",
]);

const LIFECYCLE_VALUES = new Set<LifecycleState>([
  "not started",
  "proposed",
  "in progress",
  "implemented",
  "test evidence missing",
  "tests failing",
  "review pending",
  "review failed",
  "review passed",
  "deployment pending",
  "deployed",
  "production verification pending",
  "production verified",
  "blocked",
  "stale",
  "unknown",
  "superseded",
]);

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/`/g, ""));
}

function classifyLegacyStatus(status: string): {
  evidenceClassification: EvidenceClassification;
  lifecycleState: LifecycleState;
} {
  const normalized = status.toLowerCase();
  if (normalized.includes("verified") || normalized.includes("repository")) {
    return { evidenceClassification: "Proven from repository", lifecycleState: "test evidence missing" };
  }
  if (normalized.includes("unknown")) {
    return { evidenceClassification: "Open Question", lifecycleState: "unknown" };
  }
  if (normalized.includes("roadmap")) {
    return { evidenceClassification: "Future Roadmap", lifecycleState: "proposed" };
  }
  if (normalized.includes("superseded")) {
    return { evidenceClassification: "Superseded Decision", lifecycleState: "superseded" };
  }
  return { evidenceClassification: "Locked Founder Requirement", lifecycleState: "proposed" };
}

function parseComponents(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadGovernanceRequirements(matrixPath: string = MATRIX_PATH): ProjectRequirement[] {
  const markdown = readFileSync(matrixPath, "utf8");
  const sourceDocument = safeSourceLocator(matrixPath);
  const requirements = new Map<string, ProjectRequirement>();

  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*(MEGS|VQ)-[A-Z0-9-]+/.test(line)) continue;
    const cells = splitMarkdownRow(line);
    const id = cells[0];
    if (!id || requirements.has(id)) continue;

    if (cells.length >= 8 && EVIDENCE_VALUES.has(cells[4] as EvidenceClassification)) {
      requirements.set(id, {
        id,
        description: cells[1] || "",
        rationale: cells[2] || "",
        acceptanceCriteria: cells[3] || "",
        evidenceClassification: cells[4] as EvidenceClassification,
        lifecycleState: LIFECYCLE_VALUES.has(cells[5] as LifecycleState) ? (cells[5] as LifecycleState) : "unknown",
        relatedComponents: parseComponents(cells[6] || ""),
        testsRequired: cells[7] || "",
        sourceDocument,
      });
      continue;
    }

    const legacy = classifyLegacyStatus(cells[4] || "");
    requirements.set(id, {
      id,
      description: cells[1] || "",
      rationale: cells[2] || "",
      acceptanceCriteria: cells[3] || "",
      evidenceClassification: legacy.evidenceClassification,
      lifecycleState: legacy.lifecycleState,
      relatedComponents: parseComponents(cells[5] || ""),
      testsRequired: cells[6] || "",
      sourceDocument,
    });
  }

  return [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id));
}

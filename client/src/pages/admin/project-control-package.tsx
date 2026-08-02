/**
 * Project Control — work package detail.
 *
 * Health, blockers, dependencies, evidence, the append-only audit trail, and the continuation
 * prompt generator. Every write on this page records an audit event server-side. Nothing here
 * pushes, merges, deploys, or applies a migration — recording that a deployment happened is not
 * the same as performing one, and the dashboard deliberately only does the former.
 */
import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AdminShell, Panel, StatCard, Badge, AdminButton, Chip } from "@/components/admin";
import { PackageOperationalHeader } from "@/components/admin/project-control/package-operational-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  BLOCKER_KIND_LABELS,
  BLOCKER_KINDS,
  CATEGORY_LABELS,
  SECURITY_SEVERITIES,
  DEPLOYMENT_STATES,
  EVIDENCE_KINDS,
  ISSUE_CLASS_LABELS,
  NEXT_ACTION_LABELS,
  PRODUCTION_VERIFICATIONS,
  PROMPT_TARGET_LABELS,
  PROMPT_TARGETS,
  REVIEW_STATES,
  RISK_LEVELS,
  WORK_STATUSES,
  type BlockerKind,
  type EvidenceKind,
  type NextAction,
  type PromptTarget,
  type SecuritySeverity,
  type Readiness,
  type StatusAssessment,
  type WorkPackage,
  type WorkStatus,
} from "@shared/project-control";
import {
  confidenceBadgeVariant,
  confidenceLabel,
  describeAction,
  displayPercent,
  relativeTime,
  riskBadgeVariant,
  statusBadgeVariant,
  statusLabel,
} from "./project-control-helpers";
import "@/styles/project-control.css";

const BASE = "/api/admin/project-control";

interface AuditRow {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  actor: string;
  anomaly: string | null;
  createdAt: string;
}

interface Detail {
  package: WorkPackage;
  assessment: StatusAssessment;
  readiness: Readiness;
  nodePath: string[];
  nextActions: NextAction[];
  audit: AuditRow[];
  auditTotal: number;
  tests: { id: number; kind: string; result: string; ranAt: string; detail: string }[];
}

interface StoredPrompt {
  id: number;
  target: string;
  body: string;
  contentHash: string;
  generatedAt: string;
  generatedBy: string | null;
  intact: boolean;
}

function safePackageMutationError(error: Error & { status?: number; body?: unknown }): string {
  const body = error.body as { error?: { code?: string; message?: string } | string; code?: string } | null | undefined;
  const nested = typeof body?.error === "object" && body.error !== null ? body.error : null;
  const code = nested?.code ?? body?.code;
  if (error.status === 409 || error.message.includes("409")) {
    if (code === "illegal_transition") {
      return "That status change is not allowed from the current package state. Choose a valid next state, or use the explicit override workflow when owner approval exists.";
    }
    if (code === "override_required") {
      return "This update needs an explicit owner-approved override before it can be saved.";
    }
    if (code === "version_conflict" || !code) {
      return "Someone else changed this work package while you were editing it. Reload the page so you do not overwrite their change.";
    }
    return "This update conflicts with the current work package state. Your entered values are still available; review the latest package state and try again.";
  }
  return "This update could not be saved. Your entered values are still available; review them and try again.";
}

export default function ProjectControlPackagePage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/project-control/package/:key");
  const key = params?.key ?? "";

  const detail = useQuery<Detail>({ queryKey: [`${BASE}/packages/${key}`], enabled: key.length > 0 });
  const [prompt, setPrompt] = useState<{ target: PromptTarget; body: string } | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [`${BASE}/packages/${key}`] });

  const [conflict, setConflict] = useState<string | null>(null);

  // Optimistic locking: the version read with the row is sent back. If someone else saved in the
  // meantime, the server refuses with 409 rather than letting one edit silently erase the other.
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiRequest("PUT", `${BASE}/packages/${key}`, body)).json(),
    onSuccess: () => {
      setConflict(null);
      invalidate();
    },
    onError: (error: Error & { status?: number; body?: unknown }) => {
      setConflict(safePackageMutationError(error));
    },
  });

  const addBlocker = useMutation({
    mutationFn: async (body: { kind: BlockerKind; description: string; severity: SecuritySeverity }) =>
      (await apiRequest("POST", `${BASE}/packages/${key}/blockers`, body)).json(),
    onSuccess: invalidate,
  });

  const resolveBlocker = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `${BASE}/blockers/${id}/resolve`, { note: "Resolved from Project Control" })).json(),
    onSuccess: invalidate,
  });

  const addEvidence = useMutation({
    mutationFn: async (body: { kind: EvidenceKind; supports: boolean; summary: string }) =>
      (await apiRequest("POST", `${BASE}/packages/${key}/evidence`, body)).json(),
    onSuccess: invalidate,
  });

  const generate = useMutation({
    mutationFn: async (target: PromptTarget) => {
      const res = await apiRequest("POST", `${BASE}/packages/${key}/prompt`, { target });
      return { target, ...((await res.json()) as { body: string }) };
    },
    onSuccess: (result) => setPrompt(result),
  });

  const prompts = useQuery<StoredPrompt[]>({
    queryKey: [`${BASE}/packages/${key}/prompts`],
    enabled: key.length > 0,
  });

  if (detail.isLoading) {
    return (
      <div className="p-8" style={{ color: "var(--admin-gold, #D4AF37)" }} data-testid="pcp-loading">
        Loading…
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-8" data-testid="pcp-error">
        Work package not found.
      </div>
    );
  }

  const { package: pkg, assessment: a, nodePath, nextActions, audit, tests } = detail.data;
  const openBlockers = pkg.blockers.filter((b) => !b.resolvedAt);

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title={pkg.title}
      crumb={nodePath.join(" › ")}
    >
      <div data-testid="pcp-root">
        <AdminButton variant="ghost" onClick={() => navigate("/admin/project-control")} className="mb-3">
          ← Back to Project Control
        </AdminButton>

        <PackageOperationalHeader
          pkg={pkg}
          assessment={a}
          readiness={detail.data.readiness}
          nextAction={nextActions[0] ?? null}
        />

        {conflict && (
          <div
            data-testid="pcp-conflict"
            style={{
              marginBottom: 12,
              background: "var(--admin-red, #cd8073)",
              color: "#fff",
              padding: "10px 14px",
              borderRadius: 8,
            }}
          >
            {conflict}
          </div>
        )}

        {a.warnings.length > 0 && (
          <div
            data-testid="pcp-warnings"
            style={{
              marginBottom: 12,
              background: "var(--admin-red, #cd8073)",
              color: "#fff",
              padding: "10px 14px",
              borderRadius: 8,
            }}
          >
            <strong>The dashboard disagrees with what this record claims:</strong>
            <ul style={{ paddingLeft: 18, marginTop: 6 }}>
              {a.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <Panel title="Health" sub={pkg.summary || "No summary recorded."}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
            <StatCard label="Completion" value={displayPercent(a.completion)} testId="pcp-completion" />
            <StatCard label="Declared" value={displayPercent(a.declaredCompletion)} />
            <StatCard label="Status" value={statusLabel(a.effectiveStatus)} testId="pcp-status" />
            <StatCard
              label="Confidence"
              value={confidenceLabel(a.confidence)}
              foot={a.confidenceReason}
              testId="pcp-confidence"
            />
            <StatCard label="Risk" value={pkg.risk.toUpperCase()} />
            <StatCard label="Class" value={`${pkg.classification} — ${ISSUE_CLASS_LABELS[pkg.classification]}`} />
            <StatCard label="Last updated" value={relativeTime(pkg.updatedAt)} />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <Badge variant={statusBadgeVariant(a.effectiveStatus)}>{statusLabel(a.effectiveStatus)}</Badge>
            <Badge variant={confidenceBadgeVariant(a.confidence)}>{confidenceLabel(a.confidence)}</Badge>
            <Badge variant={riskBadgeVariant(pkg.risk)}>{pkg.risk.toUpperCase()}</Badge>
            {pkg.branch && <Chip>{pkg.branch}</Chip>}
            {pkg.baseCommit && <Chip>base {pkg.baseCommit.slice(0, 8)}</Chip>}
            {pkg.latestCommit && <Chip>tip {pkg.latestCommit.slice(0, 8)}</Chip>}
            {pkg.prUrl && (
              <a href={pkg.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Pull request
              </a>
            )}
          </div>

          {pkg.worktreePath && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>Worktree: {pkg.worktreePath}</div>
          )}
        </Panel>

        <Panel
          title="Readiness breakdown"
          sub="The ten weighted categories behind the headline figure"
          className="mt-4"
        >
          {a.readiness.appliedCaps.length > 0 && (
            <div
              data-testid="pcp-caps"
              style={{
                marginBottom: 10,
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--admin-red, #cd8073)",
                color: "#fff",
              }}
            >
              <strong>Capped:</strong>
              <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                {a.readiness.appliedCaps.map((c) => (
                  <li key={c.reason}>
                    No higher than {c.cap}% — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "grid", gap: 6, fontSize: 13 }} data-testid="pcp-categories">
            {a.readiness.categories.map((c) => (
              <div key={c.category} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ minWidth: 150, fontWeight: 600 }}>{CATEGORY_LABELS[c.category]}</span>
                <Chip>{c.weight}%</Chip>
                <Badge
                  variant={
                    c.state === "complete"
                      ? "act"
                      : c.state === "failed"
                        ? "red"
                        : c.state === "in_progress"
                          ? "prog"
                          : "neu"
                  }
                >
                  {c.state.replace(/_/g, " ").toUpperCase()}
                </Badge>
                <span style={{ opacity: 0.75 }}>{c.reason}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Acceptance criteria"
          sub="A criterion only counts as met when it carries an evidence reference"
          className="mt-4"
        >
          {(pkg.acceptanceCriteria ?? []).length === 0 ? (
            <div style={{ opacity: 0.7 }} data-testid="pcp-criteria-empty">
              None recorded. Until acceptance criteria exist, the requirements category cannot score above zero.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }} data-testid="pcp-criteria">
              {pkg.acceptanceCriteria.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Badge variant={c.met && c.evidenceRef ? "act" : c.met ? "gold" : "neu"}>
                    {c.met && c.evidenceRef ? "MET" : c.met ? "CLAIMED" : "OPEN"}
                  </Badge>
                  <span>{c.text}</span>
                  {c.met && !c.evidenceRef && (
                    <span style={{ opacity: 0.75, fontSize: 12 }}>
                      marked met but no evidence recorded — not counted
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {(pkg.requiredTests ?? []).length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <strong>Required tests</strong>
              <ul style={{ paddingLeft: 18 }}>
                {pkg.requiredTests.map((r) => (
                  <li key={r.id}>
                    {r.name} ({r.kind})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Remaining work" className="mt-4">
          <div style={{ whiteSpace: "pre-wrap" }} data-testid="pcp-remaining">
            {pkg.remainingWork || "Not recorded."}
          </div>
        </Panel>

        <Panel title="What to do next" className="mt-4">
          {nextActions.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Nothing outstanding on this package.</div>
          ) : (
            nextActions.map((action) => (
              <div key={action.kind} style={{ marginBottom: 10 }} data-testid={`pcp-action-${action.kind}`}>
                <strong>{NEXT_ACTION_LABELS[action.kind]}</strong> — {describeAction(action)}
                {action.requiresOwnerApproval && (
                  <Badge variant="gold" className="ml-2">
                    NEEDS YOUR APPROVAL
                  </Badge>
                )}
                <ul style={{ paddingLeft: 18, fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                  {action.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </Panel>

        <StatusEditor
          pkg={pkg}
          onSave={(body) => patch.mutate({ ...body, expectedVersion: pkg.version })}
          saving={patch.isPending}
        />

        <BlockersPanel
          blockers={pkg.blockers}
          openCount={openBlockers.length}
          onAdd={(body) => addBlocker.mutate(body)}
          onResolve={(id) => resolveBlocker.mutate(id)}
        />

        <Panel title="Dependencies" className="mt-4">
          {pkg.dependsOn.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Nothing blocks this work package.</div>
          ) : (
            <ul style={{ paddingLeft: 18 }} data-testid="pcp-dependencies">
              {pkg.dependsOn.map((d) => (
                <li key={d}>
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/project-control/package/${d}`)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      color: "inherit",
                      textDecoration: "underline",
                    }}
                  >
                    {d}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <EvidencePanel evidence={pkg.evidence} tests={tests} onAdd={(body) => addEvidence.mutate(body)} />

        <PromptPanel prompt={prompt} generating={generate.isPending} onGenerate={(target) => generate.mutate(target)} />

        <Panel
          title="Issued prompt snapshots"
          sub="Exactly what was handed to an agent, and whether it is still unaltered"
          className="mt-4"
        >
          {(prompts.data ?? []).length === 0 ? (
            <div style={{ opacity: 0.7 }} data-testid="pcp-prompts-empty">
              No prompt has been generated for this work package yet.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8, fontSize: 13 }} data-testid="pcp-prompts">
              {(prompts.data ?? []).map((snapshot) => (
                <div key={snapshot.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Badge variant={snapshot.intact ? "act" : "red"}>{snapshot.intact ? "INTACT" : "ALTERED"}</Badge>
                  <strong>{snapshot.target}</strong>
                  <span style={{ opacity: 0.6 }}>{relativeTime(snapshot.generatedAt)}</span>
                  <Chip>{snapshot.contentHash.slice(0, 12)}</Chip>
                  <span style={{ opacity: 0.6 }}>by {snapshot.generatedBy ?? "unknown"}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="History" sub="Append-only. Enforced by the database, not by convention." className="mt-4">
          {audit.length === 0 ? (
            <div style={{ opacity: 0.7 }}>No recorded changes yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 6, fontSize: 13 }} data-testid="pcp-audit">
              {audit.map((row) => (
                <div key={row.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span style={{ opacity: 0.6, minWidth: 110 }}>{relativeTime(row.createdAt)}</span>
                  <strong>{row.field}</strong>
                  <span>
                    {row.oldValue ?? "—"} → {row.newValue ?? "—"}
                  </span>
                  <span style={{ opacity: 0.7 }}>{row.reason}</span>
                  <span style={{ opacity: 0.5 }}>by {row.actor}</span>
                  {row.anomaly && <Badge variant="red">{row.anomaly}</Badge>}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </AdminShell>
  );
}

/* ------------------------------------------------------------------------------------------ */

function StatusEditor({
  pkg,
  onSave,
  saving,
}: {
  pkg: WorkPackage;
  onSave: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [status, setStatus] = useState<WorkStatus>(pkg.status);
  const [completion, setCompletion] = useState(pkg.declaredCompletion);
  const [reviewState, setReviewState] = useState(pkg.reviewState);
  const [deploymentState, setDeploymentState] = useState(pkg.deploymentState);
  const [productionVerification, setProductionVerification] = useState(pkg.productionVerification);
  const [risk, setRisk] = useState(pkg.risk);
  const [remainingWork, setRemainingWork] = useState(pkg.remainingWork ?? "");
  const [reason, setReason] = useState("");

  const dirty =
    status !== pkg.status ||
    completion !== pkg.declaredCompletion ||
    reviewState !== pkg.reviewState ||
    deploymentState !== pkg.deploymentState ||
    productionVerification !== pkg.productionVerification ||
    risk !== pkg.risk ||
    remainingWork !== (pkg.remainingWork ?? "");

  return (
    <Panel title="Update this work package" sub="Every change is recorded in the history below" className="mt-4">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
        <Field label="Status">
          <Select
            value={status}
            options={WORK_STATUSES}
            render={(v) => statusLabel(v as WorkStatus)}
            onChange={(v) => setStatus(v as WorkStatus)}
            testId="pcp-edit-status"
          />
        </Field>
        <Field label="Declared completion %">
          <input
            type="number"
            min={0}
            max={100}
            value={completion}
            onChange={(e) => setCompletion(Number(e.target.value))}
            style={inputStyle}
            data-testid="pcp-edit-completion"
          />
        </Field>
        <Field label="Review">
          <Select
            value={reviewState}
            options={REVIEW_STATES}
            onChange={(v) => setReviewState(v as typeof reviewState)}
          />
        </Field>
        <Field label="Deployment">
          <Select
            value={deploymentState}
            options={DEPLOYMENT_STATES}
            onChange={(v) => setDeploymentState(v as typeof deploymentState)}
          />
        </Field>
        <Field label="Production verification">
          <Select
            value={productionVerification}
            options={PRODUCTION_VERIFICATIONS}
            onChange={(v) => setProductionVerification(v as typeof productionVerification)}
          />
        </Field>
        <Field label="Risk">
          <Select value={risk} options={RISK_LEVELS} onChange={(v) => setRisk(v as typeof risk)} />
        </Field>
      </div>

      <Field label="Remaining work">
        <textarea
          value={remainingWork}
          rows={4}
          onChange={(e) => setRemainingWork(e.target.value)}
          style={{ ...inputStyle, width: "100%" }}
          data-testid="pcp-edit-remaining"
        />
      </Field>

      <Field label="Why (recorded in the history)">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ ...inputStyle, width: "100%" }}
          data-testid="pcp-edit-reason"
        />
      </Field>

      <AdminButton
        variant="gold"
        disabled={!dirty || saving}
        onClick={() =>
          onSave({
            status,
            declaredCompletion: completion,
            reviewState,
            deploymentState,
            productionVerification,
            risk,
            remainingWork,
            reason,
          })
        }
        data-testid="pcp-save"
      >
        {saving ? "Saving…" : "Save changes"}
      </AdminButton>
    </Panel>
  );
}

function BlockersPanel({
  blockers,
  openCount,
  onAdd,
  onResolve,
}: {
  blockers: WorkPackage["blockers"];
  openCount: number;
  onAdd: (body: { kind: BlockerKind; description: string; severity: SecuritySeverity }) => void;
  onResolve: (id: number) => void;
}) {
  const [kind, setKind] = useState<BlockerKind>("awaiting_review");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<SecuritySeverity>("none");

  return (
    <Panel title="Blockers" sub={`${openCount} open`} className="mt-4">
      {blockers.length === 0 ? (
        <div style={{ opacity: 0.7 }}>Nothing is blocking this work.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }} data-testid="pcp-blockers">
          {blockers.map((b) => (
            <div key={String(b.id)} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge variant={b.resolvedAt ? "neu" : "red"}>{BLOCKER_KIND_LABELS[b.kind]}</Badge>
              {b.severity && b.severity !== "none" && (
                <Badge variant={b.severity === "high" || b.severity === "critical" ? "red" : "gold"}>
                  {b.severity.toUpperCase()}
                </Badge>
              )}
              <span>{b.description}</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>opened {relativeTime(b.openedAt)}</span>
              {!b.resolvedAt && (
                <AdminButton size="sm" variant="ghost" onClick={() => onResolve(Number(b.id))}>
                  Mark resolved
                </AdminButton>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Select
          value={kind}
          options={BLOCKER_KINDS}
          render={(v) => BLOCKER_KIND_LABELS[v as BlockerKind]}
          onChange={(v) => setKind(v as BlockerKind)}
        />
        <input
          value={description}
          placeholder="What exactly is blocking this?"
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          data-testid="pcp-blocker-description"
        />
        {kind === "security_issue" && (
          <Select
            value={severity}
            options={SECURITY_SEVERITIES}
            onChange={(v) => setSeverity(v as SecuritySeverity)}
            testId="pcp-blocker-severity"
          />
        )}
        <AdminButton
          variant="gold"
          disabled={description.trim().length === 0}
          onClick={() => {
            onAdd({
              kind,
              description: description.trim(),
              severity: kind === "security_issue" ? severity : "none",
            });
            setDescription("");
          }}
          data-testid="pcp-blocker-add"
        >
          Add blocker
        </AdminButton>
      </div>
    </Panel>
  );
}

function EvidencePanel({
  evidence,
  tests,
  onAdd,
}: {
  evidence: WorkPackage["evidence"];
  tests: Detail["tests"];
  onAdd: (body: { kind: EvidenceKind; supports: boolean; summary: string }) => void;
}) {
  const [kind, setKind] = useState<EvidenceKind>("manual_verification");
  const [supports, setSupports] = useState(true);
  const [summary, setSummary] = useState("");

  return (
    <Panel
      title="Evidence"
      sub="Confidence comes from this list, never from a status field. Contradicting evidence always wins."
      className="mt-4"
    >
      {evidence.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No evidence recorded — this package's status is unproven.</div>
      ) : (
        <div style={{ display: "grid", gap: 6, fontSize: 13 }} data-testid="pcp-evidence">
          {evidence.map((e, i) => (
            <div
              key={`${e.id ?? "derived"}-${i}`}
              style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}
            >
              <Badge variant={e.supports ? "act" : "red"}>{e.supports ? "SUPPORTS" : "CONTRADICTS"}</Badge>
              <strong>{e.kind}</strong>
              <span>{e.summary}</span>
              <span style={{ opacity: 0.6 }}>{relativeTime(e.capturedAt)}</span>
              {e.sourceRef && <Chip>{e.sourceRef}</Chip>}
            </div>
          ))}
        </div>
      )}

      {tests.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <strong>Recorded test runs</strong>
          <ul style={{ paddingLeft: 18 }}>
            {tests.slice(0, 20).map((t) => (
              <li key={t.id}>
                {t.kind}: {t.result} — {relativeTime(t.ranAt)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Select value={kind} options={EVIDENCE_KINDS} onChange={(v) => setKind(v as EvidenceKind)} />
        <AdminButton variant={supports ? "gold" : "ghost"} onClick={() => setSupports((v) => !v)}>
          {supports ? "Supports" : "Contradicts"}
        </AdminButton>
        <input
          value={summary}
          placeholder="What was actually observed?"
          onChange={(e) => setSummary(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          data-testid="pcp-evidence-summary"
        />
        <AdminButton
          variant="gold"
          disabled={summary.trim().length === 0}
          onClick={() => {
            onAdd({ kind, supports, summary: summary.trim() });
            setSummary("");
          }}
          data-testid="pcp-evidence-add"
        >
          Record evidence
        </AdminButton>
      </div>
    </Panel>
  );
}

function PromptPanel({
  prompt,
  generating,
  onGenerate,
}: {
  prompt: { target: PromptTarget; body: string } | null;
  generating: boolean;
  onGenerate: (target: PromptTarget) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Panel
      title="Continuation prompt"
      sub="Generates a ready-to-paste prompt that already knows the branch, base commit, worktree, objective and remaining work"
      className="mt-4"
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="pcp-prompt-targets">
        {PROMPT_TARGETS.map((t) => (
          <AdminButton
            key={t}
            variant="ghost"
            disabled={generating}
            onClick={() => onGenerate(t)}
            data-testid={`pcp-prompt-${t}`}
          >
            {PROMPT_TARGET_LABELS[t]}
          </AdminButton>
        ))}
      </div>

      {prompt && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <strong>{PROMPT_TARGET_LABELS[prompt.target]}</strong>
            <AdminButton
              size="sm"
              variant="gold"
              onClick={() => {
                navigator.clipboard?.writeText(prompt.body).then(
                  () => setCopied(true),
                  () => setCopied(false)
                );
              }}
              data-testid="pcp-prompt-copy"
            >
              {copied ? "Copied" : "Copy"}
            </AdminButton>
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              padding: 12,
              borderRadius: 8,
              border: "1px solid rgba(212,175,55,0.25)",
              maxHeight: 420,
              overflow: "auto",
            }}
            data-testid="pcp-prompt-body"
          >
            {prompt.body}
          </pre>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid rgba(212,175,55,0.3)",
  background: "transparent",
  color: "inherit",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginTop: 10 }}>
      <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", opacity: 0.6, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function Select({
  value,
  options,
  render,
  onChange,
  testId,
}: {
  value: string;
  options: readonly string[];
  render?: (v: string) => string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} data-testid={testId}>
      {options.map((o) => (
        <option key={o} value={o}>
          {render ? render(o) : o.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}

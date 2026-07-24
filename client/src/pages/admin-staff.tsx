import { Fragment, useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Pencil, Trash2 } from "lucide-react";
import { PokemonSetPicker } from "@/components/certificate-form";
import { VariantPicker, TcgCardSearch, type TcgCardPick } from "@/components/identity-tools";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";
import { GradingWorkstation } from "@/components/grading-workflow/GradingWorkstation";

/**
 * Admin staff hub (evolves admin-graders). One staff account list with per-person
 * capability toggles (grade/scan/print/edit sets); GRADE assignment is cert-level, SCAN
 * assignment is submission-level; per-person counts. All admin-gated.
 */
type Staff = {
  id: string;
  email: string;
  displayName: string | null;
  enabled: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  caps: { grade: boolean; scan: boolean; print: boolean; editSets: boolean };
  reviewRate: number;
  gradeAssigned: number;
  gradePending: number;
  gradeApproved: number;
  scanAssigned: number;
};
type QueueRow = {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  year: string | null;
  variant: string | null;
  graderStatus: string;
  assignedGraderId: string | null;
  assignedGraderEmail: string | null;
  redoCount: number;
  rejectionReason: string | null;
  hasImages: boolean;
  submissionRef: string | null;
  submissionId: number | null;
};

const QUEUE_FILTERS = [
  { key: "needs_grading", label: "Needs grading" },
  { key: "assigned", label: "Assigned" },
  { key: "pending_review", label: "Pending review" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
] as const;

function statusClass(s: string): string {
  switch (s) {
    case "assigned":
      return "text-sky-400";
    case "pending_review":
      return "text-amber-400";
    case "approved":
      return "text-emerald-400";
    default:
      return "text-[#E8E4DC]/60";
  }
}

// If you've signed into the staff/grader portal in this browser, that login
// replaces your admin session (shared cookie), so admin endpoints return 403
// "graders cannot access admin endpoints". Surface a clear re-login hint instead
// of a vague "failed" banner. Returns null when it's some other error.
function adminBlockedMsg(status: number, err?: string): string | null {
  if (status === 403 && /graders cannot access admin/i.test(err || "")) {
    return "You're signed into the staff portal in this browser, so admin actions are blocked here. Sign in again at /admin/login, then try again.";
  }
  return null;
}

export default function AdminStaffPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  // Rate is a STRING buffer so decimals type cleanly. A controlled type=number
  // bound to Number() strips the "0." intermediate (spec returns "" for it), which
  // made sub-£1 values like 0.80 impossible to enter. Parsed to a number on save.
  const [rate, setRate] = useState("0");
  const [dailyTarget, setDailyTarget] = useState(20);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "include" });
        const d = await res.json();
        setAuthed(res.ok && d.authenticated === true);
      } catch {
        setAuthed(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/staff", { replace: true });
  }, [authed, navigate]);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      fetch("/api/admin/staff", { credentials: "include" }),
      fetch("/api/admin/grader-rate", { credentials: "include" }),
    ]);
    if (s.ok) setStaff((await s.json()).staff || []);
    if (r.ok) {
      const d = await r.json();
      setRate(String(d.rate ?? 0));
      setDailyTarget(d.dailyTarget || 20);
    }
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  // create staff
  const [nEmail, setNEmail] = useState("");
  const [nPw, setNPw] = useState("");
  const [nName, setNName] = useState("");
  const [nCaps, setNCaps] = useState({ grade: true, scan: false, print: false, editSets: false });
  async function createStaff(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const res = await fetch("/api/admin/staff", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: nEmail,
        password: nPw,
        display_name: nName,
        can_grade: nCaps.grade,
        can_scan: nCaps.scan,
        can_print: nCaps.print,
        can_edit_sets: nCaps.editSets,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to create staff");
    if (d.promoted) {
      setMsg(
        `Existing account promoted to staff — ${d.email} signs in at /staff/login with their existing password ` +
          `(the password you typed was ignored).${d.reactivated ? " Account reactivated." : ""}`
      );
    } else {
      setMsg(`Staff account created: ${d.email}`);
    }
    setNEmail("");
    setNPw("");
    setNName("");
    load();
  }

  async function deleteStaff(s: Staff) {
    setMsg(null);
    setErr(null);
    if (!window.confirm(`Delete ${s.email}? This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/staff/${s.id}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to delete staff");
    }
    setMsg(`Deleted ${s.email}`);
    load();
  }

  // Per-row edit of a staff member's login email / password. The server refuses
  // admin + non-staff rows; a blank password Save is a deliberate no-op.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editPw, setEditPw] = useState("");

  function startEdit(s: Staff) {
    setMsg(null);
    setErr(null);
    setEditingId(s.id);
    setEditEmail(s.email);
    setEditPw("");
  }
  function cancelEdit() {
    setEditingId(null);
    setEditEmail("");
    setEditPw("");
  }

  async function saveEmail(s: Staff) {
    setMsg(null);
    setErr(null);
    const email = editEmail.trim();
    if (!email) return setErr("Enter an email address.");
    if (email.toLowerCase() === s.email.toLowerCase()) return setErr("That's already their email — nothing changed.");
    const res = await fetch(`/api/admin/staff/${s.id}/email`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to update email");
    setMsg("Email updated");
    cancelEdit();
    load();
  }

  async function savePassword(s: Staff) {
    setMsg(null);
    setErr(null);
    if (!editPw.trim()) return setErr("Enter a new password first — nothing was changed.");
    const res = await fetch(`/api/admin/staff/${s.id}/password`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: editPw }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to reset password");
    setMsg("Password reset — they sign in at /staff/login with the new password");
    cancelEdit();
    load();
  }

  async function revokeStaffSessions(s: Staff) {
    setMsg(null);
    setErr(null);
    if (!window.confirm(`Sign out active sessions for ${s.email}?`)) return;
    const res = await fetch(`/api/admin/staff/${s.id}/revoke-sessions`, {
      method: "POST",
      credentials: "include",
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to revoke sessions");
    setMsg(`Sessions revoked for ${s.email}`);
    load();
  }

  async function toggleCap(id: string, cap: "grade" | "scan" | "print" | "editSets", value: boolean) {
    setMsg(null);
    setErr(null);
    const body: Record<string, boolean> = {};
    body[
      cap === "grade" ? "can_grade" : cap === "scan" ? "can_scan" : cap === "print" ? "can_print" : "can_edit_sets"
    ] = value;
    const res = await fetch(`/api/admin/staff/${id}/capabilities`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to update");
    }
    load();
  }

  // PHASE 4 — set a grader's per-operator review rate (0–100). 100 = every card
  // manually reviewed; lower auto-approves the rest by deterministic sampling.
  async function saveReviewRate(s: Staff, raw: string) {
    const rate = Math.round(Number(raw));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return setErr("Review % must be 0–100.");
    if (rate === s.reviewRate) return; // no change
    setMsg(null);
    setErr(null);
    const res = await fetch(`/api/admin/staff/${s.id}/review-rate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_rate: rate }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to set review rate");
    }
    setMsg(`${s.displayName || s.email}: review rate set to ${rate}%`);
    load();
  }

  async function saveRate(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) return setErr("Enter a valid rate, e.g. 0.80");
    const res = await fetch("/api/admin/grader-rate", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rate: rateNum, dailyTarget }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}) as any);
      return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Failed to save rate");
    }
    setMsg(`Saved · £${rateNum.toFixed(2)}/card · target ${dailyTarget} cards/day`);
  }

  // GRADE assignment — cross-submission grading queue (cert-level)
  const [qFilter, setQFilter] = useState<string>("needs_grading");
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [qMeta, setQMeta] = useState<{ total: number; cap: number; capped: boolean } | null>(null);
  const [qLoading, setQLoading] = useState(false);
  const [gSel, setGSel] = useState<Set<number>>(new Set());
  const [gStaff, setGStaff] = useState("");
  // Inline outcome shown right beside the Assign buttons — the top-of-page
  // banner is off-screen when the admin is acting on the queue, which made
  // every assign look like it "did nothing".
  const [gOutcome, setGOutcome] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  const loadQueue = useCallback(async (filter: string) => {
    setQLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/grading-queue?status=${encodeURIComponent(filter)}`, {
        credentials: "include",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error || "Failed to load grading queue");
        setQueue([]);
        setQMeta(null);
        return;
      }
      setQueue(d.queue || []);
      setQMeta({ total: d.total ?? 0, cap: d.cap ?? 200, capped: !!d.capped });
      setGSel(new Set());
    } finally {
      setQLoading(false);
    }
  }, []);
  useEffect(() => {
    if (authed) loadQueue(qFilter);
  }, [authed, qFilter, loadQueue]);

  async function assignGrade(action: "assign" | "reassign" | "unassign") {
    setMsg(null);
    setErr(null);
    setGOutcome(null);
    const cert_ids = Array.from(gSel);
    // Every exit path below surfaces a visible outcome — assign must never no-op silently.
    if (!cert_ids.length) {
      setGOutcome({ kind: "err", text: "Select at least one card first." });
      return;
    }
    if (action !== "unassign" && !gStaff) {
      setGOutcome({ kind: "err", text: "Pick a grader first." });
      return;
    }
    const verb = action === "assign" ? "Assigned" : action === "reassign" ? "Reassigned" : "Unassigned";
    try {
      const res = await fetch(`/api/admin/graders/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grader_id: gStaff, cert_ids }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGOutcome({ kind: "err", text: d.error || `${action} failed (HTTP ${res.status})` });
        return;
      }
      const n = Number(d.count ?? 0);
      if (n === 0) {
        // 200 but nothing changed — the old code showed this as a green "0 card(s)"
        // success, indistinguishable from "nothing happened". Surface it as a warning.
        // (A grader without the capability is a 400 handled above, not a 0-count success.)
        setGOutcome({
          kind: "warn",
          text: `0 of ${cert_ids.length} card(s) ${action}ed — nothing changed. ${
            action === "unassign"
              ? "They may already be unassigned."
              : "They may already be approved or no longer in the queue."
          }`,
        });
      } else {
        setGOutcome({ kind: "ok", text: `${verb} ${n} card(s).` });
      }
    } catch (e: any) {
      setGOutcome({ kind: "err", text: `Network error — ${e?.message || "request failed"}. Nothing was changed.` });
      return;
    }
    // The assign has committed — the outcome set above is FINAL. Refresh the queue
    // and staff counts best-effort; a refetch failure must NEVER flip a real success
    // into "nothing changed" (loadQueue has no catch of its own and would throw here).
    try {
      await loadQueue(qFilter);
    } catch {
      /* refetch hiccup — the assign already stuck; queue may show stale until next load */
    }
    void load();
  }

  // ── Pending-review approval ───────────────────────────────────────────────
  // Admin reviews a grader-submitted cert (submitted grade + subgrades + the
  // images it was graded against), then approves (publishes live) or rejects
  // with a required note (bounces to the grader's queue for redo). Reuses the
  // existing approve-grader-grade / reject-grade endpoints.
  const [reviewCert, setReviewCert] = useState<QueueRow | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  // Open the FULL grading panel (adminReview mode) for a pending_review cert. The
  // panel self-hydrates from /api/admin/grade-review/* and handles inspection +
  // edit + save-then-approve; this wrapper supplies identity, Reject, and refresh.
  function openReview(q: QueueRow) {
    setMsg(null);
    setErr(null);
    setShowReject(false);
    setRejectNote("");
    setReviewCert(q);
  }
  function closeReview() {
    setReviewCert(null);
    setShowReject(false);
    setRejectNote("");
  }
  async function rejectReview() {
    if (!reviewCert) return;
    if (!rejectNote.trim()) return setErr("Enter a rejection note for the grader.");
    setMsg(null);
    setErr(null);
    setReviewBusy(true);
    try {
      const res = await fetch(`/api/admin/certificates/${reviewCert.certId}/reject-grade`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectNote.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Reject failed");
      setMsg(`Rejected ${reviewCert.certIdStr} — bounced to the grader's queue for redo.`);
      closeReview();
      await loadQueue(qFilter);
      void load();
    } finally {
      setReviewBusy(false);
    }
  }

  // Manual card-identity override — for cards that never auto-identify, or whose
  // auto-ID came back wrong/empty. Seeded from the cert when the overlay opens.
  const [idoOpen, setIdoOpen] = useState(false);
  const [idoName, setIdoName] = useState("");
  const [idoSet, setIdoSet] = useState("");
  const [idoSetCode, setIdoSetCode] = useState("");
  const [idoNumber, setIdoNumber] = useState("");
  const [idoYear, setIdoYear] = useState("");
  const [idoVariant, setIdoVariant] = useState("");
  const [idoBusy, setIdoBusy] = useState(false);
  const [idoRerunBusy, setIdoRerunBusy] = useState(false);
  useEffect(() => {
    if (!reviewCert) return;
    setIdoName(reviewCert.cardName || "");
    setIdoSet(reviewCert.setName || "");
    setIdoSetCode("");
    setIdoNumber(reviewCert.cardNumber || "");
    setIdoYear(reviewCert.year || "");
    setIdoVariant(reviewCert.variant || "");
    setIdoOpen(false);
  }, [reviewCert]);

  // Re-run the server identify path (identify only — never grades) and prefill
  // any EMPTY field from the result, mirroring the grader panel's re-run button.
  async function rerunIdentityOverride() {
    if (!reviewCert) return;
    setMsg(null);
    setErr(null);
    setIdoRerunBusy(true);
    try {
      const res = await fetch(`/api/admin/certificates/${reviewCert.certId}/identify`, {
        method: "POST",
        credentials: "include",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(d.error || "Re-identify failed");
      const ident = d.identification || {};
      // EnrichedCardData shape: prefer verified official* fields, else detected_*.
      const name = ident.officialName || ident.detected_name || "";
      const setName = ident.officialSet || ident.detected_set || "";
      const number = ident.officialNumber || ident.detected_number || "";
      const year = ident.detected_year || ident.copyright_year || "";
      if (name && !idoName.trim()) setIdoName(String(name));
      if (setName && !idoSet.trim()) setIdoSet(String(setName));
      if (ident.set_code && !idoSetCode.trim()) setIdoSetCode(String(ident.set_code));
      if (number && !idoNumber.trim()) setIdoNumber(String(number));
      if (year && !idoYear.trim()) setIdoYear(String(year));
      setMsg(name ? `Re-ran identification — TCGdex: ${name}` : "Re-ran identification.");
    } finally {
      setIdoRerunBusy(false);
    }
  }

  function applyIdoCardPick(c: TcgCardPick) {
    if (c.name) setIdoName(c.name);
    if (c.setName) setIdoSet(c.setName);
    if (c.setCode) setIdoSetCode(c.setCode);
    if (c.number) setIdoNumber(c.number);
    if (c.year) setIdoYear(c.year);
    setMsg(`Filled identity from ${c.name}${c.setName ? ` · ${c.setName}` : ""}`);
  }
  async function saveIdentityOverride() {
    if (!reviewCert) return;
    if (!idoName.trim()) return setErr("Enter a card name.");
    setMsg(null);
    setErr(null);
    setIdoBusy(true);
    try {
      const res = await fetch(`/api/admin/certificates/${reviewCert.certId}/identity-override`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card_name: idoName.trim(),
          set_name: idoSet.trim() || null,
          card_number_display: idoNumber.trim() || null,
          year_text: idoYear.trim() || null,
          variant: idoVariant.trim() || null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || "Save failed");
      setMsg(`Identity saved for ${reviewCert.certIdStr} — ${idoName.trim()}`);
      // Reflect the change in the open overlay header immediately.
      setReviewCert({
        ...reviewCert,
        cardName: idoName.trim(),
        setName: idoSet.trim() || reviewCert.setName,
        cardNumber: idoNumber.trim() || reviewCert.cardNumber,
        year: idoYear.trim() || reviewCert.year,
        variant: idoVariant.trim() || reviewCert.variant,
      });
      setIdoOpen(false);
      await loadQueue(qFilter);
      void load();
    } finally {
      setIdoBusy(false);
    }
  }

  // SCAN assignment (submission-level)
  const [sIds, setSIds] = useState("");
  const [sStaff, setSStaff] = useState("");
  async function assignScan(action: "assign" | "unassign") {
    setMsg(null);
    setErr(null);
    const submission_ids = sIds
      .split(/[\s,]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!submission_ids.length) return setErr("Enter submission IDs");
    if (action === "assign" && !sStaff) return setErr("Pick a scanner");
    const res = await fetch(`/api/admin/staff/scan/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staff_id: sStaff, submission_ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(adminBlockedMsg(res.status, d.error) || d.error || `${action} failed`);
    setMsg(`Scan ${action}: ${d.count} submission(s)`);
    load();
  }

  function toggleSel(certId: number) {
    setGSel((prev) => {
      const n = new Set(prev);
      if (n.has(certId)) n.delete(certId);
      else n.add(certId);
      return n;
    });
  }
  function toggleSelectAll(ids: number[]) {
    setGSel((prev) => {
      const allOn = ids.length > 0 && ids.every((id) => prev.has(id));
      const n = new Set(prev);
      if (allOn) ids.forEach((id) => n.delete(id));
      else ids.forEach((id) => n.add(id));
      return n;
    });
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  const graders = staff.filter((s) => s.caps.grade);
  const scanners = staff.filter((s) => s.caps.scan);
  // Only cards with images are selectable — you can't grade (or assign) an imageless card.
  const visibleSelectable = queue.filter((q) => q.hasImages).map((q) => q.certId);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((id) => gSel.has(id));

  // Manual card-identity override — rendered INSIDE the canonical grading
  // workstation (GradingWorkstation identityEditor slot), beside the card
  // preview in the right column, never as a detached full-width section above.
  const reviewIdentityEditor = (
    <div
      className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-gold)]/[0.03] px-3 py-2.5"
      data-testid="review-identity-editor"
    >
      {!idoOpen ? (
        <button
          type="button"
          onClick={() => setIdoOpen(true)}
          data-testid="button-edit-identity"
          className="text-xs text-[var(--admin-gold)]/80 underline underline-offset-2 hover:text-[var(--admin-gold)]"
        >
          Edit card identity…
        </button>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
            Manual card identity override
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Identify tools</span>
              <button
                type="button"
                onClick={rerunIdentityOverride}
                disabled={idoRerunBusy}
                title="Re-run TCGdex identification on this card (identify only — never grades)"
                data-testid="button-override-rerun"
                className="rounded border border-[var(--admin-gold)]/40 px-2 py-1 text-[10px] font-bold uppercase text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10 disabled:opacity-40"
              >
                {idoRerunBusy ? "Re-running…" : "Re-run TCGdex"}
              </button>
            </div>
            <TcgCardSearch onPick={applyIdoCardPick} initialQuery={idoName} testId="input-override-card-search" />
          </div>
          <PokemonSetPicker
            value={idoSet}
            onChange={(name, id) => {
              setIdoSet(name);
              setIdoSetCode(id || "");
            }}
            allowAddSet
            allowEditSet
            createEndpoint="/api/staff/custom-sets"
            prefill={{ setName: idoSet, setCode: idoSetCode }}
            testId="input-override-set"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              className="ss-input"
              placeholder="Card name (required)"
              value={idoName}
              onChange={(e) => setIdoName(e.target.value)}
              data-testid="input-override-name"
            />
            <input
              className="ss-input"
              placeholder="Card number (e.g. 037 or 037/091)"
              value={idoNumber}
              onChange={(e) => setIdoNumber(e.target.value)}
              data-testid="input-override-number"
            />
            <input
              className="ss-input"
              placeholder="Year"
              value={idoYear}
              onChange={(e) => setIdoYear(e.target.value)}
              data-testid="input-override-year"
            />
            <VariantPicker
              value={idoVariant}
              onChange={setIdoVariant}
              testId="input-override-variant"
              inputClassName="ss-input w-full"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveIdentityOverride}
              disabled={idoBusy}
              data-testid="button-save-identity"
              className="rounded bg-[var(--admin-gold)] px-4 py-1.5 text-xs font-bold text-[#1A1400] hover:bg-[var(--admin-gold-hi)] disabled:opacity-50"
            >
              {idoBusy ? "Saving…" : "Save identity"}
            </button>
            <button
              type="button"
              onClick={() => setIdoOpen(false)}
              disabled={idoBusy}
              className="rounded border border-[var(--admin-gold)]/40 px-4 py-1.5 text-xs hover:bg-[var(--admin-gold)]/10"
            >
              Cancel
            </button>
          </div>
          <div className="text-[10px] text-[var(--admin-ink-faint)]">
            Overwrites card name / set / number / year / variant. Flows to the operator queue, the public cert page, and
            the slab/PDF. Logged.
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC] px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[#D4AF37] text-xl font-extrabold">Staff</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/admin/operator-stats")}
              className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
            >
              Operator stats →
            </button>
            <button
              onClick={() => navigate("/admin")}
              className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
            >
              ← Admin
            </button>
          </div>
        </div>
        {msg && (
          <div className="text-emerald-400 text-xs bg-emerald-950/40 border border-emerald-900 rounded px-3 py-2">
            {msg}
          </div>
        )}
        {err && <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2">{err}</div>}

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Create staff account</h2>
          <form onSubmit={createStaff} className="space-y-2">
            <div className="grid sm:grid-cols-3 gap-2">
              <input
                className="ss-input"
                placeholder="Email"
                type="email"
                value={nEmail}
                onChange={(e) => setNEmail(e.target.value)}
                required
              />
              <input
                className="ss-input"
                placeholder="Password (≥10)"
                type="text"
                value={nPw}
                onChange={(e) => setNPw(e.target.value)}
                required
              />
              <input
                className="ss-input"
                placeholder="Display name"
                value={nName}
                onChange={(e) => setNName(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-4 text-sm">
              {(["grade", "scan", "print", "editSets"] as const).map((c) => (
                <label key={c} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={nCaps[c]}
                    onChange={(e) => setNCaps((p) => ({ ...p, [c]: e.target.checked }))}
                  />{" "}
                  {c === "editSets" ? "can edit sets" : `can ${c}`}
                </label>
              ))}
              <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-1.5 px-4 rounded text-sm hover:bg-[#B8960C] ml-auto">
                Create
              </button>
            </div>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Per-card grade rate & daily target</h2>
          <form onSubmit={saveRate} className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">Rate (£/card)</span>
              <input
                className="ss-input w-32"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 0.80"
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ""))}
                data-testid="input-rate"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">Daily target (cards/day)</span>
              <input
                className="ss-input w-40"
                type="number"
                min="1"
                step="1"
                value={dailyTarget}
                onChange={(e) => setDailyTarget(Number(e.target.value))}
                data-testid="input-daily-target"
              />
            </label>
            <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-2 px-4 rounded text-sm hover:bg-[#B8960C]">
              Save
            </button>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-[#D4AF37] font-semibold text-sm">Grading queue</h2>
            <div className="flex flex-wrap gap-1">
              {QUEUE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setQFilter(f.key)}
                  className={`text-[11px] px-2.5 py-1 rounded border ${
                    qFilter === f.key
                      ? "bg-[#D4AF37] text-[#1A1400] border-[#D4AF37] font-bold"
                      : "border-[#D4AF37]/30 text-[#E8E4DC]/70 hover:bg-[#D4AF37]/10"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-[#E8E4DC]/50 mb-2">
            <span>
              {qLoading
                ? "Loading…"
                : qMeta
                  ? `${queue.length} shown${
                      qMeta.capped ? ` · ${qMeta.total} total (capped at ${qMeta.cap})` : ` · ${qMeta.total} total`
                    }`
                  : ""}
            </span>
            <button onClick={() => loadQueue(qFilter)} className="hover:text-[#D4AF37]">
              ↻ Refresh
            </button>
          </div>

          {!qLoading && queue.length === 0 ? (
            <p className="text-[#E8E4DC]/50 text-xs py-3">No cards in this view.</p>
          ) : (
            <>
              <div className="max-h-80 overflow-auto border border-[#D4AF37]/10 rounded">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-black">
                    <tr className="text-[#E8E4DC]/50 text-[10px] uppercase text-left">
                      <th className="py-1.5 px-2 w-8">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={() => toggleSelectAll(visibleSelectable)}
                          disabled={visibleSelectable.length === 0}
                          title="Select all gradeable cards in view"
                        />
                      </th>
                      <th>Cert</th>
                      <th>Card</th>
                      <th>Set / Year</th>
                      <th>Status</th>
                      <th>Grader</th>
                      <th className="text-center px-2">Imgs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((q) => (
                      <tr key={q.certId} className={`border-t border-[#D4AF37]/10 ${q.hasImages ? "" : "opacity-50"}`}>
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            disabled={!q.hasImages}
                            checked={gSel.has(q.certId)}
                            onChange={() => toggleSel(q.certId)}
                            title={q.hasImages ? "" : "No images — can't grade yet"}
                          />
                        </td>
                        <td className="font-mono text-[11px] text-[#D4AF37] whitespace-nowrap pr-2">{q.certIdStr}</td>
                        <td className="truncate max-w-[150px]">
                          {q.cardName || "Unidentified"}
                          {q.cardNumber ? <span className="text-[#E8E4DC]/40"> #{q.cardNumber}</span> : null}
                          {q.redoCount > 0 && (
                            <span className="ml-1 text-[9px] text-amber-400 border border-amber-700/50 rounded px-1">
                              REDO×{q.redoCount}
                            </span>
                          )}
                        </td>
                        <td className="text-[11px] text-[#E8E4DC]/60 whitespace-nowrap pr-2">
                          {q.setName || "—"}
                          {q.year ? ` · ${q.year}` : ""}
                        </td>
                        <td className="text-[10px] uppercase whitespace-nowrap pr-2">
                          <span className={statusClass(q.graderStatus)}>{q.graderStatus.replace("_", " ")}</span>
                          {q.graderStatus === "pending_review" && (
                            <button
                              type="button"
                              onClick={() => openReview(q)}
                              data-testid={`button-review-${q.certId}`}
                              className="ml-2 normal-case border border-[#D4AF37]/40 text-[#D4AF37] rounded px-2 py-0.5 hover:bg-[#D4AF37]/10"
                            >
                              Review
                            </button>
                          )}
                        </td>
                        <td className="text-[10px] text-[#E8E4DC]/50 truncate max-w-[130px]">
                          {q.assignedGraderEmail || "—"}
                        </td>
                        <td className="text-center px-2">
                          {q.hasImages ? (
                            <span className="text-emerald-400" title="Front + back present">
                              ✓
                            </span>
                          ) : (
                            <span className="text-red-400" title="Missing front and/or back image">
                              ✗
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap gap-2 items-center mt-3">
                <span className="text-[11px] text-[#E8E4DC]/60 whitespace-nowrap">{gSel.size} selected</span>
                <select
                  className="ss-input flex-1 min-w-[160px]"
                  value={gStaff}
                  onChange={(e) => setGStaff(e.target.value)}
                >
                  <option value="">Select grader…</option>
                  {graders.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.displayName ? `${g.displayName} — ${g.email}` : g.email}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => assignGrade("assign")}
                  className="bg-[#D4AF37] text-[#1A1400] font-bold px-3 py-2 rounded text-sm hover:bg-[#B8960C]"
                >
                  Assign
                </button>
                <button
                  onClick={() => assignGrade("reassign")}
                  className="border border-[#D4AF37]/40 px-3 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
                >
                  Reassign
                </button>
                <button
                  onClick={() => assignGrade("unassign")}
                  className="border border-[#D4AF37]/40 px-3 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
                >
                  Unassign
                </button>
              </div>
              {gOutcome && (
                <div
                  className={`mt-2 text-xs rounded px-3 py-2 border ${
                    gOutcome.kind === "ok"
                      ? "text-emerald-400 bg-emerald-950/40 border-emerald-900"
                      : gOutcome.kind === "warn"
                        ? "text-amber-300 bg-amber-950/40 border-amber-900"
                        : "text-red-400 bg-red-950/40 border-red-900"
                  }`}
                  data-testid="grade-assign-outcome"
                >
                  {gOutcome.text}
                </div>
              )}
            </>
          )}
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Assign boxes to scan (by submission)</h2>
          <div className="space-y-2">
            <select className="ss-input" value={sStaff} onChange={(e) => setSStaff(e.target.value)}>
              <option value="">Select scanner…</option>
              {scanners.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName ? `${s.displayName} — ${s.email}` : s.email}
                </option>
              ))}
            </select>
            <textarea
              className="ss-input min-h-[50px]"
              placeholder="Submission IDs (comma/space separated)"
              value={sIds}
              onChange={(e) => setSIds(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={() => assignScan("assign")}
                className="bg-[#D4AF37] text-[#1A1400] font-bold px-4 py-2 rounded text-sm hover:bg-[#B8960C]"
              >
                Assign
              </button>
              <button
                onClick={() => assignScan("unassign")}
                className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
              >
                Unassign
              </button>
            </div>
          </div>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Staff accounts ({staff.length})</h2>
          {staff.length === 0 ? (
            <p className="text-[#E8E4DC]/50 text-xs">No staff yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#E8E4DC]/50 text-[11px] uppercase text-left">
                  <th className="py-1">Staff</th>
                  <th>Grade</th>
                  <th>Scan</th>
                  <th>Print</th>
                  <th>Edit Sets</th>
                  <th title="Percent of this operator's submissions that are manually reviewed (rest auto-approve)">
                    Review %
                  </th>
                  <th>Workload</th>
                  <th>Security</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <Fragment key={s.id}>
                    <tr className="border-t border-[#D4AF37]/10">
                      <td className="py-1.5">
                        {s.displayName || "—"} <span className="text-[#E8E4DC]/50 text-xs">{s.email}</span>
                      </td>
                      {(["grade", "scan", "print", "editSets"] as const).map((cap) => (
                        <td key={cap}>
                          <input
                            type="checkbox"
                            checked={s.caps[cap]}
                            onChange={(e) => toggleCap(s.id, cap, e.target.checked)}
                          />
                        </td>
                      ))}
                      <td>
                        {s.caps.grade ? (
                          <input
                            type="number"
                            min={0}
                            max={100}
                            defaultValue={s.reviewRate}
                            key={`rr-${s.id}-${s.reviewRate}`}
                            title="0–100. 100 = every card reviewed; lower auto-approves the rest."
                            data-testid={`input-review-rate-${s.id}`}
                            onBlur={(e) => saveReviewRate(s, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                            className="w-14 bg-black border border-[#D4AF37]/30 rounded px-1.5 py-0.5 text-xs text-[#E8E4DC] focus:border-[#D4AF37] outline-none"
                          />
                        ) : (
                          <span className="text-[#E8E4DC]/30 text-xs">—</span>
                        )}
                      </td>
                      <td className="text-xs text-[#E8E4DC]/70">
                        {s.caps.grade && `${s.gradeAssigned}a/${s.gradePending}p/${s.gradeApproved}✓ `}
                        {s.caps.scan && `${s.scanAssigned} box`}
                      </td>
                      <td className="text-[10px] text-[#E8E4DC]/55">
                        <div>{s.enabled ? "Enabled" : "Disabled"}</div>
                        <div>{s.failedLoginCount || 0} failed</div>
                        <div>
                          {s.lockedUntil ? `Locked until ${new Date(s.lockedUntil).toLocaleString()}` : "Not locked"}
                        </div>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => (editingId === s.id ? cancelEdit() : startEdit(s))}
                          title={`Edit ${s.email}`}
                          data-testid={`button-edit-staff-${s.id}`}
                          className="text-[#E8E4DC]/30 hover:text-[#D4AF37] p-1 rounded transition-colors"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteStaff(s)}
                          title={`Delete ${s.email}`}
                          data-testid={`button-delete-staff-${s.id}`}
                          className="text-[#E8E4DC]/30 hover:text-red-400 p-1 rounded transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                    {editingId === s.id && (
                      <tr className="border-t border-[#D4AF37]/10 bg-[#D4AF37]/5">
                        <td colSpan={8} className="px-2 py-3">
                          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                            <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                              <input
                                className="ss-input"
                                type="email"
                                value={editEmail}
                                onChange={(e) => setEditEmail(e.target.value)}
                                placeholder="Email"
                                aria-label={`Email for ${s.email}`}
                                data-testid={`input-edit-email-${s.id}`}
                              />
                              <button
                                type="button"
                                onClick={() => saveEmail(s)}
                                className="border border-[#D4AF37]/40 px-3 py-1.5 rounded text-xs whitespace-nowrap hover:bg-[#D4AF37]/10"
                                data-testid={`button-save-email-${s.id}`}
                              >
                                Save email
                              </button>
                            </div>
                            <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                              <input
                                className="ss-input"
                                type="text"
                                value={editPw}
                                onChange={(e) => setEditPw(e.target.value)}
                                placeholder="Set new password"
                                autoComplete="new-password"
                                aria-label={`New password for ${s.email}`}
                                data-testid={`input-edit-password-${s.id}`}
                              />
                              <button
                                type="button"
                                onClick={() => savePassword(s)}
                                className="border border-[#D4AF37]/40 px-3 py-1.5 rounded text-xs whitespace-nowrap hover:bg-[#D4AF37]/10"
                                data-testid={`button-save-password-${s.id}`}
                              >
                                Save password
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => revokeStaffSessions(s)}
                              className="border border-[#D4AF37]/40 px-3 py-1.5 rounded text-xs whitespace-nowrap hover:bg-[#D4AF37]/10"
                              data-testid={`button-revoke-staff-sessions-${s.id}`}
                            >
                              Revoke sessions
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="text-[#E8E4DC]/40 hover:text-[#E8E4DC] text-xs px-2 py-1.5 whitespace-nowrap"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {reviewCert && (
        // Mounted inside the shared admin-root token scope (same design system as
        // Super Admin / corrected Staff shell) rather than raw hex — this overlay
        // previously ran its own standalone bg-black/#E8E4DC visual language.
        <div className="admin-root fixed inset-0 z-50 flex flex-col bg-black/90" data-testid="grade-review-overlay">
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className="mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]">
              <div className="shrink-0 px-4 py-2.5 border-b border-[var(--admin-line)] bg-[var(--admin-panel)]">
                <AdminHeaderRow
                  testId="grade-review-header"
                  left={
                    <h3 className="truncate text-sm font-semibold text-[var(--admin-gold)]">
                      Review {reviewCert.certIdStr} — {reviewCert.cardName || "Unidentified"}
                      <span className="font-normal text-[var(--admin-ink-faint)]">
                        {[
                          reviewCert.setName,
                          reviewCert.cardNumber ? `#${reviewCert.cardNumber}` : null,
                          reviewCert.year,
                          reviewCert.variant,
                        ]
                          .filter(Boolean)
                          .map((x) => ` · ${x}`)
                          .join("")}
                      </span>
                    </h3>
                  }
                  right={
                    <>
                      {!showReject && (
                        <button
                          type="button"
                          onClick={() => setShowReject(true)}
                          disabled={reviewBusy}
                          data-testid="button-reject-grade"
                          className="rounded border border-red-700/60 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-50"
                        >
                          Reject…
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={closeReview}
                        className="px-2 text-xl leading-none text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)]"
                        aria-label="Close review"
                      >
                        ×
                      </button>
                    </>
                  }
                />
                {/* err/msg previously only rendered in the page underneath this
                    z-50 overlay — invisible while the overlay was open (e.g. a
                    failed Reject gave no visible feedback). Surfaced here too. */}
                {msg && (
                  <div className="mt-2 rounded border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-400">
                    {msg}
                  </div>
                )}
                {err && (
                  <div className="mt-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">
                    {err}
                  </div>
                )}
              </div>
              {/* Manual card-identity override moved INTO the workstation body
                  (GradingWorkstation identityEditor slot) — beside the card
                  preview, never a detached full-width section above the shell. */}
              {showReject && (
                <div className="space-y-2 border-b border-red-900/40 bg-red-950/20 px-4 py-3">
                  <textarea
                    className="ss-input min-h-[60px]"
                    placeholder="Reason for rejection (shown to the grader) — required"
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    data-testid="input-reject-note"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={rejectReview}
                      disabled={reviewBusy}
                      className="bg-red-600 text-white font-bold px-4 py-2 rounded text-sm hover:bg-red-500 disabled:opacity-50"
                    >
                      Confirm reject — bounce to grader
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowReject(false)}
                      disabled={reviewBusy}
                      className="rounded border border-[var(--admin-gold)]/40 px-4 py-2 text-sm hover:bg-[var(--admin-gold)]/10"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col">
                {/* The SAME grading panel the grader/admin use — adminReview mode is
                    charge-safe (no AI/recrop/delete) and its Approve does an explicit
                    save-then-publish via approve-grader-grade. The identity editor is
                    rendered inside the workstation (identityEditor slot). */}
                <GradingWorkstation
                  mode="admin-review"
                  adminReview
                  identityEditor={reviewIdentityEditor}
                  apiBase="/api/admin/grade-review"
                  certId={reviewCert.certId}
                  certIdStr={reviewCert.certIdStr}
                  cardName={reviewCert.cardName || ""}
                  cardSet={reviewCert.setName || ""}
                  cardNumber={reviewCert.cardNumber}
                  cardYear={reviewCert.year}
                  cardVariant={reviewCert.variant}
                  onGradeApproved={() => {
                    setMsg(`Approved ${reviewCert.certIdStr} — grade is now live on the public cert page.`);
                    closeReview();
                    void loadQueue(qFilter);
                    void load();
                  }}
                  onCertUpdated={() => {}}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      <style>{`.ss-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:8px;color:#E8E4DC;font-size:13px;outline:none}.ss-input:focus{border-color:#D4AF37}`}</style>
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import GradingPanel from "../components/grading/grading-panel";
import InstallAppButton from "../components/install-app-button";
import { PrintingConsole } from "./admin-printing";

/**
 * Unified staff dashboard. Renders ONLY the tabs the logged-in person's
 * capabilities allow (grade / scan / print). Every datum is PII-FREE (from
 * /api/staff/* + the grader surface). Server-guarded per tab — this UI is
 * convenience, not the security boundary.
 */
type Caps = { grade: boolean; scan: boolean; print: boolean };
type Tab = "grade" | "scan" | "print";

export default function StaffPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [caps, setCaps] = useState<Caps>({ grade: false, scan: false, print: false });
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/staff/session", { credentials: "include" });
        const d = await res.json();
        if (cancelled) return;
        setAuthed(!!d.authenticated);
        setEmail(d.email || "");
        const c: Caps = d.caps || { grade: false, scan: false, print: false };
        setCaps(c);
        setTab(c.grade ? "grade" : c.scan ? "scan" : c.print ? "print" : null);
      } catch {
        if (!cancelled) setAuthed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/staff/login", { replace: true });
  }, [authed, navigate]);

  async function logout() {
    await fetch("/api/staff/logout", { method: "POST", credentials: "include" });
    navigate("/staff/login", { replace: true });
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  const allTabs: { id: Tab; label: string; on: boolean }[] = [
    { id: "grade", label: "Grading", on: caps.grade },
    { id: "scan", label: "Scanning", on: caps.scan },
    { id: "print", label: "Printing", on: caps.print },
  ];
  const tabs = allTabs.filter((t) => t.on);

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC]">
      <header className="flex items-center justify-between px-5 py-3 border-b border-[#D4AF37]/20">
        <div className="flex items-center gap-4">
          <h1 className="text-[#D4AF37] font-extrabold tracking-wide">MintVault — Staff</h1>
          <nav className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`text-xs px-3 py-1 rounded ${tab === t.id ? "bg-[#D4AF37] text-[#1A1400] font-bold" : "border border-[#D4AF37]/30 hover:bg-[#D4AF37]/10"}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <InstallAppButton className="border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10" />
          <span className="text-[#E8E4DC]/60">{email}</span>
          <button onClick={logout} className="border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10">
            Sign out
          </button>
        </div>
      </header>
      {tab === "grade" && <GradeTab />}
      {tab === "scan" && <ScanTab />}
      {tab === "print" && <PrintTab />}
      {!tab && <p className="text-center text-[#E8E4DC]/50 py-16 text-sm">No tools enabled for your account.</p>}
    </div>
  );
}

// ── GRADE tab — the real MVGS panel (reuses the grader surface) ───────────────
type GCard = {
  certId: number;
  certIdStr: string;
  cardGame: string | null;
  setName: string | null;
  cardName: string | null;
  cardNumber: string | null;
  year: string | null;
  variant: string | null;
  grade: string | null;
  gradingStatus: string;
  rejectionReason: string | null;
  redoCount: number;
  assignedToMe: boolean;
  scannedByMe: boolean;
  gradedByMe: boolean;
  gradeApprovedAt: string | null;
};
type GItem = { submissionRef: string; cards: GCard[] };

type Analytics = {
  rate: number;
  dailyTarget: number;
  week: { approved: number; earnings: number; startDate: string };
  month: { approved: number; earnings: number; startDate: string };
  today: { approved: number };
  queue: { assigned: number; pendingReview: number };
  approval: { approved: number; bounced: number; rate: number };
  lifetime: { approved: number; earnings: number };
};

function Stat({
  label,
  big,
  sub,
  subLabel,
  rateNotSet,
}: {
  label: string;
  big: string;
  sub?: string;
  subLabel?: string;
  rateNotSet?: boolean;
}) {
  return (
    <div className="border border-[#D4AF37]/20 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">
        {label}
        {subLabel ? ` · ${subLabel}` : ""}
      </div>
      <div className="text-[#D4AF37] text-xl font-extrabold mt-1 leading-none">{big}</div>
      {sub && <div className="text-[11px] text-[#E8E4DC]/50 mt-1">{sub}</div>}
      {rateNotSet && <div className="text-[10px] text-amber-400/80 mt-0.5">(rate not set)</div>}
    </div>
  );
}

/** Always-visible analytics strip above the grader card list. Loading → skeleton;
 *  error/not-ready (a === null && !loading) → renders nothing (never blocks the queue). */
function GradeAnalytics({ a, loading }: { a: Analytics | null; loading: boolean }) {
  if (!a) {
    if (!loading) return null;
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border border-[#D4AF37]/20 rounded-lg p-3">
            <div className="h-2 w-16 bg-[#D4AF37]/10 rounded animate-pulse" />
            <div className="h-5 w-20 bg-[#D4AF37]/10 rounded animate-pulse mt-2" />
            <div className="h-2 w-24 bg-[#D4AF37]/10 rounded animate-pulse mt-2" />
          </div>
        ))}
      </div>
    );
  }
  const rateSet = a.rate > 0;
  const money = (v: number) => (rateSet ? `£${v.toFixed(2)}` : "—");
  const target = a.dailyTarget || 20;
  const todayN = a.today.approved;
  const now = new Date();
  const dayFrac = (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const pace = todayN >= target ? "Ahead" : todayN >= 0.7 * target && dayFrac >= 0.7 ? "On pace" : "Behind";
  const paceCls =
    pace === "Ahead"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/30"
      : pace === "On pace"
        ? "text-[#D4AF37] border-[#D4AF37]/40 bg-[#D4AF37]/10"
        : "text-red-400 border-red-500/40 bg-red-950/30";
  const pct = target > 0 ? Math.min(100, Math.round((todayN / target) * 100)) : 0;
  const inQueue = a.queue.assigned + a.queue.pendingReview;

  return (
    <div className="mb-5 space-y-4" data-testid="grade-analytics">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="This week"
          big={money(a.week.earnings)}
          sub={`${a.week.approved} cards approved`}
          rateNotSet={!rateSet}
        />
        <Stat
          label="This month"
          big={money(a.month.earnings)}
          sub={`${a.month.approved} cards approved`}
          rateNotSet={!rateSet}
        />
        <Stat
          label="Approval rate"
          subLabel="30d"
          big={`${a.approval.rate}%`}
          sub={`${a.approval.approved} approved / ${a.approval.bounced} bounced`}
        />
        <Stat
          label="Lifetime"
          big={`${a.lifetime.approved} cards`}
          sub={rateSet ? `${money(a.lifetime.earnings)} total` : "earnings —"}
          rateNotSet={!rateSet}
        />
      </div>
      <div className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[#E8E4DC]/70">
              <span className="text-[#D4AF37] font-bold">{todayN}</span> / {target} cards today
            </span>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${paceCls}`}
              data-testid="pace-badge"
            >
              {pace}
            </span>
          </div>
          <div className="h-2 bg-[#D4AF37]/10 rounded-full overflow-hidden">
            <div className="h-full bg-[#D4AF37] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="text-xs text-[#E8E4DC]/60">
          <span className="text-[#E8E4DC]/80 font-semibold">{a.queue.assigned}</span> assigned ·{" "}
          <span className="text-[#E8E4DC]/80 font-semibold">{a.queue.pendingReview}</span> pending review · {inQueue}{" "}
          total in queue
        </div>
      </div>
    </div>
  );
}

function GradeTab() {
  const [queue, setQueue] = useState<GItem[]>([]);
  const [active, setActive] = useState<{ ref: string; card: GCard } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [aLoading, setALoading] = useState(true);
  // Bad-scan: view front/back + clear-for-re-scan (own assigned cards only).
  const [viewCard, setViewCard] = useState<GCard | null>(null);
  const [viewUrls, setViewUrls] = useState<{ front: string | null; back: string | null } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [clearCard, setClearCard] = useState<GCard | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearMsg, setClearMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/grader/queue", { credentials: "include" });
    if (r.ok) setQueue((await r.json()).items || []);
    // Analytics — best-effort; any error is silent and never blocks the queue.
    setALoading(true);
    try {
      const ar = await fetch("/api/staff/analytics", { credentials: "include" });
      if (ar.ok) setAnalytics(await ar.json());
    } catch {
      /* silent */
    } finally {
      setALoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function openViewer(card: GCard) {
    setViewCard(card);
    setViewUrls(null);
    setViewLoading(true);
    try {
      const r = await fetch(`/api/grader/certificates/${card.certId}/images`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load images");
      const d = await r.json();
      const u = d.urls || {};
      setViewUrls({ front: u.front_original || u.front_cropped || null, back: u.back_original || u.back_cropped || null });
    } catch {
      setViewUrls({ front: null, back: null });
    } finally {
      setViewLoading(false);
    }
  }

  async function doClearScan() {
    if (!clearCard) return;
    setClearBusy(true);
    setClearMsg(null);
    try {
      const r = await fetch(`/api/grader/certificates/${clearCard.certId}/clear-scan`, {
        method: "POST",
        credentials: "include",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Clear failed");
      setClearCard(null);
      await load();
    } catch (e: any) {
      setClearMsg(e.message);
    } finally {
      setClearBusy(false);
    }
  }

  if (active) {
    const c = active.card;
    return (
      <div>
        <div className="px-5 py-2 flex items-center gap-3 border-b border-[#D4AF37]/10">
          <button onClick={() => setActive(null)} className="text-[#D4AF37] text-xs hover:underline">
            ← Back
          </button>
          <span className="text-[#D4AF37] font-mono text-xs">{active.ref}</span>
          {c.gradingStatus === "pending_review" && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
              Submitted · editing (stays pending review)
            </span>
          )}
        </div>
        {c.rejectionReason && (
          <div className="mx-auto max-w-3xl mt-3 px-4">
            <div className="border border-amber-500/50 bg-amber-950/30 text-amber-300 rounded-lg px-4 py-2 text-sm">
              <span className="font-bold uppercase text-[11px] tracking-wide">Sent back for redo</span> —{" "}
              {c.rejectionReason}
            </div>
          </div>
        )}
        <GradingPanel
          apiBase="/api/grader"
          graderMode
          // Reopening an already-submitted card = EDIT mode: the full workstation,
          // but the primary action saves via the gated /edit-submission (stays
          // pending review, never publishes).
          graderEdit={c.gradingStatus === "pending_review"}
          certId={c.certId}
          certIdStr={c.certIdStr}
          cardName={c.cardName || ""}
          cardSet={c.setName || ""}
          cardNumber={c.cardNumber}
          cardYear={c.year}
          cardVariant={c.variant}
          cardGame={c.cardGame || undefined}
          existingGrade={c.grade}
          onGradeApproved={async () => {
            await load();
            setActive(null);
          }}
          onCertUpdated={() => {}}
        />
      </div>
    );
  }
  // Flatten the grader's own cards (every state) and segment by workflow stage so
  // both outstanding and finished work are visible. A card the grader only SCANNED
  // (assigned to someone else / not yet assigned) is read-only here.
  const all = queue.flatMap((it) => it.cards.map((card) => ({ card, ref: it.submissionRef })));
  const toGrade = all.filter((x) => x.card.gradingStatus === "assigned" || x.card.gradingStatus === "unassigned");
  const inReview = all.filter((x) => x.card.gradingStatus === "pending_review");
  const done = all.filter((x) => x.card.gradingStatus === "approved");
  const other = all.filter(
    (x) => !["assigned", "unassigned", "pending_review", "approved"].includes(x.card.gradingStatus)
  );

  const renderRow = ({ card, ref }: { card: GCard; ref: string }) => (
    <li
      key={card.certId}
      className="border border-[#D4AF37]/20 rounded-lg p-4 flex items-center justify-between gap-4"
    >
      <div className="min-w-0">
        <div className="text-[#D4AF37] font-mono text-xs">{ref || "—"}</div>
        <div className="font-semibold truncate">
          {/* Lead with the MintVault cert number so the grader can match the row to
              the physical cert — especially for unidentified cards with no name. */}
          <span className="font-mono text-[#D4AF37]">{card.certIdStr}</span>
          <span className="text-[#E8E4DC]/40"> · </span>
          {card.cardName || "Unidentified card"}{" "}
          {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
        </div>
        <div className="text-[#E8E4DC]/50 text-xs">
          {[card.setName, card.year, card.variant].filter(Boolean).join(" · ")}
        </div>
      </div>
      {card.gradingStatus === "assigned" && card.assignedToMe ? (
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => openViewer(card)}
              data-testid={`btn-view-scan-${card.certId}`}
              className="border border-[#D4AF37]/40 text-[#D4AF37] text-xs px-2.5 py-1.5 rounded hover:bg-[#D4AF37]/10"
            >
              View
            </button>
            <button
              onClick={() => setActive({ ref, card })}
              className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C]"
            >
              Grade
            </button>
          </div>
          {/* Soft clear — NOT a delete; sends the card to an admin for re-scan. */}
          <button
            onClick={() => {
              setClearMsg(null);
              setClearCard(card);
            }}
            data-testid={`btn-bad-scan-${card.certId}`}
            className="text-[10px] uppercase tracking-wider text-amber-300/80 hover:text-amber-300 underline underline-offset-2"
          >
            Bad scan — clear for re-scan
          </button>
        </div>
      ) : card.gradingStatus === "pending_review" && card.gradedByMe ? (
        // Submitted but not yet approved — reopen the FULL workstation to correct
        // it. Stays pending_review, never auto-publishes (gated /edit-submission).
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-amber-300">Submitted</span>
          <button
            onClick={() => setActive({ ref, card })}
            data-testid={`btn-edit-submission-${card.certId}`}
            className="border border-[#D4AF37]/50 text-[#D4AF37] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#D4AF37]/10"
          >
            Edit
          </button>
        </div>
      ) : card.gradingStatus === "approved" ? (
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-emerald-400">Approved</span>
          {card.grade && <span className="text-[#D4AF37] text-sm font-bold leading-none">{card.grade}</span>}
        </div>
      ) : card.gradingStatus === "unassigned" ? (
        <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 shrink-0">
          Scanned · awaiting assignment
        </span>
      ) : (
        <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 shrink-0">{card.gradingStatus}</span>
      )}
    </li>
  );

  const section = (title: string, items: { card: GCard; ref: string }[]) =>
    items.length === 0 ? null : (
      <section
        key={title}
        className="mb-5"
        data-testid={`grade-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <h2 className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 font-bold mb-2">
          {title} · {items.length}
        </h2>
        <ul className="space-y-2">{items.map(renderRow)}</ul>
      </section>
    );

  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      <GradeAnalytics a={analytics} loading={aLoading} />
      {all.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No cards yet — scan or get assigned a card to begin.</p>
      ) : (
        <>
          {section("To grade", toGrade)}
          {section("In review", inReview)}
          {section("Other", other)}
          {section("Done", done)}
        </>
      )}

      {/* Scan viewer — front/back originals (signed R2 urls, PII-free). */}
      {viewCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setViewCard(null)}
        >
          <div
            className="bg-[#1A1400] border border-[#D4AF37]/30 rounded-xl p-4 max-w-3xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-[#D4AF37] text-sm">
                {viewCard.certIdStr} · {viewCard.cardName || "Unidentified"}
              </span>
              <button onClick={() => setViewCard(null)} className="text-[#E8E4DC]/60 hover:text-[#E8E4DC] text-sm">
                Close
              </button>
            </div>
            {viewLoading ? (
              <p className="text-[#E8E4DC]/60 text-sm text-center py-10">Loading images…</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {(["front", "back"] as const).map((side) => {
                  const url = viewUrls?.[side] || null;
                  return (
                    <div key={side} className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">{side}</div>
                      {url ? (
                        <img
                          src={url}
                          alt={`${viewCard!.certIdStr} ${side}`}
                          className="w-full rounded border border-[#D4AF37]/20 bg-black/30"
                        />
                      ) : (
                        <div className="w-full aspect-[3/4] rounded border border-[#D4AF37]/20 bg-black/30 flex items-center justify-center text-[#E8E4DC]/40 text-xs">
                          No {side} image
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => {
                  setClearMsg(null);
                  setClearCard(viewCard);
                  setViewCard(null);
                }}
                className="text-[11px] uppercase tracking-wider text-amber-300/80 hover:text-amber-300 underline underline-offset-2"
              >
                Bad scan — clear for re-scan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear-for-re-scan confirm — soft, not a delete. */}
      {clearCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => !clearBusy && setClearCard(null)}
        >
          <div
            className="bg-[#1A1400] border border-amber-500/40 rounded-xl p-5 max-w-sm w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-amber-300 font-bold">Clear this scan for re-scan?</h3>
            <p className="text-[#E8E4DC]/80 text-sm">
              This clears the scan images on{" "}
              <span className="font-mono text-[#D4AF37]">{clearCard.certIdStr}</span> so the card can be re-scanned by
              an admin. <strong>The card and its MV number stay</strong> — nothing is deleted. It leaves your grading
              queue and an admin re-dispatches it for a fresh scan.
            </p>
            {clearMsg && <p className="text-red-400 text-xs">{clearMsg}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setClearCard(null)}
                disabled={clearBusy}
                className="text-[#E8E4DC]/70 hover:text-[#E8E4DC] text-xs px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={doClearScan}
                disabled={clearBusy}
                data-testid="btn-confirm-clear-scan"
                className="bg-amber-500 text-[#1A1400] font-bold text-xs px-4 py-1.5 rounded hover:bg-amber-400 disabled:opacity-50"
              >
                {clearBusy ? "Clearing…" : "Clear for re-scan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── SCAN tab — upload raw front/back onto assigned cards ──────────────────────
type SCard = {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  cardNumber: string | null;
  hasFront: boolean;
  hasBack: boolean;
};
type SItem = { submissionId: number; submissionRef: string; cards: SCard[] };

function ScanTab() {
  const [queue, setQueue] = useState<SItem[]>([]);
  const [busyCert, setBusyCert] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/staff/scan/queue", { credentials: "include" });
    if (r.ok) setQueue((await r.json()).items || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(certId: number, side: "front" | "back", file: File) {
    setBusyCert(certId);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append(side, file);
      const r = await fetch(`/api/staff/scan/certificates/${certId}/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setMsg(d.error || "Upload failed");
      } else {
        await load();
      }
    } finally {
      setBusyCert(null);
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      {msg && (
        <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2 mb-3">{msg}</div>
      )}
      {queue.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No submissions awaiting scan.</p>
      ) : (
        queue.map((sub) => (
          <section key={sub.submissionId} className="mb-5">
            <h2 className="text-[#D4AF37] font-mono text-sm mb-2">{sub.submissionRef}</h2>
            <ul className="space-y-2">
              {sub.cards.map((card) => (
                <li
                  key={card.certId}
                  className="border border-[#D4AF37]/20 rounded-lg p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-[#D4AF37] font-mono">{card.certIdStr}</div>
                    <div className="font-semibold truncate text-sm">
                      {card.cardName || "Unidentified"}{" "}
                      {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {(["front", "back"] as const).map((side) => (
                      <label key={side} className="text-[11px] flex flex-col items-center gap-0.5 cursor-pointer">
                        <span
                          className={
                            card[side === "front" ? "hasFront" : "hasBack"] ? "text-emerald-400" : "text-[#E8E4DC]/50"
                          }
                        >
                          {card[side === "front" ? "hasFront" : "hasBack"] ? "✓ " : ""}
                          {side}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          disabled={busyCert === card.certId}
                          className="hidden"
                          onChange={(e) => e.target.files?.[0] && upload(card.certId, side, e.target.files[0])}
                        />
                        <span className="border border-[#D4AF37]/40 rounded px-2 py-0.5 hover:bg-[#D4AF37]/10">
                          upload
                        </span>
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

// ── PRINT tab — the FULL Label Sheet Printing console, reused from the admin
// dashboard (thumbnails, All/Unprinted/Printed tabs, Generate Batch, Claim
// Inserts, Latest Sheet / reprint / PNG / Cut SVG). The SAME component renders
// here; only the API base differs (staff-authed print proxies, capability-gated).
// Printing is a fulfilment step over ALL printable certs — parity with admin.
function PrintTab() {
  return <PrintingConsole apiBase="/api/staff/print" />;
}

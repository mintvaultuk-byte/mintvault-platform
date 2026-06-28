import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import GradingPanel from "../components/grading/grading-panel";
import InstallAppButton from "../components/install-app-button";

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
  const count = queue.reduce((n, it) => n + it.cards.length, 0);
  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      <GradeAnalytics a={analytics} loading={aLoading} />
      {count === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No cards assigned to you.</p>
      ) : (
        <ul className="space-y-3">
          {queue.flatMap((it) =>
            it.cards.map((card) => (
              <li
                key={card.certId}
                className="border border-[#D4AF37]/20 rounded-lg p-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-[#D4AF37] font-mono text-xs">{it.submissionRef}</div>
                  <div className="font-semibold truncate">
                    {/* Lead with the MintVault cert number so the grader can match
                        the row to the physical cert — especially for unidentified
                        cards where there's no name to go on. */}
                    <span className="font-mono text-[#D4AF37]">{card.certIdStr}</span>
                    <span className="text-[#E8E4DC]/40"> · </span>
                    {card.cardName || "Unidentified card"}{" "}
                    {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
                  </div>
                  <div className="text-[#E8E4DC]/50 text-xs">
                    {[card.setName, card.year, card.variant].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {card.gradingStatus === "assigned" ? (
                  <button
                    onClick={() => setActive({ ref: it.submissionRef, card })}
                    className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C]"
                  >
                    Grade
                  </button>
                ) : card.gradingStatus === "pending_review" ? (
                  // Submitted but not yet approved — the grader can reopen the FULL
                  // grading workstation to correct it. It stays pending_review and
                  // never auto-publishes (saves via the gated /edit-submission).
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] uppercase tracking-wider text-amber-300">Submitted</span>
                    <button
                      onClick={() => setActive({ ref: it.submissionRef, card })}
                      data-testid={`btn-edit-submission-${card.certId}`}
                      className="border border-[#D4AF37]/50 text-[#D4AF37] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#D4AF37]/10"
                    >
                      Edit
                    </button>
                  </div>
                ) : (
                  <button
                    disabled
                    className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded opacity-40"
                  >
                    {card.gradingStatus}
                  </button>
                )}
              </li>
            ))
          )}
        </ul>
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

// ── PRINT tab — slab labels for printable certs (PII-FREE) ────────────────────
// Max sets on the locked 8-up guillotine sheet — mirrors server/print-batch.ts
// MAX_CERTS_PER_BATCH. Selecting more than this is blocked client-side.
const MAX_BATCH = 8;

function PrintTab() {
  const [certs, setCerts] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/staff/print/browser", { credentials: "include" });
      if (r.ok) {
        const d = await r.json();
        setCerts(Array.isArray(d) ? d : d.certificates || d.items || []);
      }
    })();
  }, []);

  function toggle(id: string) {
    setErr(null);
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_BATCH) {
        setErr(`A sheet holds at most ${MAX_BATCH} cards. Deselect one first.`);
        return cur;
      }
      return [...cur, id];
    });
  }

  async function printBatch() {
    if (!selected.length) return;
    setBatchBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/staff/print/batch", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certIds: selected }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Claimed certs can't be batched from here (admin reprint flow only).
        throw new Error(d.error || "Couldn't build the print sheet");
      }
      if (!d.batchId) throw new Error("No batch was produced");
      // Open the 8-up guillotine PDF via the staff artefact proxy.
      window.open(`/api/staff/print/batch/${encodeURIComponent(d.batchId)}/pdf`, "_blank", "noreferrer");
      setMsg(`Sheet ready — ${selected.length} card${selected.length === 1 ? "" : "s"}. Opened in a new tab.`);
      setSelected([]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      {certs.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No certificates ready for printing.</p>
      ) : (
        <>
          {/* Batch action bar — renders the locked 8-up guillotine sheet for the
              selected certs (reuses the existing renderer; layout unchanged). */}
          <div className="sticky top-0 z-10 bg-[#1A1400]/95 backdrop-blur border border-[#D4AF37]/20 rounded-lg p-3 mb-3 flex items-center justify-between gap-3">
            <div className="text-xs text-[#E8E4DC]/70">
              <span className="text-[#D4AF37] font-bold">{selected.length}</span> / {MAX_BATCH} selected for the 8-up sheet
            </div>
            <div className="flex items-center gap-2">
              {selected.length > 0 && (
                <button
                  onClick={() => setSelected([])}
                  className="text-xs text-[#E8E4DC]/60 hover:text-[#E8E4DC] px-2 py-1"
                >
                  Clear
                </button>
              )}
              <button
                onClick={printBatch}
                disabled={batchBusy || selected.length === 0}
                data-testid="btn-print-batch"
                className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C] disabled:opacity-40"
              >
                {batchBusy ? "Building…" : "Print 8-up sheet"}
              </button>
            </div>
          </div>
          {msg && (
            <div className="text-emerald-300 text-xs bg-emerald-950/30 border border-emerald-900/50 rounded px-3 py-2 mb-3">
              {msg}
            </div>
          )}
          {err && (
            <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2 mb-3">{err}</div>
          )}
          <ul className="space-y-2">
            {certs.map((c: any) => {
              const id = c.certId || c.cert_id || c.id;
              const claim = c.referenceNumber || c.reference_number || null;
              const isSel = selected.includes(id);
              return (
                <li
                  key={id}
                  className={`border rounded-lg p-3 flex items-center gap-3 ${
                    isSel ? "border-[#D4AF37] bg-[#D4AF37]/5" : "border-[#D4AF37]/20"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(id)}
                    data-testid={`print-select-${id}`}
                    className="h-4 w-4 shrink-0 accent-[#D4AF37]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-[#D4AF37] font-mono flex items-center gap-2 flex-wrap">
                      <span>{id}</span>
                      {/* Claim / document reference number (certificates.reference_number). */}
                      {claim ? (
                        <span className="text-[#E8E4DC]/60">claim {claim}</span>
                      ) : (
                        <span className="text-[#E8E4DC]/30">no claim #</span>
                      )}
                    </div>
                    <div className="font-semibold truncate text-sm">
                      {c.cardName || c.card_name || "—"}{" "}
                      {c.grade && <span className="text-[#E8E4DC]/60">· {c.grade}</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 text-xs shrink-0">
                    <a
                      href={`/api/staff/print/label/${id}/front.pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="border border-[#D4AF37]/40 rounded px-2 py-1 hover:bg-[#D4AF37]/10"
                    >
                      Front PDF
                    </a>
                    <a
                      href={`/api/staff/print/label/${id}/back.pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="border border-[#D4AF37]/40 rounded px-2 py-1 hover:bg-[#D4AF37]/10"
                    >
                      Back PDF
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}

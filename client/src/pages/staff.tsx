import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import GradingPanel from "../components/grading/grading-panel";

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

function GradeTab() {
  const [queue, setQueue] = useState<GItem[]>([]);
  const [active, setActive] = useState<{ ref: string; card: GCard } | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/grader/queue", { credentials: "include" });
    if (r.ok) setQueue((await r.json()).items || []);
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
                    {card.cardName || "Unidentified card"}{" "}
                    {card.cardNumber && <span className="text-[#E8E4DC]/50">#{card.cardNumber}</span>}
                  </div>
                  <div className="text-[#E8E4DC]/50 text-xs">
                    {[card.setName, card.year, card.variant].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <button
                  onClick={() => setActive({ ref: it.submissionRef, card })}
                  disabled={card.gradingStatus !== "assigned"}
                  className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold px-3 py-1.5 rounded hover:bg-[#B8960C] disabled:opacity-40"
                >
                  {card.gradingStatus === "assigned" ? "Grade" : "Submitted"}
                </button>
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
function PrintTab() {
  const [certs, setCerts] = useState<any[]>([]);
  useEffect(() => {
    (async () => {
      const r = await fetch("/api/staff/print/browser", { credentials: "include" });
      if (r.ok) {
        const d = await r.json();
        setCerts(Array.isArray(d) ? d : d.certificates || d.items || []);
      }
    })();
  }, []);
  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      {certs.length === 0 ? (
        <p className="text-[#E8E4DC]/60 text-sm text-center py-12">No certificates ready for printing.</p>
      ) : (
        <ul className="space-y-2">
          {certs.map((c: any) => {
            const id = c.certId || c.cert_id || c.id;
            return (
              <li
                key={id}
                className="border border-[#D4AF37]/20 rounded-lg p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-xs text-[#D4AF37] font-mono">{c.certId || c.cert_id || id}</div>
                  <div className="font-semibold truncate text-sm">
                    {c.cardName || c.card_name || "—"}{" "}
                    {c.grade && <span className="text-[#E8E4DC]/60">· {c.grade}</span>}
                  </div>
                </div>
                <div className="flex gap-2 text-xs">
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
      )}
    </main>
  );
}

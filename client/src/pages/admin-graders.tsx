import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Admin surface for the restricted-grader system (v2 — CERT-LEVEL). Create grader
 * accounts, set the per-card rate, and assign / reassign / unassign individual
 * CERTIFICATES (so each card in a multi-card submission can go to a different
 * grader). Admin-gated; every call hits requireAdmin server-side.
 */
type Grader = {
  id: string;
  email: string;
  displayName: string | null;
  approved: number;
  pendingReview: number;
  assigned: number;
  flagged: number;
};
type Cert = {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  year: string | null;
  variant: string | null;
  assignedGraderId: string | null;
  graderEmail: string | null;
  gradingStatus: string;
  redoCount: number;
};

export default function AdminGradersPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [graders, setGraders] = useState<Grader[]>([]);
  const [rate, setRate] = useState<number>(0);
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
    if (authed === false) navigate("/admin/login?next=/admin/graders", { replace: true });
  }, [authed, navigate]);

  const load = useCallback(async () => {
    const [g, r] = await Promise.all([
      fetch("/api/admin/graders", { credentials: "include" }),
      fetch("/api/admin/grader-rate", { credentials: "include" }),
    ]);
    if (g.ok) setGraders((await g.json()).graders || []);
    if (r.ok) setRate((await r.json()).rate || 0);
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  // create grader
  const [nEmail, setNEmail] = useState("");
  const [nPw, setNPw] = useState("");
  const [nName, setNName] = useState("");
  async function createGrader(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const res = await fetch("/api/admin/graders", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: nEmail, password: nPw, display_name: nName }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || "Failed to create grader");
    setMsg(`Grader created: ${d.email}`);
    setNEmail("");
    setNPw("");
    setNName("");
    load();
  }

  async function saveRate(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    const res = await fetch("/api/admin/grader-rate", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rate }),
    });
    if (!res.ok) return setErr("Failed to save rate");
    setMsg(`Per-card rate set to £${Number(rate).toFixed(2)}`);
  }

  // cert-level assignment
  const [subId, setSubId] = useState("");
  const [certs, setCerts] = useState<Cert[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [aGrader, setAGrader] = useState("");
  async function loadCerts(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setCerts([]);
    setSel(new Set());
    const id = parseInt(subId, 10);
    if (!Number.isInteger(id) || id <= 0) return setErr("Enter a submission ID");
    const res = await fetch(`/api/admin/submissions/${id}/certs`, { credentials: "include" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || "Failed to load certs");
    setCerts(d.certs || []);
    if (!d.certs?.length) setErr("No certificates found for that submission");
  }
  function toggle(certId: number) {
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(certId)) n.delete(certId);
      else n.add(certId);
      return n;
    });
  }
  async function doAssign(action: "assign" | "reassign" | "unassign") {
    setMsg(null);
    setErr(null);
    const cert_ids = Array.from(sel);
    if (!cert_ids.length) return setErr("Select one or more certificates");
    if (action !== "unassign" && !aGrader) return setErr("Pick a grader");
    const res = await fetch(`/api/admin/graders/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grader_id: aGrader, cert_ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || `${action} failed`);
    setMsg(`${action} ok — ${d.count} certificate(s) updated`);
    // refresh the cert list + grader counts
    const id = parseInt(subId, 10);
    const cr = await fetch(`/api/admin/submissions/${id}/certs`, { credentials: "include" });
    if (cr.ok) setCerts((await cr.json()).certs || []);
    setSel(new Set());
    load();
  }

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC] px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[#D4AF37] text-xl font-extrabold">Graders</h1>
          <button
            onClick={() => navigate("/admin")}
            className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
          >
            ← Admin
          </button>
        </div>
        {msg && (
          <div className="text-emerald-400 text-xs bg-emerald-950/40 border border-emerald-900 rounded px-3 py-2">
            {msg}
          </div>
        )}
        {err && <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2">{err}</div>}

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Create grader account</h2>
          <form onSubmit={createGrader} className="grid sm:grid-cols-4 gap-2 items-end">
            <input
              className="ag-input"
              placeholder="Email"
              type="email"
              value={nEmail}
              onChange={(e) => setNEmail(e.target.value)}
              required
            />
            <input
              className="ag-input"
              placeholder="Password (≥10)"
              type="text"
              value={nPw}
              onChange={(e) => setNPw(e.target.value)}
              required
            />
            <input
              className="ag-input"
              placeholder="Display name"
              value={nName}
              onChange={(e) => setNName(e.target.value)}
            />
            <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-2 rounded text-sm hover:bg-[#B8960C]">
              Create
            </button>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Per-card rate (earnings display)</h2>
          <form onSubmit={saveRate} className="flex items-end gap-2">
            <label className="text-xs">
              <span className="text-[#E8E4DC]/70">£ per approved card</span>
              <input
                className="ag-input mt-1"
                type="number"
                min="0"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              />
            </label>
            <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-2 px-4 rounded text-sm hover:bg-[#B8960C]">
              Save rate
            </button>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Assign cards (by submission)</h2>
          <form onSubmit={loadCerts} className="flex gap-2 mb-3">
            <input
              className="ag-input"
              placeholder="Submission ID, e.g. 1201"
              value={subId}
              onChange={(e) => setSubId(e.target.value)}
            />
            <button className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10">
              Load cards
            </button>
          </form>
          {certs.length > 0 && (
            <>
              <ul className="space-y-1 mb-3 max-h-64 overflow-auto">
                {certs.map((c) => (
                  <li key={c.certId} className="flex items-center gap-2 text-sm border-b border-[#D4AF37]/10 pb-1">
                    <input type="checkbox" checked={sel.has(c.certId)} onChange={() => toggle(c.certId)} />
                    <span className="font-mono text-xs text-[#D4AF37]">{c.certIdStr}</span>
                    <span className="truncate flex-1">
                      {c.cardName || "Unidentified"} {c.cardNumber ? `#${c.cardNumber}` : ""}
                    </span>
                    <span className="text-[10px] uppercase text-[#E8E4DC]/50">{c.gradingStatus.replace("_", " ")}</span>
                    {c.graderEmail && <span className="text-[10px] text-[#E8E4DC]/40">→ {c.graderEmail}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="ag-input flex-1 min-w-[180px]"
                  value={aGrader}
                  onChange={(e) => setAGrader(e.target.value)}
                >
                  <option value="">Select grader…</option>
                  {graders.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.displayName ? `${g.displayName} — ${g.email}` : g.email}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => doAssign("assign")}
                  className="bg-[#D4AF37] text-[#1A1400] font-bold px-4 py-2 rounded text-sm hover:bg-[#B8960C]"
                >
                  Assign
                </button>
                <button
                  onClick={() => doAssign("reassign")}
                  className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
                >
                  Reassign
                </button>
                <button
                  onClick={() => doAssign("unassign")}
                  className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10"
                >
                  Unassign
                </button>
              </div>
            </>
          )}
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Grader accounts ({graders.length})</h2>
          {graders.length === 0 ? (
            <p className="text-[#E8E4DC]/50 text-xs">No graders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#E8E4DC]/50 text-[11px] uppercase text-left">
                  <th className="py-1">Grader</th>
                  <th>Assigned</th>
                  <th>Pending</th>
                  <th>Approved</th>
                  <th>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {graders.map((g) => (
                  <tr key={g.id} className="border-t border-[#D4AF37]/10">
                    <td className="py-1.5">
                      {g.displayName || "—"} <span className="text-[#E8E4DC]/50 text-xs">{g.email}</span>
                    </td>
                    <td>{g.assigned}</td>
                    <td className="text-amber-400">{g.pendingReview}</td>
                    <td className="text-emerald-400">{g.approved}</td>
                    <td>{g.flagged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <style>{`.ag-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:8px;color:#E8E4DC;font-size:13px;outline:none}.ag-input:focus{border-color:#D4AF37}`}</style>
    </div>
  );
}

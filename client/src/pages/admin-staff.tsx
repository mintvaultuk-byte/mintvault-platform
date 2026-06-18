import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Admin staff hub (evolves admin-graders). One staff account list with per-person
 * capability toggles (grade/scan/print); GRADE assignment is cert-level, SCAN
 * assignment is submission-level; per-person counts. All admin-gated.
 */
type Staff = {
  id: string;
  email: string;
  displayName: string | null;
  caps: { grade: boolean; scan: boolean; print: boolean };
  gradeAssigned: number;
  gradePending: number;
  gradeApproved: number;
  scanAssigned: number;
};
type Cert = {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  cardNumber: string | null;
  gradingStatus: string;
  graderEmail: string | null;
};

export default function AdminStaffPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rate, setRate] = useState(0);
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
    if (r.ok) setRate((await r.json()).rate || 0);
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  // create staff
  const [nEmail, setNEmail] = useState("");
  const [nPw, setNPw] = useState("");
  const [nName, setNName] = useState("");
  const [nCaps, setNCaps] = useState({ grade: true, scan: false, print: false });
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
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || "Failed to create staff");
    setMsg(`Staff created: ${d.email}`);
    setNEmail("");
    setNPw("");
    setNName("");
    load();
  }

  async function toggleCap(id: string, cap: "grade" | "scan" | "print", value: boolean) {
    setMsg(null);
    setErr(null);
    const body: any = {};
    body[cap === "grade" ? "can_grade" : cap === "scan" ? "can_scan" : "can_print"] = value;
    const res = await fetch(`/api/admin/staff/${id}/capabilities`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(d.error || "Failed to update");
    }
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

  // GRADE assignment (cert-level)
  const [gSubId, setGSubId] = useState("");
  const [certs, setCerts] = useState<Cert[]>([]);
  const [gSel, setGSel] = useState<Set<number>>(new Set());
  const [gStaff, setGStaff] = useState("");
  async function loadCerts(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setCerts([]);
    setGSel(new Set());
    const id = parseInt(gSubId, 10);
    if (!Number.isInteger(id) || id <= 0) return setErr("Enter a submission ID");
    const res = await fetch(`/api/admin/submissions/${id}/certs`, { credentials: "include" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || "Failed to load certs");
    setCerts(d.certs || []);
  }
  async function assignGrade(action: "assign" | "reassign" | "unassign") {
    setMsg(null);
    setErr(null);
    const cert_ids = Array.from(gSel);
    if (!cert_ids.length) return setErr("Select certificates");
    if (action !== "unassign" && !gStaff) return setErr("Pick a grader");
    const res = await fetch(`/api/admin/graders/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grader_id: gStaff, cert_ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error || `${action} failed`);
    setMsg(`Grade ${action}: ${d.count} card(s)`);
    loadCerts({ preventDefault() {} } as any);
    load();
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
    if (!res.ok) return setErr(d.error || `${action} failed`);
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

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  const graders = staff.filter((s) => s.caps.grade);
  const scanners = staff.filter((s) => s.caps.scan);

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC] px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[#D4AF37] text-xl font-extrabold">Staff</h1>
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
              {(["grade", "scan", "print"] as const).map((c) => (
                <label key={c} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={(nCaps as any)[c]}
                    onChange={(e) => setNCaps((p) => ({ ...p, [c]: e.target.checked }))}
                  />{" "}
                  can {c}
                </label>
              ))}
              <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-1.5 px-4 rounded text-sm hover:bg-[#B8960C] ml-auto">
                Create
              </button>
            </div>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Per-card grade rate</h2>
          <form onSubmit={saveRate} className="flex items-end gap-2">
            <input
              className="ss-input w-40"
              type="number"
              min="0"
              step="0.01"
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
            <button className="bg-[#D4AF37] text-[#1A1400] font-bold py-2 px-4 rounded text-sm hover:bg-[#B8960C]">
              Save rate
            </button>
          </form>
        </section>

        <section className="border border-[#D4AF37]/20 rounded-lg p-4">
          <h2 className="text-[#D4AF37] font-semibold text-sm mb-3">Assign cards to grade (by submission)</h2>
          <form onSubmit={loadCerts} className="flex gap-2 mb-3">
            <input
              className="ss-input"
              placeholder="Submission ID"
              value={gSubId}
              onChange={(e) => setGSubId(e.target.value)}
            />
            <button className="border border-[#D4AF37]/40 px-4 py-2 rounded text-sm hover:bg-[#D4AF37]/10">
              Load cards
            </button>
          </form>
          {certs.length > 0 && (
            <>
              <ul className="space-y-1 mb-3 max-h-56 overflow-auto">
                {certs.map((c) => (
                  <li key={c.certId} className="flex items-center gap-2 text-sm border-b border-[#D4AF37]/10 pb-1">
                    <input type="checkbox" checked={gSel.has(c.certId)} onChange={() => toggleSel(c.certId)} />
                    <span className="font-mono text-xs text-[#D4AF37]">{c.certIdStr}</span>
                    <span className="truncate flex-1">{c.cardName || "Unidentified"}</span>
                    <span className="text-[10px] uppercase text-[#E8E4DC]/50">{c.gradingStatus.replace("_", " ")}</span>
                    {c.graderEmail && <span className="text-[10px] text-[#E8E4DC]/40">→ {c.graderEmail}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2 items-center">
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
                  <th>Workload</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className="border-t border-[#D4AF37]/10">
                    <td className="py-1.5">
                      {s.displayName || "—"} <span className="text-[#E8E4DC]/50 text-xs">{s.email}</span>
                    </td>
                    {(["grade", "scan", "print"] as const).map((cap) => (
                      <td key={cap}>
                        <input
                          type="checkbox"
                          checked={s.caps[cap]}
                          onChange={(e) => toggleCap(s.id, cap, e.target.checked)}
                        />
                      </td>
                    ))}
                    <td className="text-xs text-[#E8E4DC]/70">
                      {s.caps.grade && `${s.gradeAssigned}a/${s.gradePending}p/${s.gradeApproved}✓ `}
                      {s.caps.scan && `${s.scanAssigned} box`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <style>{`.ss-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:8px;color:#E8E4DC;font-size:13px;outline:none}.ss-input:focus{border-color:#D4AF37}`}</style>
    </div>
  );
}

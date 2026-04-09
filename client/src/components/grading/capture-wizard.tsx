import { useState, useRef } from "react";
import { Camera, CheckCircle2, AlertTriangle, ChevronRight, ChevronLeft, Upload, Loader2, QrCode } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface QualityCheck { name: string; status: "pass" | "warn" | "fail"; message: string; }
interface QualityResult { overall: "pass" | "warn" | "fail"; checks: QualityCheck[]; }

interface Props {
  certId: number;
  onComplete: () => void;
  existingQuality?: Record<string, QualityResult>;
  hotFolderActive?: boolean;
}

type WizardStep = "setup" | "front" | "back" | "angled" | "closeup" | "quality";

const STEP_ORDER: WizardStep[] = ["setup", "front", "back", "angled", "closeup", "quality"];
const STEP_PROGRESS: Record<WizardStep, number> = { setup: 0, front: 25, back: 50, angled: 75, closeup: 90, quality: 100 };

const STATUS_ICON = {
  pass: <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />,
  warn: <AlertTriangle size={14} className="text-yellow-400 flex-shrink-0" />,
  fail: <AlertTriangle size={14} className="text-red-400 flex-shrink-0" />,
};
const STATUS_TEXT = { pass: "text-[#888888]", warn: "text-yellow-400", fail: "text-red-400" };

// ── Setup diagram SVG ──────────────────────────────────────────────────────

function SetupDiagram() {
  return (
    <div className="grid grid-cols-2 gap-4 my-4">
      <div className="border border-emerald-700/40 rounded-lg p-3 text-center bg-emerald-950/20">
        <p className="text-emerald-400 text-[10px] font-bold uppercase tracking-widest mb-2">✓ Good</p>
        <svg viewBox="0 0 80 60" className="w-full mx-auto" style={{ maxWidth: 80 }}>
          <rect x="5" y="15" width="70" height="30" rx="2" fill="#222" stroke="#D4AF37" strokeWidth="1" />
          <rect x="15" y="22" width="50" height="16" rx="1" fill="#333" stroke="#D4AF37" strokeWidth="0.5" />
          <line x1="0" y1="30" x2="80" y2="30" stroke="#555" strokeWidth="0.5" strokeDasharray="3,3" />
          <text x="40" y="50" textAnchor="middle" fontSize="6" fill="#888">flat, parallel, even light</text>
        </svg>
      </div>
      <div className="border border-red-700/40 rounded-lg p-3 text-center bg-red-950/20">
        <p className="text-red-400 text-[10px] font-bold uppercase tracking-widest mb-2">✗ Bad</p>
        <svg viewBox="0 0 80 60" className="w-full mx-auto" style={{ maxWidth: 80 }}>
          <rect x="5" y="10" width="70" height="30" rx="2" fill="#222" stroke="#DC2626" strokeWidth="1" transform="rotate(-12 40 25)" />
          <line x1="60" y1="5" x2="55" y2="30" stroke="#EAB308" strokeWidth="1" opacity="0.7" />
          <text x="40" y="52" textAnchor="middle" fontSize="6" fill="#888">angled, shadows, glare</text>
        </svg>
      </div>
    </div>
  );
}

// ── Upload zone ────────────────────────────────────────────────────────────

function UploadZone({ file, onFile, label, hotFolderActive }: {
  file: File | null;
  onFile: (f: File) => void;
  label: string;
  hotFolderActive?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const preview = file ? URL.createObjectURL(file) : null;

  return (
    <div>
      <div
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
          dragging ? "border-[#D4AF37] bg-[#D4AF37]/5" : file ? "border-emerald-600/50 bg-emerald-950/10" : "border-[#444444] hover:border-[#D4AF37]/50"
        }`}
        onClick={() => ref.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault(); setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && f.type.startsWith("image/")) onFile(f);
        }}
      >
        <input ref={ref} type="file" accept="image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        {preview ? (
          <div className="space-y-2">
            <img src={preview} alt="preview" className="max-h-32 mx-auto rounded-lg object-contain" />
            <p className="text-emerald-400 text-xs">✓ {file!.name}</p>
            <button type="button" onClick={e => { e.stopPropagation(); ref.current?.click(); }} className="text-[#D4AF37]/60 text-[10px] hover:text-[#D4AF37]">Retake</button>
          </div>
        ) : (
          <div className="space-y-2">
            <Upload size={24} className="mx-auto text-[#555555]" />
            <p className="text-[#888888] text-sm">{label}</p>
            <p className="text-[#555555] text-[10px]">Drop here or click to browse · JPEG / PNG</p>
          </div>
        )}
      </div>
      {hotFolderActive && (
        <p className="text-[10px] text-[#888888] mt-2 flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Scanner connected — images upload automatically
        </p>
      )}
      {!hotFolderActive && (
        <p className="text-[#555555] text-[10px] mt-2">Or scan directly — images from your MintVault Scans folder upload automatically</p>
      )}
    </div>
  );
}

// ── Phone QR panel ─────────────────────────────────────────────────────────

function PhoneQRPanel({ certId, imageType }: { certId: number; imageType: string }) {
  const [qrData, setQrData] = useState<{ uploadUrl: string; token: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(900);

  async function openQR() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/upload-token", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certId, imageType }),
      });
      const data = await res.json();
      setQrData(data);
      const interval = setInterval(() => {
        setSecondsLeft(s => {
          if (s <= 1) { clearInterval(interval); return 0; }
          return s - 1;
        });
      }, 1000);
    } catch { /* ignore */ }
    setLoading(false);
  }

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;

  if (!qrData) {
    return (
      <div className="mt-3 border-t border-[#222222] pt-3">
        <p className="text-[#888888] text-xs mb-2">Prefer to use your phone?</p>
        <button type="button" onClick={openQR} disabled={loading}
          className="flex items-center gap-2 border border-[#333333] text-[#CCCCCC] text-xs px-3 py-2 rounded hover:border-[#555555] transition-all disabled:opacity-40">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <QrCode size={13} />}
          Open Phone Camera
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-[#222222] pt-3 space-y-2">
      <p className="text-[#D4AF37] text-xs font-bold">Scan with your phone:</p>
      <div className="bg-white p-3 rounded-lg inline-block">
        <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrData.uploadUrl)}`} alt="Upload QR" className="w-32 h-32" />
      </div>
      <p className="text-[#888888] text-[10px] break-all">{qrData.uploadUrl}</p>
      <p className={`text-xs ${secondsLeft < 60 ? "text-red-400" : "text-[#888888]"}`}>
        Expires in {mins}:{String(secs).padStart(2, "0")}
      </p>
      <p className="text-[#555555] text-[10px] animate-pulse">Waiting for photo…</p>
    </div>
  );
}

// ── Main wizard ────────────────────────────────────────────────────────────

export default function CaptureWizard({ certId, onComplete, existingQuality, hotFolderActive }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState<WizardStep>("setup");
  const [setupReady, setSetupReady] = useState(false);
  const [files, setFiles] = useState<{ front?: File; back?: File; angled?: File; closeup?: File }>({});
  const [uploading, setUploading] = useState(false);
  const [quality, setQuality] = useState<Record<string, QualityResult>>(existingQuality || {});

  const progress = STEP_PROGRESS[step];

  function next() {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]);
  }
  function back() {
    const idx = STEP_ORDER.indexOf(step);
    if (idx > 0) setStep(STEP_ORDER[idx - 1]);
  }

  async function uploadAndCheck() {
    if (!files.front && !files.back) {
      toast({ title: "Front image required", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      if (files.front)   fd.append("front",   files.front);
      if (files.back)    fd.append("back",    files.back);
      if (files.angled)  fd.append("angled",  files.angled);
      if (files.closeup) fd.append("closeup", files.closeup);
      const res = await fetch(`/api/admin/certificates/${certId}/upload-images`, {
        method: "POST", credentials: "include", body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setQuality(data.quality || {});
      setStep("quality");
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="bg-[#0A0A0A] border border-[#D4AF37]/20 rounded-xl p-5 space-y-5">
      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
            <Camera size={12} />
            Image Capture
          </p>
          {hotFolderActive && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              Scanner connected
            </span>
          )}
        </div>
        <div className="h-1.5 bg-[#222222] rounded-full overflow-hidden">
          <div className="h-full bg-[#D4AF37] rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Step: Setup */}
      {step === "setup" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Prepare Your Scanning Station</h3>
          <ol className="space-y-2">
            {[
              "Remove the card from any sleeve, toploader, or case",
              "Gently clean the card surface with a microfibre cloth if needed",
              "Place the card on your flatbed scanner glass (or dark, flat surface if using a camera)",
              "Ensure even, diffuse lighting — no harsh shadows or bright spots",
              "Scanner users: scan at 1200 DPI minimum for best results",
              "Camera users: position directly above the card, perfectly parallel",
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#D4AF37]/20 text-[#D4AF37] text-[10px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                <span className="text-[#CCCCCC] text-sm">{item}</span>
              </li>
            ))}
          </ol>
          <SetupDiagram />
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={setupReady} onChange={e => setSetupReady(e.target.checked)} className="accent-[#D4AF37] w-4 h-4" />
            <span className="text-[#CCCCCC] text-sm">My scanning station is ready</span>
          </label>
          <button
            type="button" onClick={next} disabled={!setupReady}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2.5 rounded-lg disabled:opacity-40 hover:opacity-90 transition-all"
          >
            Start Scanning <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* Step: Front */}
      {step === "front" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Step 1 of 4 — Front of Card</h3>
          <p className="text-[#888888] text-sm">Place the card <strong className="text-white">FACE UP</strong> on the scanner. All four edges and corners must be fully visible.</p>
          <UploadZone file={files.front || null} onFile={f => setFiles(p => ({ ...p, front: f }))} label="Drop your front scan here or click to browse" hotFolderActive={hotFolderActive} />
          <NavRow onBack={back} onNext={next} nextDisabled={!files.front} />
        </div>
      )}

      {/* Step: Back */}
      {step === "back" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Step 2 of 4 — Back of Card</h3>
          <p className="text-[#888888] text-sm">Flip the card <strong className="text-white">FACE DOWN</strong> — same position. Do not move the scanner or adjust lighting.</p>
          <UploadZone file={files.back || null} onFile={f => setFiles(p => ({ ...p, back: f }))} label="Drop your back scan here or click to browse" hotFolderActive={hotFolderActive} />
          <NavRow onBack={back} onNext={next} nextDisabled={!files.back} />
        </div>
      )}

      {/* Step: Angled */}
      {step === "angled" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Step 3 of 4 — Angled View <span className="text-[#888888] text-sm font-normal">(Optional)</span></h3>
          <p className="text-[#888888] text-sm">Tilt the card <strong className="text-white">45° under direct light</strong>. This reveals scratches on holographic and foil surfaces invisible in flat scans.</p>
          <p className="text-[#555555] text-xs">Recommended for holo, reverse holo, foil, and full art cards.</p>
          <UploadZone file={files.angled || null} onFile={f => setFiles(p => ({ ...p, angled: f }))} label="Drop angled shot here or click to browse" hotFolderActive={hotFolderActive} />
          <PhoneQRPanel certId={certId} imageType="angled" />
          <NavRow onBack={back} onNext={next} onSkip={next} skipLabel="Skip — not holographic" />
        </div>
      )}

      {/* Step: Close-up */}
      {step === "closeup" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Step 4 of 4 — Close-up <span className="text-[#888888] text-sm font-normal">(Optional)</span></h3>
          <p className="text-[#888888] text-sm">Photograph <strong className="text-white">any area of concern</strong>. If you've spotted a defect, capture a close-up for documentation.</p>
          <UploadZone file={files.closeup || null} onFile={f => setFiles(p => ({ ...p, closeup: f }))} label="Drop close-up here or click to browse" hotFolderActive={hotFolderActive} />
          <PhoneQRPanel certId={certId} imageType="closeup" />
          <div className="flex items-center gap-3">
            <button type="button" onClick={back} className="flex items-center gap-1 text-[#888888] hover:text-[#CCCCCC] text-xs"><ChevronLeft size={13} /> Back</button>
            <button
              type="button" onClick={uploadAndCheck} disabled={uploading}
              className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2.5 rounded-lg disabled:opacity-40 hover:opacity-90"
            >
              {uploading ? <Loader2 size={13} className="animate-spin" /> : null}
              {uploading ? "Uploading…" : "Upload & Check Quality"}
            </button>
            {!uploading && <button type="button" onClick={uploadAndCheck} className="text-[#555555] text-xs hover:text-[#888888]">Skip close-up</button>}
          </div>
        </div>
      )}

      {/* Step: Quality results */}
      {step === "quality" && (
        <div className="space-y-4">
          <h3 className="text-white text-base font-bold">Image Quality Check</h3>
          {Object.entries(quality).map(([angle, q]) => (
            <div key={angle} className="bg-[#111111] rounded-lg p-3">
              <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest mb-2 capitalize">{angle}</p>
              <div className="space-y-1.5">
                {(q.checks || []).map((c: QualityCheck, i: number) => (
                  <div key={i} className="flex items-start gap-2">
                    {STATUS_ICON[c.status]}
                    <p className={`text-xs ${STATUS_TEXT[c.status]}`}>{c.message}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {Object.values(quality).every(q => q.overall !== "fail") ? (
            <div className="flex items-center gap-2 bg-emerald-950/30 border border-emerald-700/40 rounded-lg px-4 py-3">
              <CheckCircle2 size={16} className="text-emerald-400" />
              <p className="text-emerald-400 text-sm font-bold">Images ready for grading ✓</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-red-950/30 border border-red-700/40 rounded-lg px-4 py-3">
              <AlertTriangle size={16} className="text-red-400" />
              <p className="text-red-400 text-sm">Some checks failed — consider rescanning.</p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button" onClick={onComplete}
              className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2.5 rounded-lg hover:opacity-90"
            >
              Proceed to Grading <ChevronRight size={14} />
            </button>
            <button type="button" onClick={() => setStep("front")} className="text-[#555555] text-xs hover:text-[#888888]">Proceed anyway</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NavRow({ onBack, onNext, nextDisabled, onSkip, skipLabel }: {
  onBack: () => void; onNext: () => void; nextDisabled?: boolean;
  onSkip?: () => void; skipLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-[#888888] hover:text-[#CCCCCC] text-xs"><ChevronLeft size={13} /> Back</button>
      <button
        type="button" onClick={onNext} disabled={nextDisabled}
        className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-2 rounded-lg disabled:opacity-40 hover:opacity-90"
      >
        Next <ChevronRight size={13} />
      </button>
      {onSkip && <button type="button" onClick={onSkip} className="text-[#555555] text-xs hover:text-[#888888]">{skipLabel || "Skip"} →</button>}
    </div>
  );
}

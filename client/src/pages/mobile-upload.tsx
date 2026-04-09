import { useState, useRef } from "react";
import { useParams, useSearch } from "wouter";
import { Camera, Upload, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";

export default function MobileUploadPage() {
  const params = useParams<{ certId: string; imageType: string }>();
  const searchStr = useSearch();
  const search = new URLSearchParams(searchStr);
  const token = search.get("token") || "";

  const { certId, imageType } = params;
  const isAngled  = imageType === "angled";
  const isCloseup = imageType === "closeup";
  const label = isAngled ? "Angled View" : isCloseup ? "Close-up" : "Photo";
  const instruction = isAngled
    ? "Hold the card at 45° under direct light to reveal holo scratches, then tap the button below."
    : isCloseup
      ? "Position over any area of concern, then tap the button below."
      : "Take a clear photo of the card, then tap the button below.";

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File) {
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setError("");
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch(`/api/upload/${certId}/${imageType}?token=${encodeURIComponent(token)}`, {
        method: "POST", body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center px-6 text-center gap-4">
        <CheckCircle2 size={56} className="text-emerald-400" />
        <h1 className="text-white text-xl font-bold">Photo uploaded successfully</h1>
        <p className="text-[#888888] text-sm">You can close this page. The image will appear in the admin panel shortly.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center px-6 pt-12 pb-8 gap-6">
      {/* Logo */}
      <p className="text-[#D4AF37] text-sm font-bold uppercase tracking-widest">MintVault UK</p>

      <div className="text-center">
        <h1 className="text-white text-xl font-bold mb-2">Take {label}</h1>
        <p className="text-[#888888] text-sm leading-relaxed">{instruction}</p>
      </div>

      {/* Preview / upload zone */}
      <div className="w-full max-w-sm">
        {preview ? (
          <div className="space-y-3">
            <img src={preview} alt="preview" className="w-full rounded-2xl object-contain max-h-72 border border-[#333333]" />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setFile(null); setPreview(null); }}
                className="flex-1 border border-[#333333] text-[#888888] text-sm py-3 rounded-xl hover:bg-[#111111] transition-all"
              >
                Retake
              </button>
              <button
                type="button"
                onClick={upload}
                disabled={uploading}
                className="flex-[2] flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-sm font-bold py-3 rounded-xl disabled:opacity-50 hover:opacity-90"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Camera button */}
            <button
              type="button"
              onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.capture = "environment"; i.onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleFile(f); }; i.click(); }}
              className="w-full flex items-center justify-center gap-3 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-sm font-bold py-5 rounded-2xl hover:opacity-90 active:scale-95 transition-all"
            >
              <Camera size={22} />
              Take Photo
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full border border-[#333333] text-[#888888] text-sm py-4 rounded-2xl hover:bg-[#111111] transition-all"
            >
              Choose from Gallery
            </button>
            <input ref={inputRef} type="file" accept="image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 mt-3 bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3">
            <AlertTriangle size={16} className="text-red-400" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}
      </div>

      <p className="text-[#444444] text-xs text-center">
        Certificate {certId} · {label}<br />
        Secure upload — this link expires in 15 minutes.
      </p>
    </div>
  );
}

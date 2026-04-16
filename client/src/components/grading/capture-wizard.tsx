import { useState, useRef } from "react";
import { Camera, CheckCircle2, Upload, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  certId: number;
  onComplete: () => void;
  existingQuality?: Record<string, unknown>;
  hotFolderActive?: boolean;
}

// ── Drop zone for a single side ──────────────────────────────────────────────

function DropZone({ side, file, uploading, processed, onFile }: {
  side: "front" | "back";
  file: File | null;
  uploading: boolean;
  processed: boolean;
  onFile: (f: File) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files[0];
        if (f && f.type.startsWith("image/")) onFile(f);
      }}
      onClick={() => !uploading && inputRef.current?.click()}
      className={`
        h-56 rounded-xl border-2 border-dashed cursor-pointer
        flex flex-col items-center justify-center gap-2
        transition-all
        ${isDragging ? "border-[#D4AF37] bg-[#D4AF37]/5" : "border-[#D4D0C8] hover:border-[#D4AF37]/50"}
        ${processed ? "border-emerald-600/50 bg-emerald-50" : ""}
        ${uploading ? "cursor-wait opacity-80" : ""}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />

      {uploading ? (
        <>
          <Loader2 className="text-[#D4AF37] animate-spin" size={28} />
          <p className="text-[#3A3A3A] text-sm">Uploading & processing…</p>
          <p className="text-[#888888] text-[10px]">Auto-cropping and generating analysis views</p>
        </>
      ) : processed && file ? (
        <>
          <div className="w-20 h-28 bg-[#F0EEE8] rounded overflow-hidden">
            <img src={URL.createObjectURL(file)} alt={side} className="w-full h-full object-contain" />
          </div>
          <p className="text-emerald-600 text-xs font-bold flex items-center gap-1">
            <CheckCircle2 size={12} /> PROCESSED
          </p>
          <p className="text-[#888888] text-[10px]">Click to replace</p>
        </>
      ) : (
        <>
          <Upload size={28} className="text-[#888888]" />
          <p className="text-[#3A3A3A] text-sm font-bold">Drop {side} image here</p>
          <p className="text-[#888888] text-[10px]">or click to browse · JPEG / PNG / WebP</p>
        </>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CaptureWizard({ certId, onComplete }: Props) {
  const { toast } = useToast();
  const [files, setFiles] = useState<{ front: File | null; back: File | null }>({ front: null, back: null });
  const [uploading, setUploading] = useState<{ front: boolean; back: boolean }>({ front: false, back: false });
  const [processed, setProcessed] = useState<{ front: boolean; back: boolean }>({ front: false, back: false });

  async function handleFileSelect(side: "front" | "back", file: File) {
    setFiles(prev => ({ ...prev, [side]: file }));
    setUploading(prev => ({ ...prev, [side]: true }));
    setProcessed(prev => ({ ...prev, [side]: false }));

    try {
      const fd = new FormData();
      fd.append(side, file);
      const res = await fetch(`/api/admin/certificates/${certId}/upload-images`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
        console.error(`[capture-wizard] upload failed for cert ${certId}, side ${side}:`, errMsg);
        throw new Error(errMsg);
      }
      const data = await res.json();

      setProcessed(prev => {
        const next = { ...prev, [side]: true };
        // If both sides are done, notify parent
        if (next.front && next.back) {
          setTimeout(() => onComplete(), 500);
        }
        return next;
      });

      toast({ title: `${side.charAt(0).toUpperCase() + side.slice(1)} image processed` });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
      setFiles(prev => ({ ...prev, [side]: null }));
    } finally {
      setUploading(prev => ({ ...prev, [side]: false }));
    }
  }

  return (
    <div className="bg-white border border-[#D4AF37]/20 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <Camera size={16} className="text-[#D4AF37]" />
        <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Image Capture</p>
      </div>
      <p className="text-[#666666] text-xs mb-5">
        Drag front and back scans here, or click to browse. Images are auto-cropped and processed for AI analysis.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#D4AF37]/70 mb-2 font-bold">Front of Card</p>
          <DropZone
            side="front"
            file={files.front}
            uploading={uploading.front}
            processed={processed.front}
            onFile={(f) => handleFileSelect("front", f)}
          />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#D4AF37]/70 mb-2 font-bold">Back of Card</p>
          <DropZone
            side="back"
            file={files.back}
            uploading={uploading.back}
            processed={processed.back}
            onFile={(f) => handleFileSelect("back", f)}
          />
        </div>
      </div>

      {processed.front && processed.back && (
        <div className="mt-5 flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
          <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0" />
          <p className="text-emerald-600 text-sm">Both images uploaded and processed. Scroll down to click <strong>ANALYZE WITH AI</strong>.</p>
        </div>
      )}

      {processed.front && !files.back && (
        <p className="mt-4 text-[#666666] text-xs text-center">Front image processed. Upload back image to continue, or scroll down to analyze front only.</p>
      )}
    </div>
  );
}

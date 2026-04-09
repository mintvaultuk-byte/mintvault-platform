import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { CertificateRecord } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Wifi,
  WifiOff,
  CheckCircle2,
  Lock,
  Loader2,
  ExternalLink,
  Trash2,
  ShieldCheck,
  KeyRound,
} from "lucide-react";

const NFC_BASE_URL = "https://mintvaultuk.com/nfc";

type NfcOp = "idle" | "reading" | "writing" | "locking" | "testing";

function nfcAvailable(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

function nfcStatus(cert: CertificateRecord): {
  label: string;
  color: "default" | "secondary" | "destructive" | "outline";
  icon: React.ReactNode;
} {
  if (!cert.nfcUid) return { label: "No NFC assigned", color: "outline",    icon: <WifiOff className="h-3 w-3" /> };
  if (cert.nfcLocked)  return { label: "Tag locked",     color: "default",   icon: <Lock className="h-3 w-3" /> };
  if (cert.nfcWrittenAt) return { label: "Tag written",  color: "secondary", icon: <CheckCircle2 className="h-3 w-3" /> };
  return { label: "Tag detected",   color: "outline",   icon: <Wifi className="h-3 w-3" /> };
}

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

interface Props {
  cert: CertificateRecord;
  onUpdated: (updated: CertificateRecord) => void;
}

export default function NfcSection({ cert, onUpdated }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [op, setOp] = useState<NfcOp>("idle");
  const [pendingUid, setPendingUid] = useState<string | null>(null);
  const [pendingChipType, setPendingChipType] = useState<string | null>(null);
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [manualUid, setManualUid] = useState("");
  const [manualChipType, setManualChipType] = useState("");
  const [overwritePending, setOverwritePending] = useState<{ uid: string; chipType?: string } | null>(null);

  const nfcUrl = `${NFC_BASE_URL}/${cert.certId}`;
  const status = nfcStatus(cert);
  const supported = nfcAvailable();

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
  }

  const saveMutation = useMutation({
    mutationFn: (data: { uid: string; chipType?: string; url: string; overwrite?: boolean }) =>
      apiRequest("POST", `/api/admin/certificates/${cert.id}/nfc`, data),
    onSuccess: async (res) => {
      const updated = await res.json();
      onUpdated(updated);
      invalidate();
      setManualUid("");
      setManualChipType("");
      setOverwritePending(null);
      setPendingUid(null);
      toast({ title: "NFC tag saved", description: `UID: ${updated.nfcUid}` });
    },
    onError: async (err: any) => {
      const body = await err?.response?.json?.().catch(() => null);
      if (body?.conflict) {
        toast({
          title: "UID already in use",
          description: `This UID is already registered to ${body.conflict}. Each tag must be unique.`,
          variant: "destructive",
        });
      } else if (body?.code === "ALREADY_ASSIGNED") {
        // Cert already has a different UID — ask for overwrite confirmation
        const incomingUid = manualUid || pendingUid || "";
        setOverwritePending({ uid: incomingUid, chipType: manualChipType || pendingChipType || undefined });
      } else {
        toast({ title: "Save failed", description: body?.error || "Could not save NFC data.", variant: "destructive" });
      }
    },
  });

  const lockMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/certificates/${cert.id}/nfc/lock`, {}),
    onSuccess: async (res) => {
      const updated = await res.json();
      onUpdated(updated);
      invalidate();
      toast({ title: "Tag locked", description: "This tag is now permanently read-only." });
    },
    onError: () => toast({ title: "Lock failed", variant: "destructive" }),
  });

  const verifyMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/certificates/${cert.id}/nfc/verify`, {}),
    onSuccess: async () => {
      toast({ title: "Verification recorded" });
      invalidate();
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/certificates/${cert.id}/nfc`),
    onSuccess: async (res) => {
      const updated = await res.json();
      onUpdated(updated);
      invalidate();
      setPendingUid(null);
      setPendingChipType(null);
      toast({ title: "NFC record cleared" });
    },
    onError: () => toast({ title: "Clear failed", variant: "destructive" }),
  });

  const handleRead = useCallback(async () => {
    if (!supported) return;
    setOp("reading");
    try {
      const reader = new (window as any).NDEFReader();
      await reader.scan();
      toast({ title: "Tap your NFC tag now…", description: "Hold the tag to the back of your phone." });
      reader.onreading = (event: any) => {
        const uid: string = event.serialNumber || "unknown";
        const chipType = uid.replace(/:/g, "").length === 14 ? "NTAG215" : "NTAG";
        setPendingUid(uid);
        setPendingChipType(chipType);
        setOp("idle");
        toast({ title: "Tag detected", description: `UID: ${uid}  •  Type: ${chipType}` });
      };
      reader.onreadingerror = () => {
        setOp("idle");
        toast({ title: "Read failed", description: "Could not read the tag.", variant: "destructive" });
      };
    } catch (err: any) {
      setOp("idle");
      toast({ title: "Read error", description: err.message || "NFC read failed.", variant: "destructive" });
    }
  }, [supported, toast]);

  const handleWrite = useCallback(async () => {
    if (!supported) return;
    setOp("writing");
    try {
      const reader = new (window as any).NDEFReader();
      toast({ title: "Tap the NFC tag to write…", description: nfcUrl });
      await reader.write({ records: [{ recordType: "url", data: nfcUrl }] });
      const uid = pendingUid || cert.nfcUid || "unknown";
      const chipType = pendingChipType || cert.nfcChipType || undefined;
      await saveMutation.mutateAsync({ uid, chipType, url: nfcUrl });
      setPendingUid(null);
      setPendingChipType(null);
      setOp("idle");
    } catch (err: any) {
      setOp("idle");
      toast({ title: "Write failed", description: err.message || "Could not write tag.", variant: "destructive" });
    }
  }, [supported, nfcUrl, pendingUid, pendingChipType, cert, saveMutation, toast]);

  const handleLock = useCallback(async () => {
    if (!supported) return;
    setOp("locking");
    try {
      const reader = new (window as any).NDEFReader();
      toast({ title: "Tap the tag to lock…", description: "This cannot be undone." });
      try {
        await reader.makeReadOnly();
      } catch {
        // makeReadOnly may not be available on all devices — still mark as locked in DB
      }
      await lockMutation.mutateAsync();
      setOp("idle");
    } catch (err: any) {
      setOp("idle");
      toast({ title: "Lock failed", description: err.message || "Could not lock tag.", variant: "destructive" });
    }
  }, [supported, lockMutation, toast]);

  const handleTest = useCallback(() => {
    window.open(nfcUrl, "_blank");
    verifyMutation.mutate();
  }, [nfcUrl, verifyMutation]);

  const isBusy = op !== "idle" || saveMutation.isPending || lockMutation.isPending || clearMutation.isPending;

  return (
    <div className="rounded-lg border border-yellow-900/40 bg-[#FAFAF8] p-4 space-y-4" data-testid="nfc-section">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-yellow-500" />
          <span className="font-semibold text-sm text-yellow-400">NFC Verification</span>
        </div>
        <Badge variant={status.color} className="gap-1 text-xs">
          {status.icon}
          {status.label}
        </Badge>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <InfoRow label="Certificate" value={cert.certId} testId="nfc-cert-id" />
        <InfoRow label="NFC URL" value={nfcUrl} mono testId="nfc-url" />
        <InfoRow label="Chip UID"   value={pendingUid || cert.nfcUid || "—"} mono testId="nfc-uid" />
        <InfoRow label="Chip type"  value={pendingChipType || cert.nfcChipType || "—"} testId="nfc-chip-type" />
        <InfoRow label="Writable"   value={cert.nfcUid ? (cert.nfcLocked ? "Locked" : "Yes") : "—"} testId="nfc-writable" />
        <InfoRow label="Scan count" value={cert.nfcScanCount != null ? String(cert.nfcScanCount) : "0"} testId="nfc-scan-count" />
        <InfoRow label="Written"    value={fmt(cert.nfcWrittenAt)} testId="nfc-written-at" />
        <InfoRow label="Locked"     value={fmt(cert.nfcLockedAt)} testId="nfc-locked-at" />
        <InfoRow label="Last verified" value={fmt(cert.nfcLastVerifiedAt)} testId="nfc-last-verified" />
        <InfoRow label="Last scan"  value={fmt(cert.nfcLastScanAt)} testId="nfc-last-scan" />
      </div>

      {/* Browser support warning */}
      {!supported && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-700/40 bg-yellow-950/30 p-3 text-xs text-yellow-300">
          <WifiOff className="h-4 w-4 mt-0.5 shrink-0 text-yellow-500" />
          <span>
            <strong>NFC not available in this browser.</strong> Web NFC requires Chrome on Android.
            You can still save tag data manually or use an external NFC writer, then record the UID below.
          </span>
        </div>
      )}

      {/* Operation status */}
      {op !== "idle" && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-600/40 bg-[#FFF9E6] p-3 text-sm text-yellow-200">
          <Loader2 className="h-4 w-4 animate-spin text-yellow-400" />
          {op === "reading" && "Waiting for tag… hold tag to device."}
          {op === "writing" && "Writing URL to tag… hold tag to device."}
          {op === "locking" && "Locking tag… hold tag to device."}
        </div>
      )}

      {/* Pending read confirmation */}
      {pendingUid && !cert.nfcUid && (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3 text-xs text-emerald-300">
          <Wifi className="inline h-3 w-3 mr-1 text-emerald-400" />
          Tag detected: <span className="font-mono">{pendingUid}</span>. Click <strong>Write Tag</strong> to program it.
        </div>
      )}

      {/* Manual UID entry — for USB NFC writers / desktop workflows */}
      {!cert.nfcLocked && (
        <div className="rounded-md border border-yellow-900/30 bg-yellow-950/20 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-yellow-400/70 font-medium uppercase tracking-wider">
            <KeyRound className="h-3 w-3" />
            Manual UID Entry
          </div>
          <p className="text-[11px] text-[#999999]">
            Use this if you are programming tags with a USB NFC writer or an external encoder.
            Paste the tag UID exactly as printed or reported by your writer.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Tag UID  e.g. 04:1A:2B:3C:4D:5E:6F"
              value={manualUid}
              onChange={(e) => setManualUid(e.target.value.trim())}
              className="h-7 text-xs bg-white border-[#E8E4DC] text-[#1A1A1A] font-mono flex-1"
              data-testid="input-manual-uid"
            />
            <Input
              placeholder="Chip type (optional)"
              value={manualChipType}
              onChange={(e) => setManualChipType(e.target.value.trim())}
              className="h-7 text-xs bg-white border-[#E8E4DC] text-[#1A1A1A] w-36"
              data-testid="input-manual-chip-type"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!manualUid || saveMutation.isPending}
            onClick={() => saveMutation.mutate({
              uid: manualUid,
              chipType: manualChipType || undefined,
              url: nfcUrl,
            })}
            className="h-7 text-xs border-yellow-700/50 text-yellow-300 hover:bg-[#FFF9E6]"
            data-testid="btn-manual-save"
          >
            {saveMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <KeyRound className="h-3 w-3 mr-1" />}
            Link UID to {cert.certId}
          </Button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleRead}
          disabled={isBusy || !supported}
          data-testid="btn-nfc-read"
          className="border-yellow-700/50 text-yellow-300 hover:bg-[#FFF9E6]"
        >
          <Wifi className="h-3 w-3 mr-1" />
          Read Tag
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleWrite}
          disabled={isBusy || !supported || !!cert.nfcLocked}
          data-testid="btn-nfc-write"
          className="border-yellow-700/50 text-yellow-300 hover:bg-[#FFF9E6]"
        >
          {saveMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
          Write Tag
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowLockConfirm(true)}
          disabled={isBusy || !cert.nfcUid || !!cert.nfcLocked}
          data-testid="btn-nfc-lock"
          className="border-orange-700/50 text-orange-300 hover:bg-orange-900/30"
        >
          <Lock className="h-3 w-3 mr-1" />
          Lock Tag
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={isBusy}
          data-testid="btn-nfc-test"
          className="border-blue-700/50 text-blue-300 hover:bg-blue-900/30"
        >
          <ExternalLink className="h-3 w-3 mr-1" />
          Test Tag
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowClearConfirm(true)}
          disabled={isBusy || !cert.nfcUid}
          data-testid="btn-nfc-clear"
          className="text-red-400 hover:bg-red-900/20 hover:text-red-300"
        >
          <Trash2 className="h-3 w-3 mr-1" />
          Clear NFC Record
        </Button>
      </div>

      {/* Lock confirm dialog */}
      <AlertDialog open={showLockConfirm} onOpenChange={setShowLockConfirm}>
        <AlertDialogContent className="bg-white border-[#E8E4DC]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-yellow-400">Lock this NFC tag?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#666666]">
              Locking makes the tag <strong>permanently read-only</strong> — it can never be reprogrammed.
              Hold the tag to the device after confirming.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[#E8E4DC]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-700 hover:bg-orange-600 text-white"
              onClick={() => { setShowLockConfirm(false); handleLock(); }}
              data-testid="btn-nfc-lock-confirm"
            >
              Lock permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear confirm dialog */}
      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent className="bg-white border-[#E8E4DC]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-yellow-400">Clear NFC record?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#666666]">
              This removes all NFC data from this certificate. The physical tag will still work
              but will no longer be linked in the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[#E8E4DC]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-700 hover:bg-red-600 text-white"
              onClick={() => { setShowClearConfirm(false); clearMutation.mutate(); }}
              data-testid="btn-nfc-clear-confirm"
            >
              Clear record
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Overwrite confirm dialog — shown when cert already has a different UID */}
      <AlertDialog open={!!overwritePending} onOpenChange={(open) => { if (!open) setOverwritePending(null); }}>
        <AlertDialogContent className="bg-white border-[#E8E4DC]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-orange-400">Replace existing NFC tag?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#666666] space-y-2">
              <span className="block">
                This certificate already has an NFC tag linked to it.
              </span>
              <span className="block font-mono text-xs text-[#999999]">
                Existing UID: {cert.nfcUid}
              </span>
              <span className="block font-mono text-xs text-yellow-400">
                New UID: {overwritePending?.uid}
              </span>
              <span className="block text-xs text-orange-300 mt-1">
                Replacing the UID will unlink the old tag. The old physical tag will no longer open this certificate.
                Only do this if the old tag is lost or damaged.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[#E8E4DC]" onClick={() => setOverwritePending(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-700 hover:bg-orange-600 text-white"
              onClick={() => {
                if (!overwritePending) return;
                saveMutation.mutate({ uid: overwritePending.uid, chipType: overwritePending.chipType, url: nfcUrl, overwrite: true });
              }}
              data-testid="btn-nfc-overwrite-confirm"
            >
              Replace tag
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InfoRow({ label, value, mono, testId }: { label: string; value: string; mono?: boolean; testId?: string }) {
  return (
    <>
      <span className="text-[#999999]">{label}</span>
      <span className={`text-[#1A1A1A] truncate ${mono ? "font-mono text-[11px]" : ""}`} data-testid={testId}>
        {value}
      </span>
    </>
  );
}

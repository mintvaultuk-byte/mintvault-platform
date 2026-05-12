import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { CertificateRecord } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Shield,
  UserCheck,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  UserPlus,
  Clock,
  Printer,
} from "lucide-react";

interface OwnershipData {
  certId: string;
  ownershipStatus: string;
  ownerEmail: string | null;
  ownerUserId: string | null;
  hasClaimCode: boolean;
  claimCodeCreatedAt: string | null;
  claimCodeUsedAt: string | null;
  ownershipToken: string | null;
  ownershipTokenGeneratedAt: string | null;
  history: Array<{
    id: number;
    certId: string;
    fromUserId: string | null;
    toUserId: string;
    toEmail: string | null;
    eventType: string;
    notes: string | null;
    createdAt: string;
  }>;
}

export default function OwnershipSection({ cert }: { cert: CertificateRecord }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [assignEmail, setAssignEmail] = useState("");
  const [assignNotes, setAssignNotes] = useState("");
  const [showAssign, setShowAssign] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [visibleCode, setVisibleCode] = useState<string | null>(null);

  const { data, isLoading } = useQuery<OwnershipData>({
    queryKey: ["/api/admin/certificates", cert.certId, "ownership"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/certificates/${cert.certId}/ownership`);
      return res.json();
    },
  });

  const regenMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/certificates/${cert.certId}/regenerate-claim-code`);
      return res.json();
    },
    onSuccess: (result: { claimCode: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates", cert.certId, "ownership"] });
      setVisibleCode(result.claimCode);
      setCopiedCode(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate claim code", variant: "destructive" });
    },
  });

  const insertMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/certificates/${cert.certId}/claim-insert?format=pdf`);
      return res.blob();
    },
    onSuccess: (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates", cert.certId, "ownership"] });
      toast({ title: "Claim insert generated", description: "New claim code created and insert PDF opened." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate claim insert", variant: "destructive" });
    },
  });

  const assignMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/admin/certificates/${cert.certId}/assign-owner`, {
        email: assignEmail.trim(),
        notes: assignNotes.trim() || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates", cert.certId, "ownership"] });
      toast({ title: "Owner assigned", description: `Ownership assigned to ${assignEmail}` });
      setAssignEmail("");
      setAssignNotes("");
      setShowAssign(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to assign owner", variant: "destructive" });
    },
  });

  const statusColor: Record<string, string> = {
    unclaimed: "bg-gray-500/20 text-[#666666]",
    pending: "bg-yellow-500/20 text-yellow-400",
    claimed: "bg-emerald-500/20 text-emerald-400",
    transferred: "bg-blue-500/20 text-blue-400",
  };

  if (isLoading) {
    return (
      <div className="border border-[#D4AF37]/20 rounded-lg p-6">
        <div className="flex items-center gap-2 text-[#D4AF37]/60">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading ownership info...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[#D4AF37]/20 rounded-lg p-5 space-y-4" data-testid="section-ownership">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#D4AF37]" />
          <h3 className="text-sm font-bold text-[#D4AF37] tracking-wide">OWNERSHIP</h3>
        </div>
        <Badge className={statusColor[data?.ownershipStatus || "unclaimed"] || statusColor.unclaimed} data-testid="badge-ownership-status">
          {data?.ownershipStatus || "unclaimed"}
        </Badge>
      </div>

      {data?.ownerEmail && (
        <div className="flex items-center gap-2 text-sm">
          <UserCheck className="w-4 h-4 text-emerald-400" />
          <span className="text-[#666666]">Owner:</span>
          <span className="text-[#1A1A1A] font-medium" data-testid="text-owner-email">{data.ownerEmail}</span>
        </div>
      )}

      {/* Ownership Token */}
      <div className="rounded-md border border-[#D4AF37]/20 bg-[#FAFAF8] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[#D4AF37]/70 tracking-widest uppercase">Ownership Token</span>
          {data?.ownershipToken ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400">Active</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[#E8E4DC] text-[#999999]">None</span>
          )}
        </div>
        {data?.ownershipToken ? (
          <div className="flex items-center gap-2">
            <code
              className="flex-1 font-mono text-xs tracking-widest text-[#D4AF37] bg-gray-50 px-3 py-2 rounded border border-[#D4AF37]/30 select-all overflow-x-auto"
              data-testid="text-ownership-token"
            >
              {data.ownershipToken}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(data.ownershipToken!);
              }}
              className="border-[#D4AF37]/40 text-[#D4AF37] hover:bg-[#D4AF37]/15 shrink-0"
              data-testid="button-copy-ownership-token"
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <p className="text-xs text-[#999999]">Generated automatically when ownership is registered or transferred.</p>
        )}
        {data?.ownershipTokenGeneratedAt && (
          <p className="text-xs text-[#999999]">
            Generated {new Date(data.ownershipTokenGeneratedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </p>
        )}
      </div>

      {/* Claim code display */}
      <div className="rounded-md border border-[#D4AF37]/20 bg-[#FAFAF8] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[#D4AF37]/70 tracking-widest uppercase">Claim Code</span>
          <div className="flex items-center gap-1.5">
            {data?.claimCodeUsedAt ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400">Used</span>
            ) : data?.hasClaimCode ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-[#D4AF37]/10 text-[#D4AF37]">Active</span>
            ) : (
              <span className="text-xs px-1.5 py-0.5 rounded bg-[#E8E4DC] text-[#999999]">None</span>
            )}
          </div>
        </div>

        {visibleCode ? (
          <div className="flex items-center gap-2">
            <code
              className="flex-1 font-mono text-lg font-bold tracking-[0.2em] text-[#D4AF37] bg-gray-50 px-3 py-2 rounded border border-[#D4AF37]/30 select-all"
              data-testid="text-visible-claim-code"
            >
              {visibleCode}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(visibleCode);
                setCopiedCode(true);
                setTimeout(() => setCopiedCode(false), 2000);
              }}
              className="border-[#D4AF37]/40 text-[#D4AF37] hover:bg-[#D4AF37]/15 shrink-0"
              data-testid="button-copy-claim-code"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        ) : (
          <div className="text-xs text-[#999999]">
            {data?.hasClaimCode ? (
              <>
                Code generated {data.claimCodeCreatedAt ? new Date(data.claimCodeCreatedAt).toLocaleDateString("en-GB") : ""}
                {data.claimCodeUsedAt ? ` · claimed ${new Date(data.claimCodeUsedAt).toLocaleDateString("en-GB")}` : ""}
                <span className="block mt-0.5 text-[#999999]">Click "Regenerate" to reveal a new code for dispatch.</span>
              </>
            ) : (
              "No claim code generated yet. Generate one before dispatching the card."
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => regenMutation.mutate()}
          disabled={regenMutation.isPending}
          className="border-[#D4AF37]/30 text-[#D4AF37] hover:bg-[#D4AF37]/10 text-xs"
          data-testid="button-regenerate-claim-code"
        >
          {regenMutation.isPending ? (
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3 mr-1.5" />
          )}
          {data?.hasClaimCode ? "Regenerate Code" : "Generate Code"}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => insertMutation.mutate()}
          disabled={insertMutation.isPending}
          className="border-[#D4AF37]/30 text-[#D4AF37] hover:bg-[#D4AF37]/10 text-xs"
          data-testid="button-print-claim-insert"
        >
          {insertMutation.isPending ? (
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
          ) : (
            <Printer className="w-3 h-3 mr-1.5" />
          )}
          Print Claim Insert
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAssign(!showAssign)}
          className="border-[#D4AF37]/30 text-[#D4AF37] hover:bg-[#D4AF37]/10 text-xs"
          data-testid="button-manual-assign"
        >
          <UserPlus className="w-3 h-3 mr-1.5" />
          Manual Assign
        </Button>
      </div>

      {showAssign && (
        <div className="border border-[#D4AF37]/10 rounded p-3 space-y-3 bg-[#0a0a0a]">
          <Input
            placeholder="Owner email address"
            value={assignEmail}
            onChange={(e) => setAssignEmail(e.target.value)}
            className="bg-gray-50 border-[#E8E4DC] text-[#1A1A1A] text-sm"
            data-testid="input-assign-email"
          />
          <Input
            placeholder="Notes (optional)"
            value={assignNotes}
            onChange={(e) => setAssignNotes(e.target.value)}
            className="bg-gray-50 border-[#E8E4DC] text-[#1A1A1A] text-sm"
            data-testid="input-assign-notes"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => assignMutation.mutate()}
              disabled={assignMutation.isPending || !assignEmail.trim()}
              className="bg-[#D4AF37] hover:bg-[#B8962E] text-black text-xs"
              data-testid="button-confirm-assign"
            >
              {assignMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
              Assign
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowAssign(false)}
              className="text-[#666666] text-xs"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {data?.history && data.history.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-[#D4AF37]/10">
          <h4 className="text-xs font-semibold text-[#999999] tracking-wide">HISTORY</h4>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {data.history.map((h) => (
              <div key={h.id} className="flex items-start gap-2 text-xs">
                <Clock className="w-3 h-3 text-[#999999] mt-0.5 shrink-0" />
                <div>
                  <span className="text-[#666666]">{h.eventType}</span>
                  {h.toEmail && <span className="text-[#1A1A1A] ml-1">{h.toEmail}</span>}
                  <span className="text-[#999999] ml-2">
                    {new Date(h.createdAt).toLocaleDateString("en-GB")}
                  </span>
                  {h.notes && <span className="text-[#999999] ml-1">— {h.notes}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

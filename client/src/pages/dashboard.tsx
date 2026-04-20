import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Mail, Loader2, CheckCircle, AlertCircle,
  Package, Award, ArrowRightLeft, LogOut, ExternalLink, Download,
  ChevronRight, Clock, Truck, Box, Settings, RefreshCw,
  Globe, Copy, Check, Sparkles, Shield, Zap, TrendingDown,
  Camera, MapPin, X,
} from "lucide-react";
import VaultClubBadge from "@/components/vault-club-badge";
import { apiRequest } from "@/lib/queryClient";
import { isNonNumericGrade } from "@shared/schema";
import SeoHead from "@/components/seo-head";

// ── Types ──────────────────────────────────────────────────────────────────────
interface CustomerSubmission {
  id: number;
  submissionId: string;
  status: string;
  cardCount: number;
  tier: string;
  serviceTier: string | null;
  serviceType: string;
  totalAmount: number;
  createdAt: string;
  estimatedCompletionDate: string | null;
  receivedAt: string | null;
  queuedAt: string | null;
  gradingStartedAt: string | null;
  encapsulatingAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  returnCarrier: string | null;
  returnTrackingNumber: string | null;
  returnTracking: string | null;
  royalMailOutboundTracking: string | null;
  royal_mail_outbound_tracking: string | null;
  on_receipt_photo_urls: string | null;
  onReceiptPhotoUrls: string | null;
  statusHistory: Array<{ status: string; timestamp: string; note?: string }> | null;
  customerFirstName: string | null;
  packingSlipToken: string;
  shippingLabelToken: string;
}

interface CustomerCert {
  id: number;
  certId: string;
  cardName: string | null;
  setName: string | null;
  year: string | null;
  cardGame: string | null;
  language: string | null;
  gradeOverall: string | null;
  gradeType: string;
  createdAt: string;
  status: string;
  ownershipStatus: string;
  ownerEmail: string | null;
  submissionItemId: number | null;
}

// ── Submission tracking helpers ────────────────────────────────────────────────
const TRACKING_STEPS: Array<{ key: string; label: string; shortLabel: string }> = [
  { key: "awaiting",     label: "Awaiting Your Card",  shortLabel: "Awaiting" },
  { key: "received",     label: "Card Received",        shortLabel: "Received" },
  { key: "queued",       label: "In Grading Queue",     shortLabel: "Queued" },
  { key: "grading",      label: "Being Graded",         shortLabel: "Grading" },
  { key: "encapsulating",label: "Encapsulating",        shortLabel: "Sealing" },
  { key: "shipped",      label: "Shipped Back",         shortLabel: "Shipped" },
  { key: "delivered",    label: "Delivered",            shortLabel: "Delivered" },
];

function getStepIndex(sub: CustomerSubmission): number {
  if (sub.deliveredAt) return 6;
  if (sub.shippedAt) return 5;
  if (sub.encapsulatingAt) return 4;
  if (sub.gradingStartedAt) return 3;
  if (sub.queuedAt) return 2;
  if (sub.receivedAt) return 1;
  return 0;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function SubmissionProgress({ sub }: { sub: CustomerSubmission }) {
  const current = getStepIndex(sub);
  return (
    <div className="flex items-center overflow-x-auto pb-1 mt-3">
      {TRACKING_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const pending = i > current;
        return (
          <div key={step.key} className="flex items-center">
            <div className="flex flex-col items-center min-w-[42px]">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] border transition-all ${
                active ? "border-[#D4AF37] bg-[#D4AF37]/20 text-[#D4AF37] ring-2 ring-[#D4AF37]/30 ring-offset-1"
                : done ? "border-[#D4AF37] bg-[#D4AF37]/15 text-[#D4AF37]"
                : "border-[#E0DBD0] bg-transparent text-[#BBBBBB]"
              }`}>
                {done ? <Check size={10} /> : active ? <div className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" /> : <div className="w-1.5 h-1.5 rounded-full bg-[#D4DC]" />}
              </div>
              <span className={`text-[8px] mt-0.5 tracking-wide uppercase text-center leading-tight ${done || active ? "text-[#B8960C]" : "text-[#AAAAAA]"}`}>
                {step.shortLabel}
              </span>
            </div>
            {i < TRACKING_STEPS.length - 1 && (
              <div className={`h-px w-3 mb-4 flex-shrink-0 ${i < current ? "bg-[#D4AF37]/50" : "bg-[#E0DBD0]"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubmissionTimeline({ sub }: { sub: CustomerSubmission }) {
  const steps: Array<{ label: string; time: string | null; done: boolean }> = [
    { label: "Payment received", time: sub.createdAt, done: true },
    { label: "Card received at facility", time: sub.receivedAt, done: !!sub.receivedAt },
    { label: "In grading queue", time: sub.queuedAt, done: !!sub.queuedAt },
    { label: "Being graded", time: sub.gradingStartedAt, done: !!sub.gradingStartedAt },
    { label: "Encapsulating", time: sub.encapsulatingAt, done: !!sub.encapsulatingAt },
    { label: "Shipped back", time: sub.shippedAt, done: !!sub.shippedAt },
    { label: "Delivered", time: sub.deliveredAt, done: !!sub.deliveredAt },
  ];
  return (
    <div className="mt-4 space-y-1.5">
      {steps.map((s) => (
        <div key={s.label} className="flex items-center gap-2 text-xs">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.done ? "bg-[#D4AF37]" : "bg-[#E0DBD0]"}`} />
          <span className={s.done ? "text-[#444444]" : "text-[#BBBBBB]"}>{s.label}</span>
          {s.time && <span className="text-[#999999] ml-auto">{fmtDate(s.time)}</span>}
        </div>
      ))}
    </div>
  );
}

function receiptPhotos(sub: CustomerSubmission): string[] {
  const raw = sub.on_receipt_photo_urls ?? sub.onReceiptPhotoUrls;
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function outboundTracking(sub: CustomerSubmission): string | null {
  return sub.royal_mail_outbound_tracking ?? sub.royalMailOutboundTracking ?? null;
}

function returnTrackingNumber(sub: CustomerSubmission): string | null {
  return sub.returnTracking ?? sub.returnTrackingNumber ?? null;
}

// ── Submission card ────────────────────────────────────────────────────────────
function SubmissionCard({ sub }: { sub: CustomerSubmission }) {
  const queryClient = useQueryClient();
  const [showTimeline, setShowTimeline] = useState(false);
  const [trackingInput, setTrackingInput] = useState(outboundTracking(sub) ?? "");
  const [trackingSaved, setTrackingSaved] = useState(false);

  const trackingMutation = useMutation({
    mutationFn: async (tracking: string) => {
      await apiRequest("POST", `/api/submissions/${sub.id}/customer-tracking`, { tracking });
    },
    onSuccess: () => {
      setTrackingSaved(true);
      queryClient.invalidateQueries({ queryKey: ["/api/customer/submissions"] });
      setTimeout(() => setTrackingSaved(false), 2000);
    },
  });

  const photos = receiptPhotos(sub);
  const retTracking = returnTrackingNumber(sub);
  const stepIdx = getStepIndex(sub);
  const preReceived = stepIdx === 0;

  const tierLabel: Record<string, string> = { standard: "Standard", priority: "Priority", express: "Express" };
  const tierDisplay = tierLabel[(sub.serviceTier ?? sub.tier ?? "").toLowerCase()] ?? sub.serviceTier ?? sub.tier ?? "—";
  const totalGbp = ((sub.totalAmount ?? 0) / 100).toFixed(2);

  return (
    <div className="border border-[#D4AF37]/20 bg-white rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 bg-[#FAFAF8] border-b border-[#E8E4DC]">
        <div>
          <span className="font-mono text-[#D4AF37] text-sm font-bold">{sub.submissionId}</span>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-[#888888]">{sub.cardCount} card{sub.cardCount !== 1 ? "s" : ""}</span>
            <span className="text-[#CCCCCC]">·</span>
            <span className="text-xs text-[#888888]">{tierDisplay}</span>
            <span className="text-[#CCCCCC]">·</span>
            <span className="text-xs text-[#888888]">£{totalGbp}</span>
          </div>
        </div>
        <span className="text-[10px] text-[#AAAAAA] whitespace-nowrap shrink-0">{fmtDate(sub.createdAt)}</span>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {/* Estimated completion */}
        {sub.estimatedCompletionDate && stepIdx < 6 && (
          <div className="flex items-center gap-1.5 text-xs text-[#B8960C] bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-lg px-3 py-2 mb-3">
            <Clock size={11} className="shrink-0" />
            <span>Estimated completion: <strong>{fmtDate(sub.estimatedCompletionDate)}</strong></span>
          </div>
        )}

        {/* 7-step progress bar */}
        <SubmissionProgress sub={sub} />

        {/* Pre-received: packing slip, shipping label, outbound tracking input */}
        {preReceived && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              {sub.packingSlipToken && (
                <a
                  href={`/api/customer/submissions/${sub.submissionId}/packing-slip?token=${sub.packingSlipToken}`}
                  download
                  className="flex items-center gap-1.5 text-xs text-[#666666] border border-[#E8E4DC] rounded-lg px-3 py-1.5 hover:border-[#D4AF37]/40 hover:text-[#B8960C] transition-colors"
                >
                  <Download size={11} />
                  Packing Slip
                </a>
              )}
              {sub.shippingLabelToken && (
                <a
                  href={`/api/customer/submissions/${sub.submissionId}/shipping-label?token=${sub.shippingLabelToken}`}
                  download
                  className="flex items-center gap-1.5 text-xs text-[#666666] border border-[#E8E4DC] rounded-lg px-3 py-1.5 hover:border-[#D4AF37]/40 hover:text-[#B8960C] transition-colors"
                >
                  <Download size={11} />
                  Shipping Label
                </a>
              )}
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-1">
                Your Royal Mail tracking number <span className="font-normal text-[#CCCCCC] normal-case">(optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={trackingInput}
                  onChange={e => setTrackingInput(e.target.value)}
                  placeholder="e.g. AB123456789GB"
                  className="flex-1 border border-[#E8E4DC] rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
                />
                <button
                  onClick={() => trackingMutation.mutate(trackingInput.trim())}
                  disabled={trackingMutation.isPending || !trackingInput.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-[#1A1400] disabled:opacity-50 flex items-center gap-1 transition-all"
                  style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                >
                  {trackingMutation.isPending
                    ? <Loader2 size={10} className="animate-spin" />
                    : trackingSaved
                    ? <Check size={10} />
                    : null}
                  {trackingSaved ? "Saved" : "Save"}
                </button>
              </div>
              <p className="text-[10px] text-[#AAAAAA] mt-1">Helps us look out for your cards arriving</p>
            </div>
          </div>
        )}

        {/* Receipt photos */}
        {photos.length > 0 && (
          <div className="mt-4">
            <p className="text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-2">Receipt Photos</p>
            <div className="flex gap-2 flex-wrap">
              {photos.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={url}
                    alt={`Receipt photo ${i + 1}`}
                    className="w-16 h-16 object-cover rounded-lg border border-[#E8E4DC] hover:border-[#D4AF37]/50 transition-colors"
                  />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Return tracking button (once shipped) */}
        {retTracking && sub.shippedAt && (
          <div className="mt-4">
            <a
              href={`https://www.royalmail.com/track-your-item#/tracking-results/${retTracking}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs font-semibold text-[#B8960C] border border-[#D4AF37]/30 bg-[#D4AF37]/5 rounded-lg px-3 py-2 hover:bg-[#D4AF37]/10 transition-colors"
            >
              <Truck size={12} />
              Track Return Parcel
              <ExternalLink size={10} />
            </a>
            <p className="text-[10px] text-[#AAAAAA] mt-1.5 font-mono">{retTracking}</p>
          </div>
        )}

        {/* Timeline toggle */}
        <button
          onClick={() => setShowTimeline(v => !v)}
          className="mt-4 flex items-center gap-1 text-[10px] text-[#AAAAAA] hover:text-[#888888] transition-colors"
        >
          <ChevronRight size={11} className={`transition-transform ${showTimeline ? "rotate-90" : ""}`} />
          {showTimeline ? "Hide timeline" : "View timeline"}
        </button>
        {showTimeline && <SubmissionTimeline sub={sub} />}
      </div>
    </div>
  );
}

// ── Grade display ──────────────────────────────────────────────────────────────
function GradeBadge({ cert }: { cert: CustomerCert }) {
  const isNonNum = isNonNumericGrade(cert.gradeType);
  const grade = cert.gradeOverall;
  if (!grade) return <span className="text-[#999999] text-xs">—</span>;
  const num = parseFloat(grade);
  const colour = num >= 10 ? "text-emerald-500" : num >= 9 ? "text-[#D4AF37]" : num >= 8 ? "text-blue-500" : "text-[#999999]";
  return (
    <span className={`font-bold ${isNonNum ? "text-[#D4AF37] text-xs" : `${colour} text-lg`}`}>
      {isNonNum ? grade : num}
    </span>
  );
}

// ── Login form ─────────────────────────────────────────────────────────────────
function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await apiRequest("POST", "/api/customer/magic-link", { email: email.trim() });
      setSent(true);
    } catch (err: any) {
      let msg = "Failed to send login link. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setError(msg);
    }
  }

  if (sent) {
    return (
      <div className="max-w-md mx-auto text-center py-16 px-4">
        <CheckCircle className="w-12 h-12 text-[#D4AF37] mx-auto mb-4" />
        <h2 className="text-xl font-sans font-bold text-[#1A1A1A] tracking-tight mb-2">Check your inbox</h2>
        <p className="text-[#666666] text-sm">
          We sent a login link to <strong className="text-[#1A1A1A]">{email}</strong>. Click it to access your dashboard.
        </p>
        <p className="text-[#999999] text-xs mt-4">
          The link expires in 24 hours and can only be used once.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-16 px-4">
      <div className="text-center mb-8">
        <LayoutDashboard className="w-12 h-12 text-[#D4AF37] mx-auto mb-4" />
        <h1 className="text-2xl font-sans font-bold text-[#1A1A1A] tracking-tight mb-2">Customer Dashboard</h1>
        <p className="text-[#666666] text-sm">
          Enter your email to receive a secure login link. No password needed.
        </p>
      </div>
      <div className="border border-[#D4AF37]/20 bg-white rounded-xl p-6 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-[#444444] mb-1.5">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full bg-white border border-[#E8E4DC] rounded-lg px-3 py-2.5 text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37] transition-colors text-sm"
            />
            <p className="text-xs text-[#999999] mt-1">Use the email you submitted cards with.</p>
          </div>
          {error && (
            <div className="flex items-start gap-2 text-red-500 text-xs bg-red-50 border border-red-300 rounded-lg p-3">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <button
            type="submit"
            className="btn-gold w-full py-2.5 rounded-lg font-bold tracking-wide text-[#1A1400] flex items-center justify-center gap-2"
          >
            <Mail size={15} />
            Send Login Link
          </button>
        </form>
        <p className="text-xs text-[#999999] mt-4 text-center">
          We'll send a one-click login link — no password required.
        </p>
      </div>
    </div>
  );
}

// ── Username suggestion helper ────────────────────────────────────────────────
function suggestUsername(displayName: string | null, email: string): string {
  const source = displayName || email.split("@")[0];
  return source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "collector";
}

// ── Vault Club section ────────────────────────────────────────────────────────
interface VaultClubMe {
  tier: "bronze" | "silver" | "gold" | null;
  label: string | null;
  status: string | null;
  billing_interval: "month" | "year" | null;
  renews_at: string | null;
  ai_credits_balance: number;
  ai_credits_monthly: number;
}

function VaultClubSection({ authMe }: { authMe: { id: string; email: string; display_name: string | null; email_verified: boolean } }) {
  const queryClient = useQueryClient();
  const { data: vcMe, isLoading } = useQuery<VaultClubMe | null>({
    queryKey: ["/api/vault-club/me"],
    queryFn: async () => {
      const res = await fetch("/api/vault-club/me");
      if (res.status === 401) return null;
      if (!res.ok) return null;
      return res.json();
    },
    retry: false,
    staleTime: 30_000,
  });

  const portalMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/vault-club/portal", {}),
    onSuccess: (data: any) => { if (data?.url) window.location.href = data.url; },
  });

  if (isLoading) {
    return <div className="h-28 animate-pulse bg-[#D4AF37]/5 rounded-xl border border-[#D4AF37]/10 mb-6" />;
  }

  const isMember = vcMe?.tier && vcMe?.status && (vcMe.status === "active" || vcMe.status === "trialing");
  const renewsDate = vcMe?.renews_at
    ? new Date(vcMe.renews_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;
  const creditPercent = vcMe && vcMe.ai_credits_monthly > 0
    ? Math.round((vcMe.ai_credits_balance / vcMe.ai_credits_monthly) * 100)
    : 0;

  if (!isMember) {
    return (
      <div className="border border-[#D4AF37]/30 bg-white rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Shield size={16} className="text-[#D4AF37]" />
          <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Join Vault Club</h2>
        </div>
        <p className="text-xs text-[#888888] mb-4">
          Get up to 30% off grading, monthly AI Pre-Grade credits, and your own activated Showroom.
        </p>
        <Link href="/vault-club">
          <button
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-[#1A1400] transition-all active:scale-95"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
          >
            View Vault Club Plans →
          </button>
        </Link>
      </div>
    );
  }

  const tierColour: Record<string, string> = { bronze: "#CD7F32", silver: "#C0C0C0", gold: "#D4AF37" };
  const colour = vcMe!.tier ? tierColour[vcMe!.tier] : "#D4AF37";
  const statusLabel: Record<string, string> = { active: "Active", trialing: "Free Trial", past_due: "Payment Due", grace: "Grace Period" };
  const discountLabel: Record<string, string> = { bronze: "10%", silver: "20%", gold: "30%" };

  return (
    <div
      className="border rounded-xl p-5 mb-6"
      style={{ borderColor: `${colour}40`, background: `${colour}08` }}
    >
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <VaultClubBadge tier={vcMe!.tier} size="md" />
          <div>
            <span className="text-sm font-bold text-[#1A1A1A]">{vcMe!.label}</span>
            {vcMe!.status && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                {statusLabel[vcMe!.status] || vcMe!.status}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
            className="text-xs text-[#666666] border border-[#E8E4DC] bg-white rounded-lg px-3 py-1.5 font-semibold hover:border-[#D4AF37]/40 transition-colors disabled:opacity-60"
          >
            {portalMutation.isPending ? <Loader2 size={11} className="animate-spin inline" /> : "Manage"}
          </button>
          <Link href="/vault-club">
            <button className="text-xs text-[#B8960C] border border-[#D4AF37]/30 bg-[#D4AF37]/5 rounded-lg px-3 py-1.5 font-semibold hover:bg-[#D4AF37]/10 transition-colors">
              View Club
            </button>
          </Link>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white/80 border border-[#E8E4DC]/60 rounded-lg p-2.5 text-center">
          <Zap size={12} className="text-[#D4AF37] mx-auto mb-0.5" />
          <p className="text-sm font-black text-[#1A1A1A]">{vcMe!.ai_credits_balance}</p>
          <p className="text-[10px] text-[#AAAAAA]">AI Credits</p>
          <div className="mt-1.5 h-1 bg-[#F0EDE6] rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${creditPercent}%`, background: "linear-gradient(90deg,#B8960C,#D4AF37)" }} />
          </div>
        </div>
        <div className="bg-white/80 border border-[#E8E4DC]/60 rounded-lg p-2.5 text-center">
          <TrendingDown size={12} className="text-[#D4AF37] mx-auto mb-0.5" />
          <p className="text-sm font-black text-[#1A1A1A]">{vcMe!.tier ? discountLabel[vcMe!.tier] : "—"}</p>
          <p className="text-[10px] text-[#AAAAAA]">Discount</p>
        </div>
        <div className="bg-white/80 border border-[#E8E4DC]/60 rounded-lg p-2.5 text-center">
          <Award size={12} className="text-[#D4AF37] mx-auto mb-0.5" />
          <p className="text-[10px] text-[#1A1A1A] font-semibold">{renewsDate || "—"}</p>
          <p className="text-[10px] text-[#AAAAAA]">Renews</p>
        </div>
      </div>
    </div>
  );
}

// ── Showroom section ──────────────────────────────────────────────────────────
interface ShowroomMeData {
  username: string | null;
  showroom_active: boolean;
  showroom_bio: string | null;
  showroom_claimed_at: string | null;
}

function ShowroomSection({ authMe }: { authMe: { id: string; email: string; display_name: string | null; email_verified: boolean } }) {
  const queryClient = useQueryClient();
  const [usernameInput, setUsernameInput] = useState(() => suggestUsername(authMe.display_name, authMe.email));
  const [checkResult, setCheckResult] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [checking, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bio, setBio] = useState("");
  const [bioSaved, setBioSaved] = useState(false);
  const [bioError, setBioError] = useState("");

  const { data: showroomMe, isLoading: showroomLoading } = useQuery<ShowroomMeData>({
    queryKey: ["/api/showroom-me"],
    queryFn: async () => {
      const res = await fetch("/api/showroom-me");
      if (res.status === 401) return null as any;
      if (!res.ok) return null as any;
      return res.json();
    },
    retry: false,
  });

  // Debounced availability check
  useEffect(() => {
    if (!usernameInput || usernameInput.length < 3) { setCheckResult(null); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/showroom/check-username?username=${encodeURIComponent(usernameInput)}`);
        const data = await res.json();
        setCheckResult(data);
      } catch { setCheckResult(null); }
    }, 300);
    return () => clearTimeout(t);
  }, [usernameInput]);

  const claimMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/showroom/claim", { username: usernameInput }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showroom-me"] });
    },
    onError: (err: Error) => { /* error handled by checkResult */ },
  });

  const bioMutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/showroom/settings", { bio: bio.trim() || null }),
    onSuccess: () => {
      setBioSaved(true);
      setBioError("");
      queryClient.invalidateQueries({ queryKey: ["/api/showroom-me"] });
      setTimeout(() => setBioSaved(false), 2000);
    },
    onError: (err: Error) => setBioError(err.message),
  });

  const handleCopy = () => {
    const url = `https://mintvaultuk.com/showroom/${showroomMe?.username}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (showroomLoading) {
    return <div className="h-28 animate-pulse bg-[#D4AF37]/5 rounded-xl border border-[#D4AF37]/10 mb-6" />;
  }

  const hasClaimed = showroomMe?.username;

  if (hasClaimed) {
    const showroomUrl = `mintvaultuk.com/showroom/${showroomMe!.username}`;
    const currentBio = showroomMe?.showroom_bio || "";
    if (bio === "" && currentBio && !bioSaved) {
      // init bio from existing
    }
    return (
      <div className="border border-[#D4AF37]/30 bg-white rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Globe size={16} className="text-[#D4AF37]" />
          <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Your Showroom</h2>
        </div>

        {/* Link */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <a
            href={`/showroom/${showroomMe!.username}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-bold text-[#B8960C] hover:text-[#D4AF37] transition-colors"
          >
            {showroomUrl}
          </a>
          <button onClick={handleCopy} className="text-[#AAAAAA] hover:text-[#666666] transition-colors" title="Copy link">
            {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
          </button>
        </div>

        {/* View + status */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <a href={`/showroom/${showroomMe!.username}`} target="_blank" rel="noopener noreferrer">
            <button
              className="px-4 py-2 rounded-lg text-xs font-bold text-[#1A1400] transition-all"
              style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            >
              View Showroom
            </button>
          </a>
          {showroomMe!.showroom_active ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle size={12} /> Published
            </span>
          ) : (
            <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1">
              Reserved · <Link href="/vault-club" className="font-semibold hover:text-amber-800">Activate with Vault Club →</Link>
            </span>
          )}
        </div>

        {/* Bio */}
        <div>
          <label className="block text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-1">
            Bio <span className="text-[#CCCCCC] font-normal normal-case">({bio.length || currentBio.length}/280 · No URLs)</span>
          </label>
          <textarea
            value={bio || currentBio}
            onChange={e => setBio(e.target.value.slice(0, 280))}
            placeholder="Tell collectors about yourself…"
            rows={2}
            className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#D4AF37] transition-colors resize-none"
          />
          {bioError && <p className="text-xs text-red-600 mt-1">{bioError}</p>}
          <button
            onClick={() => bioMutation.mutate()}
            disabled={bioMutation.isPending}
            className="mt-2 px-4 py-1.5 rounded-lg text-xs font-bold text-[#1A1400] disabled:opacity-60 flex items-center gap-1 transition-all"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
          >
            {bioMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : bioSaved ? <Check size={11} /> : null}
            {bioSaved ? "Saved" : "Save Bio"}
          </button>
        </div>
      </div>
    );
  }

  // Unclaimed — show claim form
  const reasonLabel: Record<string, string> = {
    taken: "Already taken",
    reserved: "Reserved username",
    invalid: "Invalid — use 3-20 lowercase letters, numbers, hyphens",
  };

  return (
    <div className="border border-[#D4AF37]/30 bg-white rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={16} className="text-[#D4AF37]" />
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Claim Your Showroom</h2>
      </div>
      <p className="text-xs text-[#888888] mb-4">
        Get your own public collection page at <span className="text-[#B8960C] font-semibold">mintvaultuk.com/showroom/[your-name]</span>. Show off your verified graded cards to the world.
      </p>

      <div className="space-y-3">
        <div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#AAAAAA] pointer-events-none select-none">showroom/</span>
            <input
              type="text"
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="your-username"
              maxLength={20}
              className="w-full pl-[76px] pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>
          {usernameInput.length >= 3 && checkResult && (
            <p className={`text-xs mt-1 flex items-center gap-1 ${checkResult.available ? "text-emerald-600" : "text-red-600"}`}>
              {checkResult.available
                ? <><Check size={11} /> Available</>
                : <><span className="font-bold">✕</span> {reasonLabel[checkResult.reason as string] || "Not available"}</>
              }
            </p>
          )}
          {usernameInput.length > 0 && usernameInput.length < 3 && (
            <p className="text-xs mt-1 text-[#AAAAAA]">Minimum 3 characters</p>
          )}
        </div>

        <p className="text-[10px] text-[#AAAAAA]">
          3–20 characters · lowercase letters, numbers, hyphens · Cannot be changed once claimed.
        </p>

        <button
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending || !checkResult?.available}
          className="px-5 py-2.5 rounded-xl text-sm font-bold text-[#1A1400] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all"
          style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
        >
          {claimMutation.isPending && <Loader2 size={13} className="animate-spin" />}
          Claim Username
        </button>

        {claimMutation.isError && (
          <p className="text-xs text-red-600">{(claimMutation.error as Error)?.message || "Failed to claim. Try again."}</p>
        )}
      </div>
    </div>
  );
}

// ── Account auth type ─────────────────────────────────────────────────────────
interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

// ── Account welcome banner (shown when logged in via email+password system) ───
function AccountBanner({ authMe }: { authMe: AuthMe }) {
  const queryClient = useQueryClient();
  const [resendSent, setResendSent] = useState(false);

  const resendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/resend-verification", {}),
    onSuccess: () => setResendSent(true),
  });

  const name = authMe.display_name || authMe.email.split("@")[0];

  return (
    <div className="mb-6 space-y-3">
      {/* Welcome row */}
      <div className="flex items-center justify-between flex-wrap gap-2 bg-[#FAFAF8] border border-[#D4AF37]/20 rounded-xl px-4 py-3">
        <span className="text-sm text-[#1A1A1A] font-semibold">
          Welcome back, <span className="text-[#B8960C]">{name}</span>
        </span>
        <Link href="/account/settings" className="text-xs text-[#B8960C] font-semibold hover:text-[#D4AF37] flex items-center gap-1 transition-colors">
          <Settings size={11} />
          Account Settings
        </Link>
      </div>

      {/* Email verification warning */}
      {!authMe.email_verified && (
        <div className="flex items-start justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 font-medium">
              Please verify your email address to unlock all features.
            </p>
          </div>
          {resendSent ? (
            <span className="text-xs text-emerald-700 font-semibold whitespace-nowrap">Link sent!</span>
          ) : (
            <button
              onClick={() => resendMutation.mutate()}
              disabled={resendMutation.isPending}
              className="text-xs text-amber-700 font-bold hover:text-amber-900 flex items-center gap-1 whitespace-nowrap transition-colors disabled:opacity-60"
            >
              {resendMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Resend
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main dashboard ─────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [loginError, setLoginError] = useState("");

  // Handle redirect params from magic link verification
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("login") === "success") setLoginSuccess(true);
    if (params.get("error")) setLoginError("Invalid or expired login link. Please request a new one.");
    if (params.get("login") || params.get("error")) {
      window.history.replaceState({}, "", "/dashboard");
    }
  }, []);

  const { data: me, isLoading: meLoading } = useQuery<{ email: string } | null>({
    queryKey: ["/api/customer/me"],
    queryFn: async () => {
      const res = await fetch("/api/customer/me");
      if (res.status === 401) return null;
      return res.json();
    },
    retry: false,
  });

  const { data: authMe } = useQuery<AuthMe | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) return null;
      return res.json();
    },
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/customer/logout", {}),
    onSuccess: () => {
      queryClient.setQueryData(["/api/customer/me"], null);
      queryClient.invalidateQueries({ queryKey: ["/api/customer/submissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer/certificates"] });
    },
  });

  const { data: submissions, isLoading: subsLoading } = useQuery<CustomerSubmission[]>({
    queryKey: ["/api/customer/submissions"],
    enabled: !!me,
  });

  const { data: certs, isLoading: certsLoading } = useQuery<CustomerCert[]>({
    queryKey: ["/api/customer/certificates"],
    enabled: !!me,
  });

  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
      </div>
    );
  }

  // Not logged in
  if (!me) {
    return (
      <>
        <SeoHead
          title="Customer Dashboard | MintVault UK"
          description="Track your MintVault submissions, view your graded cards, and manage ownership from your customer dashboard."
          canonical="https://mintvaultuk.com/dashboard"
        />
        {loginError && (
          <div className="max-w-md mx-auto pt-8 px-4">
            <div className="flex items-start gap-2 text-red-500 text-sm bg-red-50 border border-red-300 rounded-lg p-3 mb-4">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              {loginError}
            </div>
          </div>
        )}
        <LoginForm />
      </>
    );
  }

  const ownedCerts = certs?.filter(c => c.ownershipStatus === "claimed" && c.ownerEmail?.toLowerCase() === me.email.toLowerCase()) ?? [];
  const linkedCerts = certs ?? [];

  return (
    <>
      <SeoHead
        title="Customer Dashboard | MintVault UK"
        description="Track your MintVault submissions, view your graded cards, and manage ownership."
        canonical="https://mintvaultuk.com/dashboard"
      />
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* Account welcome + verification banner */}
        {authMe && <AccountBanner authMe={authMe} />}

        {/* Vault Club section — shown for email+password account users */}
        {authMe && <VaultClubSection authMe={authMe} />}

        {/* Showroom section — only shown for email+password account users */}
        {authMe && <ShowroomSection authMe={authMe} />}

        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <LayoutDashboard className="text-[#D4AF37]" size={22} />
            <div>
              <h1 className="text-lg font-sans font-bold text-[#1A1A1A] leading-tight tracking-tight">My Dashboard</h1>
              <p className="text-xs text-[#999999]">{me.email}</p>
            </div>
          </div>
          <button
            onClick={() => logoutMutation.mutate()}
            className="flex items-center gap-1.5 text-xs text-[#999999] hover:text-[#666666] transition-colors"
          >
            <LogOut size={13} />
            Log out
          </button>
        </div>

        {loginSuccess && (
          <div className="mb-6 flex items-center gap-2 text-sm text-green-600 bg-green-50 border border-green-300 rounded-lg px-4 py-3">
            <CheckCircle size={15} className="shrink-0" />
            Logged in successfully.
          </div>
        )}

        {/* ── Section 1: My Submissions ──────────────────────────────────── */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Package size={16} className="text-[#D4AF37]" />
            <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">My Submissions</h2>
          </div>

          {subsLoading ? (
            <div className="animate-pulse h-28 bg-[#D4AF37]/5 rounded-xl border border-[#D4AF37]/10" />
          ) : !submissions?.length ? (
            <div className="border border-[#E8E4DC] rounded-xl p-8 text-center">
              <Package size={32} className="text-[#D4AF37]/20 mx-auto mb-3" />
              <p className="text-[#999999] text-sm mb-1">You haven't submitted any cards yet.</p>
              <Link href="/submit">
                <button className="btn-gold mt-4 px-5 py-2 rounded-lg text-[#1A1400] text-xs font-bold tracking-wide">
                  Submit Your First Card →
                </button>
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {submissions.map((sub) => (
                <SubmissionCard key={sub.id} sub={sub} />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 2: Graded Cards ────────────────────────────────────── */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Award size={16} className="text-[#D4AF37]" />
            <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Graded Cards</h2>
          </div>

          {certsLoading ? (
            <div className="animate-pulse h-28 bg-[#D4AF37]/5 rounded-xl border border-[#D4AF37]/10" />
          ) : !linkedCerts.length ? (
            <div className="border border-[#E8E4DC] rounded-xl p-6 text-center">
              <p className="text-[#999999] text-sm">No graded cards found for this email yet.</p>
            </div>
          ) : (
            <div className="border border-[#E8E4DC] rounded-xl overflow-hidden">
              {linkedCerts.map((cert, i) => (
                <div key={cert.id} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[#E8E4DC]" : ""}`}>
                  <div className="w-10 text-center shrink-0">
                    <GradeBadge cert={cert} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1A1A1A] font-medium truncate">{cert.cardName ?? "—"}</p>
                    <p className="text-xs text-[#999999] truncate">
                      {cert.setName ?? ""}
                      {cert.year ? ` (${cert.year})` : ""}
                      {cert.cardGame ? ` · ${cert.cardGame}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cert.ownershipStatus === "claimed" && cert.ownerEmail?.toLowerCase() === me.email.toLowerCase() && (
                      <a
                        href={`/api/admin/certificates/${cert.certId}/certificate-document`}
                        download={`MintVault-Certificate-${cert.certId}.pdf`}
                        className="text-[10px] text-[#999999] hover:text-[#D4AF37] flex items-center gap-1 transition-colors"
                        title="Download Certificate PDF"
                      >
                        <Download size={12} />
                        <span className="hidden sm:inline">PDF</span>
                      </a>
                    )}
                    <Link href={`/cert/${cert.certId}`}>
                      <span className="text-[10px] font-mono text-[#999999] hover:text-[#D4AF37] flex items-center gap-0.5 transition-colors cursor-pointer">
                        {cert.certId}
                        <ExternalLink size={10} />
                      </span>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Section 3: Ownership & Transfers ──────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <ArrowRightLeft size={16} className="text-[#D4AF37]" />
            <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Ownership & Transfers</h2>
          </div>

          {certsLoading ? (
            <div className="animate-pulse h-20 bg-[#D4AF37]/5 rounded-xl border border-[#D4AF37]/10" />
          ) : !ownedCerts.length ? (
            <div className="border border-[#E8E4DC] rounded-xl p-6 text-center">
              <p className="text-[#999999] text-sm">No ownership registrations found.</p>
              <p className="text-xs text-[#999999] mt-2">
                Once you claim a card, it will appear here.{" "}
                <Link href="/claim">
                  <span className="text-[#D4AF37] hover:underline cursor-pointer">Register Ownership →</span>
                </Link>
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {ownedCerts.map((cert) => (
                <OwnedCertRow key={cert.id} cert={cert} ownerEmail={me.email} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

// ── Owned cert row with inline transfer form ───────────────────────────────────
function OwnedCertRow({ cert, ownerEmail }: { cert: CustomerCert; ownerEmail: string }) {
  const [showTransfer, setShowTransfer] = useState(false);
  const [toEmail, setToEmail] = useState("");
  const [newOwnerName, setNewOwnerName] = useState("");
  const [sending, setSending] = useState(false);
  const [transferResult, setTransferResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setTransferResult(null);
    try {
      const res = await apiRequest("POST", "/api/transfer/request", {
        certId: cert.certId,
        fromEmail: ownerEmail,
        toEmail: toEmail.trim(),
        newOwnerName: newOwnerName.trim() || undefined,
      });
      const data = await res.json();
      setTransferResult({ type: "success", message: data.message });
    } catch (err: any) {
      let msg = "Transfer failed. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setTransferResult({ type: "error", message: msg });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-mono text-[#D4AF37] text-sm font-bold">{cert.certId}</span>
          <p className="text-sm text-[#1A1A1A] mt-0.5">{cert.cardName ?? "—"}</p>
          <p className="text-xs text-[#999999]">{cert.setName ?? ""}{cert.year ? ` (${cert.year})` : ""}</p>
        </div>
        <button
          onClick={() => { setShowTransfer(!showTransfer); setTransferResult(null); }}
          className="text-xs text-[#999999] hover:text-[#D4AF37] flex items-center gap-1 transition-colors shrink-0"
        >
          <ArrowRightLeft size={12} />
          Transfer
          <ChevronRight size={12} className={`transition-transform ${showTransfer ? "rotate-90" : ""}`} />
        </button>
      </div>

      {showTransfer && (
        <div className="mt-4 pt-4 border-t border-[#E8E4DC]">
          {transferResult ? (
            <div className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
              transferResult.type === "success"
                ? "text-green-600 bg-green-50 border border-green-300"
                : "text-red-500 bg-red-50 border border-red-300"
            }`}>
              {transferResult.type === "success" ? <CheckCircle size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
              {transferResult.message}
            </div>
          ) : (
            <form onSubmit={handleTransfer} className="space-y-3">
              <p className="text-xs text-[#999999]">Initiate a transfer of ownership to a new owner.</p>
              <div>
                <label className="block text-xs text-[#666666] mb-1">New Owner's Full Name</label>
                <input
                  type="text"
                  value={newOwnerName}
                  onChange={(e) => setNewOwnerName(e.target.value)}
                  placeholder="e.g. James Smith"
                  className="w-full bg-white border border-[#E8E4DC] rounded-lg px-3 py-2 text-[#1A1A1A] placeholder:text-[#999999] text-sm focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
              <div>
                <label className="block text-xs text-[#666666] mb-1">New Owner's Email</label>
                <input
                  type="email"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  placeholder="newowner@email.com"
                  required
                  className="w-full bg-white border border-[#E8E4DC] rounded-lg px-3 py-2 text-[#1A1A1A] placeholder:text-[#999999] text-sm focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
              <button
                type="submit"
                disabled={sending || !toEmail.trim()}
                className="flex items-center gap-1.5 text-xs font-bold text-[#1A1400] btn-gold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {sending ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />}
                {sending ? "Sending..." : "Initiate Transfer"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

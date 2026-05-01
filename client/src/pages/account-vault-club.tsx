/**
 * client/src/pages/account-vault-club.tsx
 *
 * /account/vault-club — subscription state + Stripe Customer Portal link.
 *
 * Matches the /vault-club marketing page visual language:
 *   - cream paper backgrounds (var(--v2-paper) / --v2-paper-raised)
 *   - gold accents (--v2-gold)
 *   - Fraunces italic display + Geist body + JetBrains Mono eyebrow
 *   - max-w-4xl content column with generous vertical padding
 *   - section eyebrow ("I", "II", "III") + Fraunces italic h2 pattern
 *
 * Three stacked cards: STATUS, PERKS, MANAGE. Banner above when arriving
 * from a successful Stripe Checkout.
 *
 * OUT OF SCOPE (Stripe Portal handles all of these):
 *   - Plan switcher (monthly ↔ annual)
 *   - Invoice history
 *   - Update payment method
 *   - Reactivation flow for canceled-pending
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowRight, Loader2, X, Sparkles, AlertTriangle } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import SeoHead from "@/components/seo-head";
import AuthRequiredPage from "@/components/auth-required-page";
import { apiRequest } from "@/lib/queryClient";
import {
  VAULT_CLUB_PERKS,
  VAULT_CLUB_SILVER as SILVER,
  VAULT_CLUB_PENCE_TO_POUNDS as poundsFromPence,
} from "@/config/vault-club-perks";

// ── API shape ──────────────────────────────────────────────────────────────

type SubStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | null;

interface VaultClubMe {
  hasSubscription: boolean;
  subscriptionStatus: SubStatus;
  tier: "silver" | null;
  interval: "month" | "year" | null;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}

// ── Date helpers ───────────────────────────────────────────────────────────

const fmtDate = (iso: string | null): string => {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

const daysUntil = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
};

// ── Status pill ────────────────────────────────────────────────────────────

interface PillStyle {
  background: string;
  color: string;
  label: string;
}

function pillFor(status: SubStatus, cancelAtPeriodEnd: boolean): PillStyle {
  if (cancelAtPeriodEnd && (status === "active" || status === "trialing")) {
    return { background: "rgba(0,0,0,0.06)", color: "var(--v2-ink-soft)", label: "Ending soon" };
  }
  switch (status) {
    case "trialing":
      return { background: "var(--v2-gold)", color: "var(--v2-panel-dark)", label: "Trialing" };
    case "active":
      return { background: "rgba(34,139,90,0.12)", color: "#1F7A4D", label: "Active" };
    case "past_due":
    case "unpaid":
      return { background: "rgba(176,0,32,0.10)", color: "#B00020", label: "Payment failed" };
    case "canceled":
    case "incomplete":
    case "incomplete_expired":
      return { background: "rgba(0,0,0,0.06)", color: "var(--v2-ink-soft)", label: "Canceled" };
    default:
      return { background: "rgba(0,0,0,0.06)", color: "var(--v2-ink-soft)", label: "Unknown" };
  }
}

// ── Status copy ────────────────────────────────────────────────────────────

function statusCopy(me: VaultClubMe): string {
  const trialEndDate = fmtDate(me.trialEnd);
  const periodEndDate = fmtDate(me.currentPeriodEnd);
  const canceledAtDate = fmtDate(me.canceledAt);
  const trialDays = daysUntil(me.trialEnd);

  // Cancellation scheduled but membership still live
  if (me.cancelAtPeriodEnd && (me.subscriptionStatus === "active" || me.subscriptionStatus === "trialing")) {
    return `Membership ends ${periodEndDate}. Reactivate before then to keep your perks.`;
  }
  // Fully ended
  if (me.subscriptionStatus === "canceled" || me.subscriptionStatus === "incomplete_expired") {
    return canceledAtDate
      ? `Your membership ended on ${canceledAtDate}. Resubscribe from the Vault Club page.`
      : `Your membership has ended. Resubscribe from the Vault Club page.`;
  }
  switch (me.subscriptionStatus) {
    case "trialing":
      return `Free trial — ${trialDays} day${trialDays === 1 ? "" : "s"} left. First payment ${trialEndDate}.`;
    case "active":
      return `Renews ${periodEndDate}.`;
    case "past_due":
    case "unpaid":
      return "Payment failed — please update your card to keep your membership active.";
    case "incomplete":
      return "Setting up — Stripe is finalising your payment method. Refresh in a moment.";
    default:
      return "";
  }
}

// ── First-payment banner ───────────────────────────────────────────────────

function FirstPaymentBanner({ me }: { me: VaultClubMe }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const priceLabel =
    me.interval === "year"
      ? `${poundsFromPence(SILVER.annual_price_pence)} / year`
      : `${poundsFromPence(SILVER.monthly_price_pence)} / month`;
  const firstPaymentDate = fmtDate(me.trialEnd) || fmtDate(me.currentPeriodEnd);

  return (
    <div
      role="status"
      data-testid="first-payment-banner"
      className="relative rounded-xl mb-12 p-6 md:p-7"
      style={{
        backgroundColor: "var(--v2-paper-raised)",
        borderLeft: "3px solid var(--v2-gold)",
        animation: "vc-banner-enter 480ms cubic-bezier(0.22, 1, 0.36, 1) both",
      }}
    >
      <style>{`
        @keyframes vc-banner-enter {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="first-payment-banner"] { animation: none !important; }
        }
      `}</style>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-3 inline-flex items-center justify-center w-7 h-7 rounded-full transition-all hover:bg-black/5"
        style={{ color: "var(--v2-ink-mute)" }}
      >
        <X size={14} />
      </button>
      <div className="flex items-start gap-4">
        <div
          className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
          style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
        >
          <Sparkles size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2"
            style={{ color: "var(--v2-gold)" }}
          >
            Welcome to Vault Club
          </p>
          <p
            className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-1"
            style={{ color: "var(--v2-ink)" }}
          >
            Your 14-day free trial is active.
          </p>
          <p className="font-body text-sm md:text-base" style={{ color: "var(--v2-ink-soft)" }}>
            First payment {firstPaymentDate}
            {firstPaymentDate ? ` (${priceLabel})` : ` — ${priceLabel}`}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Status card ────────────────────────────────────────────────────────────

function StatusCard({ me }: { me: VaultClubMe }) {
  const pill = pillFor(me.subscriptionStatus, me.cancelAtPeriodEnd);
  const copy = statusCopy(me);
  const intervalLabel = me.interval === "year" ? "Annual" : me.interval === "month" ? "Monthly" : "—";

  return (
    <section
      data-testid="vc-status-card"
      className="rounded-2xl p-8 md:p-10 mb-6"
      style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
    >
      <SectionEyebrow numeral="I" label="Membership" className="mb-6" />

      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 mb-6">
        <div>
          <p
            className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            Tier
          </p>
          <h1
            className="font-display italic font-medium leading-none"
            style={{ fontSize: "clamp(2.5rem, 5vw, 4rem)", color: "var(--v2-ink)" }}
          >
            Silver
          </h1>
        </div>
        <div className="self-end pb-2">
          <span
            className="inline-flex items-center font-mono-v2 text-[10px] uppercase tracking-widest px-3 py-1.5 rounded-full"
            style={{ backgroundColor: pill.background, color: pill.color }}
          >
            {pill.label}
          </span>
        </div>
      </div>

      {(me.subscriptionStatus === "past_due" || me.subscriptionStatus === "unpaid") && (
        <div
          className="flex items-start gap-3 rounded-lg p-4 mb-6"
          style={{ backgroundColor: "rgba(176,0,32,0.06)", border: "1px solid rgba(176,0,32,0.18)" }}
        >
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" style={{ color: "#B00020" }} />
          <p className="font-body text-sm" style={{ color: "#B00020" }}>
            {copy}
          </p>
        </div>
      )}

      {me.subscriptionStatus !== "past_due" && me.subscriptionStatus !== "unpaid" && (
        <p
          className="font-body text-base md:text-lg leading-relaxed mb-6"
          style={{ color: "var(--v2-ink-soft)" }}
        >
          {copy}
        </p>
      )}

      <div
        className="grid grid-cols-2 gap-6 pt-6"
        style={{ borderTop: "1px solid var(--v2-line)" }}
      >
        <div>
          <p
            className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            Billing
          </p>
          <p className="font-body text-sm md:text-base" style={{ color: "var(--v2-ink)" }}>
            {intervalLabel}
            {me.interval === "year" && (
              <span style={{ color: "var(--v2-ink-mute)" }}> · {poundsFromPence(SILVER.annual_price_pence)} / year</span>
            )}
            {me.interval === "month" && (
              <span style={{ color: "var(--v2-ink-mute)" }}> · {poundsFromPence(SILVER.monthly_price_pence)} / month</span>
            )}
          </p>
        </div>
        <div>
          <p
            className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            {me.subscriptionStatus === "trialing" ? "Trial ends" : "Next renewal"}
          </p>
          <p className="font-body text-sm md:text-base" style={{ color: "var(--v2-ink)" }}>
            {fmtDate(me.subscriptionStatus === "trialing" ? me.trialEnd : me.currentPeriodEnd) || "—"}
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Perks card ─────────────────────────────────────────────────────────────

function PerksCard() {
  return (
    <section
      data-testid="vc-perks-card"
      className="rounded-2xl p-8 md:p-10 mb-6"
      style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
    >
      <SectionEyebrow numeral="II" label="Your perks" className="mb-6" />
      <h2
        className="font-display italic font-medium text-2xl md:text-3xl leading-tight mb-8"
        style={{ color: "var(--v2-ink)" }}
      >
        What Silver includes.
      </h2>

      <ul className="space-y-6">
        {VAULT_CLUB_PERKS.map((perk) => (
          <li key={perk.number} className="flex items-start gap-5">
            <span
              className="flex-shrink-0 font-numeral font-semibold leading-none"
              style={{ fontSize: "clamp(1.75rem, 3vw, 2.25rem)", color: "var(--v2-gold)" }}
            >
              {perk.number}
            </span>
            <div className="flex-1 min-w-0">
              <h3
                className="font-display italic font-medium text-lg md:text-xl leading-snug mb-1.5"
                style={{ color: "var(--v2-ink)" }}
              >
                {perk.title}
              </h3>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                {perk.body}
              </p>
              {perk.value && (
                <p
                  className="font-mono-v2 text-[10px] uppercase tracking-widest mt-2"
                  style={{ color: "var(--v2-ink-mute)" }}
                >
                  {perk.value}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Manage card ────────────────────────────────────────────────────────────

function ManageCard() {
  const portal = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vault-club/portal", {});
      const data = await res.json().catch(() => ({}));
      return data as { url?: string; message?: string };
    },
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
  });

  const errorMessage =
    portal.isError
      ? "Could not open the billing portal. Please try again or contact support@mintvaultuk.com."
      : portal.data && !portal.data.url
        ? portal.data.message || "Could not open the billing portal."
        : null;

  return (
    <section
      data-testid="vc-manage-card"
      className="rounded-2xl p-8 md:p-10"
      style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
    >
      <SectionEyebrow numeral="III" label="Manage" className="mb-6" />
      <h2
        className="font-display italic font-medium text-2xl md:text-3xl leading-tight mb-3"
        style={{ color: "var(--v2-ink)" }}
      >
        Update billing or cancel.
      </h2>
      <p
        className="font-body text-sm md:text-base leading-relaxed mb-6 max-w-xl"
        style={{ color: "var(--v2-ink-soft)" }}
      >
        Manage your card, switch between monthly and annual, view invoice history,
        or cancel — all in the secure Stripe portal.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => portal.mutate()}
          disabled={portal.isPending}
          data-testid="vc-portal-button"
          className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold px-6 py-3 rounded-full transition-all hover:scale-[1.03] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
        >
          {portal.isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Opening portal&hellip;
            </>
          ) : (
            <>
              Manage billing &amp; cancel <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>

      <p
        className="font-mono-v2 text-[10px] uppercase tracking-widest mt-4"
        style={{ color: "var(--v2-ink-mute)" }}
      >
        Cancel anytime &middot; You won&rsquo;t be charged after cancellation
      </p>

      {errorMessage && (
        <p
          role="alert"
          data-testid="vc-portal-error"
          className="font-body text-sm mt-4"
          style={{ color: "#B00020" }}
        >
          {errorMessage}
        </p>
      )}
    </section>
  );
}

// ── No-subscription fallback ───────────────────────────────────────────────

function NoMembership() {
  return (
    <div
      className="rounded-2xl p-10 md:p-14 text-center"
      style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
    >
      <SectionEyebrow numeral="—" label="Vault Club" className="mb-6 text-center" />
      <h1
        className="font-display italic font-medium leading-tight mb-4"
        style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
      >
        You&rsquo;re not a Vault Club member yet.
      </h1>
      <p
        className="font-body text-base md:text-lg leading-relaxed mb-8 max-w-xl mx-auto"
        style={{ color: "var(--v2-ink-soft)" }}
      >
        Silver is a perks-and-credits membership for collectors who submit regularly.
        Two free Authentications a month, free return shipping, 100 AI Pre-Grade
        credits, and priority queueing.
      </p>
      <Link
        href="/vault-club"
        className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
        style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
      >
        Join Vault Club <ArrowRight size={14} />
      </Link>
    </div>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div
      className="rounded-2xl p-10 mb-6 overflow-hidden relative"
      style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
    >
      <style>{`
        @keyframes vc-shimmer {
          from { background-position: -200% 0; }
          to   { background-position: 200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .vc-skel { animation: none !important; }
        }
      `}</style>
      <div className="space-y-4">
        <div
          className="vc-skel h-3 w-24 rounded"
          style={{
            backgroundImage: "linear-gradient(90deg, transparent, rgba(0,0,0,0.06), transparent)",
            backgroundSize: "200% 100%",
            backgroundColor: "rgba(0,0,0,0.04)",
            animation: "vc-shimmer 1.6s ease-in-out infinite",
          }}
        />
        <div
          className="vc-skel h-12 w-48 rounded"
          style={{
            backgroundImage: "linear-gradient(90deg, transparent, rgba(0,0,0,0.06), transparent)",
            backgroundSize: "200% 100%",
            backgroundColor: "rgba(0,0,0,0.04)",
            animation: "vc-shimmer 1.6s ease-in-out infinite 120ms",
          }}
        />
        <div
          className="vc-skel h-4 w-3/4 rounded"
          style={{
            backgroundImage: "linear-gradient(90deg, transparent, rgba(0,0,0,0.06), transparent)",
            backgroundSize: "200% 100%",
            backgroundColor: "rgba(0,0,0,0.04)",
            animation: "vc-shimmer 1.6s ease-in-out infinite 240ms",
          }}
        />
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AccountVaultClubPage() {
  // Strip ?checkout=success from the URL after first paint so a refresh
  // doesn't re-show the banner. We capture the original value into state
  // first so the banner still renders this paint.
  const [showSuccessBanner, setShowSuccessBanner] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("checkout") === "success";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("checkout") || params.has("session_id")) {
      params.delete("checkout");
      params.delete("session_id");
      const cleanQuery = params.toString();
      const newUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}`;
      window.history.replaceState({}, "", newUrl);
    }
  }, []);

  const { data: me, isLoading, isError } = useQuery<VaultClubMe | null>({
    queryKey: ["/api/vault-club/me"],
    queryFn: async () => {
      const res = await fetch("/api/vault-club/me");
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`me request failed: ${res.status}`);
      return res.json();
    },
    retry: false,
    staleTime: 30_000,
  });

  // Loading: show skeleton in the same content shell as the loaded state.
  const body = useMemo(() => {
    if (isLoading) return <Skeleton />;
    if (isError) {
      return (
        <div
          role="alert"
          className="rounded-2xl p-8 text-center"
          style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
        >
          <p className="font-body text-sm" style={{ color: "var(--v2-ink-soft)" }}>
            Couldn&rsquo;t load your membership. Please refresh, or contact support@mintvaultuk.com.
          </p>
        </div>
      );
    }
    if (!me) return null; // auth gate handled below
    if (!me.hasSubscription) return <NoMembership />;
    return (
      <>
        {showSuccessBanner && <FirstPaymentBanner me={me} />}
        <StatusCard me={me} />
        <PerksCard />
        <ManageCard />
      </>
    );
  }, [isLoading, isError, me, showSuccessBanner]);

  // Auth gate — `me === null` only when GET /api/vault-club/me returned 401.
  if (!isLoading && me === null) {
    return <AuthRequiredPage currentPath="/account/vault-club" />;
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <SeoHead
        title="Vault Club Membership · MintVault UK"
        description="Manage your Silver Vault Club membership, billing, and perks."
        canonical="https://mintvaultuk.com/account/vault-club"
      />
      <HeaderV2 />
      <main className="flex-1">
        <section>
          <div className="mx-auto max-w-4xl px-6 pt-12 pb-24 md:pt-16 md:pb-32">
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-4"
              style={{ color: "var(--v2-gold)" }}
            >
              Account &middot; Vault Club
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-10"
              style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)", color: "var(--v2-ink)" }}
            >
              Your membership.
            </h1>
            {body}
          </div>
        </section>
      </main>
      <FooterV2 />
    </div>
  );
}

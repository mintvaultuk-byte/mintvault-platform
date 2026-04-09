import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { apiRequest } from "@/lib/queryClient";
import { pricingTiers, submissionTypes, calculateOrderTotals, getInsuranceTier, getInsuranceSurchargePerCard } from "@shared/schema";
import type { PricingTier } from "@shared/schema";
import { ArrowLeft, ArrowRight, Check, Shield, CreditCard, AlertTriangle, Info, ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";

interface CardItem {
  game: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  year: string;
  declaredValue: number;
  notes: string;
}

const emptyCardItem = (): CardItem => ({
  game: "",
  cardName: "",
  setName: "",
  cardNumber: "",
  year: "",
  declaredValue: 0,
  notes: "",
});

const cardGames = [
  "Pokémon", "Yu-Gi-Oh!", "Magic: The Gathering", "Dragon Ball Super",
  "One Piece", "Digimon", "Flesh and Blood", "Lorcana",
  "Weiss Schwarz", "Cardfight!! Vanguard", "Final Fantasy TCG",
  "Star Wars: Unlimited", "MetaZoo", "UniVersus", "Other",
];

interface WizardState {
  type: string;
  tier: string;
  quantity: number;
  declaredValue: number;
  submissionName: string;
  notes: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  county: string;
  postcode: string;
  cardItems: CardItem[];
  crossoverCompany: string;
  crossoverCompanyOther: string;
  crossoverOriginalGrade: string;
  crossoverCertNumber: string;
  reholderCompany: string;
  reholderReason: string;
  reholderCondition: string;
  reholderCertNumber: string;
  authReason: string;
  authConcerns: string;
  revealWrap: boolean;
}

const WIZARD_STATE_VERSION = "mv-wizard-v4";
const WIZARD_LS_KEY = "mv-submit-wizard";

function saveWizardState(state: WizardState) {
  try {
    localStorage.setItem(WIZARD_LS_KEY, JSON.stringify({ v: WIZARD_STATE_VERSION, state }));
  } catch {}
}

function loadWizardState(): WizardState | null {
  try {
    const raw = localStorage.getItem(WIZARD_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.v !== WIZARD_STATE_VERSION) return null;
    return parsed.state as WizardState;
  } catch {
    return null;
  }
}

function clearWizardState() {
  try {
    localStorage.removeItem(WIZARD_LS_KEY);
  } catch {}
}

const stepLabels = ["Tier", "Cards", "Review", "Shipping", "Payment"];

function gameAccentColor(game: string): string {
  const g = game.toLowerCase();
  if (g.includes("pokémon") || g.includes("pokemon")) return "#E3350D";
  if (g.includes("yu-gi-oh") || g.includes("yugioh")) return "#7B2D8B";
  if (g.includes("magic")) return "#1A6FB5";
  if (g.includes("one piece")) return "#E84118";
  return "#D4AF37";
}

function StepIndicator({ step, accentColor = "#D4AF37" }: { step: number; accentColor?: string }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8">
      {stepLabels.map((label, i) => (
        <div key={i} className="flex items-center">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border transition-all"
            style={
              i + 1 < step
                ? { background: accentColor, color: "#000", borderColor: accentColor }
                : i + 1 === step
                ? { background: "transparent", color: accentColor, borderColor: accentColor }
                : { background: "transparent", color: `${accentColor}4D`, borderColor: `${accentColor}33` }
            }
            data-testid={`step-indicator-${i + 1}`}
          >
            {i + 1 < step ? <Check size={14} /> : i + 1}
          </div>
          {i < stepLabels.length - 1 && (
            <div
              className="w-6 h-px mx-0.5"
              style={{ background: i + 1 < step ? accentColor : `${accentColor}33` }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function getEstimatedReturnDate(turnaroundDays: number): string {
  const date = new Date();
  let workDays = 0;
  let added = 0;
  while (added < turnaroundDays) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) {
      added++;
    }
  }
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const OTHER_SERVICES_INFO = [
  { id: "reholder", name: "Reholder", price: "£8 / card", turnaround: "20 working days", desc: "New slab + VaultLock NFC chip for an existing graded card" },
  { id: "crossover", name: "Crossover", price: "£15 / card", turnaround: "20 working days", desc: "Grade a card from another company (PSA, BGS, etc.)" },
  { id: "authentication", name: "Authentication", price: "£10 / card", turnaround: "20 working days", desc: "Verify authenticity — no grade assigned" },
];

function Step1Tier({ state, setState, tiers, capacity }: {
  state: WizardState;
  setState: (s: WizardState) => void;
  tiers: PricingTier[];
  capacity?: Record<string, { active: number; max: number; full: boolean; forceOpen: boolean }>;
}) {
  const typeName = submissionTypes.find(t => t.id === state.type)?.name || state.type;

  return (
    <div>
      <h2 className="text-2xl font-sans font-black text-[#D4AF37] tracking-tight mb-2 text-center" data-testid="text-step1-title">
        Choose Service Level
      </h2>
      <p className="text-[#999999] text-center mb-8 text-sm">Select your {typeName.toLowerCase()} speed and coverage tier</p>

      <div className="space-y-3">
        {tiers.map((tier) => {
          const isSelected = state.tier === tier.id;
          const estimatedReturn = tier.turnaroundDays ? getEstimatedReturnDate(tier.turnaroundDays) : null;
          const cap = capacity?.[tier.id];
          const isFull = state.type === "grading" && cap?.full === true;
          return (
            <button
              key={tier.id}
              onClick={() => !isFull && setState({ ...state, tier: tier.id })}
              disabled={isFull}
              className={`w-full border rounded-2xl p-4 text-left transition-all ${
                isFull
                  ? "border-[#D4AF37]/10 opacity-50 cursor-not-allowed"
                  : isSelected
                    ? "border-[#D4AF37] bg-[#D4AF37]/10"
                    : "border-[#D4AF37]/20 hover:border-[#D4AF37]/50"
              }`}
              data-testid={`button-tier-${tier.id}`}
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[#D4AF37] font-bold text-lg tracking-wider">{tier.name}</h3>
                    {isFull && (
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] bg-red-100 text-red-600 border border-red-200 rounded px-1.5 py-0.5">
                        Fully Booked
                      </span>
                    )}
                  </div>
                  <p className="text-[#999999] text-sm mt-1">{tier.turnaround} from receipt</p>
                  {isSelected && estimatedReturn && (
                    <p className="text-[#D4AF37]/70 text-xs mt-1.5 flex items-center gap-1" data-testid={`text-estimated-return-${tier.id}`}>
                      <Check size={11} />
                      Est. return by {estimatedReturn}
                    </p>
                  )}
                </div>
                <span className="text-[#1A1A1A] font-bold text-lg">{tier.price}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Turnaround note */}
      <p className="text-[#999999] text-xs text-center mt-4">
        All turnaround times begin when we receive your cards, not when you post them.
      </p>

      {/* Other Services — shown when browsing grading tiers */}
      {state.type === "grading" && (
        <div className="mt-8">
          <div className="relative flex items-center mb-4">
            <div className="flex-1 h-px bg-[#D4AF37]/20" />
            <span className="mx-3 text-[10px] font-bold uppercase tracking-[0.15em] text-[#D4AF37]/50">Other Services</span>
            <div className="flex-1 h-px bg-[#D4AF37]/20" />
          </div>
          <div className="space-y-2">
            {OTHER_SERVICES_INFO.map((svc) => (
              <button
                key={svc.id}
                onClick={() => setState({ ...state, type: svc.id, tier: svc.id })}
                className="w-full border border-[#D4AF37]/15 hover:border-[#D4AF37]/40 rounded-xl p-3.5 text-left transition-all bg-[#FAFAF8]"
                data-testid={`button-other-service-${svc.id}`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-[#D4AF37]/80 font-bold text-sm tracking-wider">{svc.name}</h3>
                    <p className="text-[#999999] text-xs mt-0.5">{svc.desc}</p>
                    <p className="text-[#BBBBBB] text-xs mt-0.5">{svc.turnaround} from receipt</p>
                  </div>
                  <span className="text-[#888888] font-bold text-sm">{svc.price}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const GRADING_COMPANIES = ["PSA", "BGS", "CGC", "AGS", "ACE", "TAG", "SGC", "Other"];

function CrossoverFields({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  return (
    <div className="max-w-sm mx-auto mb-8 space-y-4 border border-[#D4AF37]/30 rounded-2xl p-4 bg-[#FFF9E6]">
      <div>
        <h3 className="text-[#D4AF37] font-semibold text-sm tracking-wider mb-1">Crossover Details</h3>
        <p className="text-[#999999] text-xs mb-3">Tell us about the existing slab you're crossing over.</p>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">
          Original Grading Company <span className="text-red-400">*</span>
        </label>
        <select
          value={state.crossoverCompany}
          onChange={(e) => setState({ ...state, crossoverCompany: e.target.value, crossoverCompanyOther: "" })}
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="select-crossover-company"
        >
          <option value="" className="bg-white">Select company...</option>
          {GRADING_COMPANIES.map((c) => (
            <option key={c} value={c} className="bg-white">{c}</option>
          ))}
        </select>
      </div>

      {state.crossoverCompany === "Other" && (
        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Enter Grading Company</label>
          <input
            type="text"
            value={state.crossoverCompanyOther}
            onChange={(e) => setState({ ...state, crossoverCompanyOther: e.target.value })}
            placeholder="e.g. Beckett"
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-crossover-company-other"
          />
        </div>
      )}

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Original Grade</label>
        <input
          type="text"
          value={state.crossoverOriginalGrade}
          onChange={(e) => setState({ ...state, crossoverOriginalGrade: e.target.value })}
          placeholder="e.g. 9.5 or NM-MT"
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="input-crossover-grade"
        />
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Certificate Number</label>
        <input
          type="text"
          value={state.crossoverCertNumber}
          onChange={(e) => setState({ ...state, crossoverCertNumber: e.target.value })}
          placeholder="e.g. 12345678"
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="input-crossover-cert"
        />
      </div>

      <p className="text-[#999999] text-xs leading-relaxed border-t border-[#D4AF37]/20 pt-3">
        Crossover is subject to review. MintVault reserves the right to return cards that do not meet crossover standards.
      </p>
    </div>
  );
}

const SLAB_COMPANIES = ["MintVault", "PSA", "BGS", "CGC", "AGS", "ACE", "TAG", "SGC", "Other"];
const REHOLDER_REASONS = ["Damaged slab", "Cosmetic upgrade", "Label error / correction", "Slab crack", "Other"];

function ReholderFields({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  return (
    <div className="max-w-sm mx-auto mb-8 space-y-4 border border-[#D4AF37]/20 rounded-2xl p-4 bg-[#FFF9E6]">
      <div>
        <h3 className="text-[#D4AF37] font-semibold text-sm tracking-wider mb-1">Reholder Details</h3>
        <p className="text-[#999999] text-xs mb-3">Tell us about the existing slab you need reheld.</p>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">
          Current Slab Company <span className="text-red-400">*</span>
        </label>
        <select
          value={state.reholderCompany}
          onChange={(e) => setState({ ...state, reholderCompany: e.target.value })}
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="select-reholder-company"
        >
          <option value="" className="bg-white">Select company...</option>
          {SLAB_COMPANIES.map((c) => (
            <option key={c} value={c} className="bg-white">{c}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">
          Reason for Reholder <span className="text-red-400">*</span>
        </label>
        <select
          value={state.reholderReason}
          onChange={(e) => setState({ ...state, reholderReason: e.target.value })}
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="select-reholder-reason"
        >
          <option value="" className="bg-white">Select reason...</option>
          {REHOLDER_REASONS.map((r) => (
            <option key={r} value={r} className="bg-white">{r}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Existing Cert / Grade Number (optional)</label>
        <input
          type="text"
          value={state.reholderCertNumber}
          onChange={(e) => setState({ ...state, reholderCertNumber: e.target.value })}
          placeholder="e.g. 12345678 or PSA-9"
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="input-reholder-cert"
        />
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Current Slab Condition (optional)</label>
        <input
          type="text"
          value={state.reholderCondition}
          onChange={(e) => setState({ ...state, reholderCondition: e.target.value })}
          placeholder="e.g. Cracked corner, yellowing, label damage..."
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="input-reholder-condition"
        />
      </div>

      <p className="text-[#999999] text-xs leading-relaxed border-t border-[#D4AF37]/10 pt-3">
        Reholdering applies to MintVault slabs only. Cards from other grading companies are subject to review. The original grade is retained unless a new grading service is also requested.
      </p>
    </div>
  );
}

const AUTH_REASONS = ["Counterfeit suspicion", "Pre-sale verification", "Insurance / valuation", "Personal peace of mind", "Other"];

function AuthenticationFields({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  return (
    <div className="max-w-sm mx-auto mb-8 space-y-4 border border-[#D4AF37]/20 rounded-2xl p-4 bg-[#FFF9E6]">
      <div>
        <h3 className="text-[#D4AF37] font-semibold text-sm tracking-wider mb-1">Authentication Details</h3>
        <p className="text-[#999999] text-xs mb-3">Help us understand why you're requesting authentication.</p>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">
          Reason for Authentication <span className="text-red-400">*</span>
        </label>
        <select
          value={state.authReason}
          onChange={(e) => setState({ ...state, authReason: e.target.value })}
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
          data-testid="select-auth-reason"
        >
          <option value="" className="bg-white">Select reason...</option>
          {AUTH_REASONS.map((r) => (
            <option key={r} value={r} className="bg-white">{r}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1">Authenticity Concerns (optional)</label>
        <textarea
          value={state.authConcerns}
          onChange={(e) => setState({ ...state, authConcerns: e.target.value })}
          placeholder="Describe any specific concerns about the card's authenticity..."
          rows={3}
          className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors resize-none"
          data-testid="textarea-auth-concerns"
        />
      </div>

      <p className="text-[#999999] text-xs leading-relaxed border-t border-[#D4AF37]/10 pt-3">
        Authentication results in a certificate confirming the card is genuine. No condition grade is assigned. Cards found to be counterfeit will not be returned without prior arrangement.
      </p>
    </div>
  );
}

function Step2Cards({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  const insurance = getInsuranceTier(state.declaredValue);
  const declaredPerCard = state.quantity > 0 ? Math.ceil(state.declaredValue / state.quantity) : 0;
  const surchargeInfo = getInsuranceSurchargePerCard(declaredPerCard);
  const [showCardDetails, setShowCardDetails] = useState(state.cardItems.length > 0);

  const handleQuantityChange = (newQty: number) => {
    const qty = Math.max(1, newQty);
    const newItems = [...state.cardItems];
    if (showCardDetails) {
      while (newItems.length < qty) newItems.push(emptyCardItem());
      while (newItems.length > qty) newItems.pop();
    }
    setState({ ...state, quantity: qty, cardItems: newItems });
  };

  const toggleCardDetails = () => {
    if (!showCardDetails) {
      const items: CardItem[] = [];
      for (let i = 0; i < state.quantity; i++) {
        items.push(state.cardItems[i] || emptyCardItem());
      }
      setState({ ...state, cardItems: items });
      setShowCardDetails(true);
    } else {
      setShowCardDetails(false);
      setState({ ...state, cardItems: [] });
    }
  };

  const updateCardItem = (index: number, field: keyof CardItem, value: string | number) => {
    const newItems = [...state.cardItems];
    newItems[index] = { ...newItems[index], [field]: value };
    setState({ ...state, cardItems: newItems });
  };

  const cardItemsDeclaredSum = state.cardItems.reduce((sum, item) => sum + (item.declaredValue || 0), 0);
  const hasMismatch = showCardDetails && state.cardItems.length > 0 && state.declaredValue > 0 && cardItemsDeclaredSum > 0 && Math.abs(cardItemsDeclaredSum - state.declaredValue) > 0.01;

  return (
    <div>
      <h2 className="text-2xl font-sans font-black text-[#D4AF37] tracking-tight mb-2 text-center" data-testid="text-step2-title">
        How Many Cards?
      </h2>
      <p className="text-[#999999] text-center mb-8 text-sm">Enter the number of cards and total declared value</p>

      {state.type === "crossover" && <CrossoverFields state={state} setState={setState} />}
      {state.type === "reholder" && <ReholderFields state={state} setState={setState} />}
      {state.type === "authentication" && <AuthenticationFields state={state} setState={setState} />}

      <div className="max-w-sm mx-auto space-y-6">
        <div>
          <label className="text-[#D4AF37]/70 text-sm uppercase tracking-wider block mb-2">
            Number of Cards
          </label>
          <input
            type="number"
            min="0"
            step="1"
            value={state.quantity}
            onChange={(e) => handleQuantityChange(Math.max(0, parseInt(e.target.value) || 0))}
            placeholder="0"
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-xl px-4 py-3 text-[#1A1A1A] text-lg text-center focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-quantity"
          />
        </div>
        <div>
          <label className="text-[#D4AF37]/70 text-sm uppercase tracking-wider block mb-2">
            Total Declared Value (£)
          </label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#D4AF37]/60 text-lg">£</span>
            <input
              type="number"
              min="0"
              step="1"
              value={state.declaredValue || ""}
              onChange={(e) => setState({ ...state, declaredValue: Math.max(0, parseFloat(e.target.value) || 0) })}
              placeholder="0"
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded-xl pl-8 pr-4 py-3 text-[#1A1A1A] text-lg text-center focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
              data-testid="input-declared-value"
            />
          </div>
          <p className="text-[#999999] text-xs mt-1.5">Combined estimated value of all cards in this submission</p>
          {state.declaredValue > 0 && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2 text-sm">
                <Shield size={14} className="text-[#D4AF37]" />
                <span className="text-[#D4AF37]/80">
                  Insured shipping: {insurance.label} — £{(insurance.shippingPence / 100).toFixed(2)}
                </span>
              </div>
              {surchargeInfo.surchargePence > 0 && (
                <div className="flex items-center gap-2 text-sm" data-testid="text-insurance-surcharge">
                  <Shield size={14} className="text-[#D4AF37]" />
                  <span className="text-[#D4AF37]/80">
                    Insurance protection: {surchargeInfo.label} (£{(declaredPerCard).toLocaleString()}/card avg)
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="text-[#D4AF37]/70 text-sm uppercase tracking-wider block mb-2">
            Submission Name (optional)
          </label>
          <input
            type="text"
            value={state.submissionName}
            onChange={(e) => setState({ ...state, submissionName: e.target.value })}
            placeholder="e.g. My Charizard Collection"
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-xl px-4 py-3 text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-submission-name"
          />
        </div>
      </div>

      <div className="max-w-2xl mx-auto mt-8">
        <button
          type="button"
          onClick={toggleCardDetails}
          className="w-full flex items-center justify-between border border-[#D4AF37]/30 rounded-2xl px-4 py-3 text-left transition-all hover:border-[#D4AF37]/50"
          data-testid="button-toggle-card-details"
        >
          <div className="flex items-center gap-2">
            <Plus size={16} className="text-[#D4AF37]" />
            <span className="text-[#D4AF37] font-medium text-sm tracking-wide">Add Card Details (Optional)</span>
          </div>
          {showCardDetails ? <ChevronUp size={16} className="text-[#D4AF37]/60" /> : <ChevronDown size={16} className="text-[#D4AF37]/60" />}
        </button>

        {showCardDetails && (
          <div className="mt-4 space-y-4">
            <p className="text-[#999999] text-xs">Pre-fill card details to speed up processing. All fields are optional.</p>

            {hasMismatch && (
              <div className="flex items-center gap-2 border border-yellow-500/30 rounded p-3 bg-yellow-500/5" data-testid="text-declared-value-mismatch">
                <AlertTriangle size={14} className="text-yellow-500 flex-shrink-0" />
                <span className="text-yellow-400 text-xs">
                  Per-card declared values sum to £{cardItemsDeclaredSum.toLocaleString()} but total declared value is £{state.declaredValue.toLocaleString()}
                </span>
              </div>
            )}

            {state.cardItems.map((item, index) => (
              <div
                key={index}
                className="border border-[#D4AF37]/20 rounded-2xl p-4 space-y-3"
                data-testid={`card-item-${index}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#D4AF37] font-semibold text-sm tracking-wider">Card {index + 1}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Game</label>
                    <select
                      value={item.game}
                      onChange={(e) => updateCardItem(index, "game", e.target.value)}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                      data-testid={`select-game-${index}`}
                    >
                      <option value="" className="bg-white">Select game...</option>
                      {cardGames.map((g) => (
                        <option key={g} value={g} className="bg-white">{g}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Card Name</label>
                    <input
                      type="text"
                      value={item.cardName}
                      onChange={(e) => updateCardItem(index, "cardName", e.target.value)}
                      placeholder="e.g. Charizard"
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                      data-testid={`input-card-name-${index}`}
                    />
                  </div>
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Set Name</label>
                    <input
                      type="text"
                      value={item.setName}
                      onChange={(e) => updateCardItem(index, "setName", e.target.value)}
                      placeholder="e.g. Base Set"
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                      data-testid={`input-set-name-${index}`}
                    />
                  </div>
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Card Number</label>
                    <input
                      type="text"
                      value={item.cardNumber}
                      onChange={(e) => updateCardItem(index, "cardNumber", e.target.value)}
                      placeholder="e.g. 4/102"
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                      data-testid={`input-card-number-${index}`}
                    />
                  </div>
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Year</label>
                    <input
                      type="text"
                      value={item.year}
                      onChange={(e) => updateCardItem(index, "year", e.target.value)}
                      placeholder="e.g. 1999"
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                      data-testid={`input-year-${index}`}
                    />
                  </div>
                  <div>
                    <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Declared Value (£)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40 text-sm">£</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={item.declaredValue || ""}
                        onChange={(e) => updateCardItem(index, "declaredValue", Math.max(0, parseFloat(e.target.value) || 0))}
                        placeholder="0"
                        className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg pl-7 pr-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                        data-testid={`input-card-value-${index}`}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-[#D4AF37]/50 text-xs uppercase tracking-wider block mb-1">Notes</label>
                  <input
                    type="text"
                    value={item.notes}
                    onChange={(e) => updateCardItem(index, "notes", e.target.value)}
                    placeholder="Any special notes for this card..."
                    className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
                    data-testid={`input-card-notes-${index}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Step3Review({ state, setState, tier }: { state: WizardState; setState: (s: WizardState) => void; tier: PricingTier | undefined }) {
  const typeName = submissionTypes.find((t) => t.id === state.type)?.name || state.type;
  const totals = calculateOrderTotals(tier?.pricePerCard || 0, state.quantity, state.declaredValue);

  return (
    <div>
      <h2 className="text-2xl font-sans font-black text-[#D4AF37] tracking-tight mb-2 text-center" data-testid="text-step3-title">
        Order Summary
      </h2>
      <p className="text-[#999999] text-center mb-8 text-sm">Review your submission before proceeding</p>

      <div className="max-w-md mx-auto border border-[#D4AF37]/30 rounded-2xl overflow-hidden">
        <div className="bg-[#D4AF37]/5 p-4 border-b border-[#D4AF37]/20">
          <h3 className="text-[#D4AF37] font-semibold tracking-wider text-sm uppercase">Submission Details</h3>
        </div>
        <div className="p-5 space-y-3">
          <SummaryRow label="Submission Type" value={typeName} testId="text-summary-type" />
          <SummaryRow label="Service Tier" value={tier?.name || ""} testId="text-summary-tier" />
          <SummaryRow label="Turnaround" value={tier?.turnaround || ""} testId="text-summary-turnaround" />
          <SummaryRow label="Quantity" value={`${state.quantity} card${state.quantity > 1 ? "s" : ""}`} testId="text-summary-qty" />
          <SummaryRow label="Price per Card" value={tier?.price || ""} testId="text-summary-price" />
          {state.declaredValue > 0 && (
            <SummaryRow label="Declared Value" value={`£${state.declaredValue.toLocaleString()}`} testId="text-summary-declared-value" />
          )}
          {state.submissionName && (
            <SummaryRow label="Submission Name" value={state.submissionName} testId="text-summary-name" />
          )}

          {state.type === "crossover" && state.crossoverCompany && (
            <div className="border-t border-[#D4AF37]/15 pt-3 mt-1">
              <p className="text-[#D4AF37]/60 text-xs uppercase tracking-wider mb-2">Crossover Details</p>
              <SummaryRow
                label="Original Company"
                value={state.crossoverCompany === "Other" ? state.crossoverCompanyOther : state.crossoverCompany}
                testId="text-summary-crossover-company"
              />
              {state.crossoverOriginalGrade && (
                <SummaryRow label="Original Grade" value={state.crossoverOriginalGrade} testId="text-summary-crossover-grade" />
              )}
              {state.crossoverCertNumber && (
                <SummaryRow label="Certificate No." value={state.crossoverCertNumber} testId="text-summary-crossover-cert" />
              )}
              <p className="text-[#999999] text-xs mt-2">Subject to review before crossover is accepted.</p>
            </div>
          )}

          {state.type === "reholder" && state.reholderCompany && (
            <div className="border-t border-[#D4AF37]/10 pt-3 mt-1">
              <p className="text-[#D4AF37]/60 text-xs uppercase tracking-wider mb-2">Reholder Details</p>
              <SummaryRow label="Current Slab Company" value={state.reholderCompany} testId="text-summary-reholder-company" />
              {state.reholderCertNumber && (
                <SummaryRow label="Cert / Grade No." value={state.reholderCertNumber} testId="text-summary-reholder-cert" />
              )}
              {state.reholderReason && (
                <SummaryRow label="Reason" value={state.reholderReason} testId="text-summary-reholder-reason" />
              )}
              {state.reholderCondition && (
                <SummaryRow label="Condition Notes" value={state.reholderCondition} testId="text-summary-reholder-condition" />
              )}
            </div>
          )}

          {state.type === "authentication" && state.authReason && (
            <div className="border-t border-[#D4AF37]/10 pt-3 mt-1">
              <p className="text-[#D4AF37]/60 text-xs uppercase tracking-wider mb-2">Authentication Details</p>
              <SummaryRow label="Reason" value={state.authReason} testId="text-summary-auth-reason" />
              {state.authConcerns && (
                <SummaryRow label="Concerns" value={state.authConcerns} testId="text-summary-auth-concerns" />
              )}
              <p className="text-[#999999] text-xs mt-2">Authentication certificate only — no condition grade assigned.</p>
            </div>
          )}

          <div className="border-t border-[#D4AF37]/20 pt-3 mt-3 space-y-2">
            <SummaryRow label="Service Fees" value={`£${(totals.subtotal / 100).toFixed(2)}`} testId="text-summary-subtotal" />
            {totals.discountPercent > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-[#D4AF37]/80 text-sm">Bulk discount ({totals.discountPercent}%)</span>
                <span className="text-[#D4AF37] font-medium text-sm" data-testid="text-summary-discount">
                  -£{(totals.discountAmount / 100).toFixed(2)}
                </span>
              </div>
            )}
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <span className="text-[#D4AF37]/60 text-sm" data-testid="text-summary-shipping-label">
                  Fully Insured Return Shipping ({totals.shippingLabel})
                </span>
              </div>
              <span className="text-[#1A1A1A] font-medium text-sm ml-4 whitespace-nowrap" data-testid="text-summary-shipping">
                £{(totals.shipping / 100).toFixed(2)}
              </span>
            </div>
            {totals.totalInsuranceFee > 0 && (
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <span className="text-[#D4AF37]/60 text-sm" data-testid="text-summary-insurance-label">
                    Insurance Protection ({totals.insuranceSurchargeLabel})
                  </span>
                </div>
                <span className="text-[#1A1A1A] font-medium text-sm ml-4 whitespace-nowrap" data-testid="text-summary-insurance-fee">
                  £{(totals.totalInsuranceFee / 100).toFixed(2)}
                </span>
              </div>
            )}

            <div className="pl-1 space-y-1 mt-1">
              <div className="flex items-center gap-2 text-xs text-[#D4AF37]/50">
                <Check size={12} className="text-[#D4AF37]/60 flex-shrink-0" />
                <span>Fully insured return shipping</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#D4AF37]/50">
                <Check size={12} className="text-[#D4AF37]/60 flex-shrink-0" />
                <span>Signature required on delivery</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#D4AF37]/50">
                <Check size={12} className="text-[#D4AF37]/60 flex-shrink-0" />
                <span>Real-time status tracking</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#D4AF37]/50">
                <Check size={12} className="text-[#D4AF37]/60 flex-shrink-0" />
                <span>Secure intake scanning on arrival</span>
              </div>
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-[#D4AF37]/20">
              <span className="text-[#D4AF37] font-bold uppercase tracking-wider">Total</span>
              <span className="text-[#1A1A1A] font-bold text-xl" data-testid="text-summary-total">
                £{(totals.total / 100).toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Reveal Wrap */}
      <div className="max-w-md mx-auto mt-5">
        <label
          htmlFor="reveal-wrap"
          className={`flex items-start gap-3 border rounded-2xl p-4 cursor-pointer transition-all ${
            state.revealWrap
              ? "border-[#D4AF37] bg-[#D4AF37]/8"
              : "border-[#D4AF37]/25 hover:border-[#D4AF37]/50 bg-[#FAFAF8]"
          }`}
          data-testid="label-reveal-wrap"
        >
          <input
            type="checkbox"
            id="reveal-wrap"
            checked={state.revealWrap}
            onChange={(e) => setState({ ...state, revealWrap: e.target.checked })}
            className="mt-0.5 accent-[#D4AF37] shrink-0"
            data-testid="checkbox-reveal-wrap"
          />
          <div>
            <p className="text-[#1A1A1A] font-semibold text-sm">
              🎁 MintVault Reveal Wrap{" "}
              <span className="text-[#D4AF37] font-bold text-xs uppercase tracking-widest ml-1">Free</span>
            </p>
            <p className="text-[#666666] text-xs mt-1 leading-relaxed">
              Receive your slabs sealed in gold holographic foil — tear them open to reveal your grade like opening a pack. Perfect for filming unboxing content.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}

function Step4Shipping({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  return (
    <div>
      <h2 className="text-2xl font-sans font-black text-[#D4AF37] tracking-tight mb-2 text-center" data-testid="text-step4-title">
        Return Shipping & Details
      </h2>
      <p className="text-[#999999] text-center mb-6 text-sm">Where should we return your cards?</p>

      <div className="max-w-md mx-auto mb-5 flex items-start gap-2 border border-[#D4AF37]/20 rounded p-3 bg-[#D4AF37]/5" data-testid="text-shipping-notice">
        <Info size={14} className="text-[#D4AF37] flex-shrink-0 mt-0.5" />
        <span className="text-[#444444] text-xs leading-relaxed">
          Important: You are responsible for insured shipping to MintVault. Please use tracked and insured delivery appropriate to your declared item value.
        </span>
      </div>

      <div className="max-w-md mx-auto space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">First Name *</label>
            <input
              type="text"
              value={state.firstName}
              onChange={(e) => setState({ ...state, firstName: e.target.value })}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
              data-testid="input-first-name"
            />
          </div>
          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Last Name *</label>
            <input
              type="text"
              value={state.lastName}
              onChange={(e) => setState({ ...state, lastName: e.target.value })}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
              data-testid="input-last-name"
            />
          </div>
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Email *</label>
          <input
            type="email"
            value={state.email}
            onChange={(e) => setState({ ...state, email: e.target.value })}
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-email"
          />
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Phone (recommended)</label>
          <input
            type="tel"
            value={state.phone}
            onChange={(e) => setState({ ...state, phone: e.target.value })}
            placeholder="e.g. 07700 900000"
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-phone"
          />
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Address Line 1 *</label>
          <input
            type="text"
            value={state.addressLine1}
            onChange={(e) => setState({ ...state, addressLine1: e.target.value })}
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-address-1"
          />
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Address Line 2</label>
          <input
            type="text"
            value={state.addressLine2}
            onChange={(e) => setState({ ...state, addressLine2: e.target.value })}
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-address-2"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">City *</label>
            <input
              type="text"
              value={state.city}
              onChange={(e) => setState({ ...state, city: e.target.value })}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
              data-testid="input-city"
            />
          </div>
          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">County</label>
            <input
              type="text"
              value={state.county}
              onChange={(e) => setState({ ...state, county: e.target.value })}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
              data-testid="input-county"
            />
          </div>
        </div>

        <div className="max-w-[200px]">
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Postcode *</label>
          <input
            type="text"
            value={state.postcode}
            onChange={(e) => setState({ ...state, postcode: e.target.value })}
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-lg px-4 py-2.5 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]/60 transition-colors"
            data-testid="input-postcode"
          />
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Notes (optional)</label>
          <textarea
            value={state.notes}
            onChange={(e) => setState({ ...state, notes: e.target.value })}
            placeholder="Special instructions, handling notes, or anything else we should know..."
            rows={3}
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded-xl px-4 py-3 text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]/60 transition-colors resize-none"
            data-testid="input-notes"
          />
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[#D4AF37]/60 text-sm">{label}</span>
      <span className="text-[#1A1A1A] font-medium text-sm" data-testid={testId}>{value}</span>
    </div>
  );
}

function Step5Payment({ state, tier, onSuccess }: {
  state: WizardState;
  tier: PricingTier | undefined;
  onSuccess: (submissionId: string, packingSlipToken?: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState("");
  const [liabilityAccepted, setLiabilityAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const totals = calculateOrderTotals(tier?.pricePerCard || 0, state.quantity, state.declaredValue);

  const createPaymentMutation = useMutation({
    mutationFn: async () => {
      const crossoverCompanyFinal = state.type === "crossover"
        ? (state.crossoverCompany === "Other" ? state.crossoverCompanyOther : state.crossoverCompany)
        : undefined;
      const res = await apiRequest("POST", "/api/create-payment-intent", {
        type: state.type,
        tier: state.tier,
        quantity: state.quantity,
        declaredValue: state.declaredValue,
        notes: state.notes,
        submissionName: state.submissionName,
        email: state.email,
        firstName: state.firstName,
        lastName: state.lastName,
        phone: state.phone,
        cardItems: state.cardItems.length > 0 ? state.cardItems : undefined,
        liabilityAccepted: liabilityAccepted,
        termsAccepted: termsAccepted,
        shippingAddress: {
          line1: state.addressLine1,
          line2: state.addressLine2,
          city: state.city,
          county: state.county,
          postcode: state.postcode,
        },
        crossoverCompany: state.type === "crossover" ? (crossoverCompanyFinal || undefined) : undefined,
        crossoverOriginalGrade: state.type === "crossover" ? (state.crossoverOriginalGrade || undefined) : undefined,
        crossoverCertNumber: state.type === "crossover" ? (state.crossoverCertNumber || undefined) : undefined,
        reholderCompany: state.type === "reholder" ? (state.reholderCompany || undefined) : undefined,
        reholderReason: state.type === "reholder" ? (state.reholderReason || undefined) : undefined,
        reholderCondition: state.type === "reholder" ? (state.reholderCondition || undefined) : undefined,
        reholderCertNumber: state.type === "reholder" ? (state.reholderCertNumber || undefined) : undefined,
        authReason: state.type === "authentication" ? (state.authReason || undefined) : undefined,
        authConcerns: state.type === "authentication" ? (state.authConcerns || undefined) : undefined,
        revealWrap: state.revealWrap,
      });
      return res.json();
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!stripe || !elements) {
      setError("Payment system not ready. Please try again.");
      return;
    }

    try {
      const data = await createPaymentMutation.mutateAsync();

      const cardElement = elements.getElement(CardElement);
      if (!cardElement) {
        setError("Card element not found.");
        return;
      }

      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(data.clientSecret, {
        payment_method: {
          card: cardElement,
          billing_details: {
            email: state.email,
            name: `${state.firstName} ${state.lastName}`,
          },
        },
      });

      if (stripeError) {
        setError(stripeError.message || "Payment failed.");
        return;
      }

      if (paymentIntent?.status === "succeeded") {
        const confirmRes = await apiRequest("POST", "/api/confirm-payment", {
          submissionId: data.submissionId,
          paymentIntentId: paymentIntent.id,
        });
        const confirmData = await confirmRes.json();
        onSuccess(data.submissionId, confirmData.packingSlipToken);
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    }
  };

  const isPending = createPaymentMutation.isPending;

  return (
    <div>
      <h2 className="text-2xl font-sans font-black text-[#D4AF37] tracking-tight mb-2 text-center" data-testid="text-step5-title">
        Secure Payment
      </h2>
      <p className="text-[#1A1A1A]/50 text-center mb-8 text-sm">Complete your order</p>

      <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-5">
        <div className="border border-[#D4AF37]/20 rounded-2xl p-4 bg-[#D4AF37]/5 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-[#D4AF37]/60">Shipping to</span>
            <span className="text-[#1A1A1A]">{state.firstName} {state.lastName}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-[#D4AF37]/60">Address</span>
            <span className="text-[#1A1A1A] text-right">{state.addressLine1}, {state.city}, {state.postcode}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-[#D4AF37]/60">Email</span>
            <span className="text-[#1A1A1A]">{state.email}</span>
          </div>
        </div>

        <div className="flex items-start gap-2 border border-[#D4AF37]/20 rounded p-3 bg-[#D4AF37]/5">
          <input
            type="checkbox"
            id="confirm-address"
            required
            className="mt-1 accent-[#D4AF37]"
            data-testid="checkbox-confirm-address"
          />
          <label htmlFor="confirm-address" className="text-[#1A1A1A]/70 text-xs leading-relaxed cursor-pointer">
            I confirm the return address above is correct. MintVault will return cards to this address.
          </label>
        </div>

        <div className="flex items-start gap-2 border border-[#D4AF37]/20 rounded p-3 bg-[#D4AF37]/5">
          <input
            type="checkbox"
            id="liability-accept"
            checked={liabilityAccepted}
            onChange={(e) => setLiabilityAccepted(e.target.checked)}
            className="mt-1 accent-[#D4AF37]"
            data-testid="checkbox-liability"
          />
          <label htmlFor="liability-accept" className="text-[#1A1A1A]/70 text-xs leading-relaxed cursor-pointer">
            I confirm I have read and agree to the{" "}
            <Link href="/terms-and-conditions">
              <span className="text-[#D4AF37] underline">Liability & Shipping Policy</span>
            </Link>. I understand I am responsible for insured inbound shipping and that MintVault's liability is limited to the declared value of my submission.
          </label>
        </div>

        <div>
          <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-2">Card Details *</label>
          <div className="border border-[#D4AF37]/30 rounded-xl px-4 py-3" data-testid="card-element-wrapper">
            <CardElement
              options={{
                style: {
                  base: {
                    color: "#ffffff",
                    fontSize: "16px",
                    "::placeholder": { color: "rgba(212, 175, 55, 0.3)" },
                  },
                  invalid: { color: "#ef4444" },
                },
              }}
            />
          </div>
        </div>

        {error && (
          <p className="text-red-400 text-sm" data-testid="text-payment-error">{error}</p>
        )}

        <div className="flex items-start gap-2 border border-[#D4AF37]/20 rounded p-3 bg-[#D4AF37]/5">
          <input
            type="checkbox"
            id="terms-accept"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-1 accent-[#D4AF37]"
            data-testid="checkbox-terms"
          />
          <label htmlFor="terms-accept" className="text-[#1A1A1A]/70 text-xs leading-relaxed cursor-pointer">
            I confirm I have read and agree to the MintVault UK Ltd{" "}
            <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="text-[#D4AF37] underline">Terms & Conditions</a>
          </label>
        </div>

        <button
          type="submit"
          disabled={isPending || !stripe || !liabilityAccepted || !termsAccepted}
          className="gold-shimmer w-full py-3.5 rounded-xl font-black tracking-widest text-sm active:scale-95 transition-transform disabled:cursor-not-allowed flex items-center justify-center gap-2"
          data-testid="button-pay"
        >
          <CreditCard size={18} />
          {isPending ? "Processing..." : `Pay £${(totals.total / 100).toFixed(2)} Securely`}
        </button>
      </form>
    </div>
  );
}

const SERVICE_TYPE_OPTIONS = [
  {
    id: "grading",
    name: "Grading",
    desc: "Grade your raw cards with MintVault.",
    detail: "Get a professional condition grade from 1–10 for your raw trading cards.",
  },
  {
    id: "reholder",
    name: "Reholder",
    desc: "Upgrade your existing MintVault slab.",
    detail: "Transfer a previously graded MintVault card into a brand new premium slab.",
  },
  {
    id: "crossover",
    name: "Crossover",
    desc: "Move cards graded by another company into MintVault.",
    detail: "Submit cards already graded by PSA, BGS, CGC, ACE or others for MintVault crossover. Subject to review.",
  },
  {
    id: "authentication",
    name: "Authentication",
    desc: "Verify your card is genuine without grading.",
    detail: "Get an official certificate confirming your card is authentic without a condition grade.",
  },
];

function TypeSelector({ onSelect }: { onSelect: (type: string) => void }) {
  return (
    <div className="px-4 py-8 max-w-2xl mx-auto min-h-screen bg-white">
      <SeoHead
        title="Submit Cards | MintVault UK"
        description="Submit your trading cards for professional grading. Choose your service tier, enter card details, and pay securely online."
        canonical="https://mintvaultuk.com/submit"
      />
      <div className="text-center mb-8">
        <h1 className="text-2xl font-sans font-black text-[#1A1A1A] tracking-tight mb-2">
          Choose a <span className="text-[#D4AF37]">Service</span>
        </h1>
        <p className="text-[#1A1A1A]/50 text-sm">Select the type of submission you'd like to make</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SERVICE_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onSelect(opt.id)}
            className="border border-[#D4AF37]/20 hover:border-[#D4AF37]/60 bg-[#FAFAF8] hover:bg-[#D4AF37]/5 rounded-2xl p-5 text-left transition-all group"
            data-testid={`button-type-${opt.id}`}
          >
            <h3 className="text-[#D4AF37] font-black text-lg tracking-tighter mb-1">
              {opt.name}
            </h3>
            <p className="text-[#1A1A1A]/70 text-sm font-medium mb-2">{opt.desc}</p>
            <p className="text-[#1A1A1A]/40 text-xs leading-relaxed">{opt.detail}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function SubmitWizardInner() {
  const [step, setStep] = useState(1);
  const [, navigate] = useLocation();

  const searchParams = new URLSearchParams(window.location.search);
  const urlType = searchParams.get("type") || searchParams.get("service") || "";
  const urlTier = searchParams.get("tier") || searchParams.get("service") || "";

  const validTypes = ["grading", "reholder", "crossover", "authentication"];
  const resolvedType = validTypes.includes(urlType) ? urlType : "";
  // For ancillary services the tier ID matches the type ID; for grading default to "standard"
  const resolvedTier = urlTier || (resolvedType === "grading" ? "standard" : resolvedType);

  const defaultState: WizardState = {
    type: resolvedType,
    tier: resolvedTier,
    quantity: 0,
    declaredValue: 0,
    submissionName: "",
    notes: "",
    email: "",
    phone: "",
    firstName: "",
    lastName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    county: "",
    postcode: "",
    cardItems: [],
    crossoverCompany: "",
    crossoverCompanyOther: "",
    crossoverOriginalGrade: "",
    crossoverCertNumber: "",
    reholderCompany: "",
    reholderReason: "",
    reholderCondition: "",
    reholderCertNumber: "",
    authReason: "",
    authConcerns: "",
    revealWrap: false,
  };

  const [state, setState] = useState<WizardState>(() => {
    const saved = loadWizardState();
    if (saved) {
      return {
        ...defaultState,
        ...saved,
        // Never restore type from localStorage — always require the user to choose a service
        // on a fresh visit. Type can still be set via URL param (?type=reholder etc.)
        type: resolvedType,
        tier: resolvedType ? (urlTier || saved.tier) : resolvedTier,
      };
    }
    return defaultState;
  });

  useEffect(() => {
    saveWizardState(state);
  }, [state]);

  const serviceType = state.type;
  const { data: fetchedTiers } = useQuery<PricingTier[]>({
    queryKey: ["/api/service-tiers", serviceType],
    queryFn: async () => {
      const res = await fetch(`/api/service-tiers?serviceType=${serviceType}`);
      if (!res.ok) throw new Error("Failed to fetch tiers");
      return res.json();
    },
    enabled: !!serviceType,
  });

  const activeTiers = fetchedTiers || pricingTiers;

  // Capacity data — used to grey out full tiers on step 1
  const { data: capacityData } = useQuery<Record<string, { active: number; max: number; full: boolean; forceOpen: boolean }>>({
    queryKey: ["/api/capacity"],
    queryFn: async () => {
      const res = await fetch("/api/capacity");
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 1000 * 30, // 30 s matches server-side cache
  });

  useEffect(() => {
    if (urlTier && activeTiers.some((t) => t.id === urlTier)) {
      setState((s) => ({ ...s, tier: urlTier }));
    }
  }, [urlTier, activeTiers]);

  useEffect(() => {
    if (state.tier && activeTiers.length > 0 && !activeTiers.some(t => t.id === state.tier)) {
      setState((s) => ({ ...s, tier: "" }));
    }
  }, [state.type, activeTiers]);

  const selectedTier = activeTiers.find((t) => t.id === state.tier);

  const canNext = () => {
    switch (step) {
      case 1: return !!state.tier;
      case 2: {
        if (state.quantity <= 0 || state.declaredValue <= 0) return false;
        if (state.type === "crossover") {
          const company = state.crossoverCompany === "Other" ? state.crossoverCompanyOther.trim() : state.crossoverCompany;
          if (!company) return false;
        }
        if (state.type === "reholder") {
          if (!state.reholderCompany || !state.reholderReason) return false;
        }
        if (state.type === "authentication") {
          if (!state.authReason) return false;
        }
        return true;
      }
      case 3: return true;
      case 4: return !!state.email && !!state.firstName && !!state.lastName && !!state.addressLine1 && !!state.city && !!state.postcode;
      default: return false;
    }
  };

  const handleSuccess = (submissionId: string, packingSlipToken?: string) => {
    clearWizardState();
    const tokenParam = packingSlipToken ? `&pstoken=${packingSlipToken}` : "";
    navigate(`/submit/success?id=${submissionId}${tokenParam}`);
  };

  const typeName = submissionTypes.find(t => t.id === state.type)?.name || state.type;

  if (!state.type) {
    return <TypeSelector onSelect={(type) => setState((s) => ({
      ...s,
      type,
      tier: "",
      crossoverCompany: "",
      crossoverCompanyOther: "",
      crossoverOriginalGrade: "",
      crossoverCertNumber: "",
    }))} />;
  }

  return (
    <div className="px-4 py-8 max-w-2xl mx-auto min-h-screen bg-white">
      <div className="text-center mb-2">
        <span className="text-[#D4AF37]/60 text-xs uppercase tracking-widest" data-testid="text-service-badge">
          {typeName} Submission
        </span>
      </div>

      <StepIndicator step={step} accentColor={gameAccentColor(state.cardItems.find(c => c.game)?.game ?? "")} />

      {step === 1 && <Step1Tier state={state} setState={setState} tiers={activeTiers} capacity={capacityData} />}
      {step === 2 && <Step2Cards state={state} setState={setState} />}
      {step === 3 && <Step3Review state={state} setState={setState} tier={selectedTier} />}
      {step === 4 && <Step4Shipping state={state} setState={setState} />}
      {step === 5 && <Step5Payment state={state} tier={selectedTier} onSuccess={handleSuccess} />}

      <div className="flex justify-between mt-8 max-w-md mx-auto">
        {step > 1 && step < 5 && (
          <button
            onClick={() => setStep(step - 1)}
            className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors"
            data-testid="button-back"
          >
            <ArrowLeft size={16} /> Back
          </button>
        )}
        {step === 5 && (
          <button
            onClick={() => setStep(4)}
            className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors"
            data-testid="button-back"
          >
            <ArrowLeft size={16} /> Back
          </button>
        )}

        {step < 4 && (
          <button
            onClick={() => canNext() && setStep(step + 1)}
            disabled={!canNext()}
            className="gold-shimmer ml-auto flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-black tracking-widest text-sm active:scale-95 transition-transform disabled:cursor-not-allowed"
            data-testid="button-next"
          >
            Next <ArrowRight size={16} />
          </button>
        )}

        {step === 4 && (
          <button
            onClick={() => canNext() && setStep(5)}
            disabled={!canNext()}
            className="gold-shimmer ml-auto flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-black tracking-widest text-sm active:scale-95 transition-transform disabled:cursor-not-allowed"
            data-testid="button-proceed-payment"
          >
            Proceed to Payment <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function SubmitPage() {
  const { data, isLoading } = useQuery<{ publishableKey: string }>({
    queryKey: ["/api/stripe/publishable-key"],
  });

  if (isLoading || !data?.publishableKey) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#D4AF37]/10 rounded w-48 mx-auto" />
          <div className="h-4 bg-[#D4AF37]/10 rounded w-32 mx-auto" />
        </div>
      </div>
    );
  }

  const stripePromise = loadStripe(data.publishableKey);

  return (
    <Elements stripe={stripePromise}>
      <SubmitWizardInner />
    </Elements>
  );
}

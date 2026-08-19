import { useState } from "react";
import { ArrowRight, Building2, CheckCircle2, ChevronDown, CircleAlert, ShieldCheck, Store, Users } from "lucide-react";
import SeoHead from "@/components/seo-head";
import GradientButton from "@/components/ui/gradient-button";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { apiRequest } from "@/lib/queryClient";

const businessTypes = [
  ["tcg_card_shop", "TCG / card shop"],
  ["collectibles_retailer", "Collectibles retailer"],
  ["hobby_store", "Hobby store"],
  ["online_retailer", "Established online retailer"],
  ["other", "Other trading-card business"],
] as const;

const categories = ["Pokemon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Sports", "Other"];

type FormState = {
  businessName: string;
  contactName: string;
  email: string;
  city: string;
  postcode: string;
  businessType: string;
  webPresence: string;
  interestReason: string;
  phone: string;
  physicalRetail: "" | "yes" | "no";
  categories: string[];
  demandBand: string;
  existingGradingSubmissions: "" | "yes" | "no" | "not_currently";
  privacyAcknowledged: boolean;
  marketingOptIn: boolean;
};

const initialForm: FormState = {
  businessName: "",
  contactName: "",
  email: "",
  city: "",
  postcode: "",
  businessType: "",
  webPresence: "",
  interestReason: "",
  phone: "",
  physicalRetail: "",
  categories: [],
  demandBand: "",
  existingGradingSubmissions: "",
  privacyAcknowledged: false,
  marketingOptIn: false,
};

function pageAttribution() {
  const params = new URLSearchParams(window.location.search);
  return {
    route: window.location.pathname,
    utmSource: params.get("utm_source") || undefined,
    utmMedium: params.get("utm_medium") || undefined,
    utmCampaign: params.get("utm_campaign") || undefined,
    utmContent: params.get("utm_content") || undefined,
    referrer: document.referrer || undefined,
  };
}

export default function PartnersPage() {
  const { partnerApplicationsLive } = useFeatureFlags();
  const pageTitle = partnerApplicationsLive ? "Founding Partner Applications | MintVault UK" : "MintVault Partner Programme | MintVault UK";
  const pageDescription = partnerApplicationsLive
    ? "UK TCG and collectibles retailers can register interest in MintVault’s first Partner rollout. Applications are reviewed before onboarding or operational readiness."
    : "MintVault is preparing the first Partner rollout for selected UK TCG and collectibles retailers. Applications will open after the public privacy notice is available.";
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);

  const update = (field: keyof FormState, value: string | boolean | string[]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const toggleCategory = (category: string) => {
    setForm((current) => ({
      ...current,
      categories: current.categories.includes(category)
        ? current.categories.filter((entry) => entry !== category)
        : [...current.categories, category],
    }));
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!partnerApplicationsLive) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiRequest("POST", "/api/partner-applications", {
        ...form,
        physicalRetail: form.physicalRetail === "" ? undefined : form.physicalRetail === "yes",
        demandBand: form.demandBand || undefined,
        existingGradingSubmissions: form.existingGradingSubmissions || undefined,
        attribution: pageAttribution(),
      });
      const body = (await response.json()) as { leadId?: string };
      if (!body.leadId) throw new Error("No application reference was returned");
      setLeadId(body.leadId);
    } catch {
      setError("We couldn't send your application. Please check the form and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <SeoHead
        title={pageTitle}
        description={pageDescription}
        canonical="/partners"
        noindex={!partnerApplicationsLive}
      />

      <section className="overflow-hidden bg-[#0B0B0C] text-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-16 md:grid-cols-[1.1fr_0.9fr] md:py-24">
          <div className="max-w-3xl">
            <p className="mb-5 text-xs font-bold uppercase tracking-[0.24em] text-[#D4AF37]">MintVault Partner Network</p>
            <h1 className="text-4xl font-black leading-[1.04] tracking-tight md:text-6xl">Founding Partner applications</h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/72 md:text-xl">
              {partnerApplicationsLive
                ? "Applications are open for selected UK trading-card and collectibles retailers interested in MintVault’s first Partner rollout."
                : "MintVault is preparing the first Partner rollout for selected UK trading-card and collectibles retailers."}
            </p>
            <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/58">
              {partnerApplicationsLive
                ? "This is an expression of interest, not an operating account. MintVault reviews suitability before any approval, onboarding, station readiness or operational launch."
                : "Applications will open once the public privacy notice for this process is available. No business details are collected before then."}
            </p>
            <a href="#apply" className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#D4AF37] px-6 py-3 text-sm font-bold text-black transition hover:bg-[#E5C44B]">
              {partnerApplicationsLive ? "Apply to become a Founding Partner" : "Partner programme update"} <ArrowRight size={16} />
            </a>
          </div>
          <div className="rounded-3xl border border-[#D4AF37]/30 bg-white/[0.04] p-7 backdrop-blur md:p-9">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#D4AF37]">The opportunity</p>
            <div className="mt-7 space-y-6">
              {[
                [Store, "Give customers a local route into MintVault grading."],
                [ShieldCheck, "Use MintVault’s grading, evidence and certificate-verification infrastructure."],
                [Users, "Create another reason for collectors to return to your shop."],
              ].map(([Icon, copy]) => {
                const FeatureIcon = Icon as typeof Store;
                return <div key={copy as string} className="flex gap-4"><FeatureIcon className="mt-0.5 shrink-0 text-[#D4AF37]" size={20} /><p className="text-sm leading-relaxed text-white/75">{copy as string}</p></div>;
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#FAFAF8] px-6 py-16 md:py-24">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 md:grid-cols-3">
            {[
              ["Built for retailers", "TCG/card shops, collectibles retailers, hobby stores and established online retailers with genuine trading-card activity."],
              ["Backed by MintVault", "A clear customer route to MintVault grading, supported by the grading workflow, evidence, verification and population information already built into MintVault."],
              ["A measured rollout", "Applications are reviewed for fit. Approved applicants move into onboarding only when a rollout slot and operational readiness allow it."],
            ].map(([title, copy]) => (
              <article key={title} className="rounded-2xl border border-[#E8E4DC] bg-white p-7 shadow-sm">
                <Building2 className="text-[#B8960C]" size={21} />
                <h2 className="mt-5 text-xl font-black text-[#1A1A1A]">{title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-[#606060]">{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white px-6 py-16 md:py-24">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#B8960C]">What happens next</p>
            <h2 className="mt-4 text-3xl font-black tracking-tight text-[#1A1A1A]">A simple first conversation.</h2>
            <ol className="mt-8 space-y-5">
              {["Apply with a few details about your business.", "MintVault reviews your shop’s fit for the first rollout.", "Suitable applicants are contacted when an onboarding and readiness path is available."].map((step, index) => (
                <li key={step} className="flex gap-4 text-sm leading-relaxed text-[#565656]"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#FFF4C8] text-xs font-black text-[#946F00]">{index + 1}</span>{step}</li>
              ))}
            </ol>
          </div>

          <div id="apply" className="scroll-mt-8 rounded-3xl border border-[#E8E4DC] bg-[#FAFAF8] p-6 md:p-9">
            {leadId ? (
              <div className="py-8 text-center" data-testid="partner-application-success">
                <CheckCircle2 className="mx-auto text-[#6B8E23]" size={42} />
                <h2 className="mt-5 text-2xl font-black text-[#1A1A1A]">Application received</h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#5E5E5E]">Thank you. MintVault will review your application before any next step. Submitting this form does not create a Partner account or confirm approval.</p>
                <p className="mt-5 text-xs font-bold uppercase tracking-wider text-[#8A6A00]">Reference {leadId}</p>
              </div>
            ) : !partnerApplicationsLive ? (
              <div className="py-7" data-testid="partner-application-unavailable">
                <CircleAlert className="text-[#B8960C]" size={28} />
                <h2 className="mt-4 text-2xl font-black text-[#1A1A1A]">Applications are preparing to open</h2>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-[#5E5E5E]">MintVault is finalising the public privacy notice for this application process. No business details are collected until that notice is available.</p>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-5" data-testid="partner-application-form">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#B8960C]">Apply now</p>
                  <h2 className="mt-2 text-2xl font-black text-[#1A1A1A]">Tell us about your shop</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#5E5E5E]">We only use these details to review your Partner application. Marketing is optional and never implied. Submitting an application does not create a Partner account or confirm approval.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Business / shop name"><input required value={form.businessName} onChange={(e) => update("businessName", e.target.value)} autoComplete="organization" /></Field>
                  <Field label="Your name"><input required value={form.contactName} onChange={(e) => update("contactName", e.target.value)} autoComplete="name" /></Field>
                  <Field label="Business email"><input required type="email" value={form.email} onChange={(e) => update("email", e.target.value)} autoComplete="email" /></Field>
                  <Field label="Phone (optional)"><input value={form.phone} onChange={(e) => update("phone", e.target.value)} autoComplete="tel" /></Field>
                  <Field label="Town / city"><input required value={form.city} onChange={(e) => update("city", e.target.value)} autoComplete="address-level2" /></Field>
                  <Field label="Postcode"><input required value={form.postcode} onChange={(e) => update("postcode", e.target.value)} autoComplete="postal-code" /></Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Business type"><select required value={form.businessType} onChange={(e) => update("businessType", e.target.value)}><option value="">Select one</option>{businessTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label="Website or primary business social profile"><input required type="url" placeholder="https://" value={form.webPresence} onChange={(e) => update("webPresence", e.target.value)} /></Field>
                </div>
                <Field label="Why is your shop interested in the MintVault Partner programme?"><textarea required minLength={20} rows={4} value={form.interestReason} onChange={(e) => update("interestReason", e.target.value)} /></Field>
                <details className="rounded-xl border border-[#E8E4DC] bg-white px-4 py-3"><summary className="flex cursor-pointer list-none items-center justify-between text-sm font-bold text-[#2B2B2B]">Optional qualification details <ChevronDown size={16} /></summary><div className="mt-5 space-y-5">
                  <Field label="Do you have a physical retail location?"><select value={form.physicalRetail} onChange={(e) => update("physicalRetail", e.target.value)}><option value="">Prefer not to say</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
                  <fieldset><legend className="mb-2 block text-xs font-bold uppercase tracking-wider text-[#727272]">Categories you sell</legend><div className="flex flex-wrap gap-2">{categories.map((category) => <label key={category} className="cursor-pointer rounded-full border border-[#DED9CE] bg-white px-3 py-1.5 text-xs text-[#444]"><input className="mr-1.5" type="checkbox" checked={form.categories.includes(category)} onChange={() => toggleCategory(category)} />{category}</label>)}</div></fieldset>
                  <div className="grid gap-4 sm:grid-cols-2"><Field label="Approximate grading demand"><select value={form.demandBand} onChange={(e) => update("demandBand", e.target.value)}><option value="">Prefer not to say</option><option value="exploring">Just exploring</option><option value="under_25">Under 25 cards/month</option><option value="25_50">25–50 cards/month</option><option value="51_100">51–100 cards/month</option><option value="101_250">101–250 cards/month</option><option value="250_plus">250+ cards/month</option></select></Field><Field label="Do you currently offer grading submissions?"><select value={form.existingGradingSubmissions} onChange={(e) => update("existingGradingSubmissions", e.target.value)}><option value="">Prefer not to say</option><option value="yes">Yes</option><option value="no">No</option><option value="not_currently">Not currently</option></select></Field></div>
                </div></details>
                <label className="flex items-start gap-3 text-sm leading-relaxed text-[#4F4F4F]"><input required className="mt-1" type="checkbox" checked={form.privacyAcknowledged} onChange={(e) => update("privacyAcknowledged", e.target.checked)} /> <span>I confirm MintVault may use these details to review and follow up on this application, as explained in the <a className="font-semibold text-[#946F00] underline" href="/legal/privacy-policy">Privacy Policy</a>.</span></label>
                <label className="flex items-start gap-3 text-sm leading-relaxed text-[#4F4F4F]"><input className="mt-1" type="checkbox" checked={form.marketingOptIn} onChange={(e) => update("marketingOptIn", e.target.checked)} /> <span>Optional: I’d like to receive Partner programme updates by email. This is separate from reviewing my application.</span></label>
                {error ? <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="partner-application-error">{error}</p> : null}
                <GradientButton as="button" type="submit" disabled={submitting} height="50px" className="gradient-btn-filled w-full">{submitting ? "Sending application…" : "Apply to become a Founding Partner"}</GradientButton>
              </form>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wider text-[#727272] [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-[#DED9CE] [&_input]:bg-white [&_input]:px-3 [&_input]:py-3 [&_input]:text-sm [&_input]:font-normal [&_input]:normal-case [&_input]:tracking-normal [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-[#DED9CE] [&_select]:bg-white [&_select]:px-3 [&_select]:py-3 [&_select]:text-sm [&_select]:font-normal [&_select]:normal-case [&_select]:tracking-normal [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-[#DED9CE] [&_textarea]:bg-white [&_textarea]:px-3 [&_textarea]:py-3 [&_textarea]:text-sm [&_textarea]:font-normal [&_textarea]:normal-case [&_textarea]:tracking-normal">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

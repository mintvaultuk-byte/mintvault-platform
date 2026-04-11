import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CertificateRecord, CardMaster } from "@shared/schema";
import { NUMERIC_GRADES, NON_NUMERIC_GRADES, isNonNumericGrade } from "@shared/schema";
import { Save, Upload, Search, Check, AlertTriangle, X, ChevronDown, HelpCircle, Link2, FileText, Plus, Cpu, Loader2, CheckCircle2, Trash2, RefreshCw } from "lucide-react";
import { autofillCard, type AutofillResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { mapRarityTextToCode } from "@/lib/rarityOptions";
import { mapVariantTextToCode } from "@/lib/variantOptions";
import { UNIFIED_OPTIONS, parseUnifiedValue, buildUnifiedValue, buildOtherText, getUnifiedDisplayLabel, type UnifiedOption } from "@/lib/unifiedCardOptions";
import { DESIGNATION_OPTIONS, getDesignationLabel } from "@/lib/designationOptions";

interface Props {
  certificate: CertificateRecord | null;
  onSuccess: (newCert?: any) => void;
}

const cardGames = [
  "Pokémon", "Yu-Gi-Oh!", "Magic: The Gathering", "Dragon Ball Super",
  "One Piece", "Digimon", "Flesh and Blood", "Lorcana",
  "Panini", "Topps", "Upper Deck", "Other",
];

const AUTOFILL_FIELDS = ["cardName", "rarity", "variant", "year"] as const;

const PRESET_NOTES = [
  "Minor edge softening",
  "Slight off-centering",
  "Light corner wear",
  "Surface print line present",
  "Minor whitening visible",
  "Strong gloss retention",
  "Clean surface presentation",
  "No visible creasing",
  "Minor holo scratching",
  "Excellent overall eye appeal",
];

const NOTE_TEMPLATES: { label: string; text: string }[] = [
  {
    label: "Gem Mint",
    text: "Strong gloss retention\nClean surface presentation\nNo visible creasing\nExcellent overall eye appeal",
  },
  {
    label: "Mint",
    text: "Strong gloss retention\nClean surface presentation\nNo visible creasing",
  },
  {
    label: "Near Mint",
    text: "Minor edge softening\nLight corner wear\nStrong gloss retention",
  },
  {
    label: "Authentic",
    text: "Card verified as genuine.\nNo physical alterations detected.\nAuthenticity confirmed by MintVault UK.",
  },
];
type AutofillField = typeof AUTOFILL_FIELDS[number];
type ProtectedField = AutofillField | "designations";

export default function CertificateForm({ certificate, onSuccess }: Props) {
  const isEdit = !!certificate;
  const { toast } = useToast();

  const initRarity = certificate?.rarity || "";
  const initVariant = certificate?.variant || "";
  const initCollCode = (certificate as any)?.collectionCode || "";
  const initRarityOther = (certificate as any)?.rarityOther || "";
  const initVariantOther = (certificate as any)?.variantOther || "";
  const initCollOther = (certificate as any)?.collectionOther || "";

  const [form, setForm] = useState({
    gradeType: (certificate as any)?.gradeType || "numeric",
    serviceTier: "",
    submissionItemId: (certificate as any)?.submissionItemId || "",
    cardGame: certificate?.cardGame || "",
    setName: certificate?.setName || "",
    cardName: (certificate?.cardName === "(untitled)" || certificate?.cardName === "(pending)") ? "" : (certificate?.cardName || ""),
    cardNumber: certificate?.cardNumber || "",
    rarity: initRarity,
    rarityOther: initRarityOther,
    collectionCode: initCollCode,
    collectionOther: initCollOther,
    variant: initVariant,
    variantOther: initVariantOther,
    unifiedSelect: buildUnifiedValue(initRarity, initVariant, initCollCode, initRarityOther, initVariantOther, initCollOther),
    otherText: buildOtherText(initRarityOther, initVariantOther, initCollOther),
    language: certificate?.language || "English",
    year: certificate?.year || "",
    notes: certificate?.notes || "",
    gradeOverall: certificate?.gradeOverall || "",
    labelType: (certificate as any)?.labelType || "standard",
    status: certificate?.status || "active",
  });

  const [designations, setDesignations] = useState<string[]>(
    () => (certificate?.designations as string[]) || []
  );

  // Sync form state when the cert prop changes (e.g. after AI autofill refetches the cert)
  // Only overwrite fields that are currently empty — never stomp manual edits
  useEffect(() => {
    if (!certificate) return;
    const isEmpty = (v: any) => v === null || v === undefined || v === "" || v === "(pending)" || v === "(untitled)";
    const normalizeYear = (v: any): string => {
      if (!v) return "";
      const m = String(v).match(/\d{4}/);
      return m ? m[0] : "";
    };
    const clean = (v: any) => isEmpty(v) ? "" : String(v);

    setForm(prev => {
      let changed = false;
      const next = { ...prev };
      const cn = clean(certificate.cardName);
      const yr = normalizeYear(certificate.year);
      if (isEmpty(prev.cardName) && cn)             { next.cardName = cn; changed = true; }
      if (isEmpty(prev.setName) && clean(certificate.setName))  { next.setName = clean(certificate.setName); changed = true; }
      if (isEmpty(prev.cardNumber) && clean(certificate.cardNumber)) { next.cardNumber = clean(certificate.cardNumber); changed = true; }
      if (isEmpty(prev.year) && yr)                  { next.year = yr; changed = true; }
      if (isEmpty(prev.cardGame) && clean(certificate.cardGame)) { next.cardGame = clean(certificate.cardGame); changed = true; }
      if (isEmpty(prev.language) && clean(certificate.language)) { next.language = clean(certificate.language); changed = true; }
      if (isEmpty(prev.rarity) && clean((certificate as any)?.rarity)) { next.rarity = clean((certificate as any).rarity); changed = true; }
      if (isEmpty(prev.variant) && clean((certificate as any)?.variant)) { next.variant = clean((certificate as any).variant); changed = true; }
      if (isEmpty(prev.gradeOverall) && certificate.gradeOverall) { next.gradeOverall = certificate.gradeOverall; changed = true; }
      if (changed) toast({ title: "Card details auto-filled from AI" });
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [certificate?.cardName, certificate?.setName, certificate?.cardNumber, certificate?.year]);

  const isNonNum = isNonNumericGrade(form.gradeType);

  const [frontImage, setFrontImage] = useState<File | null>(null);
  const [backImage, setBackImage] = useState<File | null>(null);
  const [error, setError] = useState("");

  const [autofillLoading, setAutofillLoading] = useState(false);
  const [autofillRan, setAutofillRan] = useState(false);

  // AI Identify-only state
  const [identifyLoading, setIdentifyLoading] = useState(false);
  const [identifyConfidence, setIdentifyConfidence] = useState<string | null>(null);
  const [identifyVerified, setIdentifyVerified] = useState(false);

  async function runIdentifyOnly() {
    if (!isEdit || !certificate?.id) return;
    setIdentifyLoading(true);
    setIdentifyConfidence(null);
    try {
      const res = await fetch(`/api/admin/certificates/${certificate.id}/identify-only`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Identification failed");

      setIdentifyConfidence(data.confidence);
      setIdentifyVerified(data.tcgVerified);

      if (data.detailsWritten && data.cert) {
        // Directly update form fields from the returned cert
        const c = data.cert;
        const isEmpty = (v: any) => !v || v === "" || v === "(pending)" || v === "(untitled)";
        const yearMatch = String(c.year || "").match(/\d{4}/);
        setForm(prev => ({
          ...prev,
          cardName: isEmpty(prev.cardName) ? (c.cardName || prev.cardName) : prev.cardName,
          setName: isEmpty(prev.setName) ? (c.setName || prev.setName) : prev.setName,
          cardNumber: isEmpty(prev.cardNumber) ? (c.cardNumber || prev.cardNumber) : prev.cardNumber,
          year: isEmpty(prev.year) ? (yearMatch ? yearMatch[0] : prev.year) : prev.year,
          cardGame: isEmpty(prev.cardGame) ? (c.cardGame || prev.cardGame) : prev.cardGame,
          rarity: isEmpty(prev.rarity) ? (c.rarity || prev.rarity) : prev.rarity,
          language: isEmpty(prev.language) ? (c.language || prev.language) : prev.language,
        }));
        toast({ title: "Card identified", description: `${data.identification?.officialName || data.identification?.detected_name || "Card"} — ${data.identification?.officialSet || data.identification?.detected_set || "Unknown set"}` });
      } else {
        toast({ title: "Couldn't identify confidently", description: data.rejectReason || "Please fill in card details manually", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Identification failed", description: e.message, variant: "destructive" });
    } finally {
      setIdentifyLoading(false);
    }
  }
  const [manuallyEdited, setManuallyEdited] = useState<Set<ProtectedField>>(new Set());
  const [suggestions, setSuggestions] = useState<CardMaster[]>([]);
  const [fallbackMatch, setFallbackMatch] = useState<CardMaster | null>(null);
  const [fallbackSetName, setFallbackSetName] = useState<string | null>(null);
  const [overwriteConfirm, setOverwriteConfirm] = useState<{ fields: ProtectedField[]; card: CardMaster; setName: string | null } | null>(null);
  const [unifiedSearch, setUnifiedSearch] = useState("");
  const [unifiedOpen, setUnifiedOpen] = useState(false);
  const unifiedRef = useRef<HTMLDivElement>(null);

  const [customVariants, setCustomVariants] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("mv-custom-variants") || "[]"); }
    catch { return []; }
  });

  const { data: dbVariants = [] } = useQuery<string[]>({
    queryKey: ["/api/admin/variant-options"],
    staleTime: 60_000,
  });

  const { data: dbRarityOthers = [] } = useQuery<string[]>({
    queryKey: ["/api/admin/rarity-other-options"],
    staleTime: 60_000,
  });
  const [languageChangedByFallback, setLanguageChangedByFallback] = useState(false);

  const [setId, setSetId] = useState("");

  // ── Build 1: Grading image upload state ──────────────────────────────────
  const [gradingImages, setGradingImages] = useState<{ front?: File; back?: File; angled?: File; closeup?: File }>({});
  const [gradingUploading, setGradingUploading] = useState(false);
  const [gradingUploadDone, setGradingUploadDone] = useState(false);
  const [gradingQuality, setGradingQuality] = useState<Record<string, any>>({});
  const [gradingUrls, setGradingUrls] = useState<Record<string, string | null>>({});
  const [cardLookupQuery, setCardLookupQuery] = useState("");
  const [cardLookupGame, setCardLookupGame] = useState("pokemon");
  const [cardLookupResults, setCardLookupResults] = useState<any[]>([]);
  const [cardLookupLoading, setCardLookupLoading] = useState(false);

  async function uploadGradingImages() {
    if (!isEdit || !certificate?.id) return;
    if (!gradingImages.front && !gradingImages.back) {
      toast({ title: "Upload required", description: "Please add at least a front image.", variant: "destructive" });
      return;
    }
    setGradingUploading(true);
    try {
      const fd = new FormData();
      if (gradingImages.front)   fd.append("front",   gradingImages.front);
      if (gradingImages.back)    fd.append("back",    gradingImages.back);
      if (gradingImages.angled)  fd.append("angled",  gradingImages.angled);
      if (gradingImages.closeup) fd.append("closeup", gradingImages.closeup);
      const res = await fetch(`/api/admin/certificates/${certificate.id}/upload-images`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setGradingUrls(data.urls || {});
      setGradingQuality(data.quality || {});
      setGradingUploadDone(true);
      toast({ title: "Images uploaded", description: "Variants are being generated in the background." });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setGradingUploading(false);
    }
  }

  async function runCardLookup() {
    if (!cardLookupQuery.trim()) return;
    setCardLookupLoading(true);
    setCardLookupResults([]);
    try {
      const params = new URLSearchParams({ game: cardLookupGame, query: cardLookupQuery });
      const res = await fetch(`/api/admin/card-lookup?${params}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lookup failed");
      setCardLookupResults(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast({ title: "Card lookup failed", description: e.message, variant: "destructive" });
    } finally {
      setCardLookupLoading(false);
    }
  }

  // ── AI Grading state ──────────────────────────────────────────────────────
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiAnalysis, setAiAnalysis] = useState<any>(null);
  const [aiDraft, setAiDraft] = useState<{centering: string; corners: string; edges: string; surface: string; overall: string}>({ centering: "", corners: "", edges: "", surface: "", overall: "" });
  const [aiDefects, setAiDefects] = useState<any[]>([]);
  const [approveLoading, setApproveLoading] = useState(false);
  const [approved, setApproved] = useState(false);

  async function runAiAnalysis() {
    if (!isEdit || !certificate?.id) return;
    setAiLoading(true);
    setAiError("");
    setAiAnalysis(null);
    try {
      const res = await fetch(`/api/admin/certificates/${certificate.id}/analyze`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      const a = data.analysis;
      setAiAnalysis(a);
      setAiDraft({
        centering: String(a.centering?.subgrade ?? ""),
        corners:   String(a.corners?.subgrade   ?? ""),
        edges:     String(a.edges?.subgrade      ?? ""),
        surface:   String(a.surface?.subgrade    ?? ""),
        overall:   String(a.overall_grade         ?? ""),
      });
      setAiDefects(a.defects || []);
    } catch (e: any) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }

  async function approveGrade() {
    if (!isEdit || !certificate?.id) return;
    setApproveLoading(true);
    try {
      const res = await fetch(`/api/admin/certificates/${certificate.id}/approve-grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...aiDraft, gradeType: form.gradeType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approve failed");
      setApproved(true);
      // Update the form's grade fields to reflect the approved grade
      updateField("gradeOverall", aiDraft.overall);
    } catch (e: any) {
      setAiError(e.message);
    } finally {
      setApproveLoading(false);
    }
  }

  function subgradeColor(val: string): string {
    const n = parseFloat(val);
    if (isNaN(n)) return "#999999";
    if (n >= 10) return "#D4AF37";
    if (n >= 9)  return "#16A34A";
    if (n >= 7)  return "#CA8A04";
    return "#DC2626";
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      const UI_ONLY_KEYS = ["unifiedSelect", "otherText"];
      Object.entries(form).forEach(([key, value]) => {
        if (UI_ONLY_KEYS.includes(key)) return;
        if (value !== null && value !== undefined) {
          formData.append(key, String(value));
        }
      });
      formData.append("designations", JSON.stringify(designations));
      if (frontImage) formData.append("frontImage", frontImage);
      if (backImage) formData.append("backImage", backImage);

      const url = isEdit
        ? `/api/admin/certificates/${certificate.id}`
        : "/api/admin/certificates";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        body: formData,
        credentials: "include",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      return res.json();
    },
    onSuccess: (data: any) => onSuccess(isEdit ? undefined : data),
    onError: (err: any) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!form.cardGame || !form.setName || !form.cardName || !form.cardNumber || !form.year) {
      setError("Please fill in all required fields: Game, Set, Card Name, Card Number, Year");
      return;
    }

    // Grade is optional on initial save — can be set later via the workstation
    if (!isNonNum && form.gradeOverall) {
      const grade = parseFloat(form.gradeOverall);
      if (isNaN(grade) || grade < 1 || grade > 10) {
        setError("Overall grade must be between 1 and 10");
        return;
      }
    }

    mutation.mutate();
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (unifiedRef.current && !unifiedRef.current.contains(e.target as Node)) {
        setUnifiedOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const updateField = (field: string, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    if (autofillRan && (AUTOFILL_FIELDS.includes(field as AutofillField) || field === "designations")) {
      setManuallyEdited((prev) => new Set(prev).add(field as ProtectedField));
    }
  };

  const applyUnifiedSelection = (val: string, otherText = "") => {
    const { category, code } = parseUnifiedValue(val);
    setForm((f) => {
      const updates: Record<string, string> = {
        unifiedSelect: val,
        rarity: "",
        rarityOther: "",
        variant: "",
        variantOther: "",
        collectionCode: "",
        collectionOther: "",
        otherText: otherText,
      };
      if (category === "RARITY") {
        updates.rarity = code;
      } else if (category === "VARIANT") {
        updates.variant = code;
      } else if (category === "COLLECTION") {
        updates.collectionCode = code;
      } else if (category === "OTHER" && code === "OTHER") {
        updates.rarity = "OTHER";
        updates.rarityOther = otherText;
      }
      return { ...f, ...updates };
    });
  };

  const addCustomVariant = (label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const allLabels = [
      ...UNIFIED_OPTIONS.map((o) => o.label.toLowerCase()),
      ...customVariants.map((v) => v.toLowerCase()),
    ];
    const alreadyExists = allLabels.includes(trimmed.toLowerCase());
    if (!alreadyExists) {
      const next = [...customVariants, trimmed];
      setCustomVariants(next);
      localStorage.setItem("mv-custom-variants", JSON.stringify(next));
    }
    applyUnifiedSelection(`VARIANT:${trimmed}`);
    setUnifiedOpen(false);
    setUnifiedSearch("");
  };

  const toggleDesignation = (code: string) => {
    setDesignations((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      return next;
    });
    if (autofillRan) {
      setManuallyEdited((prev) => new Set(prev).add("designations"));
    }
  };

  const applyCardData = (card: CardMaster, setName: string | null, forceOverwrite = false) => {
    const rawRarity = card.rarity || "";
    const { rarityCode, isPromo } = mapRarityTextToCode(rawRarity);
    const variantCode = mapVariantTextToCode(card.variant || "");
    const mappedCard = { ...card, rarity: rarityCode, variant: variantCode };

    const fieldsWithNewData: ProtectedField[] = AUTOFILL_FIELDS.filter(
      (f) => mappedCard[f] !== null && mappedCard[f] !== undefined && mappedCard[f] !== ""
    );
    if (isPromo) fieldsWithNewData.push("designations");

    if (!forceOverwrite) {
      const conflicting = fieldsWithNewData.filter((f) => {
        if (f === "designations") return manuallyEdited.has("designations") || designations.length > 0;
        if (f === "rarity" || f === "variant") return manuallyEdited.has(f) || form.unifiedSelect !== "";
        return manuallyEdited.has(f) || (form[f] && form[f].trim() !== "");
      });
      if (conflicting.length > 0) {
        setOverwriteConfirm({ fields: conflicting, card, setName });
        return;
      }
    }

    setForm((f) => {
      const updates: Record<string, string> = {};
      for (const field of AUTOFILL_FIELDS) {
        if (field === "rarity" || field === "variant") continue;
        const newVal = mappedCard[field];
        if (newVal !== null && newVal !== undefined && newVal !== "") {
          if (forceOverwrite || !f[field] || f[field].trim() === "") {
            updates[field] = String(newVal);
          }
        }
      }

      if (forceOverwrite || !f.unifiedSelect) {
        if (rarityCode && rarityCode !== "OTHER") {
          updates.unifiedSelect = `RARITY:${rarityCode}`;
          updates.rarity = rarityCode;
          updates.rarityOther = "";
          updates.variant = "";
          updates.variantOther = "";
          updates.collectionCode = "";
          updates.collectionOther = "";
          updates.otherText = "";
        }
      }

      return { ...f, ...updates, ...(setName ? { setName } : {}) };
    });

    if (isPromo && (forceOverwrite || !designations.includes("PROMO"))) {
      setDesignations((prev) => prev.includes("PROMO") ? prev : [...prev, "PROMO"]);
    }

    setAutofillRan(true);
    setSuggestions([]);
    setFallbackMatch(null);
    setOverwriteConfirm(null);
  };

  const confirmOverwrite = () => {
    if (!overwriteConfirm) return;
    const { card, setName } = overwriteConfirm;
    setManuallyEdited(new Set());
    setOverwriteConfirm(null);
    applyCardData(card, setName, true);
    toast({ title: "Card details overwritten" });
  };

  const handleAutofill = async (fallback = false) => {
    const lookupSetId = setId.trim() || form.setName.trim();
    const cardNumber = form.cardNumber.trim();
    const language = form.language.trim();

    if (!lookupSetId || !cardNumber) return;

    setAutofillLoading(true);
    setSuggestions([]);
    setFallbackMatch(null);
    setError("");

    try {
      const result: AutofillResult = await autofillCard({
        setId: lookupSetId,
        cardNumber,
        language,
        allowFallbackLanguage: fallback,
      });

      if (result.matchType === "exact" && result.match) {
        applyCardData(result.match, result.setName);
        toast({ title: "Card details auto-filled" });
      } else if (result.matchType === "fallback_language" && result.match) {
        setFallbackMatch(result.match);
        setFallbackSetName(result.setName);
      } else {
        if (result.suggestions && result.suggestions.length > 0) {
          setSuggestions(result.suggestions);
        } else {
          toast({ title: "No exact match found", variant: "destructive" });
        }
      }
    } catch (err: any) {
      setError(err.message || "Autofill failed");
    } finally {
      setAutofillLoading(false);
    }
  };

  const applyFallback = () => {
    if (!fallbackMatch) return;
    applyCardData(fallbackMatch, fallbackSetName, true);
    if (fallbackMatch.language) {
      setForm((f) => ({ ...f, language: fallbackMatch.language }));
      setLanguageChangedByFallback(true);
    }
    toast({ title: "Card details auto-filled (fallback language)" });
    setFallbackMatch(null);
  };

  const canAutofill = (setId.trim() || form.setName.trim()) && form.cardNumber.trim();

  return (
    <div>
      <h2 className="text-xl font-bold text-[#D4AF37] tracking-widest mb-1" data-testid="text-form-title">
        {isEdit
          ? (!certificate.cardName || certificate.cardName === "(untitled)" || certificate.cardName === "(pending)" ? `NEW ${certificate.certId}` : `EDIT ${certificate.certId}`)
          : "NEW CERTIFICATE"}
      </h2>
      <p className="text-[#999999] text-sm mb-6">
        {isEdit
          ? "Update certificate details"
          : "Fill in card details and click Save. A cert number will be assigned automatically."}
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {!isEdit && <SubmissionItemLink
          value={form.submissionItemId}
          onChange={(itemId, item) => {
            setForm((f) => ({
              ...f,
              submissionItemId: itemId,
              ...(item ? {
                cardGame: item.game || f.cardGame,
                setName: item.card_set || f.setName,
                cardName: (item.card_name || "").toUpperCase() || f.cardName,
                cardNumber: item.card_number || f.cardNumber,
                year: item.year || f.year,
              } : {}),
            }));
          }}
        />}
        {/* AI Identify button — populate card details from uploaded scans */}
        {isEdit && certificate?.id && (
          <div className="border border-[#D4AF37]/30 rounded-lg p-4 bg-[#D4AF37]/5 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">AI Card Identification</p>
                <p className="text-[#888888] text-[10px] mt-0.5">Auto-fill card details from the uploaded scan (fast, no grading)</p>
              </div>
              <button
                type="button"
                onClick={runIdentifyOnly}
                disabled={identifyLoading}
                className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-2 rounded-lg disabled:opacity-50 hover:opacity-90 transition-all shrink-0"
              >
                {identifyLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                {identifyLoading ? "Identifying…" : "Identify Card"}
              </button>
            </div>
            {identifyConfidence && (
              <div className="flex items-center gap-2 text-xs">
                <span className={`w-2 h-2 rounded-full ${identifyConfidence === "high" ? "bg-emerald-400" : identifyConfidence === "medium" ? "bg-yellow-400" : "bg-red-400"}`} />
                <span className={identifyConfidence === "high" ? "text-emerald-600" : identifyConfidence === "medium" ? "text-yellow-600" : "text-red-600"}>
                  {identifyConfidence} confidence{identifyVerified ? " · TCG API verified" : ""}
                </span>
                {identifyConfidence !== "high" && !identifyVerified && (
                  <button type="button" onClick={runIdentifyOnly} disabled={identifyLoading} className="text-[#D4AF37] text-[10px] hover:underline">
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-4">
          <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2">Card Details</legend>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormSelect
              label="Card Game *"
              value={form.cardGame}
              onChange={(v) => updateField("cardGame", v)}
              options={cardGames}
              testId="select-card-game"
            />
            <div>
              <PokemonSetPicker
                value={form.setName}
                onChange={(name, id) => { updateField("setName", name); if (id) setSetId(id); }}
                testId="input-set-name"
              />
              <div className="mt-1.5">
                <label className="text-[#D4AF37]/40 text-[10px] uppercase tracking-wider block mb-1">Set ID (for autofill)</label>
                <input
                  type="text"
                  value={setId}
                  onChange={(e) => setSetId(e.target.value)}
                  placeholder="e.g. sv3pt5"
                  className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-2 py-1 text-[#1A1A1A] text-xs placeholder:text-[#D4AF37]/15 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
                  data-testid="input-set-id"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormInput
              label="Card Name *"
              value={form.cardName}
              onChange={(v) => updateField("cardName", v)}
              onBlur={() => setForm((f) => ({ ...f, cardName: f.cardName.toUpperCase() }))}
              testId="input-card-name"
              highlight={autofillRan && manuallyEdited.has("cardName")}
            />
            <div>
              <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Card Number *</label>
              <div className="flex gap-2">
                <div className="flex-1 flex items-center bg-transparent border border-[#D4AF37]/30 rounded overflow-hidden focus-within:border-[#D4AF37] transition-colors">
                  <span className="pl-3 text-[#D4AF37]/50 text-sm select-none">#</span>
                  <input
                    type="text"
                    value={form.cardNumber}
                    onChange={(e) => updateField("cardNumber", e.target.value.replace(/^#+/, ""))}
                    placeholder="e.g. 125/198"
                    className="flex-1 bg-transparent px-2 py-2 text-[#1A1A1A] text-sm placeholder:text-[#D4AF37]/20 focus:outline-none"
                    data-testid="input-card-number"
                  />
                </div>
                <button
                  type="button"
                  disabled={!canAutofill || autofillLoading}
                  onClick={() => handleAutofill(false)}
                  className="px-3 py-2 border border-[#D4AF37]/30 rounded text-[#D4AF37] text-sm hover:bg-[#D4AF37]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
                  data-testid="button-autofill"
                  title="Auto-fill card details"
                >
                  <Search size={14} />
                  {autofillLoading ? "..." : "Auto-fill"}
                </button>
              </div>

              {suggestions.length > 0 && (
                <div className="mt-2 border border-[#D4AF37]/20 rounded bg-white max-h-40 border border-[#E8E4DC] overflow-y-auto" data-testid="autofill-suggestions">
                  <p className="text-[#D4AF37]/50 text-[10px] uppercase tracking-widest px-3 pt-2 pb-1">Suggestions</p>
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setForm((f) => ({ ...f, cardNumber: s.cardNumber }));
                        applyCardData(s, null);
                        toast({ title: "Card details auto-filled" });
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm text-[#666666] hover:bg-[#D4AF37]/10 hover:text-[#1A1A1A] transition-colors"
                      data-testid={`suggestion-${s.id}`}
                    >
                      <span className="text-[#D4AF37]">{s.cardNumber}</span>
                      {" – "}
                      {s.cardName}
                      {s.rarity && <span className="text-[#999999]"> ({s.rarity})</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSuggestions([])}
                    className="w-full text-center text-[10px] text-[#999999] py-1 hover:text-[#666666]"
                    data-testid="button-dismiss-suggestions"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {fallbackMatch && (
                <div className="mt-2 border border-amber-500/40 bg-amber-500/5 rounded p-3" data-testid="fallback-banner">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-amber-400 text-sm font-medium">Match found in different language</p>
                      <p className="text-[#666666] text-xs mt-1">
                        Found: <span className="text-[#1A1A1A]">{fallbackMatch.cardName}</span> ({fallbackMatch.language})
                      </p>
                      <div className="flex gap-2 mt-2">
                        <button
                          type="button"
                          onClick={applyFallback}
                          className="px-3 py-1 text-xs border border-amber-500/40 text-amber-400 rounded hover:bg-amber-500/10 transition-colors flex items-center gap-1"
                          data-testid="button-apply-fallback"
                        >
                          <Check size={12} /> Apply Anyway
                        </button>
                        <button
                          type="button"
                          onClick={() => setFallbackMatch(null)}
                          className="px-3 py-1 text-xs text-[#999999] hover:text-[#666666] transition-colors flex items-center gap-1"
                          data-testid="button-dismiss-fallback"
                        >
                          <X size={12} /> Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {!fallbackMatch && canAutofill && !autofillLoading && suggestions.length === 0 && (
            <button
              type="button"
              onClick={() => handleAutofill(true)}
              className="text-[10px] text-[#D4AF37]/40 hover:text-[#D4AF37]/70 transition-colors underline"
              data-testid="button-search-other-languages"
            >
              Search other languages
            </button>
          )}

          {overwriteConfirm && (
            <div className="border border-amber-500/40 bg-amber-500/5 rounded p-3" data-testid="overwrite-confirm">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-amber-400 text-sm font-medium">Overwrite manually edited fields?</p>
                  <p className="text-[#666666] text-xs mt-1">
                    You edited: {overwriteConfirm.fields.join(", ")}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      onClick={confirmOverwrite}
                      className="px-3 py-1 text-xs border border-amber-500/40 text-amber-400 rounded hover:bg-amber-500/10 transition-colors"
                      data-testid="button-confirm-overwrite"
                    >
                      Yes, overwrite
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverwriteConfirm(null)}
                      className="px-3 py-1 text-xs text-[#999999] hover:text-[#666666] transition-colors"
                      data-testid="button-cancel-overwrite"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(() => {
            // Build merged option list: static (minus OTHER) + DB variants + localStorage custom + OTHER
            // seenLabels uses BOTH labels ("reverse holo") AND codes ("reverse_holo") to prevent
            // built-in DB-stored codes appearing as duplicate custom entries.
            const builtInLabels = new Set(UNIFIED_OPTIONS.map((o) => o.label.toLowerCase()));
            const builtInCodes  = new Set(UNIFIED_OPTIONS.map((o) => o.code.toLowerCase()));
            const seenLabels = new Set<string>([...builtInLabels, ...builtInCodes]);
            const extraVariants: UnifiedOption[] = [];
            // DB variants first (shared across all admins/devices)
            for (const v of dbVariants) {
              const key = v.toLowerCase();
              if (!seenLabels.has(key)) {
                seenLabels.add(key);
                extraVariants.push({ value: `VARIANT:${v}`, label: v, category: "VARIANT" as const, code: v });
              }
            }
            // localStorage custom variants (optimistic, same-device additions)
            for (const v of customVariants) {
              const key = v.toLowerCase();
              if (!seenLabels.has(key)) {
                seenLabels.add(key);
                extraVariants.push({ value: `VARIANT:${v}`, label: v, category: "VARIANT" as const, code: v });
              }
            }
            const otherOpt = UNIFIED_OPTIONS.find((o) => o.value === "OTHER")!;
            const allOptions: UnifiedOption[] = [
              ...UNIFIED_OPTIONS.filter((o) => o.value !== "OTHER"),
              ...extraVariants,
              otherOpt,
            ];
            const q = unifiedSearch.toLowerCase().trim();
            const filteredOpts = allOptions.filter((o) =>
              !q || o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q)
            );
            const hasExactMatch = !q || allOptions.some(
              (o) => o.label.toLowerCase() === q || o.code.toLowerCase() === q
            );
            const showAddButton = q.length > 1 && !hasExactMatch;

            return (
              <div ref={unifiedRef} className="relative">
                <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Variant</label>
                <button
                  type="button"
                  onClick={() => { setUnifiedOpen(!unifiedOpen); setUnifiedSearch(""); }}
                  className={`w-full bg-transparent border rounded px-3 py-2 text-sm text-left flex items-center justify-between transition-colors focus:outline-none focus:border-[#D4AF37] ${autofillRan && (manuallyEdited.has("rarity") || manuallyEdited.has("variant")) ? "border-amber-500/50" : "border-[#D4AF37]/30"}`}
                  data-testid="select-unified"
                >
                  <span className={form.unifiedSelect ? "text-[#1A1A1A]" : "text-[#D4AF37]/20"}>
                    {form.unifiedSelect
                      ? (form.unifiedSelect === "OTHER" ? "OTHER (manual)" : getUnifiedDisplayLabel(form.unifiedSelect))
                      : "Select or type a variant..."}
                  </span>
                  <ChevronDown size={14} className="text-[#D4AF37]/50" />
                </button>
                {unifiedOpen && (
                  <div className="absolute z-50 left-0 right-0 mt-1 border border-[#D4AF37]/30 bg-white rounded-lg shadow-xl max-h-72 overflow-hidden flex flex-col" data-testid="unified-dropdown">
                    <div className="p-2 border-b border-[#D4AF37]/10">
                      <input
                        type="text"
                        value={unifiedSearch}
                        onChange={(e) => setUnifiedSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (showAddButton) {
                              addCustomVariant(unifiedSearch);
                            } else if (filteredOpts.length === 1) {
                              applyUnifiedSelection(filteredOpts[0].value);
                              setUnifiedOpen(false);
                              setUnifiedSearch("");
                            }
                          }
                          if (e.key === "Escape") setUnifiedOpen(false);
                        }}
                        placeholder="Type to filter or add a new variant..."
                        className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-2 py-1.5 text-[#1A1A1A] text-xs placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37]/50"
                        autoFocus
                        data-testid="input-unified-search"
                      />
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {form.unifiedSelect && (
                        <button
                          type="button"
                          onClick={() => { applyUnifiedSelection(""); setUnifiedOpen(false); }}
                          className="w-full text-left px-3 py-2 text-xs text-[#999999] hover:bg-[#D4AF37]/10 hover:text-[#666666] transition-colors border-b border-[#D4AF37]/10"
                          data-testid="unified-clear"
                        >
                          Clear selection
                        </button>
                      )}
                      {showAddButton && (
                        <button
                          type="button"
                          onClick={() => addCustomVariant(unifiedSearch)}
                          className="w-full text-left px-3 py-2 text-sm text-[#D4AF37] hover:bg-[#D4AF37]/10 transition-colors flex items-center gap-2 border-b border-[#D4AF37]/10"
                          data-testid="unified-add-custom"
                        >
                          <Plus size={13} />
                          Add "{unifiedSearch}" as variant
                        </button>
                      )}
                      {filteredOpts.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          onClick={() => { applyUnifiedSelection(o.value); setUnifiedOpen(false); setUnifiedSearch(""); }}
                          className={`w-full text-left px-3 py-2 text-sm transition-colors group ${form.unifiedSelect === o.value ? "bg-[#D4AF37]/15 text-[#D4AF37]" : "text-[#666666] hover:bg-[#D4AF37]/10 hover:text-[#1A1A1A]"}`}
                          data-testid={`unified-option-${o.value}`}
                        >
                          <span className="block">{o.label}</span>
                          {o.help && <span className="block text-[10px] text-[#999999] group-hover:text-[#666666] mt-0.5">{o.help}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {form.unifiedSelect && (() => {
                  const opt = allOptions.find((o) => o.value === form.unifiedSelect);
                  return opt?.help ? (
                    <p className="text-[#999999] text-[10px] mt-1 flex items-center gap-1" data-testid="text-unified-help">
                      <HelpCircle size={10} className="shrink-0" /> {opt.help}
                    </p>
                  ) : null;
                })()}
                {form.unifiedSelect === "OTHER" && (
                  <div className="mt-2 space-y-2">
                    <input
                      type="text"
                      value={form.otherText}
                      onChange={(e) => {
                        const val = e.target.value;
                        setForm((f) => ({ ...f, otherText: val, rarity: "OTHER", rarityOther: val }));
                      }}
                      placeholder="Enter custom rarity / variant / collection..."
                      className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
                      data-testid="input-other-text"
                    />
                    {dbRarityOthers.length > 0 && (
                      <div className="flex flex-wrap gap-1.5" data-testid="rarity-other-suggestions">
                        {dbRarityOthers
                          .filter((v) => !form.otherText || v.toLowerCase().includes(form.otherText.toLowerCase()))
                          .map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setForm((f) => ({ ...f, otherText: v, rarity: "OTHER", rarityOther: v }))}
                              className={`px-2 py-0.5 rounded text-xs border transition-colors ${form.otherText === v ? "bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37]" : "bg-transparent border-[#D4AF37]/15 text-[#666666] hover:border-[#D4AF37]/40 hover:text-[#1A1A1A]"}`}
                              data-testid={`rarity-other-chip-${v}`}
                            >
                              {v}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Designations</label>
            <div className="flex flex-wrap gap-2" data-testid="designations-chips">
              {DESIGNATION_OPTIONS.map((d) => {
                const active = designations.includes(d.code);
                return (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => toggleDesignation(d.code)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-all ${active ? "bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37]" : "bg-transparent border-[#D4AF37]/15 text-[#999999] hover:border-[#D4AF37]/30 hover:text-[#666666]"}`}
                    data-testid={`designation-${d.code}`}
                    title={d.help}
                  >
                    {active && <Check size={10} className="inline mr-1" />}
                    {d.label}
                  </button>
                );
              })}
            </div>
            {designations.length > 0 && (
              <p className="text-[#999999] text-[10px] mt-1.5" data-testid="text-designations-summary">
                Selected: {designations.map((c) => getDesignationLabel(c)).join(", ")}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FormInput
                label="Language"
                value={form.language}
                onChange={(v) => {
                  updateField("language", v);
                  setLanguageChangedByFallback(false);
                }}
                testId="input-language"
                highlight={languageChangedByFallback}
              />
              {languageChangedByFallback && (
                <p className="text-amber-400 text-[10px] mt-1" data-testid="text-language-fallback-notice">Changed by fallback match</p>
              )}
            </div>
            <FormInput
              label="Year *"
              value={form.year}
              onChange={(v) => updateField("year", v)}
              placeholder="e.g. 1999"
              testId="input-year"
              highlight={autofillRan && manuallyEdited.has("year")}
            />
          </div>

          {/* Grader Notes with preset helper */}
          <div className="border border-[#D4AF37]/20 rounded-lg p-3 space-y-3 bg-[#D4AF37]/[0.02]">
            <div className="flex items-center gap-2">
              <FileText size={13} className="text-[#D4AF37]/60 shrink-0" />
              <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider">Grader Notes</label>
            </div>

            {/* Template buttons */}
            <div>
              <p className="text-[#D4AF37]/40 text-[10px] uppercase tracking-widest mb-1.5">Insert template</p>
              <div className="flex flex-wrap gap-1.5">
                {NOTE_TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => updateField("notes", t.text)}
                    className="text-xs px-2.5 py-1 rounded border border-[#D4AF37]/30 text-[#D4AF37]/70 hover:border-[#D4AF37]/60 hover:text-[#D4AF37] hover:bg-[#D4AF37]/5 transition-all"
                    data-testid={`button-template-${t.label.toLowerCase().replace(" ", "-")}`}
                  >
                    {t.label} Notes
                  </button>
                ))}
              </div>
            </div>

            {/* Notes textarea */}
            <textarea
              value={form.notes}
              onChange={(e) => updateField("notes", e.target.value)}
              rows={4}
              placeholder="Grader notes appear on the public certificate page. Leave blank to hide."
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37] transition-colors resize-none"
              data-testid="input-cert-notes"
            />

            {/* Preset chips */}
            <div>
              <p className="text-[#D4AF37]/40 text-[10px] uppercase tracking-widest mb-1.5">Quick add</p>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_NOTES.map((preset) => {
                  const lines = form.notes.split("\n").map((l) => l.trim()).filter(Boolean);
                  const alreadyAdded = lines.includes(preset);
                  return (
                    <button
                      key={preset}
                      type="button"
                      disabled={alreadyAdded}
                      onClick={() => {
                        const current = form.notes.trimEnd();
                        updateField("notes", current ? `${current}\n${preset}` : preset);
                      }}
                      className={`text-[11px] px-2 py-0.5 rounded border transition-all flex items-center gap-1 ${
                        alreadyAdded
                          ? "border-[#D4AF37]/15 text-[#D4AF37]/25 cursor-default"
                          : "border-[#D4AF37]/25 text-[#666666] hover:border-[#D4AF37]/50 hover:text-[#1A1A1A] hover:bg-[#D4AF37]/5 cursor-pointer"
                      }`}
                      data-testid={`button-preset-${preset.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {!alreadyAdded && <Plus size={10} className="shrink-0" />}
                      {preset}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-4">
          <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2">Grade</legend>

          <div>
            <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Grade Type *</label>
            <select
              value={form.gradeType}
              onChange={(e) => {
                const gt = e.target.value;
                setForm(f => ({
                  ...f,
                  gradeType: gt,
                  ...(isNonNumericGrade(gt) ? {
                    gradeOverall: "",
                    gradeCentering: "",
                    gradeCorners: "",
                    gradeEdges: "",
                    gradeSurface: "",
                  } : {
                    gradeOverall: f.gradeOverall || "",
                  }),
                }));
              }}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
              data-testid="select-grade-type"
            >
              <option value="numeric" className="bg-white">Numeric (1–10)</option>
              {NON_NUMERIC_GRADES.map(ng => (
                <option key={ng.value} value={ng.value} className="bg-white">{ng.value} – {ng.description}</option>
              ))}
            </select>
          </div>

          {isNonNum && (
            <div className="bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-lg p-3">
              <p className="text-[#D4AF37] text-sm font-semibold">
                {form.gradeType === "NO" ? "AUTHENTIC – No Numerical Grade" : "AUTHENTIC ALTERED – No Numerical Grade"}
              </p>
              <p className="text-[#666666] text-xs mt-1">
                {form.gradeType === "NO"
                  ? "Card verified as authentic. No numerical grade or subgrades assigned."
                  : "Card verified as authentic but has been altered. No numerical grade or subgrades assigned."}
              </p>
            </div>
          )}

          {!isNonNum && (
            <>
              <div>
                <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Overall Grade *</label>
                <select
                  value={form.gradeOverall === "10" && form.labelType === "black" ? "black_label" : form.gradeOverall}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "black_label") {
                      setForm(f => ({ ...f, gradeOverall: "10", labelType: "black" }));
                    } else {
                      setForm(f => ({ ...f, gradeOverall: v, labelType: "standard" }));
                    }
                  }}
                  className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                  data-testid="select-grade-overall"
                >
                  <option value="" className="bg-white">Select grade...</option>
                  <option value="black_label" className="bg-white">★ 10 — BLACK LABEL (Gem Mint)</option>
                  {NUMERIC_GRADES.map(g => (
                    <option key={g.value} value={String(g.value)} className="bg-white">{g.value} – {g.label} ({g.description})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Service Tier</label>
                <select
                  value={form.serviceTier}
                  onChange={(e) => updateField("serviceTier", e.target.value)}
                  className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                  data-testid="select-service-tier"
                >
                  <option value="" className="bg-white">Standard (default)</option>
                  <option value="standard" className="bg-white">Standard — £12</option>
                  <option value="priority" className="bg-white">Priority — £15</option>
                  <option value="express" className="bg-white">Express — £20</option>
                  <option value="gold" className="bg-white">Gold — £85 (Black Label if grade 10)</option>
                  <option value="gold-elite" className="bg-white">Gold Elite — £125 (Black Label if grade 10)</option>
                </select>
                {(form.serviceTier === "gold" || form.serviceTier === "gold-elite") && form.gradeOverall === "10" && (
                  <p className="text-[#D4AF37] text-xs mt-1.5">⭐ This card will receive a Black Label.</p>
                )}
              </div>
            </>
          )}
        </fieldset>

        {/* ── Card images and AI grading are handled by the GradingPanel workstation below ── */}

        {/* ── Legacy Grading Images section (hidden — use Capture Wizard in workstation instead) ── */}
        {false && isEdit && (
          <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-4">
            <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2 flex items-center gap-2">
              <Upload size={12} />
              Grading Images
            </legend>

            <p className="text-[#666666] text-xs">Upload high-res scans for AI analysis. Front and back are required. Images are auto-cropped and processed into analysis variants.</p>

            {/* 2×2 upload grid */}
            <div className="grid grid-cols-2 gap-3">
              {(["front", "back", "angled", "closeup"] as const).map((angle) => {
                const isRequired = angle === "front" || angle === "back";
                const label = angle === "front" ? "Front (required)" : angle === "back" ? "Back (required)" : angle === "angled" ? "Angled (optional)" : "Closeup (optional)";
                const existingUrl = gradingUrls[`${angle}_cropped`] || gradingUrls[`${angle}_original`] || null;
                const previewUrl = gradingImages[angle] ? URL.createObjectURL(gradingImages[angle]!) : null;
                const displayUrl = previewUrl || existingUrl;
                return (
                  <label
                    key={angle}
                    className={`relative border-2 border-dashed rounded-xl p-3 cursor-pointer transition-all flex flex-col items-center justify-center gap-2 min-h-[120px] text-center
                      ${gradingImages[angle] ? "border-[#D4AF37]/60 bg-[#D4AF37]/5" : "border-[#E8E4DC] bg-[#FAFAF8] hover:border-[#D4AF37]/40 hover:bg-white"}`}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setGradingImages(prev => ({ ...prev, [angle]: f }));
                      }}
                    />
                    {displayUrl ? (
                      <img src={displayUrl} alt={angle} className="w-full h-20 object-contain rounded" />
                    ) : (
                      <Upload size={20} className={isRequired ? "text-[#D4AF37]/60" : "text-[#CCCCCC]"} />
                    )}
                    <span className={`text-[10px] uppercase tracking-wider ${isRequired ? "text-[#666666] font-semibold" : "text-[#AAAAAA]"}`}>{label}</span>
                    {gradingImages[angle] && <span className="text-[9px] text-[#D4AF37] truncate w-full">{gradingImages[angle]!.name}</span>}
                  </label>
                );
              })}
            </div>

            {/* Upload button */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={uploadGradingImages}
                disabled={gradingUploading || (!gradingImages.front && !gradingImages.back)}
                className="flex items-center gap-2 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] px-4 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all hover:bg-[#D4AF37]/20 disabled:opacity-40"
              >
                {gradingUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {gradingUploading ? "Uploading…" : "Upload & Process"}
              </button>
              {gradingUploadDone && <span className="text-emerald-600 text-xs flex items-center gap-1"><CheckCircle2 size={12} /> Uploaded — variants generating in background</span>}
            </div>

            {/* Quality check results */}
            {Object.keys(gradingQuality).length > 0 && (
              <div className="space-y-2">
                <p className="text-[#666666] text-[10px] uppercase tracking-widest">Image Quality Checks</p>
                {Object.entries(gradingQuality).map(([angle, q]: [string, any]) => (
                  <div key={angle} className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3">
                    <p className="text-[#1A1A1A] text-[10px] font-bold uppercase mb-1">{angle} — {q.overall === "pass" ? <span className="text-emerald-600">PASS</span> : q.overall === "warn" ? <span className="text-amber-600">WARN</span> : <span className="text-red-600">FAIL</span>}</p>
                    <div className="space-y-0.5">
                      {(q.checks || []).map((c: any, i: number) => (
                        <p key={i} className={`text-[10px] ${c.status === "pass" ? "text-[#888888]" : c.status === "warn" ? "text-amber-600" : "text-red-600"}`}>
                          {c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"} {c.message}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Card database lookup */}
            <div className="space-y-2 pt-2 border-t border-[#E8E4DC]">
              <p className="text-[#666666] text-[10px] uppercase tracking-widest">Verify Card Identity</p>
              <div className="flex gap-2">
                <select
                  value={cardLookupGame}
                  onChange={(e) => setCardLookupGame(e.target.value)}
                  className="bg-white border border-[#E8E4DC] text-[#1A1A1A] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#D4AF37]"
                >
                  <option value="pokemon">Pokémon</option>
                  <option value="mtg">MTG</option>
                  <option value="yugioh">Yu-Gi-Oh!</option>
                </select>
                <input
                  type="text"
                  value={cardLookupQuery}
                  onChange={(e) => setCardLookupQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runCardLookup()}
                  placeholder="Card name…"
                  className="flex-1 bg-white border border-[#E8E4DC] text-[#1A1A1A] text-xs rounded px-3 py-1.5 placeholder-[#AAAAAA] focus:outline-none focus:border-[#D4AF37]"
                />
                <button
                  type="button"
                  onClick={runCardLookup}
                  disabled={cardLookupLoading || !cardLookupQuery.trim()}
                  className="flex items-center gap-1 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] px-3 py-1.5 rounded text-xs font-bold disabled:opacity-40 hover:bg-[#D4AF37]/20"
                >
                  {cardLookupLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                </button>
              </div>
              {cardLookupResults.length > 0 && (
                <div className="bg-white rounded-lg border border-[#E8E4DC] max-h-48 overflow-y-auto">
                  {cardLookupResults.map((r, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        updateField("cardName", r.name);
                        if (r.setName) updateField("setName", r.setName);
                        if (r.year)    updateField("year", r.year);
                        if (r.number)  updateField("cardNumber", r.number);
                        if (r.rarity)  updateField("rarity", r.rarity);
                        setCardLookupResults([]);
                        toast({ title: "Card details filled", description: `${r.name} from ${r.setName}` });
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-[#D4AF37]/5 border-b border-[#F0EDE8] last:border-0 flex items-start gap-3"
                    >
                      {r.imageUrl && <img src={r.imageUrl} alt={r.name} className="w-8 h-10 object-contain rounded flex-shrink-0" />}
                      <div>
                        <p className="text-[#1A1A1A] font-medium">{r.name}</p>
                        <p className="text-[#666666] text-[10px]">{r.setName}{r.number ? ` · #${r.number}` : ""}{r.rarity ? ` · ${r.rarity}` : ""}</p>
                        <p className="text-[#AAAAAA] text-[9px]">{r.source}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {cardLookupResults.length === 0 && cardLookupQuery && !cardLookupLoading && (
                <p className="text-[#999999] text-[10px]">No results — check spelling or try a shorter name.</p>
              )}
            </div>
          </fieldset>
        )}

        {/* ── Legacy AI Grading Panel (hidden — use workstation's ANALYZE WITH AI instead) ── */}
        {false && isEdit && (
          <fieldset className="border border-[#D4AF37]/30 rounded-lg p-4 space-y-4">
            <legend className="text-[#D4AF37] text-xs uppercase tracking-widest px-2 flex items-center gap-2">
              <Cpu size={12} />
              AI-Assisted Grading
            </legend>

            <div className="flex items-center justify-between">
              <p className="text-[#666666] text-xs">Analyze card photos with Claude Vision to generate a draft grade.</p>
              <button
                type="button"
                onClick={runAiAnalysis}
                disabled={aiLoading}
                className="flex items-center gap-2 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] px-4 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all hover:bg-[#D4AF37]/20 disabled:opacity-50"
                data-testid="button-analyze-ai"
              >
                {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Cpu size={14} />}
                {aiLoading ? "Analyzing…" : "Analyze with AI"}
              </button>
            </div>

            {aiLoading && (
              <div className="flex items-center gap-3 text-[#D4AF37] text-xs bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-lg p-3">
                <Loader2 size={14} className="animate-spin shrink-0" />
                Sending images to Claude Vision. This takes 15–30 seconds…
              </div>
            )}

            {aiError && (
              <div className="flex items-center gap-2 text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertTriangle size={14} className="shrink-0" />
                {aiError}
              </div>
            )}

            {aiAnalysis && !aiLoading && (
              <div className="space-y-4">
                {/* Subgrade cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(["centering", "corners", "edges", "surface"] as const).map((cat) => (
                    <div key={cat} className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3 text-center">
                      <p className="text-[#888888] text-[10px] uppercase tracking-widest mb-1">{cat}</p>
                      <p className="text-2xl font-black mb-1" style={{ color: subgradeColor(aiDraft[cat]) }}>{aiDraft[cat] || "—"}</p>
                      <input
                        type="number"
                        min="1" max="10" step="0.5"
                        value={aiDraft[cat]}
                        onChange={(e) => setAiDraft(d => ({ ...d, [cat]: e.target.value }))}
                        className="w-full bg-white border border-[#E8E4DC] rounded px-2 py-1 text-[#1A1A1A] text-xs text-center focus:outline-none focus:border-[#D4AF37]"
                      />
                      <p className="text-[#888888] text-[9px] leading-tight mt-1.5 line-clamp-2">
                        {aiAnalysis[cat]?.notes || ""}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Centering ratios */}
                {aiAnalysis.centering && (
                  <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3 text-xs grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      ["Front L/R", aiAnalysis.centering.front_left_right],
                      ["Front T/B", aiAnalysis.centering.front_top_bottom],
                      ["Back L/R",  aiAnalysis.centering.back_left_right],
                      ["Back T/B",  aiAnalysis.centering.back_top_bottom],
                    ].map(([label, val]) => (
                      <div key={label}>
                        <p className="text-[#AAAAAA] text-[9px] uppercase">{label}</p>
                        <p className="text-[#1A1A1A] font-mono font-bold">{val || "—"}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Defects */}
                {aiDefects.length > 0 && (
                  <div>
                    <p className="text-[#666666] text-[10px] uppercase tracking-widest mb-2">Identified Defects</p>
                    <div className="space-y-1.5">
                      {aiDefects.map((d, i) => (
                        <div key={i} className="flex items-start gap-2 bg-[#FAFAF8] border border-[#E8E4DC] rounded px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-[#D4AF37] text-xs font-semibold uppercase">{d.type?.replace(/_/g, " ")}</span>
                            <span className="text-[#CCCCCC] text-xs mx-1.5">·</span>
                            <span className="text-[#666666] text-xs">{d.location}</span>
                            <span className="text-[#CCCCCC] text-xs mx-1.5">·</span>
                            <span className="text-[#888888] text-xs italic">{d.severity}</span>
                            <p className="text-[#666666] text-[11px] mt-0.5">{d.description}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAiDefects(prev => prev.filter((_, j) => j !== i))}
                            className="text-[#CCCCCC] hover:text-red-500 transition-colors shrink-0 mt-0.5"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Overall grade + explanation */}
                <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-[#888888] text-[10px] uppercase tracking-widest">AI Draft Overall</p>
                      <p className="text-3xl font-black" style={{ color: subgradeColor(aiDraft.overall) }}>{aiDraft.overall || "—"}</p>
                      <p className="text-[#D4AF37] text-xs">{aiAnalysis.grade_label || ""}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[#888888] text-[10px] uppercase tracking-widest mb-1">Override Overall</p>
                      <input
                        type="number"
                        min="1" max="10" step="0.5"
                        value={aiDraft.overall}
                        onChange={(e) => setAiDraft(d => ({ ...d, overall: e.target.value }))}
                        className="w-24 bg-white border border-[#E8E4DC] rounded px-2 py-1 text-[#1A1A1A] text-sm text-center focus:outline-none focus:border-[#D4AF37]"
                      />
                    </div>
                  </div>
                  {aiAnalysis.grade_explanation && (
                    <p className="text-[#555555] text-xs leading-relaxed border-t border-[#E8E4DC] pt-3">{aiAnalysis.grade_explanation}</p>
                  )}
                  {aiAnalysis.authentication_notes && (
                    <p className="text-[#888888] text-[11px] leading-relaxed mt-2 italic">{aiAnalysis.authentication_notes}</p>
                  )}
                </div>

                {/* Approve button */}
                {!approved ? (
                  <button
                    type="button"
                    onClick={approveGrade}
                    disabled={approveLoading || !aiDraft.overall}
                    className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] py-3 rounded font-bold text-sm uppercase tracking-widest disabled:opacity-50 hover:opacity-90 transition-opacity"
                    data-testid="button-approve-grade"
                  >
                    {approveLoading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                    {approveLoading ? "Approving…" : "Approve Grade"}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 text-emerald-600 text-sm font-semibold bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                    <CheckCircle2 size={16} />
                    Grade approved
                  </div>
                )}
              </div>
            )}

            <p className="text-[#AAAAAA] text-[10px] leading-relaxed">
              Upload high-res scans (600+ DPI) for best results. Card must be outside the sleeve. Use even, diffuse lighting — avoid shadows and hot-spots. Holo cards: photograph at an angle to reveal surface scratches.
            </p>
          </fieldset>
        )}

        {error && (
          <p className="text-red-400 text-sm" data-testid="text-form-error">{error}</p>
        )}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] py-3 rounded font-bold tracking-widest text-sm transition-all btn-gold-glow hover:bg-[#D4AF37]/20 disabled:opacity-50 flex items-center justify-center gap-2"
          data-testid="button-save-cert"
        >
          <Save size={16} />
          {mutation.isPending ? "Saving..." : isEdit ? "Update Certificate" : "Save Certificate"}
        </button>
      </form>
    </div>
  );
}

function FormInput({
  label, value, onChange, onBlur, testId, placeholder, type, step, min, max, highlight,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  testId: string;
  placeholder?: string;
  type?: string;
  step?: string;
  min?: string;
  max?: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <input
        type={type || "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        step={step}
        min={min}
        max={max}
        className={`w-full bg-transparent border rounded px-3 py-2 text-[#1A1A1A] text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37] transition-colors ${highlight ? "border-amber-500/50" : "border-[#D4AF37]/30"}`}
        data-testid={testId}
      />
    </div>
  );
}

function FormSelect({
  label, value, onChange, options, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  testId: string;
}) {
  return (
    <div>
      <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
        data-testid={testId}
      >
        <option value="">Select...</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

function FileUpload({
  label, current, onChange, testId,
}: {
  label: string;
  current?: string | null;
  onChange: (f: File | null) => void;
  testId: string;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = (file: File | null) => {
    onChange(file);
    if (file) setPreview(URL.createObjectURL(file));
  };

  const displaySrc = preview || current;

  return (
    <div>
      <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <label
        className={`relative block border-2 border-dashed rounded-xl cursor-pointer transition-all overflow-hidden
          ${dragging ? "border-[#D4AF37] bg-[#D4AF37]/5" : displaySrc ? "border-[#D4AF37]/40 bg-[#FAFAF8]" : "border-[#E8E4DC] bg-[#FAFAF8] hover:border-[#D4AF37]/40 hover:bg-white"}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
      >
        {displaySrc ? (
          <div className="relative">
            <img src={displaySrc} alt={label} className="w-full h-40 object-contain rounded-xl bg-white p-2" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/20 transition-all rounded-xl">
              <span className="opacity-0 hover:opacity-100 text-white text-xs font-bold bg-black/50 px-2 py-1 rounded transition-opacity">Replace</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center min-h-[140px]">
            <Upload size={24} className="text-[#D4AF37]/50" />
            <p className="text-[#666666] text-xs font-medium">Drag & drop or click to upload</p>
            <p className="text-[#AAAAAA] text-[10px]">JPG, PNG, WEBP</p>
          </div>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
          className="sr-only"
          data-testid={testId}
        />
      </label>
    </div>
  );
}

function SubmissionItemLink({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string, item?: any) => void;
}) {
  const { data: items, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/submission-items/unlinked"],
    queryFn: async () => {
      const res = await fetch("/api/admin/submission-items/unlinked", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  return (
    <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-2" data-testid="fieldset-submission-link">
      <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2 flex items-center gap-1.5">
        <Link2 size={12} /> Link to Submission
      </legend>
      <p className="text-[#999999] text-xs">Optionally link this certificate to a customer submission item. Fields will auto-populate.</p>
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) {
            onChange("");
            return;
          }
          const item = items?.find((i: any) => String(i.id) === id);
          onChange(id, item);
        }}
        className="w-full bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
        data-testid="select-submission-item"
      >
        <option value="">No link (standalone certificate)</option>
        {isLoading && <option value="" disabled>Loading...</option>}
        {items?.map((item: any) => (
          <option key={item.id} value={String(item.id)}>
            Sub #{item.submission_id} Card {item.card_index} — {item.card_name || item.game || "Unnamed"} {item.card_set ? `(${item.card_set})` : ""} — {item.customer_first_name} {item.customer_last_name}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

// ── Pokemon Set Picker — searchable dropdown from TCG API ────────────────

interface PokemonSet { id: string; name: string; series: string; ptcgoCode: string | null; releaseDate: string; total: number; }

function PokemonSetPicker({ value, onChange, testId }: { value: string; onChange: (name: string, id?: string) => void; testId?: string }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<PokemonSet[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    fetch("/api/pokemon-sets").then(r => r.json()).then(d => { if (Array.isArray(d)) setSets(d); }).catch(() => {});
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const q = query.toLowerCase();
  const filtered = q ? sets.filter(s =>
    s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.ptcgoCode || "").toLowerCase().includes(q) || s.series.toLowerCase().includes(q)
  ).slice(0, 12) : sets.slice(0, 12);

  return (
    <div ref={ref} className="relative">
      <label className="text-[#D4AF37]/60 text-[10px] uppercase tracking-wider block mb-1">Set Name *</label>
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Type to search sets…"
        data-testid={testId}
        className="w-full bg-white border border-[#D4AF37]/30 rounded px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37]"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-[#E8E4DC] rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {filtered.map(s => (
            <button key={s.id} type="button"
              onClick={() => { onChange(s.name, s.id); setQuery(s.name); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-[#D4AF37]/5 border-b border-[#F0EDE8] last:border-0"
            >
              <span className="font-mono text-[#D4AF37] text-[10px] mr-2">{s.id}</span>
              <span className="text-[#1A1A1A] font-medium">{s.name}</span>
              <span className="text-[#999999] ml-2">· {s.series} · {s.total} cards · {s.releaseDate?.split("-")[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

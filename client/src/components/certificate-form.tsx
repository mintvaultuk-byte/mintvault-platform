import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CertificateRecord, CardMaster } from "@shared/schema";
import { NUMERIC_GRADES, NON_NUMERIC_GRADES, isNonNumericGrade } from "@shared/schema";
import { Save, Upload, Search, Check, AlertTriangle, X, ChevronDown, HelpCircle, Link2, FileText, Plus } from "lucide-react";
import { autofillCard, type AutofillResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { mapRarityTextToCode } from "@/lib/rarityOptions";
import { mapVariantTextToCode } from "@/lib/variantOptions";
import { UNIFIED_OPTIONS, parseUnifiedValue, buildUnifiedValue, buildOtherText, getUnifiedDisplayLabel, type UnifiedOption } from "@/lib/unifiedCardOptions";
import { DESIGNATION_OPTIONS, getDesignationLabel } from "@/lib/designationOptions";

interface Props {
  certificate: CertificateRecord | null;
  onSuccess: () => void;
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
    submissionItemId: (certificate as any)?.submissionItemId || "",
    cardGame: certificate?.cardGame || "",
    setName: certificate?.setName || "",
    cardName: certificate?.cardName || "",
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
    status: certificate?.status || "active",
  });

  const [designations, setDesignations] = useState<string[]>(
    () => (certificate?.designations as string[]) || []
  );

  const isNonNum = isNonNumericGrade(form.gradeType);

  const [frontImage, setFrontImage] = useState<File | null>(null);
  const [backImage, setBackImage] = useState<File | null>(null);
  const [error, setError] = useState("");

  const [autofillLoading, setAutofillLoading] = useState(false);
  const [autofillRan, setAutofillRan] = useState(false);
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
    onSuccess: () => onSuccess(),
    onError: (err: any) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!form.cardGame || !form.setName || !form.cardName || !form.cardNumber || !form.year) {
      setError("Please fill in all required fields");
      return;
    }

    if (!isNonNum) {
      if (!form.gradeOverall) {
        setError("Please select an overall grade");
        return;
      }
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
        {isEdit ? `EDIT ${certificate.certId}` : "NEW CERTIFICATE"}
      </h2>
      <p className="text-gray-500 text-sm mb-6">
        {isEdit ? "Update certificate details" : "Certificate ID will be auto-generated"}
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
              <FormInput
                label="Set Name *"
                value={form.setName}
                onChange={(v) => updateField("setName", v)}
                testId="input-set-name"
              />
              <div className="mt-1.5">
                <label className="text-[#D4AF37]/40 text-[10px] uppercase tracking-wider block mb-1">Set ID (for autofill)</label>
                <input
                  type="text"
                  value={setId}
                  onChange={(e) => setSetId(e.target.value)}
                  placeholder="e.g. sv3pt5"
                  className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-2 py-1 text-white text-xs placeholder:text-[#D4AF37]/15 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
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
                    className="flex-1 bg-transparent px-2 py-2 text-white text-sm placeholder:text-[#D4AF37]/20 focus:outline-none"
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
                <div className="mt-2 border border-[#D4AF37]/20 rounded bg-black/80 max-h-40 overflow-y-auto" data-testid="autofill-suggestions">
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
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-[#D4AF37]/10 hover:text-white transition-colors"
                      data-testid={`suggestion-${s.id}`}
                    >
                      <span className="text-[#D4AF37]">{s.cardNumber}</span>
                      {" – "}
                      {s.cardName}
                      {s.rarity && <span className="text-gray-500"> ({s.rarity})</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSuggestions([])}
                    className="w-full text-center text-[10px] text-gray-500 py-1 hover:text-gray-400"
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
                      <p className="text-gray-400 text-xs mt-1">
                        Found: <span className="text-white">{fallbackMatch.cardName}</span> ({fallbackMatch.language})
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
                          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-400 transition-colors flex items-center gap-1"
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
                  <p className="text-gray-400 text-xs mt-1">
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
                      className="px-3 py-1 text-xs text-gray-500 hover:text-gray-400 transition-colors"
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
                  <span className={form.unifiedSelect ? "text-white" : "text-[#D4AF37]/20"}>
                    {form.unifiedSelect
                      ? (form.unifiedSelect === "OTHER" ? "OTHER (manual)" : getUnifiedDisplayLabel(form.unifiedSelect))
                      : "Select or type a variant..."}
                  </span>
                  <ChevronDown size={14} className="text-[#D4AF37]/50" />
                </button>
                {unifiedOpen && (
                  <div className="absolute z-50 left-0 right-0 mt-1 border border-[#D4AF37]/30 bg-black rounded-lg shadow-xl max-h-72 overflow-hidden flex flex-col" data-testid="unified-dropdown">
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
                        className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-2 py-1.5 text-white text-xs placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37]/50"
                        autoFocus
                        data-testid="input-unified-search"
                      />
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {form.unifiedSelect && (
                        <button
                          type="button"
                          onClick={() => { applyUnifiedSelection(""); setUnifiedOpen(false); }}
                          className="w-full text-left px-3 py-2 text-xs text-gray-500 hover:bg-[#D4AF37]/10 hover:text-gray-300 transition-colors border-b border-[#D4AF37]/10"
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
                          className={`w-full text-left px-3 py-2 text-sm transition-colors group ${form.unifiedSelect === o.value ? "bg-[#D4AF37]/15 text-[#D4AF37]" : "text-gray-300 hover:bg-[#D4AF37]/10 hover:text-white"}`}
                          data-testid={`unified-option-${o.value}`}
                        >
                          <span className="block">{o.label}</span>
                          {o.help && <span className="block text-[10px] text-gray-500 group-hover:text-gray-400 mt-0.5">{o.help}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {form.unifiedSelect && (() => {
                  const opt = allOptions.find((o) => o.value === form.unifiedSelect);
                  return opt?.help ? (
                    <p className="text-gray-500 text-[10px] mt-1 flex items-center gap-1" data-testid="text-unified-help">
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
                      className="w-full bg-transparent border border-[#D4AF37]/20 rounded px-3 py-2 text-white text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
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
                              className={`px-2 py-0.5 rounded text-xs border transition-colors ${form.otherText === v ? "bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37]" : "bg-transparent border-[#D4AF37]/15 text-gray-400 hover:border-[#D4AF37]/40 hover:text-gray-200"}`}
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
                    className={`px-2.5 py-1 rounded-full text-xs border transition-all ${active ? "bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37]" : "bg-transparent border-[#D4AF37]/15 text-gray-500 hover:border-[#D4AF37]/30 hover:text-gray-400"}`}
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
              <p className="text-gray-500 text-[10px] mt-1.5" data-testid="text-designations-summary">
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
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37] transition-colors resize-none"
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
                          : "border-[#D4AF37]/25 text-gray-300 hover:border-[#D4AF37]/50 hover:text-white hover:bg-[#D4AF37]/5 cursor-pointer"
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
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
              data-testid="select-grade-type"
            >
              <option value="numeric" className="bg-black">Numeric (1–10)</option>
              {NON_NUMERIC_GRADES.map(ng => (
                <option key={ng.value} value={ng.value} className="bg-black">{ng.value} – {ng.description}</option>
              ))}
            </select>
          </div>

          {isNonNum && (
            <div className="bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-lg p-3">
              <p className="text-[#D4AF37] text-sm font-semibold">
                {form.gradeType === "NO" ? "AUTHENTIC – No Numerical Grade" : "AUTHENTIC ALTERED – No Numerical Grade"}
              </p>
              <p className="text-gray-400 text-xs mt-1">
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
                  value={form.gradeOverall}
                  onChange={(e) => updateField("gradeOverall", e.target.value)}
                  className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                  data-testid="select-grade-overall"
                >
                  <option value="" className="bg-black">Select grade...</option>
                  {NUMERIC_GRADES.map(g => (
                    <option key={g.value} value={String(g.value)} className="bg-black">{g.value} – {g.label} ({g.description})</option>
                  ))}
                </select>
              </div>

            </>
          )}
        </fieldset>

        <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-4">
          <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2">Images</legend>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FileUpload
              label="Front Image"
              current={(certificate as any)?.frontImageUrl || certificate?.frontImagePath}
              onChange={setFrontImage}
              testId="input-front-image"
            />
            <FileUpload
              label="Back Image"
              current={(certificate as any)?.backImageUrl || certificate?.backImagePath}
              onChange={setBackImage}
              testId="input-back-image"
            />
          </div>
        </fieldset>

        <fieldset className="border border-[#D4AF37]/20 rounded-lg p-4">
          <legend className="text-[#D4AF37]/70 text-xs uppercase tracking-widest px-2">Status</legend>
          <div className="flex gap-4 mt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="status"
                value="draft"
                checked={form.status === "draft"}
                onChange={() => updateField("status", "draft")}
                className="accent-[#D4AF37]"
                data-testid="radio-status-draft"
              />
              <span className="text-gray-400 text-sm">Draft</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="status"
                value="active"
                checked={form.status === "active" || form.status === "published"}
                onChange={() => updateField("status", "active")}
                className="accent-[#D4AF37]"
                data-testid="radio-status-active"
              />
              <span className="text-emerald-400 text-sm">Active</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="status"
                value="voided"
                checked={form.status === "voided"}
                onChange={() => updateField("status", "voided")}
                className="accent-[#D4AF37]"
                data-testid="radio-status-voided"
              />
              <span className="text-red-400 text-sm">Voided</span>
            </label>
          </div>
        </fieldset>

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
          {mutation.isPending ? "Saving..." : isEdit ? "Update Certificate" : "Create Certificate"}
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
        className={`w-full bg-transparent border rounded px-3 py-2 text-white text-sm placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37] transition-colors ${highlight ? "border-amber-500/50" : "border-[#D4AF37]/30"}`}
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
        className="w-full bg-black border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
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

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    onChange(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
    }
  };

  const displaySrc = preview || current;

  return (
    <div>
      <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <div className="border border-[#D4AF37]/20 rounded p-3">
        {displaySrc && (
          <img src={displaySrc} alt={label} className="w-full h-32 object-contain rounded mb-2 bg-gray-900" />
        )}
        <label className="flex items-center gap-2 cursor-pointer text-[#D4AF37]/60 hover:text-[#D4AF37] text-sm transition-colors">
          <Upload size={14} />
          <span>{current && !preview ? "Replace image" : "Upload image"}</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFile}
            className="hidden"
            data-testid={testId}
          />
        </label>
      </div>
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
      <p className="text-gray-500 text-xs">Optionally link this certificate to a customer submission item. Fields will auto-populate.</p>
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
        className="w-full bg-black border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
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

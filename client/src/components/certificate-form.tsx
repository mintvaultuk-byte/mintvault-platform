import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { classifyLookupError } from "@/lib/lookup-errors";
import { displayCollectorNumber } from "@shared/collector-number-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RarityVariantPicker } from "@/components/rarity-picker/RarityVariantPicker";
import { ReviewSummary } from "@/components/grading-workflow/ReviewSummary";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";
import { CertificatePreviewPanel } from "@/components/grading-workflow/CertificatePreviewPanel";
import { CanonicalGradingWorkstationShell } from "@/components/grading-workflow/CanonicalGradingWorkstationShell";
import { VariantSummary } from "@/components/grading-workflow/VariantSummary";
import { deriveStageCompletion, furthestReached } from "@shared/grading-workflow";
import { CONSOLIDATED_VARIANT_SCHEME, legacyFreeTextLostOnConversion } from "@shared/variant-line";
import { languageByValueOrLabel, type StructuredCardVariant } from "@shared/pokemon-rarity-catalogue";
import type { CertificateRecord, CardMaster } from "@shared/schema";
import { NON_NUMERIC_GRADES, isNonNumericGrade, isValidNumericGrade } from "@shared/schema";
import {
  Save,
  Upload,
  Search,
  Check,
  AlertTriangle,
  X,
  ChevronDown,
  HelpCircle,
  Link2,
  FileText,
  Copy,
  Plus,
  Cpu,
  Loader2,
  CheckCircle2,
  Trash2,
  RefreshCw,
  Database,
  Pencil,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { autofillCard, type AutofillResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { mapRarityTextToCode } from "@/lib/rarityOptions";
import { mapVariantTextToCode } from "@/lib/variantOptions";
import { deriveVariantFromIdentification, splitSetDesignation } from "@shared/variant-derive";
import { CONFLICT_GUARDED_FIELDS } from "@shared/edit-conflict";
import {
  UNIFIED_OPTIONS,
  parseUnifiedValue,
  buildUnifiedValue,
  buildOtherText,
  getUnifiedDisplayLabel,
  type UnifiedOption,
} from "@/lib/unifiedCardOptions";
import { DESIGNATION_OPTIONS, getDesignationLabel } from "@/lib/designationOptions";
import { readLastCardContext, writeLastCardContext, type LastCardContext } from "@/lib/last-card-context";
import GradientButton from "@/components/ui/gradient-button";

interface Props {
  certificate: CertificateRecord | null;
  onSuccess: (newCert?: any) => void;
  onIdentifyAndGrade?: (result: { analysis: any; identification: any }) => void;
  /** External identification pushed from AI panel's "Change card" button */
  externalIdentification?: Record<string, unknown> | null;
  onExternalIdentificationConsumed?: () => void;
  /** Owner directive (2026-07-01): the grading workstation renders INSIDE this
      form's flow — after AI Identify, before Card Details — so the whole page
      reads as one block: identify → grade with the card tool → fill details →
      grade section. Passed as a slot so the workstation stays a separate
      component (and outside the <form> element — its buttons must never
      trigger a form submit). */
  workstationSlot?: ReactNode;
  /** Optional grading-queue context (display + Next Card navigation only). When
      absent the form behaves exactly as before — no progress, no Next Card. */
  queue?: {
    position: number; // 1-based position of the current card in the queue
    total: number;
    hasNext: boolean;
    onNext: () => void; // open the next queued draft (parent-owned navigation)
    onBackToQueue?: () => void;
  };
  /** Optional read-only batch header (customer / submission / remaining). */
  batch?: { customer?: string; submissionId?: string; remaining?: number };
  correctionMode?: boolean;
  onCorrectionMetadataReady?: (getFormData: () => FormData) => void;
}

/**
 * Card-game options. Slug = canonical DB value (matches the AI identification
 * pipeline's `detected_game` enum + the server's `lookupCard` branches).
 * Label = human display name. Slug is what round-trips to the DB; label is
 * what the dropdown shows.
 *
 * Legacy migration: certs saved before this refactor may have stored the
 * label string ("Pokémon") in the card_game column. `slugifyCardGame()`
 * below normalises both forms back to the slug at form-load time.
 */
const cardGames: { value: string; label: string }[] = [
  { value: "pokemon", label: "Pokémon" },
  { value: "yugioh", label: "Yu-Gi-Oh!" },
  { value: "mtg", label: "Magic: The Gathering" },
  { value: "onepiece", label: "One Piece" },
  { value: "digimon", label: "Digimon" },
  { value: "lorcana", label: "Lorcana" },
  { value: "sports", label: "Sports" },
  { value: "other", label: "Other" },
];

/**
 * Map a stored card_game value to its canonical slug. Accepts:
 *  - Already-slug form ("pokemon", "mtg") → returned as-is
 *  - Legacy display labels ("Pokémon", "Magic: The Gathering") → mapped to slug
 *  - Empty/unknown → ""
 */
function slugifyCardGame(stored: string | null | undefined): string {
  if (!stored) return "";
  const s = String(stored).trim();
  if (!s) return "";
  // Already a known slug
  if (cardGames.some((g) => g.value === s)) return s;
  // Match against label (case-insensitive, normalise é/è and punctuation)
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[éè]/g, "e")
      .replace(/[^a-z0-9]/g, "");
  const target = norm(s);
  const byLabel = cardGames.find((g) => norm(g.label) === target);
  if (byLabel) return byLabel.value;
  // Last-ditch: aliases used historically in the codebase
  if (target === "magic" || target === "magicthegathering") return "mtg";
  if (target === "pokemontcg") return "pokemon";
  if (target === "yugiohtcg") return "yugioh";
  return "";
}

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
type AutofillField = (typeof AUTOFILL_FIELDS)[number];
type ProtectedField = AutofillField | "designations";

/**
 * The ONE mapping from a certificate row to editable form state.
 *
 * Used both for the initial seed and for the cross-certificate reset, so the two
 * can never drift — a field added here is re-seeded on a cert switch for free.
 * Every editable value is derived from `cert`; nothing is carried over from a
 * previously edited certificate. Exported so the isolation contract is
 * unit-testable without a DOM (this repo has no jsdom/RTL).
 */
export function buildFormStateFromCert(
  certInput: (CertificateRecord & Record<string, any>) | null | undefined
) {
  const cert = certInput as (CertificateRecord & Record<string, any>) | null | undefined;
  const initRarity = cert?.rarity || "";
  const initVariant = cert?.variant || "";
  const initCollCode = cert?.collectionCode || "";
  const initRarityOther = cert?.rarityOther || "";
  const initVariantOther = cert?.variantOther || "";
  const initCollOther = cert?.collectionOther || "";
  return {
    gradeType: cert?.gradeType || "numeric",
    serviceTier: "",
    // Coerced to string: the field is a text input and the payload builder
    // stringifies it anyway. (Previously reached this state via an `as any`.)
    submissionItemId: cert?.submissionItemId ? String(cert.submissionItemId) : "",
    cardGame: slugifyCardGame(cert?.cardGame),
    setName: cert?.setName || "",
    cardName: cert?.cardName === "(untitled)" || cert?.cardName === "(pending)" ? "" : cert?.cardName || "",
    cardNumber: cert?.cardNumber || "",
    rarity: initRarity,
    rarityOther: initRarityOther,
    collectionCode: initCollCode,
    collectionOther: initCollOther,
    variant: initVariant,
    variantOther: initVariantOther,
    unifiedSelect: buildUnifiedValue(
      initRarity,
      initVariant,
      initCollCode,
      initRarityOther,
      initVariantOther,
      initCollOther
    ),
    otherText: buildOtherText(initRarityOther, initVariantOther, initCollOther),
    language: cert?.language || "English",
    year: cert?.year || "",
    notes: cert?.notes || "",
    gradeOverall: cert?.gradeOverall || "",
    labelType: cert?.labelType || "standard",
    status: cert?.status || "active",
    // Structured Pokémon rarity/variant (visual picker). Seeded from the cert's
    // structured columns so an edit re-sends them unchanged (never erased). The
    // legacy `variant`/`rarity` above stay as the historical source of truth.
    rarityCode: cert?.rarityCode || "",
    finishVariant: cert?.finishVariant || "",
    promoType: cert?.promoType || "",
    subsetName: cert?.subsetName || "",
    era: cert?.era || "",
  };
}

export default function CertificateForm({
  certificate,
  onSuccess,
  onIdentifyAndGrade,
  externalIdentification,
  onExternalIdentificationConsumed,
  workstationSlot,
  queue,
  batch,
  correctionMode = false,
  onCorrectionMetadataReady,
}: Props) {
  const isEdit = !!certificate;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState(() => buildFormStateFromCert(certificate));

  const [designations, setDesignations] = useState<string[]>(() => (certificate?.designations as string[]) || []);
  // Grader notes live in Stage 4 (Review), collapsed unless the cert already has notes.
  const [notesOpen, setNotesOpen] = useState<boolean>(() => Boolean(certificate?.notes));

  // Session HUD: count of cards completed (explicit save success) this session.
  const [sessionCompleted, setSessionCompleted] = useState(0);
  // "✓ Saved" confirmation toast — fades ~2.5s after a successful explicit save.
  const [savedToast, setSavedToast] = useState(false);
  // Post-save panel (only when a queue is provided): Saved → Next Card / Back.
  const [showSavedPanel, setShowSavedPanel] = useState(false);
  // Fields to briefly highlight (~1s) after a quick-fill, for visual feedback.
  const [flashFields, setFlashFields] = useState<Set<string>>(new Set());
  const flashApplied = (keys: string[]) => {
    setFlashFields(new Set(keys));
    window.setTimeout(() => setFlashFields(new Set()), 1000);
  };

  // "Same as last card" — remember the shared identification context of the last
  // card a grader processed (game/set/year/language, NOT the per-card name/number)
  // so a box of the same set fills in one click. Display convenience only: it is
  // captured locally on Continue and only applied when the grader clicks it, and
  // it never overwrites a field that already has a value.
  const [lastCardContext, setLastCardContext] = useState<LastCardContext | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return readLastCardContext(window.sessionStorage);
    } catch {
      return null;
    }
  });
  function captureLastCardContext() {
    const ctx = { cardGame: form.cardGame, setName: form.setName, setId, year: form.year, language: form.language };
    if (!ctx.setName && !ctx.year) return; // nothing worth remembering yet
    const safeContext = typeof window === "undefined" ? ctx : writeLastCardContext(window.sessionStorage, ctx);
    setLastCardContext(safeContext);
  }
  function applyLastCardContext() {
    if (!lastCardContext) return;
    const filled: string[] = [];
    setForm((f) => {
      const next = { ...f };
      if (!f.cardGame && lastCardContext.cardGame) {
        next.cardGame = lastCardContext.cardGame;
        filled.push("cardGame");
      }
      if (!f.setName && lastCardContext.setName) {
        next.setName = lastCardContext.setName;
        filled.push("setName");
      }
      if (!f.year && lastCardContext.year) {
        next.year = lastCardContext.year;
        filled.push("year");
      }
      if (!f.language && lastCardContext.language) {
        next.language = lastCardContext.language;
        filled.push("language");
      }
      return next;
    });
    if (!setId && lastCardContext.setId) setSetId(lastCardContext.setId);
    if (filled.length) flashApplied(filled);
  }
  /** Copy one shared field from the last card (explicit per-field action). */
  function copyLastCardField(field: "setName" | "year" | "language") {
    if (!lastCardContext) return;
    const val = lastCardContext[field];
    if (!val) return;
    updateField(field, val);
    if (field === "setName" && lastCardContext.setId && !setId) setSetId(lastCardContext.setId);
    flashApplied([field]);
  }

  // ── Structured rarity/variant picker wiring ────────────────────────────────
  // The picker emits a full StructuredCardVariant; we fan it out to the separate
  // form keys (which auto-serialise to the save payload) and keep the existing
  // `language` field in sync. A no-op guard prevents the picker's mount-time
  // onChange from dirtying the form (which would trigger a spurious auto-save).
  const handleStructuredChange = useCallback((v: StructuredCardVariant) => {
    setForm((f) => {
      const langLabel = languageByValueOrLabel(v.language)?.label ?? f.language;
      if (
        f.rarityCode === (v.rarity ?? "") &&
        f.finishVariant === (v.finish ?? "") &&
        f.promoType === (v.promo ?? "") &&
        f.subsetName === (v.subset ?? "") &&
        f.era === (v.era ?? "") &&
        f.language === langLabel
      ) {
        return f;
      }
      return {
        ...f,
        rarityCode: v.rarity ?? "",
        finishVariant: v.finish ?? "",
        promoType: v.promo ?? "",
        subsetName: v.subset ?? "",
        era: v.era ?? "",
        language: langLabel,
      };
    });
  }, []);

  // Per-admin favourites / recently-used (server-persisted via pipeline_settings).
  // Undefined until loaded → the picker falls back to localStorage in the meantime.
  const [rarityFavourites, setRarityFavourites] = useState<string[] | undefined>(undefined);
  const [rarityRecent, setRarityRecent] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    let active = true;
    fetch("/api/admin/rarity-preferences", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { favourites: [], recent: [] }))
      .then((p) => {
        if (!active) return;
        setRarityFavourites(Array.isArray(p?.favourites) ? p.favourites : []);
        setRarityRecent(Array.isArray(p?.recent) ? p.recent : []);
      })
      .catch(() => {
        if (active) {
          setRarityFavourites([]);
          setRarityRecent([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const persistPrefs = useCallback((favourites: string[], recent: string[]) => {
    void fetch("/api/admin/rarity-preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favourites, recent }),
    }).catch(() => {});
  }, []);
  const onFavouritesChange = useCallback(
    (favs: string[]) => {
      setRarityFavourites(favs);
      persistPrefs(favs, rarityRecent ?? []);
    },
    [persistPrefs, rarityRecent]
  );
  const onRecentChange = useCallback(
    (rec: string[]) => {
      setRarityRecent(rec);
      persistPrefs(rarityFavourites ?? [], rec);
    },
    [persistPrefs, rarityFavourites]
  );

  // Stale-tab guard: snapshot of the metadata values this form loaded. Sent
  // with every save so the server can detect a field someone ELSE changed
  // since (field-scoped — grade saves on this same page never conflict; see
  // shared/edit-conflict.ts). Refreshed from the cert prop on refetch and
  // from each save's own posted values on success (self-healing).
  const loadedSnapshotRef = useRef<Record<string, string> | null>(null);
  // Whether the SAVED cert already prints the consolidated variant line
  // (structuredVariantVersion ≥ CONSOLIDATED_VARIANT_SCHEME). Refreshed from the
  // cert prop and from every save's response row inside refreshSnapshotFromCert.
  // A pre-consolidation cert that carries structured columns will change its
  // printed variant line the next time it is saved, so the preview (which shows
  // the post-save wording) legitimately differs from what is printed today.
  const savedConsolidatedRef = useRef(false);
  // Conversion warning: the wordings that will stop printing when this save
  // converts the cert to the consolidated scheme (null = nothing to warn about).
  // The ack ref is per-certificate and is reset by the isolation effect, so the
  // warning appears ONCE, at the boundary — never again on a v2 certificate.
  const [legacyLossWarning, setLegacyLossWarning] = useState<string[] | null>(null);
  const legacyLossAckRef = useRef(false);

  // Label-freshness signal for the Review certificate preview. Compares ONLY the
  // fields that affect the printed label against the last SAVED snapshot (server
  // truth, refreshed after every save/auto-save via refreshSnapshotFromCert) —
  // DELIBERATELY excluding server-derived fields (labelType/status), whose casing
  // the server rewrites ("standard" → "Standard"); comparing those would pin the
  // preview to "Unsaved changes" forever after the first save. Create flow: always
  // "unsaved" because nothing is printed yet. Both sides are trimmed so a stored
  // value and the live form value normalise identically.
  // (The former labelPreviewDirty() "unsaved changes" helper drove the removed
  //  second LabelPreview panel; the canonical CertificatePreviewPanel renders
  //  live from the current field values, so no dirty check is needed here.)

  /** Snapshot = SERVER truth for the guarded fields. Always refreshed from a
      cert row (prop refetch or a save's response) — never from what we posted,
      because the server coerces some fields on write (empty language →
      "English", *Other cleared unless selector is OTHER) and a posted≠written
      snapshot would false-conflict against our own save forever. */
  function refreshSnapshotFromCert(row: Record<string, unknown> | null | undefined) {
    if (!row || typeof row !== "object") return;
    const snap: Record<string, string> = {};
    for (const f of CONFLICT_GUARDED_FIELDS) {
      const v = (row as any)[f];
      snap[f] = v === null || v === undefined ? "" : String(v);
    }
    loadedSnapshotRef.current = snap;
    const ver = Number((row as any).structuredVariantVersion ?? 0);
    savedConsolidatedRef.current = ver >= CONSOLIDATED_VARIANT_SCHEME;
  }

  useEffect(() => {
    if (certificate) refreshSnapshotFromCert(certificate as any);
  }, [certificate]);

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
    const clean = (v: any) => (isEmpty(v) ? "" : String(v));

    setForm((prev) => {
      let changed = false;
      const next = { ...prev };
      const cn = clean(certificate.cardName);
      const yr = normalizeYear(certificate.year);
      if (isEmpty(prev.cardName) && cn) {
        next.cardName = cn;
        changed = true;
      }
      if (isEmpty(prev.setName) && clean(certificate.setName)) {
        next.setName = clean(certificate.setName);
        changed = true;
      }
      if (isEmpty(prev.cardNumber) && clean(certificate.cardNumber)) {
        next.cardNumber = clean(certificate.cardNumber);
        changed = true;
      }
      if (isEmpty(prev.year) && yr) {
        next.year = yr;
        changed = true;
      }
      if (isEmpty(prev.cardGame) && slugifyCardGame(certificate.cardGame)) {
        next.cardGame = slugifyCardGame(certificate.cardGame);
        changed = true;
      }
      if (isEmpty(prev.language) && clean(certificate.language)) {
        next.language = clean(certificate.language);
        changed = true;
      }
      if (isEmpty(prev.rarity) && clean((certificate as any)?.rarity)) {
        next.rarity = clean((certificate as any).rarity);
        changed = true;
      }
      if (isEmpty(prev.variant) && clean((certificate as any)?.variant)) {
        next.variant = clean((certificate as any).variant);
        changed = true;
      }
      if (isEmpty(prev.gradeOverall) && certificate.gradeOverall) {
        next.gradeOverall = certificate.gradeOverall;
        changed = true;
      }
      if (changed) toast({ title: "Card details auto-filled from AI" });
      return changed ? next : prev;
    });
    // eslint-disable-next-line
  }, [certificate?.cardName, certificate?.setName, certificate?.cardNumber, certificate?.year]);

  const isNonNum = isNonNumericGrade(form.gradeType);

  const [frontImage, setFrontImage] = useState<File | null>(null);
  const [backImage, setBackImage] = useState<File | null>(null);
  const [error, setError] = useState("");

  const [autofillLoading, setAutofillLoading] = useState(false);
  const [autofillRan, setAutofillRan] = useState(false);

  // AI Identify & Grade state — split into two independent operations
  const [identifyLoading, setIdentifyLoading] = useState(false);
  const [gradeLoading, setGradeLoading] = useState(false);
  const [identifyConfidence, setIdentifyConfidence] = useState<string | null>(null);
  const [identifyVerified, setIdentifyVerified] = useState(false);
  // The PROPOSED identification from the last SUCCESSFUL AI identify — kept
  // separate from the form so the panel never presents stale existing
  // certificate values (e.g. a previous Rayquaza/#014) as a new result. Null
  // until a real result arrives; cleared on any identify failure.
  const [identifyResult, setIdentifyResult] = useState<{
    name: string;
    number: string;
    year: string;
    language: string;
    rarity: string;
    variant: string;
  } | null>(null);
  // Structured error for the TCG search dialog (distinguishes a transport /
  // provider failure from a legitimate zero-result).
  const [tcgError, setTcgError] = useState<string | null>(null);
  // Manual card-detail fields are part of the NORMAL verification process (not
  // an exceptional fallback) and always render — see manualEditorRef below,
  // used only to scroll them into view from the "Edit" affordance.
  const manualEditorRef = useRef<HTMLDivElement>(null);

  // AI feature flags (for gating the Identify / Grade buttons)
  const { data: aiFlags } = useQuery<{ flags: Array<{ name: string; enabled: boolean }> }>({
    queryKey: ["/api/admin/ai-feature-flags"],
    queryFn: async () => {
      const r = await fetch("/api/admin/ai-feature-flags", { credentials: "include" });
      if (!r.ok) return { flags: [] };
      return r.json();
    },
    staleTime: 60_000,
  });
  const flagsByName = (aiFlags?.flags || []).reduce<Record<string, boolean>>((acc, f) => {
    acc[f.name] = f.enabled;
    return acc;
  }, {});
  const identifyEnabled = flagsByName["AI_IDENTIFY_ENABLED"] !== false; // default ON
  const fullGradeEnabled = flagsByName["AI_FULL_GRADE_ENABLED"] === true; // default OFF

  // TCG manual search state
  const [tcgSearchOpen, setTcgSearchOpen] = useState(false);
  const [tcgQuery, setTcgQuery] = useState("");
  const [tcgResults, setTcgResults] = useState<
    {
      id: string;
      name: string;
      setName: string;
      number: string | null;
      rarity: string | null;
      year: string | null;
      imageUrl: string | null;
    }[]
  >([]);
  const [tcgLoading, setTcgLoading] = useState(false);
  const [tcgCache] = useState(() => new Map<string, typeof tcgResults>());
  const [manuallyVerified, setManuallyVerified] = useState(false);
  const tcgDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Accept identification from the AI panel (workstation "AI Identify" /
  // "Change card"). This is the path the admin grading flow actually uses, so
  // it must fill the same fields as the form's own AI Identify — including
  // variant (from the AI's finish detection) and language, which used to be
  // skipped here and left blank. All fields stay editable.
  useEffect(() => {
    if (externalIdentification) {
      const id = externalIdentification as any;
      // Owner ruling (option B): a designation in the set name ("… Trainer
      // Gallery", "… Black Star Promos") moves off the set line into Variant.
      const setSplit = splitSetDesignation(id.officialSet || id.detected_set || "");
      const aiVariant = setSplit.designation || deriveVariantFromIdentification(id);
      setForm((prev) => ({
        ...prev,
        cardName: id.officialName || id.detected_name || prev.cardName,
        setName: setSplit.baseSet || prev.setName,
        cardNumber: id.officialNumber || id.detected_number || prev.cardNumber,
        year: id.detected_year || prev.year,
        // Variant/Rarity are exactly-one-of: a designation/finish claims Variant
        // and clears Rarity so the save guard can never see both populated.
        rarity: aiVariant ? "" : id.detected_rarity || prev.rarity,
        variant: aiVariant || prev.variant,
        language: id.detected_language || prev.language,
        // Keep the visible unified control in sync with what will be saved —
        // otherwise the dropdown shows the old value while the payload changed.
        ...(aiVariant ? { unifiedSelect: `VARIANT:${aiVariant}`, otherText: "" } : {}),
      }));
      setManuallyVerified(true);
      onExternalIdentificationConsumed?.();
    }
  }, [externalIdentification]);

  function handleTcgSearch(query: string) {
    setTcgQuery(query);
    if (tcgDebounceRef.current) clearTimeout(tcgDebounceRef.current);
    if (query.trim().length < 3) {
      setTcgResults([]);
      setTcgLoading(false);
      return;
    }

    const cacheKey = `${form.cardGame || "pokemon"}:${query.trim().toLowerCase()}`;
    if (tcgCache.has(cacheKey)) {
      setTcgError(null);
      setTcgResults(tcgCache.get(cacheKey)!);
      return;
    }

    setTcgLoading(true);
    setTcgError(null);
    tcgDebounceRef.current = setTimeout(async () => {
      // Transport vs response: a thrown fetch = server unreachable; a non-2xx =
      // classified provider/auth/invalid error. Both must be distinguishable from
      // a legitimate empty result set (which is NOT an error).
      let res: Response;
      try {
        const gameSlug = (form.cardGame || "pokemon")
          .toLowerCase()
          .replace(/[éè]/g, "e")
          .replace(/[^a-z0-9]/g, "");
        const fetchUrl = `/api/admin/card-lookup?game=${encodeURIComponent(gameSlug)}&query=${encodeURIComponent(query.trim())}&mode=wildcard`;
        console.log("[tcg-search] fetching:", fetchUrl);
        res = await fetch(fetchUrl, { credentials: "include" });
      } catch (netErr) {
        setTcgResults([]);
        setTcgError(classifyLookupError({ thrown: netErr }).message);
        setTcgLoading(false);
        return;
      }
      try {
        let data: any = null;
        try {
          data = await res.json();
        } catch {
          /* non-JSON */
        }
        if (!res.ok) {
          setTcgResults([]);
          setTcgError(classifyLookupError({ status: res.status, body: data }).message);
          return;
        }
        const results = Array.isArray(data) ? data : [];
        tcgCache.set(cacheKey, results);
        setTcgError(null); // success — an empty list here is a real zero-result, not an error
        setTcgResults(results);
      } finally {
        setTcgLoading(false);
      }
    }, 400);
  }

  function selectTcgCard(card: (typeof tcgResults)[number]) {
    setForm((prev) => ({
      ...prev,
      cardName: card.name || prev.cardName,
      setName: card.setName || prev.setName,
      cardNumber: card.number || prev.cardNumber,
      year: card.year || prev.year,
      rarity: card.rarity || prev.rarity,
    }));
    // A manually-selected TCG card IS a confirmed result — reflect it as the
    // proposed/verified identification so the panel shows it (not stale data).
    setIdentifyResult({
      name: card.name || "",
      number: card.number || "",
      year: card.year || "",
      language: form.language || "",
      rarity: card.rarity || "",
      variant: "",
    });
    setIdentifyVerified(true);
    setManuallyVerified(true);
    setTcgSearchOpen(false);
    setTcgQuery("");
    setTcgResults([]);
    setTcgError(null);
    toast({
      title: "Card selected",
      description: `${card.name} — ${card.setName}${card.number ? ` ${displayCollectorNumber(card.number)}` : ""}`,
    });

    // Sync manual verification to AI panel via the existing pipeline
    const manualId = {
      detected_name: card.name || "",
      detected_set: card.setName || "",
      detected_number: card.number || null,
      detected_year: card.year || null,
      detected_game: form.cardGame || "pokemon",
      detected_language: form.language || "English",
      detected_rarity: card.rarity || null,
      is_holo: false,
      confidence: "high",
      verified: true,
      officialName: card.name || "",
      officialSet: card.setName || "",
      officialNumber: card.number || null,
      referenceImageUrl: card.imageUrl || null,
      dbSource: "manual-tcg-search",
      manuallyVerified: true,
    };
    onIdentifyAndGrade?.({ analysis: null, identification: manualId });
  }

  // AI Identify — populates ONLY card metadata (name/set/number/year/rarity/lang).
  // Hits the new /identify endpoint (split out from /identify-and-analyze so the
  // operator can run identify without burning Opus tokens on a full grade).
  async function runIdentify() {
    if (!isEdit || !certificate?.id) return;
    setIdentifyLoading(true);
    setIdentifyConfidence(null);
    // Transport layer: fetch() throws only when the request never reaches the
    // server (down/offline) — surface an actionable message, not "Failed to fetch".
    let res: Response;
    try {
      res = await fetch(`/api/admin/certificates/${certificate.id}/identify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
    } catch (netErr) {
      const c = classifyLookupError({ thrown: netErr });
      setIdentifyResult(null); // never leave a stale result looking current
      toast({ title: c.title, description: c.message, variant: "destructive" });
      setIdentifyLoading(false);
      return;
    }
    try {
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const c = classifyLookupError({ status: res.status, body: data });
        setIdentifyResult(null);
        toast({ title: c.title, description: c.message, variant: "destructive" });
        return;
      }

      // /identify returns everything NESTED under `identification`, with
      // detected_* names + set_code — NOT flat card_name/set_id. Read from there.
      // (Reading the old flat shape made the guard always-false → 0 TCGdex lookups.)
      const id = data.identification ?? data;

      setIdentifyConfidence(id.confidence ?? null);
      setIdentifyVerified(!!id.verified);

      if (id.detected_name || id.set_code || id.detected_number) {
        const aiVariant = deriveVariantFromIdentification(id);
        // Record the PROPOSED identification separately from the form so the panel
        // shows the real result (and never the pre-existing certificate values).
        setIdentifyResult({
          name: id.detected_name || id.officialName || "",
          number: id.detected_number || "",
          year: id.detected_year || "",
          language: id.detected_language || "",
          rarity: id.detected_rarity || "",
          variant: aiVariant || "",
        });
        const isEmpty = (v: any) => !v || v === "" || v === "(pending)" || v === "(untitled)";
        // Fill BLANK fields only — never overwrite populated certificate details
        // from the AI guess (the grader confirms via Accept, or TCGdex enrichment
        // below supplies the authoritative set/name on a confirmed match).
        const fillBlank = (next: any, prev: any) => (isEmpty(prev) ? next || prev : prev);
        setForm((prev) => ({
          ...prev,
          cardName: fillBlank(id.detected_name, prev.cardName),
          // setName is intentionally NOT taken from the AI — TCGdex is the SOLE
          // source of set metadata (runTcgdexPrefill below). Prefilling it from
          // detected_set was the original Scarlet & Violet mis-prefill bug.
          cardNumber: fillBlank(id.detected_number, prev.cardNumber),
          year: fillBlank(id.detected_year, prev.year),
          rarity: fillBlank(id.detected_rarity, prev.rarity),
          // Language is deterministic (script-based detection), so always fill it when
          // identify returns one — don't gate like the other fields, or the non-empty
          // "English" default keeps it stuck. The TCGdex lookup below overrides with the
          // authoritative resolved language when a set resolves. Stays editable.
          language: id.detected_language || prev.language,
          // Variant fills from the AI's finish detection into a blank slot only.
          variant: fillBlank(aiVariant, prev.variant),
        }));
        toast({
          title: "Card identified",
          description: `${id.detected_name || id.officialName || "Card"}${id.detected_number ? ` · ${displayCollectorNumber(id.detected_number)}` : ""}`,
        });

        // TCGdex enrichment — the ONLY source of canonical set/name/year. Fires
        // whenever the AI extracted a set code + number.
        if (id.set_code && id.detected_number) {
          console.info("[tcgdex-prefill] firing lookup", {
            code: id.set_code,
            number: id.detected_number,
            lang: id.detected_language,
          });
          runTcgdexPrefill(id.set_code, id.detected_number, id.detected_language || "English", certificate?.id);
        } else if (id.detected_name && id.detected_number) {
          // No set code (the AI couldn't read it): resolve the set from name+number
          // against the imported English TCGdex catalogue. Still TCGdex-sourced, so
          // the "set is never the AI's guess" rule holds — fills only on a confirmed
          // unique match, else leaves Set blank.
          console.info("[tcgdex-prefill] no set_code — trying name+number resolution", {
            name: id.detected_name,
            number: id.detected_number,
          });
          runTcgdexPrefillByName(id.detected_name, id.detected_number, id.detected_language || "English");
        } else {
          console.info("[tcgdex-prefill] skipped — no set_code/number from identify", {
            set_code: id.set_code,
            detected_number: id.detected_number,
          });
        }
      } else {
        // A genuine zero-result (the request succeeded, no card matched) — NOT a
        // transport error. Clear any prior proposal so nothing stale is shown.
        setIdentifyResult(null);
        toast({
          title: "No confident match",
          description: "The card couldn’t be identified automatically — enter the details manually below.",
          variant: "destructive",
        });
      }
    } catch (e: any) {
      const c = classifyLookupError({ thrown: e });
      setIdentifyResult(null);
      toast({ title: c.title, description: c.message, variant: "destructive" });
    } finally {
      setIdentifyLoading(false);
    }
  }

  /** TCGdex canonical metadata lookup — enriches set/card fields after AI identify */
  async function runTcgdexPrefill(setCode: string, cardNumber: string, language: string, certDbId?: number) {
    const langMap: Record<string, string> = {
      english: "en",
      japanese: "ja",
      french: "fr",
      german: "de",
      spanish: "es",
      italian: "it",
      portuguese: "pt",
      korean: "ko",
      "traditional chinese": "zh-tw",
      "simplified chinese": "zh-cn",
    };
    const lang = langMap[language.toLowerCase()] || "en";
    try {
      const r = await fetch(
        `/api/admin/tcgdex-lookup?code=${encodeURIComponent(setCode)}&number=${encodeURIComponent(cardNumber)}&lang=${encodeURIComponent(lang)}${certDbId ? `&certId=${certDbId}` : ""}`,
        { credentials: "include" }
      );
      if (!r.ok) {
        let body: { error?: string } | null = null;
        try {
          body = await r.json();
        } catch {
          /* non-JSON */
        }
        const c = classifyLookupError({ status: r.status, body });
        // Best-effort enrichment, but surface a transport/provider/auth failure so
        // the grader knows the set wasn't confirmed (not a silently-blank Set).
        if (c.kind !== "not_found") toast({ title: c.title, description: c.message, variant: "destructive" });
        return;
      }
      const td = await r.json();
      if (!td.found) return;

      // Authoritative language: the endpoint the card actually resolved on (the set code
      // determines it). Maps the TCGdex lang code to the form's Language value. Overrides
      // identify's detected_language. Falls through to prev if the code is unknown.
      const langLabel: Record<string, string> = {
        ja: "Japanese",
        en: "English",
        ko: "Korean",
        "zh-tw": "Chinese",
        "zh-cn": "Chinese",
        fr: "French",
        de: "German",
        es: "Spanish",
        it: "Italian",
        pt: "Portuguese",
      };

      // Owner ruling (option B): strip a trailing designation from the TCGdex
      // set name — base set stays on the set line, designation fills Variant
      // (clearing Rarity: the two are exactly-one-of).
      const tdSplit = splitSetDesignation(td.set_name || "");
      setForm((prev) => ({
        ...prev,
        cardName: td.card_name?.toUpperCase() || prev.cardName,
        setName: tdSplit.baseSet || prev.setName,
        year: td.release_date ? td.release_date.split("-")[0] : prev.year,
        language: (td.resolved_lang && langLabel[td.resolved_lang]) || prev.language,
        ...(tdSplit.designation
          ? { variant: tdSplit.designation, rarity: "", unifiedSelect: `VARIANT:${tdSplit.designation}`, otherText: "" }
          : {}),
      }));

      const badge = td.auto_added ? " (set auto-added)" : td.needs_manual_add ? " (set needs manual add)" : "";
      toast({ title: `TCGdex enriched${badge}`, description: `${td.card_name} — ${td.set_name}` });
    } catch (e) {
      const c = classifyLookupError({ thrown: e });
      toast({ title: c.title, description: c.message, variant: "destructive" });
    }
  }

  /** English-only fallback: resolve the SET from card name + number when the AI
   *  couldn't read the set code. Still TCGdex-sourced (server confirms a UNIQUE
   *  match in the imported catalogue), so the "set is never the AI's guess" rule
   *  holds — fills Set only on a confirmed match, otherwise leaves it blank. */
  async function runTcgdexPrefillByName(name: string, cardNumber: string, language: string) {
    if (language && language.toLowerCase() !== "english") return; // English only this phase
    try {
      const r = await fetch(
        `/api/admin/tcgdex-resolve-set?name=${encodeURIComponent(name)}&number=${encodeURIComponent(cardNumber)}`,
        { credentials: "include" }
      );
      if (!r.ok) {
        let body: { error?: string } | null = null;
        try {
          body = await r.json();
        } catch {
          /* non-JSON */
        }
        const c = classifyLookupError({ status: r.status, body });
        if (c.kind !== "not_found") toast({ title: c.title, description: c.message, variant: "destructive" });
        return;
      }
      const td = await r.json();
      if (!td.found) return;
      // Same designation split as runTcgdexPrefill (owner ruling, option B).
      const tdSplit = splitSetDesignation(td.set_name || "");
      setForm((prev) => ({
        ...prev,
        setName: tdSplit.baseSet || prev.setName,
        year: td.release_date ? td.release_date.split("-")[0] : prev.year,
        ...(tdSplit.designation
          ? { variant: tdSplit.designation, rarity: "", unifiedSelect: `VARIANT:${tdSplit.designation}`, otherText: "" }
          : {}),
      }));
      toast({ title: "TCGdex set resolved", description: `${name} → ${td.set_name}` });
    } catch (e) {
      const c = classifyLookupError({ thrown: e });
      // Only a transport failure is worth a toast here; anything else leaves Set blank.
      if (c.kind === "network") toast({ title: c.title, description: c.message, variant: "destructive" });
    }
  }

  // AI Full Grade — Opus 4.7 across all images, populates ONLY grade columns.
  // Gated server-side on AI_FULL_GRADE_ENABLED; UI gates on the same flag.
  async function runGrade() {
    if (!isEdit || !certificate?.id) return;
    setGradeLoading(true);
    try {
      const res = await fetch(`/api/admin/certificates/${certificate.id}/grade`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Grade failed");

      toast({
        title: "Card graded",
        description: `Grade ${data.overall ?? "?"} ${data.grade_label || ""} · C${data.centering ?? "?"}/Co${data.corners ?? "?"}/E${data.edges ?? "?"}/S${data.surface ?? "?"}`,
      });

      // Refresh cert in parent so the grading panel reads the new subgrades.
      // pendingAnalysis path expects an AiAnalysisResult shape — we don't have
      // the per-corner breakdown here, only aggregates, so reuse the existing
      // identification-only callback to refetch the cert without overwriting
      // the AI panel's grading state with empty per-corner data.
      onIdentifyAndGrade?.({ analysis: null, identification: null });
    } catch (e: any) {
      toast({ title: "Grade failed", description: e.message, variant: "destructive" });
    } finally {
      setGradeLoading(false);
    }
  }
  const [manuallyEdited, setManuallyEdited] = useState<Set<ProtectedField>>(new Set());
  const [suggestions, setSuggestions] = useState<CardMaster[]>([]);
  const [fallbackMatch, setFallbackMatch] = useState<CardMaster | null>(null);
  const [fallbackSetName, setFallbackSetName] = useState<string | null>(null);
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    fields: ProtectedField[];
    card: CardMaster;
    setName: string | null;
  } | null>(null);
  const [unifiedSearch, setUnifiedSearch] = useState("");
  const [unifiedOpen, setUnifiedOpen] = useState(false);
  const unifiedRef = useRef<HTMLDivElement>(null);

  const [customVariants, setCustomVariants] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("mv-custom-variants") || "[]");
    } catch {
      return [];
    }
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
  // Stable preview URLs keyed to the File objects — object URLs were being
  // re-minted on EVERY render (URL.createObjectURL called inline in JSX),
  // leaking a blob URL on each keystroke elsewhere in this form. Memoized
  // here so a URL is only (re)created when the underlying file actually
  // changes, and revoked on the next change / unmount.
  const gradingPreviewUrls = useMemo(() => {
    const out: Partial<Record<"front" | "back" | "angled" | "closeup", string>> = {};
    (["front", "back", "angled", "closeup"] as const).forEach((angle) => {
      const f = gradingImages[angle];
      if (f) out[angle] = URL.createObjectURL(f);
    });
    return out;
  }, [gradingImages.front, gradingImages.back, gradingImages.angled, gradingImages.closeup]);
  useEffect(() => {
    return () => {
      Object.values(gradingPreviewUrls).forEach((u) => u && URL.revokeObjectURL(u));
    };
  }, [gradingPreviewUrls]);
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
      if (gradingImages.front) fd.append("front", gradingImages.front);
      if (gradingImages.back) fd.append("back", gradingImages.back);
      if (gradingImages.angled) fd.append("angled", gradingImages.angled);
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
  const [aiDraft, setAiDraft] = useState<{
    centering: string;
    corners: string;
    edges: string;
    surface: string;
    overall: string;
  }>({ centering: "", corners: "", edges: "", surface: "", overall: "" });
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
        corners: String(a.corners?.subgrade ?? ""),
        edges: String(a.edges?.subgrade ?? ""),
        surface: String(a.surface?.subgrade ?? ""),
        overall: String(a.overall_grade ?? ""),
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
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certificate?.id}/grading`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
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
    if (n >= 9) return "#16A34A";
    if (n >= 7) return "#CA8A04";
    return "#DC2626";
  }

  // Shared FormData assembly — used by both the explicit create/approved-edit
  // save (mutation, below) and the silent auto-save (autoSaveNow, below) so
  // the two payload-builders can never drift apart. `confirmPublishedEdit`
  // is ONLY set true by the explicit "Save Changes to Published Certificate"
  // path — auto-save must never send it (see the server-side approval lock
  // in the PUT /api/admin/certificates/:id route).
  function buildCertFormData(confirmPublishedEdit = false): FormData {
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
    if (confirmPublishedEdit) formData.append("confirmPublishedEdit", "true");
    // Stale-tab guard: tell the server which metadata values this form loaded;
    // it 409s only if a field changed elsewhere since AND this save would
    // overwrite that newer value (see PUT /:id + shared/edit-conflict.ts).
    if (isEdit && loadedSnapshotRef.current) {
      formData.append("loadedSnapshot", JSON.stringify(loadedSnapshotRef.current));
    }
    return formData;
  }

  useEffect(() => {
    if (!onCorrectionMetadataReady) return;
    onCorrectionMetadataReady(() => buildCertFormData(false));
    return () => onCorrectionMetadataReady(() => new FormData());
  }, [onCorrectionMetadataReady, form, designations, frontImage, backImage, loadedSnapshotRef.current]);

  const mutation = useMutation({
    mutationFn: async () => {
      // Only the "edit an already-approved certificate" path needs to confirm
      // the override — create has nothing to approve yet, and the auto-save
      // path below never reaches this mutation at all.
      const formData = buildCertFormData(isEdit && !!certificate?.gradeApprovedAt);
      const url = isEdit ? `/api/admin/certificates/${certificate.id}` : "/api/admin/certificates";
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

      const data = await res.json();
      // The response is the cert row the server actually WROTE — refresh the
      // stale-tab snapshot from it so the next save from this tab never
      // conflicts with our own successful write (incl. server-coerced fields).
      refreshSnapshotFromCert(data);
      return data;
    },
    onSuccess: (data: any) => {
      // Clear picked files so a subsequent save (auto-save or explicit) never
      // re-submits/re-uploads the same File object once it's already persisted.
      setFrontImage(null);
      setBackImage(null);
      // Session/feedback UI (display only — save behaviour is unchanged above).
      setSessionCompleted((c) => c + 1);
      setSavedToast(true);
      window.setTimeout(() => setSavedToast(false), 2500);
      // When a grading queue is provided, hold on a "Saved → Next Card" panel
      // instead of navigating away immediately. Without a queue, behave exactly
      // as before (call the parent's onSuccess straight away).
      if (queue) {
        setShowSavedPanel(true);
      } else {
        onSuccess(isEdit ? undefined : data);
      }
    },
    onError: (err: any) => setError(err.message),
  });

  // ── Silent auto-save for an EXISTING, NOT-YET-APPROVED certificate ─────────
  // Owner directive (2026-07-01): editing a card's identity (name/set/game/
  // etc.) should behave like the grading workstation below it — no manual
  // "Update Certificate" click. Gated to pre-approval only, mirroring the
  // exact same protection grading-panel.tsx already uses for its own
  // auto-save ("kills the previous 'edits save automatically to the live
  // record' silent-write behaviour") — the server route this posts to has
  // no approval lock of its own, so an already-approved/published cert must
  // keep requiring an explicit save (see the "Save Changes" button below).
  const autoSaveEligible = isEdit && !!certificate?.id && !certificate?.gradeApprovedAt;
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveSeqRef = useRef(0);
  const autoSavedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedOnceRef = useRef(false);

  // ── Cross-certificate isolation ────────────────────────────────────────────
  // The workstation swaps `certificate` for the next queued card WITHOUT
  // unmounting this form (admin-dashboard renders it with no `key`), and every
  // editable value is `useState`-seeded once at mount. Without this reset, card
  // A's rarity/finish/promo/subset/era and legacy variant/rarity stayed in
  // `form` and the next auto-save wrote them onto card B.
  //
  // A remount (`key={cert.id}`) would fix it too, but would destroy state the
  // operator needs ACROSS cards — sessionCompleted, the saved panel/toast and
  // the auto-save status HUD all live in this component. So we reset only the
  // per-certificate editable state and deliberately leave session/queue state
  // alone. The picker IS keyed (below), so its internal selection re-seeds.
  const currentCertIdRef = useRef<number | null>(certificate?.id ?? null);
  // Certificate id whose next auto-save tick must be skipped (undefined = none).
  const skipAutoSaveForCertRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const nextId = certificate?.id ?? null;
    if (currentCertIdRef.current === nextId) return; // same cert — nothing to do
    currentCertIdRef.current = nextId;

    // Drop any queued/in-flight auto-save so it can never land on the new cert.
    // Bumping the sequence makes the in-flight response a no-op for UI state.
    autoSavePendingRef.current = false;
    autoSaveSeqRef.current += 1;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    // Re-seed every editable value from the NEW certificate (one shared mapping).
    setForm(buildFormStateFromCert(certificate));
    setDesignations((certificate?.designations as string[]) || []);
    setNotesOpen(Boolean(certificate?.notes));
    setFrontImage(null);
    setBackImage(null);

    // Everything else that describes THIS certificate. Most important:
    // gradingImages holds picked File objects and uploadGradingImages() POSTs
    // them to the CURRENT certificate id — without this reset, card A's photos
    // would upload onto card B. The identify/AI/verification state likewise
    // describes card A and would otherwise be shown as card B's.
    setGradingImages({});
    setGradingUrls({});
    setGradingQuality({});
    setGradingUploadDone(false);
    setManuallyEdited(new Set());
    setManuallyVerified(false);
    setAutofillRan(false);
    setIdentifyResult(null);
    setIdentifyConfidence(null);
    setIdentifyVerified(false);
    setAiAnalysis(null);
    setAiDraft({ centering: "", corners: "", edges: "", surface: "", overall: "" });
    setAiDefects([]);
    setApproved(false);
    setSetId("");
    setFlashFields(new Set());
    setError("");
    setWfStage(0);
    setWfMaxStage(0);

    // Per-certificate refs: the conflict snapshot and the consolidated-scheme
    // flag describe the OLD cert; re-derive them for the new one.
    loadedSnapshotRef.current = null;
    savedConsolidatedRef.current = false;
    legacyLossAckRef.current = false;
    setLegacyLossWarning(null);
    refreshSnapshotFromCert(certificate as unknown as Record<string, unknown> | null);
    // Skip the auto-save tick for THIS certificate id, so re-seeding the form
    // does not immediately PUT back what we just loaded. Keyed on the id (not a
    // one-shot boolean) — see the debounce effect for why a boolean is consumed
    // by the wrong commit on a real switch.
    skipAutoSaveForCertRef.current = nextId;
    setAutoSaveStatus("idle");
    // eslint-disable-next-line
  }, [certificate?.id]);

  // Serialize auto-saves: never two PUTs in flight at once. Overlapping saves
  // were the one way this tab could race ITSELF into a stale-snapshot 409
  // (save B built before save A's success refreshed the snapshot). A save
  // requested mid-flight just marks pending and re-runs when the current one
  // finishes — same debounce feel, strictly ordered writes.
  const autoSaveInFlightRef = useRef(false);
  const autoSavePendingRef = useRef(false);
  // The queued replay MUST run the LATEST autoSaveNow, not the one that belongs
  // to the in-flight save. `autoSaveNow` is re-created every render and reads
  // `form` from its own closure (via buildCertFormData), so re-invoking the
  // in-flight save's own binding replayed that render's STALE snapshot and
  // silently re-persisted values the operator had since changed or cleared —
  // e.g. clearing a rarity mid-flight was undone by the replay, making the
  // pre-clear state the last write to the database. Assigning the newest
  // closure to this ref every render (same deliberate pattern as the picker's
  // onChangeRef) makes the replay build its payload from current state.
  const autoSaveNowRef = useRef<(() => Promise<void>) | null>(null);

  async function autoSaveNow() {
    if (!certificate?.id) return;
    // Mirror the debounce effect's guard. The queued replay now posts CURRENT
    // state, so a field left transiently blank while a save was in flight must
    // defer here exactly as the debounce defers it — never silently persist a
    // blank required field. The next edit re-triggers the debounce and saves.
    if (!hasRequiredFields) return;
    // One-time conversion warning: this save would move the certificate onto the
    // consolidated scheme while it still carries legacy free text that the new
    // structured line will not print. Hold the save and ask first.
    if (!legacyLossAckRef.current) {
      const lost = legacyFreeTextLostOnConversion({
        currentVersion: savedConsolidatedRef.current ? CONSOLIDATED_VARIANT_SCHEME : 0,
        variantOther: form.variantOther,
        rarityOther: form.rarityOther,
        rarityCode: form.rarityCode,
        finishVariant: form.finishVariant,
        promoType: form.promoType,
        subsetName: form.subsetName,
      });
      if (lost.length > 0) {
        setLegacyLossWarning(lost);
        return; // deferred until the operator confirms or changes the selection
      }
    }
    if (autoSaveInFlightRef.current) {
      autoSavePendingRef.current = true;
      return;
    }
    autoSaveInFlightRef.current = true;
    const seq = ++autoSaveSeqRef.current;
    setAutoSaveStatus("saving");
    try {
      // NEVER pass confirmPublishedEdit=true here — if the certificate was
      // approved in the moment between this call being scheduled and firing,
      // the server-side approval lock (added 2026-07-01) rejects the write
      // with a 409 rather than silently overwriting a live/published cert.
      const formData = buildCertFormData();
      const res = await fetch(`/api/admin/certificates/${certificate.id}`, {
        method: "PUT",
        body: formData,
        credentials: "include",
      });
      // Snapshot refresh runs even for a superseded save — the write DID land,
      // so later saves must compare against it (before the seq early-return).
      // Refreshed from the response row (server-written truth), never from
      // what we posted — the server coerces some fields on write.
      if (res.ok) {
        const saved = await res.json().catch(() => null);
        refreshSnapshotFromCert(saved);
      }
      if (seq !== autoSaveSeqRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Clear picked files so an unrelated field edit moments later doesn't
      // re-submit (and the server re-upload+delete-old) the same image.
      setFrontImage(null);
      setBackImage(null);
      setAutoSaveStatus("saved");
      if (autoSavedClearTimerRef.current) clearTimeout(autoSavedClearTimerRef.current);
      autoSavedClearTimerRef.current = setTimeout(() => {
        if (autoSaveSeqRef.current === seq) setAutoSaveStatus("idle");
      }, 2500);
    } catch (e: any) {
      if (seq !== autoSaveSeqRef.current) return;
      setAutoSaveStatus("error");
      toast({ title: "Auto-save failed", description: e.message, variant: "destructive" });
    } finally {
      autoSaveInFlightRef.current = false;
      if (autoSavePendingRef.current) {
        autoSavePendingRef.current = false;
        // Replay through the ref so the queued save serialises the CURRENT form
        // state. `autoSaveNow()` here would re-run THIS closure and re-post the
        // snapshot this save was built from, losing every edit made in flight.
        // Falls back to this closure only if the ref was never assigned (it is
        // assigned on every render below, so that is unreachable in practice).
        void (autoSaveNowRef.current ?? autoSaveNow)();
      }
    }
  }

  // Keep the replay target pointed at the newest closure (and therefore the
  // newest `form`). Plain per-render assignment — not an effect — so it is
  // already current when a save that started this render settles.
  autoSaveNowRef.current = autoSaveNow;

  // Debounced auto-save whenever an identity field changes. Skips the first
  // render (hydratedOnceRef) so we don't immediately re-PUT what was just
  // loaded from the certificate. Required fields are checked here (mirrors
  // handleSubmit's own check) so a transiently-blank field — e.g. mid-retype
  // of the card name — is never silently persisted; the save is simply
  // deferred until the field is filled in again.
  const hasRequiredFields = !!form.cardGame && !!form.setName && !!form.cardName && !!form.cardNumber && !!form.year;
  useEffect(() => {
    if (!autoSaveEligible || !hasRequiredFields) return;
    // Skip the tick that merely RE-SEEDS the form for a (new) certificate, so
    // loading a card never immediately PUTs back what was just loaded. Gated on
    // the certificate id, not a one-shot boolean: on a real switch the deps
    // `autoSaveEligible`/`hasRequiredFields` can change on the SAME commit as
    // the isolation effect — while `form` is still the previous card — and a
    // boolean flag would be consumed by that commit, letting the NEXT commit
    // (the freshly re-seeded form) schedule an un-edited full-state PUT.
    if (skipAutoSaveForCertRef.current !== undefined && skipAutoSaveForCertRef.current === (certificate?.id ?? null)) {
      skipAutoSaveForCertRef.current = undefined;
      hydratedOnceRef.current = true;
      return;
    }
    if (!hydratedOnceRef.current) {
      hydratedOnceRef.current = true;
      return;
    }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveNow();
    }, 600);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line
  }, [autoSaveEligible, hasRequiredFields, form, designations, frontImage, backImage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Auto-save already persists every change for an existing, not-yet-approved
    // certificate (no button is rendered in that case) — an Enter keypress
    // submitting the form should not ALSO fire the explicit mutation, which
    // navigates away via onSuccess. Only the create flow and the
    // already-approved "Save Changes" flow use this explicit submit path.
    if (autoSaveEligible) return;

    if (correctionMode) return;

    if (!form.cardGame || !form.setName || !form.cardName || !form.cardNumber || !form.year) {
      setError("Please fill in all required fields: Game, Set, Card Name, Card Number, Year");
      return;
    }

    // Grade is optional on initial save — can be set later via the workstation
    if (!isNonNum && form.gradeOverall) {
      const grade = parseFloat(form.gradeOverall);
      if (!isValidNumericGrade(grade)) {
        setError("Overall grade must be a valid MVGS grade (1–10, including half grades)");
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
      setDesignations((prev) => (prev.includes("PROMO") ? prev : [...prev, "PROMO"]));
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

  // Grading workflow progress (advisory only — never gates saving/grading). The
  // bar reflects which of the 4 stages have enough data; clicking a stage scrolls
  // its section into view. No form value is changed here.
  const stageCompletion = useMemo(
    () =>
      deriveStageCompletion({
        cardName: form.cardName,
        setName: form.setName,
        rarityCode: form.rarityCode,
        variant: form.variant,
        finishVariant: form.finishVariant,
        promoType: form.promoType,
        subsetName: form.subsetName,
        gradeOverall: form.gradeOverall,
      }),
    [
      form.cardName,
      form.setName,
      form.rarityCode,
      form.variant,
      form.finishVariant,
      form.promoType,
      form.subsetName,
      form.gradeOverall,
    ]
  );
  // Stage gating is LOCAL UI STATE only: every stage's content stays mounted
  // (hidden with CSS) so moving Back/Next can never clear a field, trigger a
  // save, grade, or touch the DB. The protected workstation is geometry-safe
  // under this: its card tool reads getBoundingClientRect LIVE per event
  // (manual-card-tool.tsx), never caching mount-time sizes.
  const [wfStage, setWfStage] = useState(0);
  const [wfMaxStage, setWfMaxStage] = useState(0);
  const goToStage = (i: number) => {
    const next = Math.min(3, Math.max(0, i));
    setWfStage(next);
    setWfMaxStage((m) => Math.max(m, next));
    if (typeof document !== "undefined") {
      document
        .querySelector('[data-testid="grading-workflow-bar"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  /** Hidden-not-unmounted: stage content keeps all React state while inactive. */
  const stageClass = (i: number) => (wfStage === i ? "" : "hidden");

  // Auto-focus the first logical field when a stage opens, so a grader can start
  // typing without reaching for the mouse. Card stage → Card Name. Guarded so it
  // never steals focus mid-typing (only fires on stage change) and never on an
  // already-focused field.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const firstField: Record<number, string> = { 0: "input-card-name" };
    const testId = firstField[wfStage];
    if (!testId) return;
    const active = document.activeElement;
    // Don't steal focus if the grader already put the cursor in a field.
    const alreadyTyping =
      active &&
      active !== document.body &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
    if (alreadyTyping) return;
    const t = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [wfStage]);
  const workflowCurrent = wfStage;
  const workflowMax = Math.max(wfMaxStage, furthestReached(stageCompletion));

  // AI-first Card stage derived state (presentation only — no save/grade/API).
  // hasCardMeta: the card already carries identification data (from AI, TCGdex
  // or a previous edit) so we can show the read-only "verify" chips above the
  // (always-visible) manual fields instead of a plain prompt.
  // aiIdentifyAvailable: AI Identify can run (edit mode + flag on).
  const hasCardMeta = !!(form.cardName.trim() || form.setName.trim() || form.cardNumber.trim());
  const aiIdentifyAvailable = isEdit && !!certificate?.id && identifyEnabled;

  return (
    // Canonical grading workstation shell — the ONE shared outer geometry (fixed
    // viewport height, full width, two-panel columns, internal scroll), extracted
    // verbatim from this component's previously-inline geometry so /admin renders
    // identically; Staff / Grader / Admin Review use the exact same shell. Grade
    // (wfStage 2) deliberately hides the preview aside because the protected
    // grading-panel.tsx workstation already renders its own interactive card
    // image + defect-marking tool (its own internal two-column split); mounting
    // the aside there would duplicate the image or narrow that protected grid — a
    // real functional regression, not cosmetic. The shrink-0 header div + <form>
    // body below are the shell's control-panel children, unchanged.
    // Bounded viewport-height wrapper for /admin (unchanged 4.5rem admin-header
    // offset). The canonical shell fills this exactly (h-full) — no black band.
    <div className="flex min-h-0 flex-col md:h-[calc(100dvh-4.5rem)]" data-testid="grading-workspace-bound">
    <CanonicalGradingWorkstationShell
      previewAside={
        wfStage <= 1 || wfStage === 3 ? (
          <WorkstationPreviewAside
            certificateId={certificate?.id ?? null}
            frontFile={frontImage}
            backFile={backImage}
            // Live front-certificate preview on Rarity + Review only (reuses the
            // real print pipeline, read-only). Card stage passes no `below`, so
            // its layout is byte-identical to before.
            below={
              wfStage === 1 || wfStage === 3 ? (
                <CertificatePreviewPanel
                  fields={{
                    // Editing an existing cert → the server starts from the SAVED
                    // grade/subgrade columns so the black-label (Pristine) preview
                    // matches print; absent (create flow) it renders from fields.
                    certificateId: certificate?.id ?? null,
                    cardName: form.cardName,
                    setName: form.setName,
                    year: form.year,
                    cardNumber: form.cardNumber,
                    gradeType: form.gradeType,
                    gradeOverall: form.gradeOverall,
                    variant: form.variant,
                    variantOther: form.variantOther,
                    rarity: form.rarity,
                    rarityOther: form.rarityOther,
                    // Structured-variant codes → server derives the ONE consolidated
                    // variant line (parity with print), same as the save routes.
                    rarityCode: form.rarityCode,
                    finishVariant: form.finishVariant,
                    promoType: form.promoType,
                    subsetName: form.subsetName,
                    era: form.era,
                    labelType: form.labelType,
                    language: form.language,
                  }}
                />
              ) : undefined
            }
          />
        ) : null
      }
    >
          <div className="shrink-0 space-y-1">
            {/* Shared workstation header strip (WorkstationHeaderStrip) — 4-stage
                workflow navigation + queue/session stats. ONE render site for
                all four stages (outside the per-stage sections below), so
                every stage sees byte-identical header geometry. Moved out of
                the <form> into the fixed control-panel header so it stays put
                while the form scrolls. Display-only: no queue-order or
                session-calc change. */}
            <WorkstationHeaderStrip
              workflowCurrent={workflowCurrent}
              workflowMax={workflowMax}
              onStageClick={(i) => goToStage(i)}
              batch={batch}
              queue={queue}
              sessionCompleted={sessionCompleted}
            />
            {isEdit && certificate?.id && (
              <details
                className="border border-[var(--admin-gold)]/15 rounded-lg bg-[var(--admin-gold)]/[0.02] mb-1"
                data-testid="identification-tools"
              >
                <summary className="cursor-pointer list-none px-3 py-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/70 hover:text-[var(--admin-gold)]">
                  <Cpu size={12} /> Identification tools
                  <span className="ml-auto text-[9px] font-normal normal-case text-[var(--admin-ink-faint)]">
                    AI Identify · AI Grade
                  </span>
                </summary>
                <div className="px-3 pb-3 pt-1 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Identify */}
                    <button
                      type="button"
                      onClick={runIdentify}
                      disabled={!identifyEnabled || identifyLoading}
                      title={!identifyEnabled ? "Enabled in /admin → AI Learning" : "Card name, set, number, year"}
                      className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-[var(--admin-gold)]/40 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all"
                    >
                      <span className="flex items-center gap-2">
                        {identifyLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                        <span>{identifyLoading ? "Identifying…" : "AI Identify"}</span>
                      </span>
                      <span className="text-[9px] font-normal normal-case opacity-70">name · set · number · year</span>
                    </button>

                    {/* Grade */}
                    <button
                      type="button"
                      onClick={runGrade}
                      disabled={!fullGradeEnabled || gradeLoading}
                      title={!fullGradeEnabled ? "Enabled in /admin → AI Learning" : "4 subgrades + overall (Opus)"}
                      className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-[var(--admin-gold)]/40 bg-[var(--admin-panel2)] text-[var(--admin-gold)] text-xs font-bold uppercase disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--admin-panel3)] transition-all"
                    >
                      <span className="flex items-center gap-2">
                        {gradeLoading ? <Loader2 size={13} className="animate-spin" /> : <Cpu size={13} />}
                        <span>{gradeLoading ? "Grading…" : "AI Grade"}</span>
                      </span>
                      <span className="text-[9px] font-normal normal-case opacity-60">4 subgrades + overall</span>
                    </button>
                  </div>

                  {(!identifyEnabled || !fullGradeEnabled) && (
                    <p className="text-[10px] text-[var(--admin-ink-faint)]">
                      {!identifyEnabled && !fullGradeEnabled
                        ? "Both AI actions disabled — toggle in /admin → AI Learning."
                        : !identifyEnabled
                          ? "AI Identify disabled — toggle in /admin → AI Learning."
                          : "AI Grade disabled — toggle in /admin → AI Learning."}
                    </p>
                  )}

                  {identifyConfidence && (
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`w-2 h-2 rounded-full ${identifyConfidence === "high" ? "bg-[var(--admin-green)]" : identifyConfidence === "medium" ? "bg-[var(--admin-amber)]" : "bg-[var(--admin-red)]"}`}
                      />
                      <span
                        className={
                          identifyConfidence === "high"
                            ? "text-[var(--admin-green)]"
                            : identifyConfidence === "medium"
                              ? "text-[var(--admin-amber)]"
                              : "text-[var(--admin-red)]"
                        }
                      >
                        {identifyConfidence} confidence{identifyVerified ? " · TCG API verified" : ""}
                      </span>
                      {identifyConfidence !== "high" && !identifyVerified && identifyEnabled && (
                        <button
                          type="button"
                          onClick={runIdentify}
                          disabled={identifyLoading}
                          className="text-[var(--admin-gold)] text-[10px] hover:underline"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
          <form
            onSubmit={handleSubmit}
            onKeyDown={(e) => {
              // Enter advances the stage (Continue) when the grader isn't in a
              // textarea and the stage's validation already passes — and never lets
              // Enter submit/save the form from Stage 1/2. Textareas keep newlines.
              if (e.key !== "Enter") return;
              const tag = (e.target as HTMLElement).tagName;
              if (tag === "TEXTAREA") return;
              if (wfStage === 0) {
                e.preventDefault();
                if (form.cardName.trim() && form.cardNumber.trim()) {
                  captureLastCardContext();
                  goToStage(1);
                }
              } else if (wfStage === 1) {
                e.preventDefault();
                goToStage(2);
              }
            }}
            className="min-h-0 flex-1 space-y-2.5 overflow-y-auto md:pr-1"
          >
            {/* "✓ Saved" confirmation toast — fades ~2.5s after a successful save. */}
            {savedToast && (
              <div
                className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg border border-[var(--admin-green)]/40 bg-[var(--admin-panel)] px-3 py-2 text-[12px] text-[var(--admin-green)] shadow-lg"
                style={{ animation: "fadeIn 0.15s ease-out" }}
                role="status"
                data-testid="save-toast"
              >
                <CheckCircle2 size={14} /> Saved
              </div>
            )}

            {/* Post-save panel (only when a grading queue is provided) — Next Card is
            the primary action; the grader confirms before the next draft opens. */}
            {showSavedPanel && queue && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="Card saved"
                data-testid="saved-panel"
              >
                <div className="w-full max-w-sm rounded-xl border border-[var(--admin-gold)]/30 bg-[var(--admin-panel)] p-5 text-center">
                  <div className="mb-3 flex items-center justify-center gap-2 text-[var(--admin-green)]">
                    <CheckCircle2 size={20} />{" "}
                    <span className="text-sm font-bold uppercase tracking-wider">Card Saved</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      data-testid="button-next-card"
                      disabled={!queue.hasNext}
                      title={queue.hasNext ? "Open the next queued draft" : "No more cards in the queue"}
                      onClick={() => {
                        setShowSavedPanel(false);
                        queue.onNext();
                      }}
                      className="w-full rounded-lg bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] px-4 py-2.5 text-xs font-bold uppercase text-[#1A1400] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {queue.hasNext ? "Next Card →" : "No more cards"}
                    </button>
                    <button
                      type="button"
                      data-testid="button-back-to-queue"
                      onClick={() => {
                        setShowSavedPanel(false);
                        (queue.onBackToQueue ?? (() => onSuccess(undefined)))();
                      }}
                      className="w-full rounded-lg border border-[var(--admin-gold)]/30 px-4 py-2 text-xs font-bold uppercase text-[var(--admin-gold)]/80 hover:bg-[var(--admin-gold)]/10"
                    >
                      Back to Queue
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Existing auto-save status, kept visible on every stage (reuses the
            pre-existing autoSaveStatus state — no new save system). */}
            {autoSaveEligible && wfStage !== 3 && (
              <div
                className="-mt-3 text-right text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]"
                data-testid="text-autosave-status-mini"
              >
                {autoSaveStatus === "saving"
                  ? "Saving…"
                  : autoSaveStatus === "error"
                    ? "Save failed — retrying on next change"
                    : autoSaveStatus === "saved"
                      ? "Saved"
                      : "Unsaved changes save automatically"}
              </div>
            )}
            {!isEdit && (
              <SubmissionItemLink
                value={form.submissionItemId}
                onChange={(itemId, item) => {
                  setForm((f) => ({
                    ...f,
                    submissionItemId: itemId,
                    ...(item
                      ? {
                          cardGame: slugifyCardGame(item.game) || f.cardGame,
                          setName: item.card_set || f.setName,
                          cardName: (item.card_name || "").toUpperCase() || f.cardName,
                          cardNumber: item.card_number || f.cardNumber,
                          year: item.year || f.year,
                        }
                      : {}),
                  }));
                }}
              />
            )}
            {/* Identify controls (stages 0 + 1). The card preview now lives in the
            fixed workspace aside; this panel is just the stage controls. */}
            <div data-workflow-stage="identify" className={`space-y-2.5 ${wfStage <= 1 ? "" : "hidden"}`}>
              {/* ── STAGE 1 · CARD — identification fields only ── */}
              <div className={`space-y-3 ${stageClass(0)}`}>
                {/* AI-first card identification — the primary Card-stage experience.
              The grader runs AI Identify (the EXISTING runIdentify — logic
              unchanged), then VERIFIES the auto-filled result via read-only
              chips. The tall manual field grid below stays hidden until they
              choose Manual (or identify comes back low-confidence). */}
                {aiIdentifyAvailable && (
                  <div
                    className={`rounded-lg border p-3 space-y-2.5 transition-colors ${
                      identifyConfidence === "high"
                        ? "border-[var(--admin-green)]/40 bg-[var(--admin-green)]/[0.05]"
                        : identifyConfidence === "medium"
                          ? "border-[var(--admin-amber)]/40 bg-[var(--admin-amber)]/[0.05]"
                          : identifyConfidence === "low"
                            ? "border-[var(--admin-red)]/40 bg-[var(--admin-red)]/[0.05]"
                            : "border-[var(--admin-gold)]/25 bg-[var(--admin-gold)]/[0.03]"
                    }`}
                    data-testid="ai-identify-panel"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">
                        <Cpu size={12} /> Card Identification
                      </span>
                      {identifyConfidence && (
                        <span
                          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            identifyConfidence === "high"
                              ? "bg-[var(--admin-green)]/15 text-[var(--admin-green)]"
                              : identifyConfidence === "medium"
                                ? "bg-[var(--admin-amber)]/15 text-[var(--admin-amber)]"
                                : "bg-[var(--admin-red)]/15 text-[var(--admin-red)]"
                          }`}
                          data-testid="ai-identify-confidence"
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${identifyConfidence === "high" ? "bg-[var(--admin-green)]" : identifyConfidence === "medium" ? "bg-[var(--admin-amber)]" : "bg-[var(--admin-red)]"}`}
                          />
                          {identifyConfidence} confidence{identifyVerified ? " · TCG API verified" : ""}
                        </span>
                      )}
                    </div>

                    {/* Result summary. Three distinct states so stale certificate data is
                  NEVER shown as if it were a fresh identification:
                    • identifyResult set  → the PROPOSED result (from AI/TCGdex), verify chips.
                    • no result, cert has existing data → clearly labelled EXISTING data.
                    • otherwise → prompt to identify or enter manually. */}
                    {identifyResult ? (
                      <div className="space-y-1" data-testid="ai-identify-summary">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/60">
                          Proposed — verify
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[
                            identifyResult.name,
                            displayCollectorNumber(identifyResult.number),
                            identifyResult.year,
                            identifyResult.language,
                            identifyResult.rarity,
                          ]
                            .filter(Boolean)
                            .map((chip, i) => (
                              <span
                                key={i}
                                className="rounded border border-[var(--admin-gold)]/20 bg-[var(--admin-panel2)] px-2 py-1 text-[11px] text-[var(--admin-ink)]"
                              >
                                {chip}
                              </span>
                            ))}
                          <button
                            type="button"
                            onClick={() =>
                              manualEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                            }
                            data-testid="button-verify-edit"
                            title="The fields are always editable below — jump to them"
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/70 hover:text-[var(--admin-gold)]"
                          >
                            <Pencil size={10} /> Edit
                          </button>
                        </div>
                      </div>
                    ) : hasCardMeta ? (
                      <div className="space-y-1" data-testid="ai-existing-details">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--admin-ink-faint)]">
                          Existing certificate details
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[form.cardName, displayCollectorNumber(form.cardNumber), form.setName, form.year]
                            .filter(Boolean)
                            .map((chip, i) => (
                              <span
                                key={i}
                                className="rounded border border-[var(--admin-line)] bg-transparent px-2 py-1 text-[11px] text-[var(--admin-ink-dim)]"
                              >
                                {chip}
                              </span>
                            ))}
                        </div>
                        <p className="text-[10px] text-[var(--admin-ink-faint)]">
                          Run AI Identify to propose an update, or edit manually — these are not a new result.
                        </p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-[var(--admin-ink-faint)]">
                        {identifyLoading
                          ? "Identifying…"
                          : "Run AI Identify to auto-fill the card details, or switch to Manual entry."}
                      </p>
                    )}

                    {/* Primary actions. Once a card is identified, Accept is the
                  strongest action (confirm & continue → Rarity); Search Again is
                  the secondary outline; Manual stays visually quiet. Before any
                  match exists, AI Identify is the strong primary. */}
                    <div className="flex flex-wrap items-center gap-2">
                      {(identifyResult || hasCardMeta) && (
                        <button
                          type="button"
                          onClick={() => {
                            // Accepting a proposed result is the ONLY point where it
                            // overwrites populated certificate fields (req: don't clobber
                            // until the grader confirms). Manual-only flow just advances.
                            if (identifyResult) {
                              setForm((prev) => ({
                                ...prev,
                                cardName: identifyResult.name || prev.cardName,
                                cardNumber: identifyResult.number || prev.cardNumber,
                                year: identifyResult.year || prev.year,
                                language: identifyResult.language || prev.language,
                                rarity: identifyResult.rarity || prev.rarity,
                                variant: identifyResult.variant || prev.variant,
                              }));
                            }
                            captureLastCardContext();
                            goToStage(1);
                          }}
                          disabled={
                            identifyResult
                              ? !(identifyResult.name || form.cardName.trim()) ||
                                !(identifyResult.number || form.cardNumber.trim())
                              : !form.cardName.trim() || !form.cardNumber.trim()
                          }
                          title={
                            identifyResult ? "Accept the proposed identification and continue" : "Confirm and continue"
                          }
                          data-testid="button-accept-identify"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--admin-green)] bg-[var(--admin-green)] px-4 py-2 text-[12px] font-bold uppercase text-[#07130b] shadow-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                        >
                          <Check size={14} /> Accept
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={runIdentify}
                        disabled={identifyLoading}
                        data-testid="button-ai-identify"
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-bold uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          hasCardMeta
                            ? "border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10"
                            : "border border-[var(--admin-gold)]/40 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] hover:opacity-90"
                        }`}
                      >
                        {identifyLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                        {identifyLoading ? "Identifying…" : hasCardMeta ? "Search Again" : "AI Identify"}
                      </button>
                      {/* The manual fields are always visible below (not a hidden
                    panel) — this just scrolls to them; there is nothing to
                    "reveal". Kept as button-manual-entry for compatibility. */}
                      <button
                        type="button"
                        onClick={() => manualEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                        data-testid="button-manual-entry"
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-ink-dim)] hover:bg-[var(--admin-gold)]/5 hover:text-[var(--admin-gold)] transition-colors"
                      >
                        Card fields ↓
                      </button>
                    </div>
                  </div>
                )}

                {/* Same as last card — one-click quick-fill of the shared set/year/
              language context (never overwrites a field that already has a value). */}
                {lastCardContext && (lastCardContext.setName || lastCardContext.year) && (
                  <div className="flex flex-wrap items-center gap-1.5" data-testid="last-card-quick-fill">
                    {!form.setName && (
                      <button
                        type="button"
                        onClick={applyLastCardContext}
                        data-testid="button-same-as-last-card"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--admin-gold)]/30 px-2.5 py-1.5 text-[11px] text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10 transition-colors"
                        title="Fill game, set, year and language from the last card you processed"
                      >
                        <Copy size={12} /> Same as last card
                        {lastCardContext.setName ? `: ${lastCardContext.setName}` : ""}
                      </button>
                    )}
                    {lastCardContext.setName && (
                      <button
                        type="button"
                        onClick={() => copyLastCardField("setName")}
                        data-testid="button-copy-set"
                        className="rounded border border-[var(--admin-gold)]/20 px-2 py-1 text-[10px] text-[var(--admin-gold)]/70 hover:bg-[var(--admin-gold)]/10"
                        title={`Copy set: ${lastCardContext.setName}`}
                      >
                        Copy Set
                      </button>
                    )}
                    {lastCardContext.year && (
                      <button
                        type="button"
                        onClick={() => copyLastCardField("year")}
                        data-testid="button-copy-year"
                        className="rounded border border-[var(--admin-gold)]/20 px-2 py-1 text-[10px] text-[var(--admin-gold)]/70 hover:bg-[var(--admin-gold)]/10"
                        title={`Copy year: ${lastCardContext.year}`}
                      >
                        Copy Year
                      </button>
                    )}
                    {lastCardContext.language && (
                      <button
                        type="button"
                        onClick={() => copyLastCardField("language")}
                        data-testid="button-copy-language"
                        className="rounded border border-[var(--admin-gold)]/20 px-2 py-1 text-[10px] text-[var(--admin-gold)]/70 hover:bg-[var(--admin-gold)]/10"
                        title={`Copy language: ${lastCardContext.language}`}
                      >
                        Copy Language
                      </button>
                    )}
                  </div>
                )}

                {/* TCG search + manual entry helpers — Search TCG is a compact outlined
              utility button (TCGdex behaviour unchanged). */}
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <button
                    type="button"
                    onClick={() => {
                      setTcgSearchOpen(true);
                      setTcgQuery("");
                      setTcgResults([]);
                    }}
                    disabled={!form.cardGame}
                    title="Search the TCGdex card database"
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--admin-gold)]/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Database size={11} />
                    Search TCG
                  </button>
                  {!form.cardGame && (
                    <span className="text-[var(--admin-ink-faint)] italic">Select card game first</span>
                  )}
                  {manuallyVerified && (
                    <span className="flex items-center gap-1 text-[var(--admin-green)]">
                      <CheckCircle2 size={10} />
                      Manually verified
                    </span>
                  )}
                </div>

                {/* TCG Search Dialog */}
                <Dialog open={tcgSearchOpen} onOpenChange={setTcgSearchOpen}>
                  <DialogContent className="max-w-lg p-0 overflow-hidden">
                    <div className="p-4 pb-2 border-b border-[var(--admin-line)]">
                      <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest mb-2">
                        Search TCG Database
                      </p>
                      <div className="flex items-center gap-2 border border-[var(--admin-gold)]/30 rounded-lg px-3 py-2 focus-within:border-[var(--admin-gold)] transition-colors">
                        <Search size={14} className="text-[var(--admin-gold)]/50 shrink-0" />
                        <input
                          type="text"
                          value={tcgQuery}
                          onChange={(e) => handleTcgSearch(e.target.value)}
                          placeholder={`Type card name (e.g. Charizard ex, Kofu)...`}
                          className="flex-1 bg-transparent text-sm text-[var(--admin-ink)] placeholder:text-[var(--admin-ink-faint)] outline-none"
                          autoFocus
                        />
                        {tcgLoading && <Loader2 size={14} className="animate-spin text-[var(--admin-gold)]" />}
                      </div>
                      <p className="text-[var(--admin-ink-faint)] text-[9px] mt-1">
                        Searching {(form.cardGame || "pokemon").toUpperCase()} database · Type 3+ characters
                      </p>
                    </div>
                    <div className="max-h-[320px] overflow-y-auto">
                      {/* Transport/provider failure — distinct from a legitimate no-result. */}
                      {tcgError && !tcgLoading && (
                        <div className="py-8 text-center" data-testid="tcg-search-error">
                          <p className="text-[var(--admin-red)] text-sm font-semibold">Search unavailable</p>
                          <p className="text-[var(--admin-ink-faint)] text-[11px] mt-1 px-6">{tcgError}</p>
                        </div>
                      )}
                      {!tcgError && tcgQuery.trim().length >= 3 && !tcgLoading && tcgResults.length === 0 && (
                        <div className="py-8 text-center">
                          <p className="text-[var(--admin-ink-faint)] text-sm">No cards found</p>
                          <p className="text-[var(--admin-ink-faint)] text-[10px] mt-1">
                            Check spelling or enter details manually
                          </p>
                        </div>
                      )}
                      {tcgResults.map((card) => (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => selectTcgCard(card)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--admin-gold)]/5 transition-colors border-b border-[var(--admin-line)] last:border-0"
                        >
                          {card.imageUrl ? (
                            <img src={card.imageUrl} alt="" className="w-10 h-14 object-contain rounded shrink-0" />
                          ) : (
                            <div className="w-10 h-14 bg-[var(--admin-panel2)] rounded shrink-0 flex items-center justify-center">
                              <Search size={12} className="text-[var(--admin-ink-faint)]" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-[var(--admin-ink)] text-sm font-bold truncate">{card.name}</p>
                            <p className="text-[var(--admin-ink-dim)] text-xs truncate">
                              {card.setName}
                              {card.number ? ` · ${displayCollectorNumber(card.number)}` : ""}
                            </p>
                            <p className="text-[var(--admin-ink-faint)] text-[10px]">
                              {[card.rarity, card.year].filter(Boolean).join(" · ")}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </DialogContent>
                </Dialog>

                {/* Manual card-detail fields — ALWAYS visible (this is the normal
              verification process, not an exceptional fallback). AI Identify /
              Search TCG above are helper tools that propose values into these
              same fields; the grader can always read and edit them directly. */}
                <div ref={manualEditorRef} className="space-y-3" data-testid="manual-card-editor">
                  {/* Card identity — mock-matching 3-column row (Game · Set · Set Code).
              Set Code is its own full field (not a nested sub-input) to match the
              workstation reference density at 1280px. Set Name gets a wider share
              of the row (it holds a searchable dropdown with long collection
              names — "Chaos Rising", "Perfect Origins", etc — and was cramped to
              an equal 1/3 column in production). */}
                  <div className="grid grid-cols-1 sm:grid-cols-[0.8fr_2fr_0.9fr] gap-4">
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
                        onChange={(name, id) => {
                          updateField("setName", name);
                          if (id) setSetId(id);
                        }}
                        allowEditSet
                        testId="input-set-name"
                      />
                      <p className="text-[9px] text-[var(--admin-ink-faint)] mt-1" data-testid="help-set">
                        The collection name printed on the card.
                      </p>
                    </div>
                    <div>
                      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                        Set Code
                      </label>
                      <input
                        type="text"
                        value={setId}
                        onChange={(e) => setSetId(e.target.value)}
                        placeholder="e.g. MEW or SV8"
                        className="w-full bg-transparent border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-gold)]/20 focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
                        data-testid="input-set-id"
                      />
                      <p className="text-[9px] text-[var(--admin-ink-faint)] mt-1" data-testid="help-set-code">
                        Usually a short code such as MEW or SV8.
                      </p>
                    </div>
                  </div>

                  {/* Row 2 — 4-column (Name · Card Number+Auto-fill · Year · Language) so
              Language shares this row instead of a near-empty row of its own. The
              tuned template keeps the Card Number cell (widest, 1.3fr) readable at
              1280px. */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1fr)]">
                    <FormInput
                      label="Card Name *"
                      value={form.cardName}
                      onChange={(v) => updateField("cardName", v)}
                      onBlur={() => setForm((f) => ({ ...f, cardName: f.cardName.toUpperCase() }))}
                      testId="input-card-name"
                      highlight={autofillRan && manuallyEdited.has("cardName")}
                    />
                    <div>
                      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                        Card Number *
                      </label>
                      <div className="flex gap-2">
                        <div className="flex-1 flex items-center bg-transparent border border-[var(--admin-gold)]/30 rounded overflow-hidden focus-within:border-[var(--admin-gold)] transition-colors">
                          <span className="pl-3 text-[var(--admin-gold)]/50 text-sm select-none">#</span>
                          <input
                            type="text"
                            value={form.cardNumber}
                            onChange={(e) => updateField("cardNumber", e.target.value.replace(/^#+/, ""))}
                            placeholder="e.g. 125/198"
                            className="flex-1 bg-transparent px-2 py-2 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-gold)]/20 focus:outline-none"
                            data-testid="input-card-number"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={!canAutofill || autofillLoading}
                          onClick={() => handleAutofill(false)}
                          className="px-3 py-2 border border-[var(--admin-gold)]/30 rounded text-[var(--admin-gold)] text-sm hover:bg-[var(--admin-gold)]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
                          data-testid="button-autofill"
                          title="Auto-fill card details"
                        >
                          <Search size={14} />
                          {autofillLoading ? "..." : "Auto-fill"}
                        </button>
                      </div>
                      <p className="text-[9px] text-[var(--admin-ink-faint)] mt-1" data-testid="help-card-number">
                        The number at the bottom of the card, for example 063/165.
                      </p>

                      {suggestions.length > 0 && (
                        <div
                          className="mt-2 border border-[var(--admin-gold)]/20 rounded bg-[var(--admin-panel)] max-h-40 border border-[var(--admin-line)] overflow-y-auto"
                          data-testid="autofill-suggestions"
                        >
                          <p className="text-[var(--admin-gold)]/50 text-[10px] uppercase tracking-widest px-3 pt-2 pb-1">
                            Suggestions
                          </p>
                          {suggestions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => {
                                setForm((f) => ({ ...f, cardNumber: s.cardNumber }));
                                applyCardData(s, null);
                                toast({ title: "Card details auto-filled" });
                              }}
                              className="w-full text-left px-3 py-1.5 text-sm text-[var(--admin-ink-dim)] hover:bg-[var(--admin-gold)]/10 hover:text-[var(--admin-ink)] transition-colors"
                              data-testid={`suggestion-${s.id}`}
                            >
                              <span className="text-[var(--admin-gold)]">{s.cardNumber}</span>
                              {" – "}
                              {s.cardName}
                              {s.rarity && <span className="text-[var(--admin-ink-faint)]"> ({s.rarity})</span>}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => setSuggestions([])}
                            className="w-full text-center text-[10px] text-[var(--admin-ink-faint)] py-1 hover:text-[var(--admin-ink-dim)]"
                            data-testid="button-dismiss-suggestions"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}

                      {fallbackMatch && (
                        <div
                          className="mt-2 border border-[var(--admin-amber)]/40 bg-[var(--admin-amber)]/5 rounded p-3"
                          data-testid="fallback-banner"
                        >
                          <div className="flex items-start gap-2">
                            <AlertTriangle size={16} className="text-[var(--admin-amber)] mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <p className="text-[var(--admin-amber)] text-sm font-medium">
                                Match found in different language
                              </p>
                              <p className="text-[var(--admin-ink-dim)] text-xs mt-1">
                                Found: <span className="text-[var(--admin-ink)]">{fallbackMatch.cardName}</span> (
                                {fallbackMatch.language})
                              </p>
                              <div className="flex gap-2 mt-2">
                                <button
                                  type="button"
                                  onClick={applyFallback}
                                  className="px-3 py-1 text-xs border border-[var(--admin-amber)]/40 text-[var(--admin-amber)] rounded hover:bg-[var(--admin-amber)]/10 transition-colors flex items-center gap-1"
                                  data-testid="button-apply-fallback"
                                >
                                  <Check size={12} /> Apply Anyway
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setFallbackMatch(null)}
                                  className="px-3 py-1 text-xs text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)] transition-colors flex items-center gap-1"
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
                    <FormInput
                      label="Year *"
                      value={form.year}
                      onChange={(v) => updateField("year", v)}
                      placeholder="e.g. 1999"
                      testId="input-year"
                      highlight={(autofillRan && manuallyEdited.has("year")) || flashFields.has("year")}
                    />
                    <div>
                      <FormInput
                        label="Language"
                        value={form.language}
                        onChange={(v) => {
                          updateField("language", v);
                          setLanguageChangedByFallback(false);
                        }}
                        testId="input-language"
                        highlight={languageChangedByFallback || flashFields.has("language")}
                      />
                      {languageChangedByFallback && (
                        <p
                          className="text-[var(--admin-amber)] text-[10px] mt-1"
                          data-testid="text-language-fallback-notice"
                        >
                          Changed by fallback match
                        </p>
                      )}
                    </div>
                  </div>

                  {!fallbackMatch && canAutofill && !autofillLoading && suggestions.length === 0 && (
                    <button
                      type="button"
                      onClick={() => handleAutofill(true)}
                      className="text-[10px] text-[var(--admin-gold)]/40 hover:text-[var(--admin-gold)]/70 transition-colors underline"
                      data-testid="button-search-other-languages"
                    >
                      Search other languages
                    </button>
                  )}

                  {overwriteConfirm && (
                    <div
                      className="border border-[var(--admin-amber)]/40 bg-[var(--admin-amber)]/5 rounded p-3"
                      data-testid="overwrite-confirm"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={16} className="text-[var(--admin-amber)] mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <p className="text-[var(--admin-amber)] text-sm font-medium">
                            Overwrite manually edited fields?
                          </p>
                          <p className="text-[var(--admin-ink-dim)] text-xs mt-1">
                            You edited: {overwriteConfirm.fields.join(", ")}
                          </p>
                          <div className="flex gap-2 mt-2">
                            <button
                              type="button"
                              onClick={confirmOverwrite}
                              className="px-3 py-1 text-xs border border-[var(--admin-amber)]/40 text-[var(--admin-amber)] rounded hover:bg-[var(--admin-amber)]/10 transition-colors"
                              data-testid="button-confirm-overwrite"
                            >
                              Yes, overwrite
                            </button>
                            <button
                              type="button"
                              onClick={() => setOverwriteConfirm(null)}
                              className="px-3 py-1 text-xs text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)] transition-colors"
                              data-testid="button-cancel-overwrite"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {/* ── STAGE 2 · RARITY — structured picker + finish + promo (+ legacy/advanced) ── */}
              <div className={`space-y-3 ${stageClass(1)}`}>
                {/* Legacy flat Variant control — superseded for daily grading by the
              structured picker below. Kept fully functional (historical values,
              save compatibility) but collapsed under Legacy / advanced. */}
                <details
                  className="rounded-lg border border-[var(--admin-gold)]/10 px-3 py-2"
                  data-testid="legacy-variant-details"
                >
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]">
                    Legacy / advanced variant
                  </summary>
                  <div className="pt-2">
                    {(() => {
                      // Build merged option list: static (minus OTHER) + DB variants + localStorage custom + OTHER
                      // seenLabels uses BOTH labels ("reverse holo") AND codes ("reverse_holo") to prevent
                      // built-in DB-stored codes appearing as duplicate custom entries.
                      const builtInLabels = new Set(UNIFIED_OPTIONS.map((o) => o.label.toLowerCase()));
                      const builtInCodes = new Set(UNIFIED_OPTIONS.map((o) => o.code.toLowerCase()));
                      const seenLabels = new Set<string>([...builtInLabels, ...builtInCodes]);
                      const extraVariants: UnifiedOption[] = [];
                      // DB variants first (shared across all admins/devices)
                      for (const v of dbVariants) {
                        const key = v.toLowerCase();
                        if (!seenLabels.has(key)) {
                          seenLabels.add(key);
                          extraVariants.push({
                            value: `VARIANT:${v}`,
                            label: v,
                            category: "VARIANT" as const,
                            code: v,
                          });
                        }
                      }
                      // localStorage custom variants (optimistic, same-device additions)
                      for (const v of customVariants) {
                        const key = v.toLowerCase();
                        if (!seenLabels.has(key)) {
                          seenLabels.add(key);
                          extraVariants.push({
                            value: `VARIANT:${v}`,
                            label: v,
                            category: "VARIANT" as const,
                            code: v,
                          });
                        }
                      }
                      const otherOpt = UNIFIED_OPTIONS.find((o) => o.value === "OTHER")!;
                      const allOptions: UnifiedOption[] = [
                        ...UNIFIED_OPTIONS.filter((o) => o.value !== "OTHER"),
                        ...extraVariants,
                        otherOpt,
                      ];
                      const q = unifiedSearch.toLowerCase().trim();
                      const filteredOpts = allOptions.filter(
                        (o) => !q || o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q)
                      );
                      const hasExactMatch =
                        !q || allOptions.some((o) => o.label.toLowerCase() === q || o.code.toLowerCase() === q);
                      const showAddButton = q.length > 1 && !hasExactMatch;

                      return (
                        <div ref={unifiedRef} className="relative">
                          <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                            Variant
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              setUnifiedOpen(!unifiedOpen);
                              setUnifiedSearch("");
                            }}
                            className={`w-full bg-transparent border rounded px-3 py-2 text-sm text-left flex items-center justify-between transition-colors focus:outline-none focus:border-[var(--admin-gold)] ${autofillRan && (manuallyEdited.has("rarity") || manuallyEdited.has("variant")) ? "border-[var(--admin-amber)]/50" : "border-[var(--admin-gold)]/30"}`}
                            data-testid="select-unified"
                          >
                            <span
                              className={form.unifiedSelect ? "text-[var(--admin-ink)]" : "text-[var(--admin-gold)]/20"}
                            >
                              {form.unifiedSelect
                                ? form.unifiedSelect === "OTHER"
                                  ? "OTHER (manual)"
                                  : getUnifiedDisplayLabel(form.unifiedSelect)
                                : "Select or type a variant..."}
                            </span>
                            <ChevronDown size={14} className="text-[var(--admin-gold)]/50" />
                          </button>
                          {unifiedOpen && (
                            <div
                              className="absolute z-50 left-0 right-0 mt-1 border border-[var(--admin-gold)]/30 bg-[var(--admin-panel)] rounded-lg shadow-xl max-h-72 overflow-hidden flex flex-col"
                              data-testid="unified-dropdown"
                            >
                              <div className="p-2 border-b border-[var(--admin-gold)]/10">
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
                                  className="w-full bg-transparent border border-[var(--admin-gold)]/20 rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs placeholder:text-[var(--admin-gold)]/20 focus:outline-none focus:border-[var(--admin-gold)]/50"
                                  autoFocus
                                  data-testid="input-unified-search"
                                />
                              </div>
                              <div className="overflow-y-auto flex-1">
                                {form.unifiedSelect && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      applyUnifiedSelection("");
                                      setUnifiedOpen(false);
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs text-[var(--admin-ink-faint)] hover:bg-[var(--admin-gold)]/10 hover:text-[var(--admin-ink-dim)] transition-colors border-b border-[var(--admin-gold)]/10"
                                    data-testid="unified-clear"
                                  >
                                    Clear selection
                                  </button>
                                )}
                                {showAddButton && (
                                  <button
                                    type="button"
                                    onClick={() => addCustomVariant(unifiedSearch)}
                                    className="w-full text-left px-3 py-2 text-sm text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10 transition-colors flex items-center gap-2 border-b border-[var(--admin-gold)]/10"
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
                                    onClick={() => {
                                      applyUnifiedSelection(o.value);
                                      setUnifiedOpen(false);
                                      setUnifiedSearch("");
                                    }}
                                    className={`w-full text-left px-3 py-2 text-sm transition-colors group ${form.unifiedSelect === o.value ? "bg-[var(--admin-gold)]/15 text-[var(--admin-gold)]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-gold)]/10 hover:text-[var(--admin-ink)]"}`}
                                    data-testid={`unified-option-${o.value}`}
                                  >
                                    <span className="block">{o.label}</span>
                                    {o.help && (
                                      <span className="block text-[10px] text-[var(--admin-ink-faint)] group-hover:text-[var(--admin-ink-dim)] mt-0.5">
                                        {o.help}
                                      </span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {form.unifiedSelect &&
                            (() => {
                              const opt = allOptions.find((o) => o.value === form.unifiedSelect);
                              return opt?.help ? (
                                <p
                                  className="text-[var(--admin-ink-faint)] text-[10px] mt-1 flex items-center gap-1"
                                  data-testid="text-unified-help"
                                >
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
                                className="w-full bg-transparent border border-[var(--admin-gold)]/20 rounded px-3 py-2 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-gold)]/20 focus:outline-none focus:border-[var(--admin-gold)]/50 transition-colors"
                                data-testid="input-other-text"
                              />
                              {dbRarityOthers.length > 0 && (
                                <div className="flex flex-wrap gap-1.5" data-testid="rarity-other-suggestions">
                                  {dbRarityOthers
                                    .filter(
                                      (v) => !form.otherText || v.toLowerCase().includes(form.otherText.toLowerCase())
                                    )
                                    .map((v) => (
                                      <button
                                        key={v}
                                        type="button"
                                        onClick={() =>
                                          setForm((f) => ({ ...f, otherText: v, rarity: "OTHER", rarityOther: v }))
                                        }
                                        className={`px-2 py-0.5 rounded text-xs border transition-colors ${form.otherText === v ? "bg-[var(--admin-gold)]/20 border-[var(--admin-gold)]/60 text-[var(--admin-gold)]" : "bg-transparent border-[var(--admin-gold)]/15 text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/40 hover:text-[var(--admin-ink)]"}`}
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
                  </div>
                </details>

                {/* AI Card Identification removed from the daily grading UI (founder
              decision 2026-07-16): graders identify cards manually with TCGdex
              lookup + the visual picker. The feature stays flag-OFF and dormant
              server-side; nothing here calls a provider. */}

                {/* Structured Pokémon rarity/variant picker (visual). Writes the new
              nullable columns only; the legacy Variant control above is unchanged. */}
                <div data-workflow-stage="rarity">
                  <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                    Structured Rarity &amp; Variant (visual picker)
                    <a
                      href="/admin/pokemon-knowledge"
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 normal-case tracking-normal text-[10px] text-slate-400 underline hover:text-slate-200"
                      title="Open the Pokémon Knowledge Hub — set codes, rarity symbols, comparisons and the printable handbook"
                    >
                      Knowledge Hub ↗
                    </a>
                  </label>
                  <RarityVariantPicker
                    // Keyed by certificate so switching cards REMOUNTS the picker
                    // and re-seeds its internal rarity/finish/promo from the new
                    // cert. Without this the picker keeps card A's selection
                    // (its state is seeded once at mount) — the same protection
                    // grading-panel.tsx already applies to this component.
                    key={certificate?.id ?? "new"}
                    legacyVariant={(certificate?.variant ?? form.variant) || null}
                    value={{
                      // Seed STRICTLY from the certificate (server truth), never from
                      // `form`. `key` and `value` are both evaluated in the RENDER of
                      // the commit where certificate.id changes, while `form` still
                      // holds the PREVIOUS card — the re-seed happens in a passive
                      // effect afterwards. Seeding from `form` would therefore mount
                      // the new picker with card A's selection and, on the first
                      // interaction, emit A's values into card B. Same rule (and same
                      // reason) as grading-panel.tsx's picker.
                      language:
                        languageByValueOrLabel(certificate?.language ?? form.language)?.value ?? "en",
                      era: ((certificate?.era ?? form.era) || null) as StructuredCardVariant["era"],
                      rarity: (certificate?.rarityCode ?? form.rarityCode) || null,
                      finish: (certificate?.finishVariant ?? form.finishVariant) || null,
                      promo: (certificate?.promoType ?? form.promoType) || null,
                      subset: (certificate?.subsetName ?? form.subsetName) || null,
                    }}
                    onChange={handleStructuredChange}
                    favourites={rarityFavourites}
                    recent={rarityRecent}
                    onFavouritesChange={onFavouritesChange}
                    onRecentChange={onRecentChange}
                    onCustomRarityNote={(note) => updateField("rarityOther", note ?? "")}
                  />

                  {/* Permanent classification summary (item 2) — always visible below
                the picker so the grader sees the exact language / rarity / finish /
                promo they have selected, in the same wording used on Review. */}
                  <VariantSummary
                    values={{
                      language: form.language,
                      rarityCode: form.rarityCode,
                      finishVariant: form.finishVariant,
                      promoType: form.promoType,
                      subsetName: form.subsetName,
                      variant: form.variant,
                      rarity: form.rarity,
                      variantOther: form.variantOther,
                      rarityOther: form.rarityOther,
                    }}
                  />
                </div>

                {/* Optional designations — collapsed by default so daily grading stays
              compact. Auto-open when the cert already carries designations. */}
                <details
                  className="rounded-lg border border-[var(--admin-gold)]/10 px-3 py-2"
                  open={designations.length > 0}
                  data-testid="designations-details"
                >
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]">
                    Optional designations{designations.length > 0 ? ` (${designations.length})` : ""}
                  </summary>
                  <div className="pt-2 flex flex-wrap gap-2" data-testid="designations-chips">
                    {DESIGNATION_OPTIONS.map((d) => {
                      const active = designations.includes(d.code);
                      return (
                        <button
                          key={d.code}
                          type="button"
                          onClick={() => toggleDesignation(d.code)}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-all ${active ? "bg-[var(--admin-gold)]/20 border-[var(--admin-gold)]/60 text-[var(--admin-gold)]" : "bg-transparent border-[var(--admin-gold)]/15 text-[var(--admin-ink-faint)] hover:border-[var(--admin-gold)]/30 hover:text-[var(--admin-ink-dim)]"}`}
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
                    <p
                      className="text-[var(--admin-ink-faint)] text-[10px] mt-1.5"
                      data-testid="text-designations-summary"
                    >
                      Selected: {designations.map((c) => getDesignationLabel(c)).join(", ")}
                    </p>
                  )}
                </details>

                {/* Stage 2 nav */}
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => goToStage(0)}
                    data-testid="button-back-to-card"
                    className="px-4 py-2 rounded-lg border border-[var(--admin-gold)]/30 text-[var(--admin-gold)]/80 text-xs font-bold uppercase hover:bg-[var(--admin-gold)]/10 transition-colors"
                  >
                    ← Back to Card
                  </button>
                  <button
                    type="button"
                    onClick={() => goToStage(2)}
                    data-testid="button-continue-to-grade"
                    className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase hover:opacity-90 transition-all"
                  >
                    Continue to Grade →
                  </button>
                </div>
              </div>

              {/* ── stage 1 (card) nav — all card fields (incl. Year + Language) now
              live in the two dense rows above ── */}
              <div className={`space-y-3 ${stageClass(0)}`}>
                {/* Stage 1 nav */}
                <div className="flex items-center justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      captureLastCardContext();
                      goToStage(1);
                    }}
                    disabled={!form.cardName.trim() || !form.cardNumber.trim()}
                    title={
                      !form.cardName.trim() || !form.cardNumber.trim()
                        ? "Enter the card name and number first."
                        : undefined
                    }
                    data-testid="button-continue-to-rarity"
                    className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Continue to Rarity →
                  </button>
                </div>
                {(!form.cardName.trim() || !form.cardNumber.trim()) && (
                  <p className={`text-[10px] text-[var(--admin-ink-faint)] text-right ${stageClass(0)}`}>
                    Enter the card name and number first.
                  </p>
                )}
              </div>
            </div>

            {/* Grading workstation — card tool front/back + defect marking. Placed
            right after Card Details (owner directive, Option A 2026-07-02):
            AI Identify → Card Details → grade the card → Grade section. Rendered
            inside the <form> but every workstation button is type="button" and
            handleSubmit no-ops pre-approval, so it can never submit the form. */}
            {/* Stage 3 · GRADE — the protected workstation renders UNCHANGED inside
            this wrapper. Hidden with CSS only (never unmounted, never scaled or
            transformed): the card tool reads getBoundingClientRect live per
            event, so visibility toggling cannot alter its coordinate system. */}
            <div data-workflow-stage="grade" className={stageClass(2)}>
              {workstationSlot && (
                // Plain in-flow wrapper — exists ONLY for the Enter-key guard below.
                // It must not size or scroll: a height cap here becomes a second
                // scrollport that clips the protected workstation. Full rationale +
                // measurements in tests/grading-grade-stage-layout.test.ts.
                <div
                  onKeyDown={(e) => {
                    // Workstation now lives inside the <form>. On an already-approved
                    // cert the explicit "Save Changes to Published Certificate" submit
                    // button exists, so Enter in a workstation text/number input would
                    // otherwise submit the form (save + close the editor, discarding
                    // the in-progress workstation edit). Swallow Enter's default for
                    // INPUT elements only — textareas keep newlines, selects/buttons
                    // are unaffected, and no grading input relies on Enter.
                    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
                      e.preventDefault();
                    }
                  }}
                >
                  {workstationSlot}
                </div>
              )}

              <div className="space-y-4">
                <div className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-widest mb-1">Grade</div>

                <div>
                  <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                    Grade Type *
                  </label>
                  <select
                    value={form.gradeType}
                    onChange={(e) => {
                      const gt = e.target.value;
                      setForm((f) => ({
                        ...f,
                        gradeType: gt,
                        ...(isNonNumericGrade(gt)
                          ? {
                              gradeOverall: "",
                              gradeCentering: "",
                              gradeCorners: "",
                              gradeEdges: "",
                              gradeSurface: "",
                            }
                          : {
                              gradeOverall: f.gradeOverall || "",
                            }),
                      }));
                    }}
                    className="w-full bg-transparent border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
                    data-testid="select-grade-type"
                  >
                    <option value="numeric" className="bg-[var(--admin-panel)]">
                      Numeric (1–10)
                    </option>
                    {NON_NUMERIC_GRADES.map((ng) => (
                      <option key={ng.value} value={ng.value} className="bg-[var(--admin-panel)]">
                        {ng.value} – {ng.description}
                      </option>
                    ))}
                  </select>
                </div>

                {isNonNum && (
                  <div className="bg-[var(--admin-gold)]/5 border border-[var(--admin-gold)]/20 rounded-lg p-3">
                    <p className="text-[var(--admin-gold)] text-sm font-semibold">
                      {form.gradeType === "NO" || form.gradeType === "not_original"
                        ? "AUTHENTIC – No Numerical Grade"
                        : "AUTHENTIC ALTERED – No Numerical Grade"}
                    </p>
                    <p className="text-[var(--admin-ink-dim)] text-xs mt-1">
                      {form.gradeType === "NO" || form.gradeType === "not_original"
                        ? "Card verified as authentic. No numerical grade or subgrades assigned."
                        : "Card verified as authentic but has been altered. No numerical grade or subgrades assigned."}
                    </p>
                  </div>
                )}

                {!isNonNum && (
                  <>
                    <div>
                      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                        Overall Grade
                      </label>
                      {/* Read-only (owner directive 2026-07-01): the grade is set 100%
                    automatically by the MVGS grading workstation (card tool +
                    defect pins). No manual grade entry on the certificate form. */}
                      <div
                        className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-gold)]/20 rounded px-3 py-2 text-[var(--admin-ink)] text-sm"
                        data-testid="display-grade-overall"
                      >
                        {form.gradeOverall
                          ? form.gradeOverall === "10" && form.labelType === "black"
                            ? "★ 10 — Black Label (Gem Mint)"
                            : form.gradeOverall
                          : "Not yet graded"}
                        <span className="text-[var(--admin-ink-dim)] text-xs ml-2">
                          — set automatically by MVGS grading
                        </span>
                      </div>
                    </div>

                    <div>
                      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">
                        Service Tier
                      </label>
                      <select
                        value={form.serviceTier}
                        onChange={(e) => updateField("serviceTier", e.target.value)}
                        className="w-full bg-transparent border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
                        data-testid="select-service-tier"
                      >
                        <option value="" className="bg-[var(--admin-panel)]">
                          Standard (default)
                        </option>
                        <option value="vault-queue" className="bg-[var(--admin-panel)]">
                          Vault Queue — £19
                        </option>
                        <option value="standard" className="bg-[var(--admin-panel)]">
                          Standard — £25
                        </option>
                        <option value="express" className="bg-[var(--admin-panel)]">
                          Express — £45
                        </option>
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Stage 3 nav */}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => goToStage(1)}
                  data-testid="button-back-to-rarity"
                  className="px-4 py-2 rounded-lg border border-[var(--admin-gold)]/30 text-[var(--admin-gold)]/80 text-xs font-bold uppercase hover:bg-[var(--admin-gold)]/10 transition-colors"
                >
                  ← Back to Rarity
                </button>
                <button
                  type="button"
                  onClick={() => goToStage(3)}
                  data-testid="button-review-card"
                  className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase hover:opacity-90 transition-all"
                >
                  Continue to Review →
                </button>
              </div>
            </div>

            {/* ── Card images and AI grading are handled by the GradingPanel workstation above ── */}

            {/* ── Legacy Grading Images section (hidden — use Capture Wizard in workstation instead) ── */}
            {false && isEdit && (
              <fieldset className="border border-[var(--admin-gold)]/20 rounded-lg p-4 space-y-4">
                <legend className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-widest px-2 flex items-center gap-2">
                  <Upload size={12} />
                  Grading Images
                </legend>

                <p className="text-[var(--admin-ink-dim)] text-xs">
                  Upload high-res scans for AI analysis. Front and back are required. Images are auto-cropped and
                  processed into analysis variants.
                </p>

                {/* 2×2 upload grid */}
                <div className="grid grid-cols-2 gap-3">
                  {(["front", "back", "angled", "closeup"] as const).map((angle) => {
                    const isRequired = angle === "front" || angle === "back";
                    const label =
                      angle === "front"
                        ? "Front (required)"
                        : angle === "back"
                          ? "Back (required)"
                          : angle === "angled"
                            ? "Angled (optional)"
                            : "Closeup (optional)";
                    const existingUrl = gradingUrls[`${angle}_cropped`] || gradingUrls[`${angle}_original`] || null;
                    const previewUrl = gradingPreviewUrls[angle] || null;
                    const displayUrl = previewUrl || existingUrl;
                    return (
                      <label
                        key={angle}
                        className={`relative border-2 border-dashed rounded-xl p-3 cursor-pointer transition-all flex flex-col items-center justify-center gap-2 min-h-[120px] text-center
                      ${gradingImages[angle] ? "border-[var(--admin-gold)]/60 bg-[var(--admin-gold)]/5" : "border-[var(--admin-line)] bg-[var(--admin-panel2)] hover:border-[var(--admin-gold)]/40 hover:bg-[var(--admin-panel)]"}`}
                      >
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) setGradingImages((prev) => ({ ...prev, [angle]: f }));
                          }}
                        />
                        {displayUrl ? (
                          <img src={displayUrl} alt={angle} className="w-full h-20 object-contain rounded" />
                        ) : (
                          <Upload
                            size={20}
                            className={isRequired ? "text-[var(--admin-gold)]/60" : "text-[var(--admin-ink-dim)]"}
                          />
                        )}
                        <span
                          className={`text-[10px] uppercase tracking-wider ${isRequired ? "text-[var(--admin-ink-dim)] font-semibold" : "text-[var(--admin-ink-faint)]"}`}
                        >
                          {label}
                        </span>
                        {gradingImages[angle] && (
                          <span className="text-[9px] text-[var(--admin-gold)] truncate w-full">
                            {gradingImages[angle]!.name}
                          </span>
                        )}
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
                    className="flex items-center gap-2 bg-[var(--admin-gold)]/10 border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] px-4 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all hover:bg-[var(--admin-gold)]/20 disabled:opacity-40"
                  >
                    {gradingUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    {gradingUploading ? "Uploading…" : "Upload & Process"}
                  </button>
                  {gradingUploadDone && (
                    <span className="text-[var(--admin-green)] text-xs flex items-center gap-1">
                      <CheckCircle2 size={12} /> Uploaded — variants generating in background
                    </span>
                  )}
                </div>

                {/* Quality check results */}
                {Object.keys(gradingQuality).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest">
                      Image Quality Checks
                    </p>
                    {Object.entries(gradingQuality).map(([angle, q]: [string, any]) => (
                      <div
                        key={angle}
                        className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3"
                      >
                        <p className="text-[var(--admin-ink)] text-[10px] font-bold uppercase mb-1">
                          {angle} —{" "}
                          {q.overall === "pass" ? (
                            <span className="text-[var(--admin-green)]">PASS</span>
                          ) : q.overall === "warn" ? (
                            <span className="text-[var(--admin-amber)]">WARN</span>
                          ) : (
                            <span className="text-[var(--admin-red)]">FAIL</span>
                          )}
                        </p>
                        <div className="space-y-0.5">
                          {(q.checks || []).map((c: any, i: number) => (
                            <p
                              key={i}
                              className={`text-[10px] ${c.status === "pass" ? "text-[var(--admin-ink-faint)]" : c.status === "warn" ? "text-[var(--admin-amber)]" : "text-[var(--admin-red)]"}`}
                            >
                              {c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"} {c.message}
                            </p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Card database lookup */}
                <div className="space-y-2 pt-2 border-t border-[var(--admin-line)]">
                  <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest">
                    Verify Card Identity
                  </p>
                  <div className="flex gap-2">
                    <select
                      value={cardLookupGame}
                      onChange={(e) => setCardLookupGame(e.target.value)}
                      className="bg-[var(--admin-panel)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[var(--admin-gold)]"
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
                      className="flex-1 bg-[var(--admin-panel)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-3 py-1.5 placeholder-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)]"
                    />
                    <button
                      type="button"
                      onClick={runCardLookup}
                      disabled={cardLookupLoading || !cardLookupQuery.trim()}
                      className="flex items-center gap-1 bg-[var(--admin-gold)]/10 border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] px-3 py-1.5 rounded text-xs font-bold disabled:opacity-40 hover:bg-[var(--admin-gold)]/20"
                    >
                      {cardLookupLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                    </button>
                  </div>
                  {cardLookupResults.length > 0 && (
                    <div className="bg-[var(--admin-panel)] rounded-lg border border-[var(--admin-line)] max-h-48 overflow-y-auto">
                      {cardLookupResults.map((r, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            updateField("cardName", r.name);
                            if (r.setName) updateField("setName", r.setName);
                            if (r.year) updateField("year", r.year);
                            if (r.number) updateField("cardNumber", r.number);
                            if (r.rarity) updateField("rarity", r.rarity);
                            setCardLookupResults([]);
                            toast({ title: "Card details filled", description: `${r.name} from ${r.setName}` });
                          }}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--admin-gold)]/5 border-b border-[var(--admin-line)] last:border-0 flex items-start gap-3"
                        >
                          {r.imageUrl && (
                            <img
                              src={r.imageUrl}
                              alt={r.name}
                              className="w-8 h-10 object-contain rounded flex-shrink-0"
                            />
                          )}
                          <div>
                            <p className="text-[var(--admin-ink)] font-medium">{r.name}</p>
                            <p className="text-[var(--admin-ink-dim)] text-[10px]">
                              {r.setName}
                              {r.number ? ` · ${displayCollectorNumber(r.number)}` : ""}
                              {r.rarity ? ` · ${r.rarity}` : ""}
                            </p>
                            <p className="text-[var(--admin-ink-faint)] text-[9px]">{r.source}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {cardLookupResults.length === 0 && cardLookupQuery && !cardLookupLoading && (
                    <p className="text-[var(--admin-ink-faint)] text-[10px]">
                      No results — check spelling or try a shorter name.
                    </p>
                  )}
                </div>
              </fieldset>
            )}

            {/* ── Legacy AI Grading Panel (hidden — use workstation's ANALYZE WITH AI instead) ── */}
            {false && isEdit && (
              <fieldset className="border border-[var(--admin-gold)]/30 rounded-lg p-4 space-y-4">
                <legend className="text-[var(--admin-gold)] text-xs uppercase tracking-widest px-2 flex items-center gap-2">
                  <Cpu size={12} />
                  AI-Assisted Grading
                </legend>

                <div className="flex items-center justify-between">
                  <p className="text-[var(--admin-ink-dim)] text-xs">
                    Analyze card photos with Claude Vision to generate a draft grade.
                  </p>
                  <button
                    type="button"
                    onClick={runAiAnalysis}
                    disabled={aiLoading}
                    className="flex items-center gap-2 bg-[var(--admin-gold)]/10 border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] px-4 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all hover:bg-[var(--admin-gold)]/20 disabled:opacity-50"
                    data-testid="button-analyze-ai"
                  >
                    {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Cpu size={14} />}
                    {aiLoading ? "Analyzing…" : "Analyze with AI"}
                  </button>
                </div>

                {aiLoading && (
                  <div className="flex items-center gap-3 text-[var(--admin-gold)] text-xs bg-[var(--admin-gold)]/5 border border-[var(--admin-gold)]/20 rounded-lg p-3">
                    <Loader2 size={14} className="animate-spin shrink-0" />
                    Sending images to Claude Vision. This takes 15–30 seconds…
                  </div>
                )}

                {aiError && (
                  <div className="flex items-center gap-2 text-[var(--admin-red)] text-xs bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded-lg p-3">
                    <AlertTriangle size={14} className="shrink-0" />
                    {aiError}
                  </div>
                )}

                {aiAnalysis && !aiLoading && (
                  <div className="space-y-4">
                    {/* Subgrade cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {(["centering", "corners", "edges", "surface"] as const).map((cat) => (
                        <div
                          key={cat}
                          className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3 text-center"
                        >
                          <p className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-widest mb-1">
                            {cat}
                          </p>
                          <p className="text-2xl font-black mb-1" style={{ color: subgradeColor(aiDraft[cat]) }}>
                            {aiDraft[cat] || "—"}
                          </p>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            step="0.5"
                            value={aiDraft[cat]}
                            onChange={(e) => setAiDraft((d) => ({ ...d, [cat]: e.target.value }))}
                            className="w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-[var(--admin-ink)] text-xs text-center focus:outline-none focus:border-[var(--admin-gold)]"
                          />
                          <p className="text-[var(--admin-ink-faint)] text-[9px] leading-tight mt-1.5 line-clamp-2">
                            {aiAnalysis[cat]?.notes || ""}
                          </p>
                        </div>
                      ))}
                    </div>

                    {/* Centering ratios */}
                    {aiAnalysis.centering && (
                      <div className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3 text-xs grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {[
                          ["Front L/R", aiAnalysis.centering.front_left_right],
                          ["Front T/B", aiAnalysis.centering.front_top_bottom],
                          ["Back L/R", aiAnalysis.centering.back_left_right],
                          ["Back T/B", aiAnalysis.centering.back_top_bottom],
                        ].map(([label, val]) => (
                          <div key={label}>
                            <p className="text-[var(--admin-ink-faint)] text-[9px] uppercase">{label}</p>
                            <p className="text-[var(--admin-ink)] font-mono font-bold">{val || "—"}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Defects */}
                    {aiDefects.length > 0 && (
                      <div>
                        <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest mb-2">
                          Identified Defects
                        </p>
                        <div className="space-y-1.5">
                          {aiDefects.map((d, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-2 bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded px-3 py-2"
                            >
                              <div className="flex-1 min-w-0">
                                <span className="text-[var(--admin-gold)] text-xs font-semibold uppercase">
                                  {d.type?.replace(/_/g, " ")}
                                </span>
                                <span className="text-[var(--admin-ink-dim)] text-xs mx-1.5">·</span>
                                <span className="text-[var(--admin-ink-dim)] text-xs">{d.location}</span>
                                <span className="text-[var(--admin-ink-dim)] text-xs mx-1.5">·</span>
                                <span className="text-[var(--admin-ink-faint)] text-xs italic">{d.severity}</span>
                                <p className="text-[var(--admin-ink-dim)] text-[11px] mt-0.5">{d.description}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => setAiDefects((prev) => prev.filter((_, j) => j !== i))}
                                className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-red)] transition-colors shrink-0 mt-0.5"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Overall grade + explanation */}
                    <div className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-widest">
                            AI Draft Overall
                          </p>
                          <p className="text-3xl font-black" style={{ color: subgradeColor(aiDraft.overall) }}>
                            {aiDraft.overall || "—"}
                          </p>
                          <p className="text-[var(--admin-gold)] text-xs">{aiAnalysis.grade_label || ""}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-widest mb-1">
                            Override Overall
                          </p>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            step="0.5"
                            value={aiDraft.overall}
                            onChange={(e) => setAiDraft((d) => ({ ...d, overall: e.target.value }))}
                            className="w-24 bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-[var(--admin-ink)] text-sm text-center focus:outline-none focus:border-[var(--admin-gold)]"
                          />
                        </div>
                      </div>
                      {aiAnalysis.grade_explanation && (
                        <p className="text-[var(--admin-ink-dim)] text-xs leading-relaxed border-t border-[var(--admin-line)] pt-3">
                          {aiAnalysis.grade_explanation}
                        </p>
                      )}
                      {aiAnalysis.authentication_notes && (
                        <p className="text-[var(--admin-ink-faint)] text-[11px] leading-relaxed mt-2 italic">
                          {aiAnalysis.authentication_notes}
                        </p>
                      )}
                    </div>

                    {/* Approve button */}
                    {!approved ? (
                      <button
                        type="button"
                        onClick={approveGrade}
                        disabled={approveLoading || !aiDraft.overall}
                        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] py-3 rounded font-bold text-sm uppercase tracking-widest disabled:opacity-50 hover:opacity-90 transition-opacity"
                        data-testid="button-approve-grade"
                      >
                        {approveLoading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                        {approveLoading ? "Approving…" : "Approve Grade"}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 text-[var(--admin-green)] text-sm font-semibold bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)] rounded-lg p-3">
                        <CheckCircle2 size={16} />
                        Grade approved
                      </div>
                    )}
                  </div>
                )}

                <p className="text-[var(--admin-ink-faint)] text-[10px] leading-relaxed">
                  Upload high-res scans (1200+ DPI) for best results. Card must be outside the sleeve. Use even, diffuse
                  lighting — avoid shadows and hot-spots. Holo cards: photograph at an angle to reveal surface
                  scratches.
                </p>
              </fieldset>
            )}

            {error && (
              <p className="text-[var(--admin-red)] text-sm" data-testid="text-form-error">
                {error}
              </p>
            )}

            {/* Stage 4 · REVIEW & SAVE — moved grader notes (collapsed) + the existing
            explicit save action. Note content, templates and persistence are the
            EXACT pre-existing implementation, only relocated. */}
            <div data-workflow-stage="review" className={`space-y-2.5 ${stageClass(3)}`}>
              {/* Compact approval header — frames Stage 4 as a final dashboard and keeps
            Back to Grade as a quiet inline control instead of a chunky button row. */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">
                  Final review &amp; approval
                </span>
                <button
                  type="button"
                  onClick={() => goToStage(2)}
                  data-testid="button-back-to-grade"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/70 hover:bg-[var(--admin-gold)]/10 hover:text-[var(--admin-gold)] transition-colors"
                >
                  ← Back to Grade
                </button>
              </div>
              {/* Read-only confirmation summary — every value comes from existing form
            state; Edit links only switch the local stage (no save/mutation). */}
              <ReviewSummary
                values={{
                  certificateId: certificate?.id ?? null,
                  frontFile: frontImage,
                  backFile: backImage,
                  cardGame: form.cardGame,
                  cardName: form.cardName,
                  setName: form.setName,
                  cardNumber: form.cardNumber,
                  year: form.year,
                  language: form.language,
                  rarityCode: form.rarityCode,
                  finishVariant: form.finishVariant,
                  promoType: form.promoType,
                  subsetName: form.subsetName,
                  era: form.era,
                  variant: form.variant,
                  rarity: form.rarity,
                  variantOther: form.variantOther,
                  rarityOther: form.rarityOther,
                  designations,
                  gradeOverall: form.gradeOverall,
                  labelType: form.labelType,
                  status: form.status,
                }}
                onEditCard={() => goToStage(0)}
                onEditRarity={() => goToStage(1)}
                onEditGrade={() => goToStage(2)}
              />
              {/* Authentication summary — shown only for non-numeric (Authentic /
            Authentic Altered) grade types, derived from the EXISTING form
            gradeType. No value is invented; numeric grades render nothing here. */}
              {isNonNum && (
                <div
                  className="flex items-center gap-2 rounded-lg border border-[var(--admin-gold)]/15 bg-[var(--admin-gold)]/[0.02] px-2.5 py-1.5"
                  data-testid="review-authentication"
                >
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">
                    Authentication
                  </span>
                  <span className="text-[12px] font-bold text-[var(--admin-ink)]">
                    {NON_NUMERIC_GRADES.find((ng) => ng.value === form.gradeType)?.description ?? form.gradeType}
                  </span>
                </div>
              )}
              {/* The Review-stage live FRONT-label preview is now the single
                  canonical CertificatePreviewPanel (mounted once, above, for the
                  Rarity + Review stages via WorkstationPreviewAside `below`). The
                  former second LabelPreview here was a duplicate of the same
                  renderer and endpoint and has been consolidated away. */}
              {/* Public Notes with preset helper — moved from Card Details, unchanged. */}
              {notesOpen ? (
                <div className="border border-[var(--admin-gold)]/20 rounded-lg p-3 space-y-3 bg-[var(--admin-gold)]/[0.02]">
                  <div className="flex items-center gap-2">
                    <FileText size={13} className="text-[var(--admin-gold)]/60 shrink-0" />
                    <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider">
                      Public Notes <span className="text-[var(--admin-ink-faint)] normal-case tracking-normal">· shown on the certificate</span>
                    </label>
                  </div>

                  {/* Template buttons */}
                  <div>
                    <p className="text-[var(--admin-gold)]/40 text-[10px] uppercase tracking-widest mb-1.5">
                      Insert template
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {NOTE_TEMPLATES.map((t) => (
                        <button
                          key={t.label}
                          type="button"
                          onClick={() => updateField("notes", t.text)}
                          className="text-xs px-2.5 py-1 rounded border border-[var(--admin-gold)]/30 text-[var(--admin-gold)]/70 hover:border-[var(--admin-gold)]/60 hover:text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/5 transition-all"
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
                    className="w-full bg-transparent border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-gold)]/20 focus:outline-none focus:border-[var(--admin-gold)] transition-colors resize-none"
                    data-testid="input-cert-notes"
                  />

                  {/* Preset chips */}
                  <div>
                    <p className="text-[var(--admin-gold)]/40 text-[10px] uppercase tracking-widest mb-1.5">
                      Quick add
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {PRESET_NOTES.map((preset) => {
                        const lines = form.notes
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean);
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
                                ? "border-[var(--admin-gold)]/15 text-[var(--admin-gold)]/25 cursor-default"
                                : "border-[var(--admin-gold)]/25 text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/50 hover:text-[var(--admin-ink)] hover:bg-[var(--admin-gold)]/5 cursor-pointer"
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
              ) : (
                <button
                  type="button"
                  onClick={() => setNotesOpen(true)}
                  data-testid="button-add-grader-notes"
                  className="w-full px-4 py-2.5 rounded-lg border border-dashed border-[var(--admin-gold)]/30 text-[var(--admin-gold)]/70 text-xs font-bold uppercase hover:bg-[var(--admin-gold)]/5 transition-colors"
                >
                  + Add Public Notes
                </button>
              )}

              {/* Owner directive (2026-07-01): an existing, not-yet-approved
            certificate auto-saves silently (see autoSaveNow above) — no
            manual button, matching the grading workstation below it. Create
            flow (no certificate yet) and an already-approved/published
            certificate (server has no approval lock of its own — see
            autoSaveEligible) both keep an explicit save action. */}
              {correctionMode ? (
                <div
                  className="flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)] h-6"
                  data-testid="text-correction-save-owned-by-parent"
                >
                  Correction Mode uses the Save Correction button.
                </div>
              ) : autoSaveEligible ? (
                /* Item 7 — a large explicit Save button on Review. Auto-save is
                   preserved (owner directive 2026-07-01): this button FORCES an
                   immediate save via the same autoSaveNow() path rather than the
                   navigating mutation, so it never leaves the workstation. The
                   status line below still reflects auto-save + this save. */
                <div className="space-y-1.5">
                  {/* One-time conversion warning — shown ONLY at the boundary where
                      this certificate first moves onto the consolidated scheme while
                      it still carries legacy free text the new line will not print.
                      The wording stays in the database either way. */}
                  {legacyLossWarning && legacyLossWarning.length > 0 && (
                    <div
                      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5"
                      data-testid="legacy-freetext-warning"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-wide text-amber-300">
                        Legacy wording will stop printing
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--admin-ink)]">
                        This save converts the certificate to the structured classification. The typed wording{" "}
                        <span className="font-semibold">{legacyLossWarning.join(" · ")}</span> stays stored on the record but
                        will <span className="font-semibold">no longer appear on the printed label</span>, because a
                        converted certificate prints only its explicit structured selections.
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--admin-ink-faint)]">
                        If that wording is still required, cancel and select the matching structured values instead.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          data-testid="legacy-freetext-warning-confirm"
                          onClick={() => {
                            legacyLossAckRef.current = true;
                            setLegacyLossWarning(null);
                            autoSaveNow();
                          }}
                          className="rounded-md border border-amber-400/60 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/15"
                        >
                          Convert and save
                        </button>
                        <button
                          type="button"
                          data-testid="legacy-freetext-warning-cancel"
                          onClick={() => setLegacyLossWarning(null)}
                          className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:border-slate-400"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  <GradientButton
                    as="button"
                    type="button"
                    onClick={() => {
                      // Cancel any pending debounced auto-save so this explicit
                      // save doesn't get followed by a redundant second PUT.
                      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
                      autoSaveNow();
                    }}
                    disabled={autoSaveStatus === "saving"}
                    height="48px"
                    className="w-full"
                    data-testid="button-save-now"
                  >
                    <Save size={16} />
                    {autoSaveStatus === "saving" ? "Saving…" : "Save Now"}
                  </GradientButton>
                  <div
                    className="flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)] h-5"
                    data-testid="text-autosave-status"
                  >
                    {autoSaveStatus === "saving" && (
                      <span className="flex items-center gap-1.5">
                        <Loader2 size={10} className="animate-spin" /> Saving…
                      </span>
                    )}
                    {autoSaveStatus === "saved" && (
                      <span className="flex items-center gap-1.5 text-[var(--admin-green)]">
                        <CheckCircle2 size={10} /> Saved · auto-saves as you edit
                      </span>
                    )}
                    {autoSaveStatus === "idle" && (
                      <span className="text-[var(--admin-ink-faint)]">Auto-saves as you edit</span>
                    )}
                    {autoSaveStatus === "error" && (
                      <span className="text-[var(--admin-red)]">Save failed — retrying on next change</span>
                    )}
                  </div>
                </div>
              ) : (
                <GradientButton
                  as="button"
                  type="submit"
                  disabled={mutation.isPending}
                  height="48px"
                  className="w-full"
                  data-testid="button-save-cert"
                >
                  <Save size={16} />
                  {mutation.isPending
                    ? "Saving..."
                    : isEdit
                      ? "Save Changes to Published Certificate"
                      : "Save Certificate"}
                </GradientButton>
              )}
            </div>
          </form>
        </CanonicalGradingWorkstationShell>
    </div>
  );
}

function FormInput({
  label,
  value,
  onChange,
  onBlur,
  testId,
  placeholder,
  type,
  step,
  min,
  max,
  highlight,
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
      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <input
        type={type || "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        step={step}
        min={min}
        max={max}
        className={`w-full bg-transparent border rounded px-3 py-2 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-gold)]/20 focus:outline-none focus:border-[var(--admin-gold)] transition-colors ${highlight ? "border-[var(--admin-amber)]/50" : "border-[var(--admin-gold)]/30"}`}
        data-testid={testId}
      />
    </div>
  );
}

type SelectOption = string | { value: string; label: string };

function FormSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  testId: string;
}) {
  return (
    <div>
      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[var(--admin-panel)] border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
        data-testid={testId}
      >
        <option value="">Select...</option>
        {options.map((opt) => {
          const v = typeof opt === "string" ? opt : opt.value;
          const l = typeof opt === "string" ? opt : opt.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function FileUpload({
  label,
  current,
  onChange,
  testId,
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
      <label className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-wider block mb-1.5">{label}</label>
      <label
        className={`relative block border-2 border-dashed rounded-xl cursor-pointer transition-all overflow-hidden
          ${dragging ? "border-[var(--admin-gold)] bg-[var(--admin-gold)]/5" : displaySrc ? "border-[var(--admin-gold)]/40 bg-[var(--admin-panel2)]" : "border-[var(--admin-line)] bg-[var(--admin-panel2)] hover:border-[var(--admin-gold)]/40 hover:bg-[var(--admin-panel)]"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
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
            <img
              src={displaySrc}
              alt={label}
              className="w-full h-40 object-contain rounded-xl bg-[var(--admin-panel)] p-2"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/20 transition-all rounded-xl">
              <span className="opacity-0 hover:opacity-100 text-white text-xs font-bold bg-black/50 px-2 py-1 rounded transition-opacity">
                Replace
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center min-h-[140px]">
            <Upload size={24} className="text-[var(--admin-gold)]/50" />
            <p className="text-[var(--admin-ink-dim)] text-xs font-medium">Drag & drop or click to upload</p>
            <p className="text-[var(--admin-ink-faint)] text-[10px]">JPG, PNG, WEBP</p>
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

function SubmissionItemLink({ value, onChange }: { value: string; onChange: (id: string, item?: any) => void }) {
  const { data: items, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/submission-items/unlinked"],
    queryFn: async () => {
      const res = await fetch("/api/admin/submission-items/unlinked", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  return (
    <fieldset
      className="border border-[var(--admin-gold)]/20 rounded-lg p-4 space-y-2"
      data-testid="fieldset-submission-link"
    >
      <legend className="text-[var(--admin-gold)]/70 text-xs uppercase tracking-widest px-2 flex items-center gap-1.5">
        <Link2 size={12} /> Link to Submission
      </legend>
      <p className="text-[var(--admin-ink-faint)] text-xs">
        Optionally link this certificate to a customer submission item. Fields will auto-populate.
      </p>
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
        className="w-full bg-[var(--admin-panel)] border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
        data-testid="select-submission-item"
      >
        <option value="">No link (standalone certificate)</option>
        {isLoading && (
          <option value="" disabled>
            Loading...
          </option>
        )}
        {items?.map((item: any) => (
          <option key={item.id} value={String(item.id)}>
            Sub #{item.submission_id} Card {item.card_index} — {item.card_name || item.game || "Unnamed"}{" "}
            {item.card_set ? `(${item.card_set})` : ""} — {item.customer_first_name} {item.customer_last_name}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

// ── Pokemon Set Picker — searchable dropdown from TCG API ────────────────

interface PokemonSet {
  id: string;
  name: string;
  series: string;
  ptcgoCode: string | null;
  releaseDate: string;
  total: number;
  source?: string;
}

export function PokemonSetPicker({
  value,
  onChange,
  testId,
  allowAddSet = true,
  allowEditSet = false,
  createEndpoint = "/api/admin/custom-sets",
  editEndpoint,
  prefill,
}: {
  value: string;
  onChange: (name: string, id?: string) => void;
  testId?: string;
  /** Show the "Add custom set" affordance. Admin defaults to the admin endpoint;
   *  graders pass allowAddSet + createEndpoint="/api/staff/custom-sets" so they can
   *  add a set whose name isn't in the picker rather than being blocked. */
  allowAddSet?: boolean;
  /** Show set editing for authorised admin/staff surfaces. Only custom sets are editable. */
  allowEditSet?: boolean;
  /** Where the add-set form POSTs. Default admin; graders override to the
   *  staff endpoint (admin-or-grade auth + dedup). */
  createEndpoint?: string;
  /** Where the edit-set form PATCHes. Defaults to the add-set endpoint base. */
  editEndpoint?: string;
  /** Seed the add-set form (e.g. from the AI identification) so the operator just
   *  confirms. setCode → Set Code, setName → Set Name. */
  prefill?: { setName?: string; setCode?: string };
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<PokemonSet[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ setId: "", setName: "", series: "Promo", releaseYear: "", totalCards: "" });
  const [addSaving, setAddSaving] = useState(false);
  const [editingSet, setEditingSet] = useState<PokemonSet | null>(null);
  const [editForm, setEditForm] = useState({ setId: "", setName: "", series: "", releaseYear: "", totalCards: "" });
  const [editSaving, setEditSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Recently-used sets (last 8, per-device) so a grader working through a box of
  // the same set fills it in one click. Display-only convenience — never changes
  // stored data or the set catalogue.
  const [recentSets, setRecentSets] = useState<{ id: string; name: string }[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("mv.recentSets") || "[]");
      return Array.isArray(raw) ? raw.filter((r) => r && r.id && r.name).slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  function recordRecentSet(id: string, name: string) {
    if (!id || !name) return;
    setRecentSets((prev) => {
      const next = [{ id, name }, ...prev.filter((r) => r.id !== id)].slice(0, 8);
      try {
        localStorage.setItem("mv.recentSets", JSON.stringify(next));
      } catch {
        /* private mode — chips just won't persist */
      }
      return next;
    });
  }

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Unexpected error");

  useEffect(() => {
    setQuery(value);
  }, [value]);

  function fetchSets() {
    fetch("/api/pokemon-sets")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setSets(d);
      })
      .catch(() => {});
  }
  useEffect(() => {
    fetchSets();
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAddForm(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const q = query.toLowerCase().trim();
  // Intelligent set search — rank matches so typing a collection code or a
  // partial name surfaces the right set first, e.g. "MEW" → Scarlet & Violet 151
  // (MEW), "PAR" → Paradox Rift, "TG12"/"SVP…" → the matching promo/gallery set.
  // Case-insensitive fuzzy match over set code (ptcgo/collection code) AND name,
  // reading the EXISTING /api/pokemon-sets catalogue (data source unchanged).
  // Exact/prefix code hits outrank name hits; series is the weakest match.
  // NOTE: on staging the card_sets catalogue is near-empty, so results may be
  // sparse there — that's a data condition, not a UI bug.
  const scoreSet = (s: PokemonSet): number => {
    const code = (s.ptcgoCode || "").toLowerCase();
    const id = s.id.toLowerCase();
    const name = s.name.toLowerCase();
    const series = (s.series || "").toLowerCase();
    if (code === q || id === q) return 0; // exact collection code
    if (code.startsWith(q) || id.startsWith(q)) return 1; // code prefix
    if (name.startsWith(q)) return 2; // name prefix
    if (name.includes(q)) return 3; // name substring
    if (code.includes(q) || id.includes(q)) return 4; // code substring
    if (series.includes(q)) return 5; // series
    return 99; // no match
  };
  const filtered = q
    ? sets
        .map((s) => ({ s, score: scoreSet(s) }))
        .filter((x) => x.score < 99)
        .sort((a, b) => a.score - b.score)
        .slice(0, 12)
        .map((x) => x.s)
    : sets.slice(0, 12);

  const selectedSet = sets.find(
    (s) => s.source === "custom" && (s.name === query || s.name === value || s.id === query)
  );
  const canEditSelectedSet = allowEditSet && !!selectedSet;

  function openEditSet(set: PokemonSet) {
    setEditingSet(set);
    setEditForm({
      setId: set.id,
      setName: set.name,
      series: set.series || "",
      releaseYear: set.releaseDate ? set.releaseDate.split("-")[0] : "",
      totalCards: set.total ? String(set.total) : "",
    });
    setOpen(false);
    setShowAddForm(false);
  }

  async function saveNewSet() {
    if (!addForm.setId || !addForm.setName) return;
    setAddSaving(true);
    try {
      const normId = addForm.setId.replace(/\s+/g, "").toLowerCase();
      const r = await fetch(createEndpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setId: normId,
          setName: addForm.setName,
          series: addForm.series || null,
          releaseDate: addForm.releaseYear ? `${addForm.releaseYear}-01-01` : null,
          totalCards: addForm.totalCards ? parseInt(addForm.totalCards) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      // Dedup: the server matched an existing set (by code or name) and returned
      // it instead of creating a duplicate — select that one.
      if (d.duplicate) {
        toast({ title: "Existing set selected", description: d.message || `Using "${d.setName}".` });
      } else {
        toast({ title: `Custom set added: ${d.setId || normId}` });
      }
      fetchSets();
      onChange(d.setName || addForm.setName, d.setId || normId);
      setQuery(d.setName || addForm.setName);
      setShowAddForm(false);
      setOpen(false);
    } catch (e: unknown) {
      toast({ title: "Failed to add set", description: errorMessage(e), variant: "destructive" });
    } finally {
      setAddSaving(false);
    }
  }

  async function saveEditedSet() {
    if (!editingSet) return;
    const nextCode = editForm.setId.replace(/\s+/g, "").toLowerCase().trim();
    const nextName = editForm.setName.trim();
    if (!nextCode || !nextName) {
      toast({ title: "Set code and set name are required", variant: "destructive" });
      return;
    }

    const changedName = nextName !== editingSet.name;
    const changedCode = nextCode !== editingSet.id;
    if (
      (changedName || changedCode) &&
      !window.confirm("Changing a set name or code updates the existing set record. Continue?")
    ) {
      return;
    }

    setEditSaving(true);
    try {
      const r = await fetch(`${editEndpoint || createEndpoint}/${encodeURIComponent(editingSet.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setId: nextCode,
          setName: nextName,
          series: editForm.series || null,
          releaseYear: editForm.releaseYear ? parseInt(editForm.releaseYear, 10) : null,
          totalCards: editForm.totalCards ? parseInt(editForm.totalCards, 10) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not update set");

      const updated: PokemonSet = {
        id: d.setId || nextCode,
        name: d.setName || nextName,
        series: d.series || "Custom",
        ptcgoCode: editingSet.ptcgoCode || null,
        releaseDate: d.releaseYear ? `${d.releaseYear}-01-01` : "",
        total: d.totalCards || 0,
        source: "custom",
      };
      setSets((current) => [updated, ...current.filter((s) => s.id !== editingSet.id && s.id !== updated.id)]);
      onChange(updated.name, updated.id);
      setQuery(updated.name);
      setEditingSet(null);
      toast({ title: "Set updated", description: `${updated.name} (${updated.id})` });
    } catch (e: unknown) {
      toast({ title: "Failed to update set", description: errorMessage(e), variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <label className="text-[var(--admin-gold)]/60 text-[10px] uppercase tracking-wider block mb-1">Set Name *</label>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Type to search sets…"
        data-testid={testId}
        className="w-full bg-[var(--admin-panel)] border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-sm text-[var(--admin-ink)] placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)]"
      />
      {canEditSelectedSet && (
        <button
          type="button"
          onClick={() => openEditSet(selectedSet)}
          className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)] hover:text-[var(--admin-gold-bright)]"
        >
          <Pencil size={11} /> Edit Set
        </button>
      )}
      {open && (
        // Width is allowed to exceed the (narrow) input column — real set
        // names like "Chaos Rising" / "Perfect Origins" were being clipped
        // to the input's own width in production. Floors at 26rem, caps at
        // the viewport so it never overflows off-screen.
        <div className="absolute z-30 left-0 mt-1 w-[max(100%,26rem)] max-w-[calc(100vw-2rem)] bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {/* Recently-used sets — one-click fill, pinned above the list when the
              grader hasn't typed a query yet. */}
          {!q && recentSets.length > 0 && (
            <div className="border-b border-[var(--admin-line)] px-2 py-2" data-testid="recent-sets">
              <p className="mb-1 px-1 text-[9px] uppercase tracking-widest text-[var(--admin-gold)]/40">Recent sets</p>
              <div className="flex flex-wrap gap-1">
                {recentSets.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      onChange(r.name, r.id);
                      setQuery(r.name);
                      recordRecentSet(r.id, r.name);
                      setOpen(false);
                    }}
                    data-testid={`recent-set-${r.id}`}
                    className="rounded border border-[var(--admin-gold)]/25 px-2 py-1 text-[10px] text-[var(--admin-ink)] hover:bg-[var(--admin-gold)]/10"
                    title={`${r.id} · ${r.name}`}
                  >
                    <span className="font-mono text-[var(--admin-gold)] mr-1">{r.id}</span>
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {filtered.map((s) => {
            const year = s.releaseDate?.split("-")[0];
            const code = s.ptcgoCode || "";
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onChange(s.name, s.id);
                  setQuery(s.name);
                  recordRecentSet(s.id, s.name);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-[var(--admin-gold)]/5 border-b border-[var(--admin-line)] last:border-0"
              >
                {/* Line 1: recognisable collection code chip + set name. Line 2:
                    series · year · card count · internal id — so the grader can
                    recognise the set without memorising codes. */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-[var(--admin-gold)]/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-[var(--admin-gold)]">
                    {code || s.id}
                  </span>
                  {/* No truncate — full names must stay readable; the row may
                      wrap to two lines rather than clip destructively. */}
                  <span className="min-w-0 flex-1 text-xs font-medium leading-snug text-[var(--admin-ink)]">
                    {s.name}
                  </span>
                  {s.source === "custom" && (
                    <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] px-1 py-0.5 text-[8px] font-bold uppercase text-[var(--admin-green)]">
                      Custom
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--admin-ink-faint)]">
                  {s.series && <span>{s.series}</span>}
                  {year && <span>· {year}</span>}
                  {s.total ? <span>· {s.total} cards</span> : null}
                  {code && code !== s.id && <span className="font-mono">· {s.id}</span>}
                </div>
              </button>
            );
          })}
          {/* Add new set button (admin only) */}
          {allowAddSet && (
            <button
              type="button"
              onClick={() => {
                setShowAddForm(true);
                // Prefill from the AI identification where available, else from
                // what the operator typed, so they just confirm: the typed text is
                // the SET NAME field; the code comes from AI if known.
                setAddForm((f) => ({
                  ...f,
                  setName: prefill?.setName || query || f.setName,
                  setId: prefill?.setCode || f.setId,
                }));
              }}
              className="w-full text-left px-3 py-2.5 text-xs text-[var(--admin-gold)] font-bold hover:bg-[var(--admin-gold)]/5 border-t border-[var(--admin-line)] flex items-center gap-1"
            >
              <Plus size={12} /> Add new set{query ? ` "${query}"` : ""}
            </button>
          )}
        </div>
      )}

      {/* Add set modal */}
      {allowAddSet && showAddForm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowAddForm(false)}
        >
          <div className="bg-[var(--admin-panel)] rounded-lg p-5 w-96 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Add Custom Set</p>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Set Code *</label>
              <input
                value={addForm.setId}
                onChange={(e) => setAddForm((f) => ({ ...f, setId: e.target.value }))}
                placeholder="e.g. M24 EN"
                className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
              />
            </div>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Set Name *</label>
              <input
                value={addForm.setName}
                onChange={(e) => setAddForm((f) => ({ ...f, setName: e.target.value }))}
                placeholder="e.g. McDonald's Match Battle 2024"
                className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Series</label>
                <input
                  value={addForm.series}
                  onChange={(e) => setAddForm((f) => ({ ...f, series: e.target.value }))}
                  placeholder="Promo"
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Year</label>
                <input
                  type="number"
                  value={addForm.releaseYear}
                  onChange={(e) => setAddForm((f) => ({ ...f, releaseYear: e.target.value }))}
                  placeholder="2024"
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Total Cards</label>
                <input
                  type="number"
                  value={addForm.totalCards}
                  onChange={(e) => setAddForm((f) => ({ ...f, totalCards: e.target.value }))}
                  placeholder="15"
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="flex-1 border border-[var(--admin-line)] text-[var(--admin-ink-faint)] text-xs py-2 rounded hover:bg-[var(--admin-panel2)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveNewSet}
                disabled={addSaving || !addForm.setId || !addForm.setName}
                className="flex-1 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-50"
              >
                {addSaving ? "Saving…" : "Add Set"}
              </button>
            </div>
          </div>
        </div>
      )}

      {allowEditSet && editingSet && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setEditingSet(null)}
        >
          <div className="bg-[var(--admin-panel)] rounded-lg p-5 w-96 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Edit Set</p>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Set Code *</label>
              <input
                value={editForm.setId}
                onChange={(e) => setEditForm((f) => ({ ...f, setId: e.target.value }))}
                className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
              />
            </div>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Set Name *</label>
              <input
                value={editForm.setName}
                onChange={(e) => setEditForm((f) => ({ ...f, setName: e.target.value }))}
                className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Series</label>
                <input
                  value={editForm.series}
                  onChange={(e) => setEditForm((f) => ({ ...f, series: e.target.value }))}
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Year</label>
                <input
                  type="number"
                  value={editForm.releaseYear}
                  onChange={(e) => setEditForm((f) => ({ ...f, releaseYear: e.target.value }))}
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-0.5">Card Count</label>
                <input
                  type="number"
                  value={editForm.totalCards}
                  onChange={(e) => setEditForm((f) => ({ ...f, totalCards: e.target.value }))}
                  className="w-full border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs bg-white text-[#111] placeholder:text-gray-400"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingSet(null)}
                className="flex-1 border border-[var(--admin-line)] text-[var(--admin-ink-faint)] text-xs py-2 rounded hover:bg-[var(--admin-panel2)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEditedSet}
                disabled={editSaving || !editForm.setId.trim() || !editForm.setName.trim()}
                className="flex-1 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-50"
              >
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

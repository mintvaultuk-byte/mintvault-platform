/**
 * Vault Quest AI generators (Phases 2-4). Each builds a guard-railed prompt, calls
 * the text provider, parses strict JSON, screens every suggestion through the
 * guardrails, and returns PREVIEW-ONLY suggestions. Nothing is saved or applied
 * here — the route records an audit row and the client requires a manual Apply.
 */
import { getTextProvider } from "./provider";
import { guardInput, guardOutput } from "./guardrails";

export interface CardContext {
  name?: string;
  cardType?: string;
  element?: string;
  stageNumber?: string | number;
  familyName?: string;
  previousStage?: string;
  rarity?: string;
  health?: string | number;
  guard?: string | number;
  shift?: string | number;
  attack1Name?: string;
  attack1Damage?: string | number;
  attack2Name?: string;
  vulnerability?: string;
  // ── family-consistency (hydrated by the route from the DB; all optional) ──
  familyId?: string;
  variantTier?: string;
  baseCardId?: string;
  familyElement?: string;
  /** The family's canonical name for THIS card's stage (e.g. "Flammro"). Present ⇒ the species is locked. */
  canonicalStageName?: string;
  /** For a variant: its base card's species name. */
  baseName?: string;
  characterDna?: string;
  visualDescription?: string;
  bodyShape?: string;
  colours?: string;
  markings?: string;
  eyes?: string;
  tailAccessories?: string;
  personality?: string;
  stageProgressionNotes?: string;
  elementIdentity?: string;
  negativePrompt?: string;
  masterArtworkPrompt?: string;
  referenceArtworkR2Key?: string;
  approvedArtworkR2Key?: string;
  previousCharacterName?: string;
  previousCharacterDna?: string;
  previousVisualDescription?: string;
}

export interface Suggestion {
  text: string; // display string
  reason?: string;
  pronunciation?: string;
  warning?: string; // similarity / style warnings (soft)
  fields?: Record<string, unknown>; // structured values to Apply (stats, attack, family names…)
}

export interface GenResult {
  suggestions: Suggestion[];
  provider: string;
  model: string;
  promptSummary: string;
  dropped: number; // suggestions removed by guardrails
  note?: string;
}

export type GenKind = "name" | "family-names" | "gameplay" | "flavour" | "artwork-prompt";

// The locked VQ lexicon the model must stay inside.
const LEXICON = `Vault Quest lexicon (MANDATORY): use Health, Guard, Shift, Core (energy), Ascend (evolve), Vulnerability. NEVER use HP, Weakness, Resistance, Retreat, or any Pokémon/Yu-Gi-Oh/Magic/Lorcana/Digimon/One Piece term. Attacks are free unless a Core cost is printed. Family-friendly, readable by a child.`;
const NAME_RULES = `Names must be SHORT (one word preferred, max two), invented and evocative, easy to say. FORBIDDEN: medieval words (guardian, sentinel, warden, knight, vault, sword, shield, castle, realm, throne, etc.); the specific words Guardian/Sentinel/Warden/Knight/Vault; copying or near-copying Pokémon/Yu-Gi-Oh/Magic/Lorcana/Digimon/One Piece names; any trademarked name.`;
const STAGE_SCALE = `Stage 1 (Baby) is weakest, Stage 2 (Teen) stronger, Stage 3 (Final) strongest. Baseline stats: S1 Health 5 / Guard 0 / Shift 0; S2 8 / 1 / 1; S3 12 / 3 / 2. Keep numbers small and whole.`;

// Element → attack theme. Total over every element the 12 real families use (+ the
// editor's default "Flame"); the generic fallback means it is NEVER silently
// disabled for an unmapped element, so rule 3 (element-matched attacks) always fires.
const ELEMENT_THEME: Record<string, string> = {
  Blaze: "fire, flame, ember and heat",
  Flame: "fire, flame, ember and heat",
  Tide: "water, wave, tidal and ocean",
  Water: "water, current, splash and aqua",
  Blossom: "nature, petal, bloom, pollen and vine",
  Spark: "electric spark, jolt and static",
  Electric: "lightning, shock, volt and thunder",
  Earth: "earth, rock, stone, quake and boulder",
  Cosmos: "cosmic, star, gravity and nebula",
  Wind: "wind, gust, gale and air",
  Ice: "ice, frost, freeze, glacial and snow",
  Dark: "shadow, dark, night and umbral",
};
function elementTheme(element?: string): string {
  const e = (element ?? "").trim();
  return ELEMENT_THEME[e] || (e ? `${e}-themed` : "on-element");
}
// Per-element vocabulary for a SOFT off-element check (warning only — never a hard
// reject, which would false-positive-loop and burn tokens; identity/element/stats
// are the hard guarantees, attacks are steered + flagged).
const ELEMENT_TOKENS: Record<string, string[]> = {
  Blaze: ["fire", "flame", "ember", "burn", "heat", "lava", "blaze"],
  Flame: ["fire", "flame", "ember", "burn", "heat", "blaze"],
  Tide: ["water", "wave", "tidal", "ocean", "aqua", "splash", "surge"],
  Water: ["water", "wave", "aqua", "splash", "current", "drip"],
  Blossom: ["leaf", "petal", "bloom", "vine", "pollen", "seed", "nature", "flower", "thorn"],
  Spark: ["spark", "jolt", "static", "zap", "shock"],
  Electric: ["lightning", "shock", "volt", "electric", "thunder", "zap"],
  Earth: ["rock", "stone", "earth", "quake", "boulder", "mud", "sand"],
  Cosmos: ["star", "cosmic", "gravity", "nebula", "void", "astral", "meteor"],
  Wind: ["wind", "gust", "gale", "air", "cyclone", "breeze"],
  Ice: ["ice", "frost", "freeze", "glacial", "snow", "chill"],
  Dark: ["shadow", "dark", "night", "umbral", "gloom", "dusk"],
};
function offElementWarning(element: string, text: string): string | undefined {
  const own = new Set(ELEMENT_TOKENS[element] ?? []);
  const low = ` ${text.toLowerCase()} `;
  const foreign = new Set<string>();
  for (const [el, toks] of Object.entries(ELEMENT_TOKENS)) {
    if (el === element) continue;
    for (const t of toks) if (!own.has(t) && new RegExp(`\\b${t}\\b`).test(low)) foreign.add(t);
  }
  const uniq = [...foreign];
  return uniq.length ? `Attack text mentions off-element terms (${uniq.slice(0, 4).join(", ")}) — check they fit ${element || "the element"}.` : undefined;
}

// Stat bands per stage [min,max]. Health/guard/shift are clamped HARD into these so
// "scale by stage" is a guarantee, not a request the model can ignore. A variant may
// sit at the premium (top) end via a small bump — never above it (never a broken jump).
const STAGE_BANDS: Record<number, { health: [number, number]; guard: [number, number]; shift: [number, number] }> = {
  1: { health: [4, 7], guard: [0, 2], shift: [0, 2] },
  2: { health: [7, 11], guard: [1, 3], shift: [1, 3] },
  3: { health: [11, 16], guard: [2, 5], shift: [1, 4] },
};

function ctxLine(c: CardContext): string {
  const parts = [
    c.name && `name "${c.name}"`,
    c.cardType && `type ${c.cardType}`,
    c.element && `element ${c.element}`,
    c.stageNumber && `stage ${c.stageNumber}`,
    c.familyName && `family "${c.familyName}"`,
    c.previousStage && `evolves from "${c.previousStage}"`,
    c.rarity && `rarity ${c.rarity}`,
    (c.health || c.guard || c.shift) && `stats H${c.health ?? "?"}/G${c.guard ?? "?"}/S${c.shift ?? "?"}`,
    c.attack1Name && `attack1 "${c.attack1Name}"`,
    c.vulnerability && `vulnerable to ${c.vulnerability}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "(no data yet)";
}

function parseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const lastCurly = s.lastIndexOf("}");
  const lastSquare = s.lastIndexOf("]");
  const end = Math.max(lastCurly, lastSquare);
  if (end >= 0) s = s.slice(0, end + 1);
  return JSON.parse(s);
}

interface PromptSpec {
  system: string;
  user: string;
  maxTokens: number;
  // turn parsed JSON into raw suggestions before guardrails
  extract: (parsed: unknown) => Suggestion[];
}

function nameSpec(ctx: CardContext, mode: string, n: number): PromptSpec {
  const modeInstruction: Record<string, string> = {
    generate: `Generate ${n} name ideas.`,
    alternatives: `Generate ${n} alternative names.`,
    improve: `Improve the current name; give ${n} refined variants.`,
    cuter: `Make the name cuter / more adorable; give ${n} options.`,
    powerful: `Make the name more powerful / imposing (still family-friendly); give ${n} options.`,
    "less-medieval": `Make the name less medieval and more modern/mascot; give ${n} options.`,
    mascot: `Make the name more mascot-style (playful, brandable); give ${n} options.`,
    stage1: `Suggest ${n} Stage 1 (Baby) names — cute, small.`,
    stage2: `Suggest ${n} Stage 2 (Teen) names — evolving.`,
    stage3: `Suggest ${n} Stage 3 (Final) names — strongest.`,
  };
  return {
    system: `You name creatures for Vault Quest, a family-friendly collectible card game. ${NAME_RULES} Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\n${modeInstruction[mode] ?? modeInstruction.generate}\nReturn JSON: {"suggestions":[{"name":"...","reason":"short why","pronunciation":"PRO-nun-see-AY-shun","warning":"only if close to a famous/trademarked name, else empty"}]}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: { name?: string; reason?: string; pronunciation?: string; warning?: string }[] }).suggestions ?? [])
      .filter((s) => s?.name)
      .map((s) => ({ text: String(s.name), reason: s.reason, pronunciation: s.pronunciation, warning: s.warning || undefined, fields: { name: String(s.name) } })),
  };
}

function familyNamesSpec(ctx: CardContext, n: number): PromptSpec {
  return {
    system: `You name three-stage evolution families for Vault Quest. ${NAME_RULES} The three names should sound related (shared root/theme) but distinct. Reply with STRICT JSON only.`,
    user: `Family context: ${ctxLine(ctx)}.\nGenerate ${n} full family name sets (Baby → Teen → Final).\nReturn JSON: {"suggestions":[{"stage1":"...","stage2":"...","stage3":"...","reason":"short why"}]}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: { stage1?: string; stage2?: string; stage3?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.stage1 && s?.stage2 && s?.stage3)
      .map((s) => ({ text: `${s.stage1} → ${s.stage2} → ${s.stage3}`, reason: s.reason, fields: { stage1: s.stage1, stage2: s.stage2, stage3: s.stage3 } })),
  };
}

function gameplaySpec(ctx: CardContext, mode: string): PromptSpec {
  const base = `Card context: ${ctxLine(ctx)}. ${LEXICON} ${STAGE_SCALE}`;
  const specs: Record<string, { instr: string; shape: string }> = {
    attack1: { instr: "Design attack 1.", shape: `{"suggestions":[{"attack1Name":"...","attack1Cost":0,"attack1Damage":2,"attack1Effect":"optional short effect","reason":"..."}]}` },
    attack2: { instr: "Design attack 2.", shape: `{"suggestions":[{"attack2Name":"...","attack2Cost":1,"attack2Damage":3,"attack2Effect":"optional short effect","reason":"..."}]}` },
    "balanced-pair": { instr: "Design a balanced pair of attacks (a cheap one and a stronger one).", shape: `{"suggestions":[{"attack1Name":"...","attack1Cost":0,"attack1Damage":2,"attack1Effect":"","attack2Name":"...","attack2Cost":2,"attack2Damage":4,"attack2Effect":"","reason":"..."}]}` },
    weaker: { instr: "Rebalance this card WEAKER (lower stats/damage) while staying fun.", shape: `{"suggestions":[{"health":4,"guard":0,"shift":0,"attack1Damage":1,"reason":"..."}]}` },
    stronger: { instr: "Rebalance this card STRONGER (within its stage) while staying fair.", shape: `{"suggestions":[{"health":10,"guard":2,"shift":1,"attack1Damage":3,"reason":"..."}]}` },
    "suggest-stats": { instr: "Suggest Health / Guard / Shift for this stage.", shape: `{"suggestions":[{"health":5,"guard":0,"shift":0,"reason":"..."}]}` },
    "suggest-core": { instr: "Suggest Core costs for the attacks (0 unless it should cost).", shape: `{"suggestions":[{"attack1Cost":0,"attack2Cost":1,"reason":"..."}]}` },
    "suggest-vulnerability": { instr: "Suggest a Vulnerability element that makes thematic sense.", shape: `{"suggestions":[{"vulnerability":"...","reason":"..."}]}` },
  };
  const s = specs[mode] ?? specs.attack1;
  return {
    system: `You design balanced gameplay for Vault Quest creatures. ${LEXICON} Numbers only where asked; keep them small and whole. Reply with STRICT JSON only.`,
    user: `${base}\n${s.instr}\nReturn JSON: ${s.shape}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: Record<string, unknown>[] }).suggestions ?? []).map((row) => {
      const reason = typeof row.reason === "string" ? row.reason : undefined;
      const fields = { ...row };
      delete (fields as Record<string, unknown>).reason;
      const summary = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(" · ");
      return { text: summary || "(gameplay)", reason, fields };
    }),
  };
}

function flavourSpec(ctx: CardContext, mode: string, n: number): PromptSpec {
  const modeInstr: Record<string, string> = {
    generate: `Write ${n} short flavour texts (1 sentence each).`,
    simpler: `Rewrite the flavour simpler / clearer; give ${n} options.`,
    "child-readable": `Rewrite the flavour so a young child can read it; give ${n} options.`,
  };
  return {
    system: `You write short, charming flavour text for Vault Quest cards. ${LEXICON} One sentence, evocative, no game mechanics. Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\n${modeInstr[mode] ?? modeInstr.generate}\nReturn JSON: {"suggestions":[{"text":"...","reason":"short why"}]}`,
    maxTokens: 700,
    extract: (p) => ((p as { suggestions?: { text?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.text)
      .map((s) => ({ text: String(s.text), reason: s.reason, fields: { flavour: String(s.text) } })),
  };
}

function artworkSpec(ctx: CardContext, mode: string): PromptSpec {
  const modeInstr: Record<string, string> = {
    main: "the main creature portrait",
    "prev-portrait": "a small portrait of the PREVIOUS evolution stage",
    "family-sheet": "a family sheet showing all three evolution stages side by side",
    variant: "a premium variant illustration (more dramatic lighting/pose)",
    "fsr-scene": "a full-scene FSR illustration (creature in an environment)",
    cleaner: "a cleaner, simpler version of the artwork",
    "more-mascot": "a more mascot-like, friendly, rounded version",
    "less-pokemon": "a version with a more original silhouette and less familiar monster-battler styling",
  };
  return {
    system: `You write image-generation prompts for ORIGINAL creature ARTWORK ONLY for Vault Quest. The prompt must describe artwork only — NEVER a card layout, frame, border, text, logo, stat box, or any symbol. Explicitly forbid copying famous franchise styles or characters. The image must have a clean or transparent background suitable for dropping into a fixed art window. Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\nWrite one detailed artwork prompt for ${modeInstr[mode] ?? modeInstr.main}. Include: creature name, family, element, stage, personality, pose, background, colour palette, art direction. End with: "original character, no text, no card layout, no logos, artwork only, clean/transparent background". \nReturn JSON: {"suggestions":[{"text":"the full prompt","reason":"short note"}]}`,
    maxTokens: 800,
    extract: (p) => ((p as { suggestions?: { text?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.text)
      .map((s) => ({ text: String(s.text), reason: s.reason, fields: { prompt: String(s.text) } })),
  };
}

function specFor(kind: GenKind, ctx: CardContext, mode: string, n: number): PromptSpec {
  switch (kind) {
    case "name": return nameSpec(ctx, mode, n);
    case "family-names": return familyNamesSpec(ctx, n);
    case "gameplay": return gameplaySpec(ctx, mode);
    case "flavour": return flavourSpec(ctx, mode, n);
    case "artwork-prompt": return artworkSpec(ctx, mode);
  }
}

export async function runGenerator(kind: GenKind, mode: string, ctx: CardContext, n = 6): Promise<GenResult> {
  const provider = getTextProvider();
  if (!provider) {
    return { suggestions: [], provider: "none", model: "none", promptSummary: "", dropped: 0, note: "Provider not connected — set ANTHROPIC_API_KEY." };
  }
  const spec = specFor(kind, ctx, mode, Math.max(1, Math.min(n, 10)));

  // Guard only admin-entered card context before spending a token. The trusted
  // system prompt intentionally contains negative examples ("never use ..."),
  // which must not trip the user-input guard.
  const inGuard = guardInput(JSON.stringify(ctx));
  if (!inGuard.ok) {
    return { suggestions: [], provider: provider.id, model: provider.model, promptSummary: spec.user, dropped: 0, note: `Blocked: ${inGuard.violations.join("; ")}` };
  }

  const raw = await provider.complete(spec.system, spec.user, spec.maxTokens);
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return { suggestions: [], provider: provider.id, model: provider.model, promptSummary: spec.user, dropped: 0, note: "AI returned malformed output — try Regenerate." };
  }

  const rawSuggestions = spec.extract(parsed);
  const kept: Suggestion[] = [];
  let dropped = 0;
  for (const s of rawSuggestions) {
    const screenText = [s.text, s.reason, JSON.stringify(s.fields ?? {})].join(" ");
    const g = guardOutput(kind, screenText);
    if (g.hard.length) { dropped++; continue; } // never show IP / banned-term / layout violations
    const soft = [s.warning, ...g.soft].filter(Boolean).join("; ");
    kept.push({ ...s, warning: soft || undefined });
  }

  return {
    suggestions: kept,
    provider: provider.id,
    model: provider.model,
    promptSummary: spec.user,
    dropped,
    note: kept.length === 0 ? (dropped > 0 ? "All suggestions failed guardrails — try Regenerate." : "No suggestions returned.") : undefined,
  };
}

// ─── Generate Full Card (one-flow) ───────────────────────────────────────────
// Generates a COMPLETE card draft in a single Anthropic call: every field plus a
// clean artwork prompt. Preview-only + guard-railed like everything else; the
// route audits it and the client requires a manual Save Draft to persist.
export interface FullCardResult {
  fields: Record<string, unknown>;
  artworkPrompt: string; // "" if the model produced an unsafe one → caller uses the safe builder
  provider: string;
  model: string;
  note?: string;
  warnings: string[];
}

const SUPPORT_TYPES_TEXT = ["Tactic", "Relic", "Vault", "Collector", "Place"];

export async function generateFullCard(ctx: CardContext): Promise<FullCardResult> {
  const provider = getTextProvider();
  if (!provider) {
    return { fields: {}, artworkPrompt: "", provider: "none", model: "none", note: "Provider not connected — set ANTHROPIC_API_KEY.", warnings: [] };
  }
  const lockedType = (ctx.cardType ?? "").trim();
  const isSupport = SUPPORT_TYPES_TEXT.includes(lockedType);

  // ── Family identity (route-hydrated). When a family + canonical stage name are
  // known, the species is LOCKED so an established character is never renamed or
  // turned into a different creature. Variants stay bound to their base's identity.
  const stageNum = Number(ctx.stageNumber) || undefined;
  const canonicalName = (ctx.canonicalStageName ?? "").trim();
  const familyElement = (ctx.element || ctx.familyElement || "").trim();
  const isVariant = !!(ctx.baseCardId || (ctx.variantTier && ctx.variantTier.trim().toUpperCase() !== "STANDARD"));
  const established = !!canonicalName; // card sits in a defined family stage
  const theme = elementTheme(familyElement);
  const lockedName = canonicalName || (ctx.name ?? "").trim();
  const bibleBlock = [
    ctx.characterDna && `Character DNA (locked): ${ctx.characterDna}`,
    ctx.visualDescription && `Visual description (locked): ${ctx.visualDescription}`,
    ctx.bodyShape && `Body shape (locked): ${ctx.bodyShape}`,
    ctx.colours && `Colours (locked): ${ctx.colours}`,
    ctx.markings && `Markings (locked): ${ctx.markings}`,
    ctx.eyes && `Eyes (locked): ${ctx.eyes}`,
    ctx.tailAccessories && `Tail/accessories (locked): ${ctx.tailAccessories}`,
    ctx.personality && `Personality: ${ctx.personality}`,
    ctx.stageProgressionNotes && `Stage progression: ${ctx.stageProgressionNotes}`,
    ctx.elementIdentity && `Element identity: ${ctx.elementIdentity}`,
    ctx.previousCharacterName && ctx.previousCharacterDna && `Previous stage reference: ${ctx.previousCharacterName} DNA = ${ctx.previousCharacterDna}`,
    ctx.previousVisualDescription && `Previous stage visual reference: ${ctx.previousVisualDescription}`,
    ctx.masterArtworkPrompt && `Master artwork prompt (identity source): ${ctx.masterArtworkPrompt}`,
    ctx.negativePrompt && `Negative prompt: ${ctx.negativePrompt}`,
  ].filter(Boolean).join("\n");

  const locked = [
    familyElement && `element MUST be exactly "${familyElement}"`,
    ctx.cardType && `cardType MUST be exactly "${ctx.cardType}"`,
    stageNum && `stageNumber MUST be ${stageNum}`,
    ctx.familyName && `it belongs to family "${ctx.familyName}"`,
    lockedName && `the species/name is "${lockedName}" — keep this exact identity and exact name; do NOT rename it or invent a different creature`,
    !canonicalName && ctx.name && `refine (don't wholly replace) the name "${ctx.name}"`,
    !isSupport && familyElement && `attacks MUST be ${theme}; never an off-element attack`,
    isVariant && `this is a ${ctx.variantTier || "premium"} VARIANT of "${ctx.baseName || canonicalName}" — the SAME creature, only rarity/premium flavour differs`,
  ].filter(Boolean).join("; ");

  // Family-consistency guidance (in the user prompt, not ctxLine, to keep the blast
  // radius off every other generator). Branches on variant / evolution / establish.
  let familyPara = "";
  if (isVariant) {
    familyPara = `Family consistency: this is a rarity variant of "${ctx.baseName || canonicalName}". Keep the SAME name, element and stage; do not change the creature — only its rarity treatment.`;
  } else if (established && stageNum && stageNum > 1) {
    familyPara = `Family consistency: this is stage ${stageNum} of family "${ctx.familyName ?? ""}"${ctx.previousStage ? `, evolving from "${ctx.previousStage}"` : ""}. Design a clear evolution of that SAME species — older and stronger, not a different creature.`;
  } else if (established) {
    familyPara = `Family consistency: this is the definitive design for "${canonicalName}" (family "${ctx.familyName ?? ""}", element ${familyElement}).`;
  }

  const creatureShape = `{"name":"","displayName":"","cardType":"Creature","element":"","rarity":"C|U|R|RR|SR|SRA|UR|FSR|CR","stageNumber":1,"health":5,"guard":0,"shift":0,"attack1Name":"","attack1Cost":0,"attack1Damage":2,"attack1Effect":"short or empty","attack2Name":"","attack2Cost":1,"attack2Damage":3,"attack2Effect":"short or empty","vulnerability":"an element","keywords":["one","two"],"flavour":"one charming sentence","artworkPrompt":"..."}`;
  const supportShape = `{"name":"","displayName":"","cardType":"${lockedType || "Tactic"}","element":"","rarity":"C|U|R|RR|SR|SRA|UR|FSR|CR","attack1Effect":"the support card's effect text","vulnerability":"","keywords":["one"],"flavour":"one charming sentence","artworkPrompt":"..."}`;

  const system = `You design COMPLETE, original, premium cards for Vault Quest — a family-friendly collectible card game. ${LEXICON} ${NAME_RULES} ${STAGE_SCALE} Design one coherent, balanced card where the name, stats, attacks, flavour and artwork all fit together. Reply with STRICT JSON only, no prose.`;
  const user = `${locked ? "LOCKED (must honor): " + locked + ". " : ""}Context: ${ctxLine(ctx)}.
${familyPara ? familyPara + "\n" : ""}${bibleBlock ? "Character Bible:\n" + bibleBlock + "\n" : ""}
Design the full ${isSupport ? lockedType || "support" : "creature"} card. Numbers small and whole, balanced for the stage. keywords: 1-3 short invented words. flavour: one charming child-readable sentence (no game mechanics).
artworkPrompt: describe ORIGINAL CHARACTER ARTWORK ONLY of the existing Character Bible subject — new pose/camera/lighting/background/action only. The creature's body, colours, markings, eyes, accessories, family, element, stage and name MUST remain identical. It MUST NOT mention a card, frame, border, panel, text, letters, numbers, logo, watermark, or any real franchise/character.
Return JSON EXACTLY in this shape: ${isSupport ? supportShape : creatureShape}`;

  const raw = await provider.complete(system, user, 1500);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson(raw) as Record<string, unknown>;
  } catch {
    return { fields: {}, artworkPrompt: "", provider: provider.id, model: provider.model, note: "AI returned malformed output — try again.", warnings: [] };
  }

  const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
  const nameText = str(parsed.name);
  const gameplayText = [parsed.attack1Name, parsed.attack1Effect, parsed.attack2Name, parsed.attack2Effect, parsed.vulnerability].map(str).join(" ");
  const flavourText = str(parsed.flavour);
  const ipHard = [
    ...guardOutput("name", nameText).hard,
    ...guardOutput("gameplay", gameplayText).hard,
    ...guardOutput("flavour", flavourText).hard,
  ];
  if (ipHard.length) {
    return { fields: {}, artworkPrompt: "", provider: provider.id, model: provider.model, note: `AI produced disallowed content (${[...new Set(ipHard)].join(", ")}) — try again.`, warnings: [] };
  }

  // artwork prompt: fall back to the safe builder (signalled by "") if unsafe/empty
  let artworkPrompt = str(parsed.artworkPrompt);
  if (!artworkPrompt || guardOutput("artwork-prompt", artworkPrompt).hard.length) artworkPrompt = "";

  const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : undefined;
  };
  const fields: Record<string, unknown> = {
    name: lockedName || nameText || undefined,
    displayName: lockedName || str(parsed.displayName) || undefined,
    cardType: ctx.cardType || str(parsed.cardType) || undefined,
    element: ctx.element || str(parsed.element) || undefined,
    rarity: str(parsed.rarity) || undefined,
    vulnerability: str(parsed.vulnerability) || undefined,
    keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as unknown[]).map(str).filter(Boolean).slice(0, 3) : undefined,
    flavour: flavourText || undefined,
  };
  if (!isSupport) {
    fields.stageNumber = ctx.stageNumber ?? clamp(parsed.stageNumber, 1, 3);
    fields.health = clamp(parsed.health, 1, 40);
    fields.guard = clamp(parsed.guard, 0, 10);
    fields.shift = clamp(parsed.shift, 0, 10);
    fields.attack1Name = str(parsed.attack1Name) || undefined;
    fields.attack1Cost = clamp(parsed.attack1Cost, 0, 10);
    fields.attack1Damage = clamp(parsed.attack1Damage, 0, 30);
    fields.attack1Effect = str(parsed.attack1Effect) || undefined;
    fields.attack2Name = str(parsed.attack2Name) || undefined;
    fields.attack2Cost = clamp(parsed.attack2Cost, 0, 10);
    fields.attack2Damage = clamp(parsed.attack2Damage, 0, 30);
    fields.attack2Effect = str(parsed.attack2Effect) || undefined;
  } else {
    fields.attack1Effect = str(parsed.attack1Effect) || undefined; // support effect text
  }

  return { fields, artworkPrompt, provider: provider.id, model: provider.model, warnings: guardOutput("name", nameText).soft };
}

// ─── Character Description workflow (text before pixels) ─────────────────────
// Generates / improves the FULL Character Bible identity as text — Anthropic only,
// never artwork. Stage 2/3 inherit the previous stage's APPROVED identity and must
// evolve it clearly (same creature line, never identical, never a redesign).
export const DESCRIPTION_FIELD_KEYS = [
  "characterDna", "visualDescription", "bodyShape", "colours", "markings", "eyes",
  "tailAccessories", "personality", "stageProgressionNotes", "elementIdentity",
  "negativePrompt", "masterArtworkPrompt",
] as const;
export type DescriptionFields = Record<(typeof DESCRIPTION_FIELD_KEYS)[number], string>;

export interface DescribeInput {
  characterName: string;
  element: string;
  stageNumber: number;
  familyName?: string | null;
  /** Previous stage's identity fields (stage 2 inherits 1, stage 3 inherits 2). */
  previous?: { characterName: string; fields: Partial<DescriptionFields> } | null;
  /** Current fields — used by "improve" mode (and as fallback context). */
  current?: Partial<DescriptionFields> | null;
}

export interface DescribeResult {
  fields: DescriptionFields | null;
  provider: string;
  model: string;
  note?: string;
}

const DESCRIPTION_UNIVERSAL_NEGATIVE =
  "No card frame, no trading card layout, no text, no logo, no watermark, no signature, no UI, no border, no cropped limbs, no extra limbs, no duplicate body parts, no deformed anatomy, no scary horror, no weapons unless explicitly part of the character, no realistic violence, no photorealistic animal, no copyrighted characters, no franchise resemblance.";

export async function generateCharacterDescription(mode: "generate" | "improve", input: DescribeInput): Promise<DescribeResult> {
  const provider = getTextProvider();
  if (!provider) return { fields: null, provider: "none", model: "none", note: "Provider not connected — set ANTHROPIC_API_KEY." };

  const fieldsJson = (f: Partial<DescriptionFields> | null | undefined) =>
    JSON.stringify(Object.fromEntries(DESCRIPTION_FIELD_KEYS.map((k) => [k, (f?.[k] ?? "").toString().slice(0, 600)])));

  const inherit = input.previous
    ? `PREVIOUS STAGE (the stage this creature evolves FROM) — "${input.previous.characterName}", approved identity: ${fieldsJson(input.previous.fields)}.
INHERITANCE RULES (mandatory): this is the SAME creature line — keep the same species, the same core colour palette, the same marking language, the same eye character and the same signature accessories. But it must be CLEARLY EVOLVED, never identical: larger and more mature, a visibly developed silhouette (e.g. a tuft grows into a mane, nubs grow into horns, a short tail lengthens), a more confident bearing. In stageProgressionNotes, LIST the explicit visual differences vs "${input.previous.characterName}" an artist must draw. Do NOT redesign the creature; do NOT copy the previous stage unchanged.`
    : `This is STAGE 1 — the establishing identity of the family line. Design a distinctive, original baby/first-stage creature whose features later stages can visibly grow from.`;

  const improve = mode === "improve" && input.current
    ? `CURRENT FIELDS (improve these — richer, more precise, more drawable; keep the established identity unchanged, sharpen the stage differences): ${fieldsJson(input.current)}.`
    : "";

  const system = `You write permanent CHARACTER BIBLE identity descriptions for Vault Quest, a family-friendly collectible card game. Text only — never artwork. ${NAME_RULES} Each field must be concrete and drawable (an artist should reproduce the exact creature from it). Reply with STRICT JSON only, no prose.`;
  const user = `Character: "${input.characterName}", element ${input.element}, stage ${input.stageNumber} of 3${input.familyName ? `, family "${input.familyName}"` : ""}.
${inherit}
${improve}
Write ALL of these fields:
- characterDna: one dense paragraph — the permanent identity contract (species concept, colours, markings, eyes, accessories, what may NEVER change).
- visualDescription: what the creature looks like, drawable.
- bodyShape: body/proportions/silhouette.
- colours: exact colour palette.
- markings: patterns/marks and where.
- eyes: shape/colour/expression.
- tailAccessories: tail + signature accessories.
- personality: character traits.
- stageProgressionNotes: how this stage differs from the previous one and what the next stage should grow into.
- elementIdentity: how the ${input.element} element shows visually.
- negativePrompt: MUST include: ${DESCRIPTION_UNIVERSAL_NEGATIVE}
- masterArtworkPrompt: a standalone character-artwork description (subject + pose + palette; plain background; never mention a card, frame, text or logo).
Return JSON EXACTLY: {"characterDna":"","visualDescription":"","bodyShape":"","colours":"","markings":"","eyes":"","tailAccessories":"","personality":"","stageProgressionNotes":"","elementIdentity":"","negativePrompt":"","masterArtworkPrompt":""}`;

  const raw = await provider.complete(system, user, 2400);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson(raw) as Record<string, unknown>;
  } catch {
    return { fields: null, provider: provider.id, model: provider.model, note: "AI returned malformed output — try again." };
  }
  const fields = Object.fromEntries(
    DESCRIPTION_FIELD_KEYS.map((k) => [k, String(parsed[k] ?? "").trim()]),
  ) as DescriptionFields;
  const missing = DESCRIPTION_FIELD_KEYS.filter((k) => !fields[k]);
  if (missing.length) return { fields: null, provider: provider.id, model: provider.model, note: `AI left fields empty (${missing.join(", ")}) — try again.` };
  // IP screen (banned franchises) across the identity — EXCEPT the negative prompt,
  // which legitimately names franchises to avoid ("no resemblance to Pokémon…"): a
  // comma-list defeats the negation detector and would false-positive (same class of
  // bug as the trusted-Bible-negatives guardrail fix). Instead, franchise mentions in
  // the negative prompt are normalised to a generic clause.
  const screenable = DESCRIPTION_FIELD_KEYS.filter((k) => k !== "negativePrompt").map((k) => fields[k]).join(" ");
  const ip = guardOutput("name", screenable).hard;
  if (ip.length) return { fields: null, provider: provider.id, model: provider.model, note: `AI produced disallowed content (${[...new Set(ip)].join(", ")}) — try again.` };
  if (guardOutput("name", fields.negativePrompt).hard.length) {
    fields.negativePrompt = DESCRIPTION_UNIVERSAL_NEGATIVE; // safe canonical negative, no named franchises
  }
  return { fields, provider: provider.id, model: provider.model };
}

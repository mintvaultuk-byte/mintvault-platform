import { RARITY_OPTIONS } from "./rarityOptions";
import { VARIANT_OPTIONS } from "./variantOptions";
import { COLLECTION_OPTIONS } from "./collectionOptions";

export type UnifiedOption = {
  value: string;
  label: string;
  category: "RARITY" | "VARIANT" | "COLLECTION" | "OTHER";
  code: string;
  help?: string;
};

function buildOptions(): UnifiedOption[] {
  const opts: UnifiedOption[] = [];

  for (const r of RARITY_OPTIONS) {
    if (r.code === "OTHER") continue;
    opts.push({
      value: `RARITY:${r.code}`,
      label: r.label,
      category: "RARITY",
      code: r.code,
      help: r.help,
    });
  }

  for (const v of VARIANT_OPTIONS) {
    if (v.code === "NONE" || v.code === "OTHER") continue;
    opts.push({
      value: `VARIANT:${v.code}`,
      label: v.label,
      category: "VARIANT",
      code: v.code,
    });
  }

  for (const c of COLLECTION_OPTIONS) {
    if (c.code === "OTHER") continue;
    opts.push({
      value: `COLLECTION:${c.code}`,
      label: c.label,
      category: "COLLECTION",
      code: c.code,
    });
  }

  opts.push({
    value: "OTHER",
    label: "OTHER (manual)",
    category: "OTHER",
    code: "OTHER",
    help: "Free text — saved as custom rarity.",
  });

  return opts;
}

export const UNIFIED_OPTIONS = buildOptions();

export function parseUnifiedValue(val: string): { category: "RARITY" | "VARIANT" | "COLLECTION" | "OTHER"; code: string } {
  if (!val) return { category: "OTHER", code: "" };
  if (val === "OTHER") return { category: "OTHER", code: "OTHER" };
  const idx = val.indexOf(":");
  if (idx < 0) return { category: "OTHER", code: val };
  const cat = val.substring(0, idx) as "RARITY" | "VARIANT" | "COLLECTION";
  const code = val.substring(idx + 1);
  return { category: cat, code };
}

export function buildUnifiedValue(
  rarity: string | null | undefined,
  variant: string | null | undefined,
  collectionCode: string | null | undefined,
  rarityOther: string | null | undefined,
  variantOther: string | null | undefined,
  collectionOther: string | null | undefined
): string {
  if (rarity && rarity !== "OTHER") return `RARITY:${rarity}`;
  if (variant && variant !== "NONE" && variant !== "OTHER") return `VARIANT:${variant}`;
  if (collectionCode && collectionCode !== "OTHER") return `COLLECTION:${collectionCode}`;
  if (rarity === "OTHER" || variant === "OTHER" || collectionCode === "OTHER") return "OTHER";
  return "";
}

export function buildOtherText(
  rarityOther: string | null | undefined,
  variantOther: string | null | undefined,
  collectionOther: string | null | undefined
): string {
  return rarityOther || variantOther || collectionOther || "";
}

export function getUnifiedDisplayLabel(val: string): string {
  if (!val) return "";
  const opt = UNIFIED_OPTIONS.find((o) => o.value === val);
  if (opt) return opt.label;
  // Custom values not in the static list — strip the category prefix
  const idx = val.indexOf(":");
  if (idx >= 0) return val.substring(idx + 1);
  return val;
}

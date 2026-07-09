/** Card row — exact shape of the pack's cards_sample.csv columns. */
export interface VqCard {
  collector_number: string; // "001/150"
  card_id: string; // "GNV-001"
  card_name: string;
  display_name: string;
  card_type: string; // "Creature"
  element: string; // "Blaze" — must exist in elements.json
  family_id: string;
  family: string;
  stage_number: number; // 1 | 2 | 3
  life_stage: string; // BABY | TEEN | FINAL
  previous_stage: string; // required for stage 2/3, forbidden for stage 1
  health: number;
  guard: number;
  shift: number;
  vulnerable_to: string;
  attack_1_cost: number;
  attack_1_name: string;
  attack_1_damage: number;
  attack_1_effect: string;
  attack_2_cost: number;
  attack_2_name: string;
  attack_2_damage: number;
  attack_2_effect: string;
  rarity: string;
  set_code: string;
  language: string;
  year: number;
  edition: string;
  artwork_file: string;
  prev_artwork_file: string;
  // optional set-list columns (150-card commercial master); ignored by the renderer
  variant_tier?: string; // STANDARD | SRA | CHR | FSR | UR | CR | ...
  source_base_card?: string; // collector_number of the base card, for variants
}

export interface TemplateLock {
  template: string; // "VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.1_STAGE_LOCK"
  canvas_mm: [number, number];
  trim_mm: [number, number];
  bleed_mm: number;
  set_code: string;
  year: number;
  front_qr_nfc_allowed: boolean;
  grid_rule: string;
  stage_templates: Record<string, string>;
}

export interface ElementStyle {
  border: string;
  accent: string;
  dark: string;
  crest: string;
}

export interface QaIssue {
  level: "reject" | "warn";
  field: string;
  message: string;
}

export interface CardQa {
  card_id: string;
  card_name: string;
  status: "pass" | "reject";
  issues: QaIssue[];
  outputs: string[];
}

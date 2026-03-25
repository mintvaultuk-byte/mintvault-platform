export type DesignationOption = {
  code: string;
  label: string;
  help: string;
};

export const DESIGNATION_OPTIONS: DesignationOption[] = [
  { code: "PROMO", label: "Promo", help: "Not from regular booster packs; promotional distribution." },
  { code: "TOURNAMENT_STAMP", label: "Tournament / Event Stamp", help: "Stamped for tournament/event (often has year/stamp)." },
  { code: "PRERELEASE", label: "Prerelease", help: "Prerelease stamp/marking." },
  { code: "STAFF", label: "Staff", help: "Staff stamp/edition." },

  { code: "ERROR_MISCUT", label: "Error / Miscut / Misprint", help: "Manufacturing error; document clearly." },

  { code: "FIRST_EDITION", label: "1st Edition", help: "1st Edition marking (WOTC era)." },
  { code: "SHADOWLESS", label: "Shadowless", help: "WOTC shadowless print variant." },
  { code: "UNLIMITED", label: "Unlimited", help: "Unlimited print run variant." },

  { code: "JAPANESE_PRINT", label: "Japanese Print", help: "Card is Japanese (language should also be set)." },
  { code: "OTHER_LANGUAGE", label: "Other Language", help: "Non-English/Japanese language print." },
];

export function getDesignationLabel(code: string): string {
  const opt = DESIGNATION_OPTIONS.find(d => d.code === code);
  return opt?.label || code;
}

/** Canonical, server-owned Partner supplies catalogue facts. Prices for configurable products live
 * in the HQ database table; browser requests may name a code and quantity only. */
export const PARTNER_SUPPLY_CURRENCY = "GBP" as const;
export const MAX_PARTNER_SUPPLY_ITEM_QUANTITY = 100;

export const PARTNER_SUPPLY_PRODUCT_CODES = {
  slabs: "plastic_mintvault_slab_box",
  holographicPaper: "holographic_printing_paper",
  nfcTags: "nfc_tags",
} as const;

export const LOCKED_PARTNER_SUPPLY_PRODUCTS = {
  [PARTNER_SUPPLY_PRODUCT_CODES.slabs]: {
    code: PARTNER_SUPPLY_PRODUCT_CODES.slabs,
    displayName: "Plastic MintVault slabs",
    unitsPerPack: 50,
    pricePence: 7500,
    pencePerUnit: 150,
  },
} as const;

export type PartnerSupplyProductCode = (typeof PARTNER_SUPPLY_PRODUCT_CODES)[keyof typeof PARTNER_SUPPLY_PRODUCT_CODES];
export type PartnerSupplyTaxTreatment = "UNCONFIGURED" | "VAT_INCLUDED";
export type PartnerSupplyOrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "PROCESSING"
  | "DISPATCHED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

/** Canonical, server-owned Partner supplies catalogue facts. Prices for configurable products live
 * in the HQ database table; browser requests may name a code and quantity only. */
export const PARTNER_SUPPLY_CURRENCY = "GBP" as const;
export const MAX_PARTNER_SUPPLY_ITEM_QUANTITY = 100;

export const PARTNER_SUPPLY_PRODUCT_CODES = {
  slabs: "plastic_mintvault_slab_box",
  holographicPaper: "holographic_printing_paper",
  nfcTags: "nfc_tags",
} as const;

/**
 * PRICES ARE NOT DECLARED IN CODE.
 *
 * A `LOCKED_PARTNER_SUPPLY_PRODUCTS` constant used to live here, pinning the slab box at 7500 pence,
 * and `pricing_mode = 'LOCKED'` in the database refused to let an administrator change it. Owner
 * decision (2026-08-22): every current and future selling price is editable by Super Admin, so both
 * are gone. £75 survives as the value migration 0111 SEEDS, which is a starting point rather than a
 * rule.
 *
 * The single price authority is `partner_supply_products.active_price_pence`, snapshotted onto
 * `partner_supply_order_items.gross_unit_price_pence` when an order is placed. Nothing in the client
 * bundle, and nothing in Stripe, holds a second copy.
 */

/** Image formats the catalogue accepts. Enforced by magic bytes and a real decode, not by name. */
export const PARTNER_SUPPLY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PartnerSupplyImageType = (typeof PARTNER_SUPPLY_IMAGE_TYPES)[number];

/** 4 MB. Comfortable for a product photograph, far below anything that stresses the pipeline. */
export const MAX_PARTNER_SUPPLY_IMAGE_BYTES = 4 * 1024 * 1024;

/** A catalogue entry as every surface sees it. Price is pence; null means "not purchasable yet". */
export interface PartnerSupplyProduct {
  code: string;
  displayName: string;
  description: string | null;
  unitsPerPack: number;
  activePricePence: number | null;
  active: boolean;
  /** Signed, short-lived. Never an object key, never a bucket path. */
  imageUrl: string | null;
  sortOrder: number;
}

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

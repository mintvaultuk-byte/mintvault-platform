/**
 * server/ebay.ts
 *
 * eBay Browse API client for MintVault.
 *
 * Handles:
 *  1. OAuth 2.0 client-credentials token (in-memory cache, auto-refreshes)
 *  2. Searching eBay UK GRADED-only fixed-price listings for a card
 *  3. Cache layer: DB cache in ebay_price_cache, 24h TTL, graceful stale fallback
 *
 * IMPORTANT: eBay credentials are server-side only and must NEVER be sent to
 * the browser. This module is only imported by server-side code.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EbayListing {
  title: string;
  price_pence: number;    // e.g. £12.99 → 1299
  currency: string;       // always "GBP"
  url: string;
  image_url: string | null;
  end_time: string | null;
  condition: string;
  grade: string | null;   // extracted grade, e.g. "PSA 10", "CGC 9.5", "BLACK LABEL"
}

export interface EbayPriceResult {
  averagePence: number;
  gradeAverages: Record<string, { averagePence: number; count: number }>;
  listings: EbayListing[];
  cachedAt: Date;
}

// ── Token cache ───────────────────────────────────────────────────────────────

let _tokenValue: string | null = null;
let _tokenExpiresAt: number = 0; // epoch ms

async function getEbayAccessToken(): Promise<string> {
  const now = Date.now();
  // Refresh 60 seconds before actual expiry to avoid edge cases
  if (_tokenValue && now < _tokenExpiresAt - 60_000) {
    return _tokenValue;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;

  if (!appId || !certId) {
    throw new Error("EBAY_APP_ID and EBAY_CERT_ID environment variables are required");
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`eBay token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  _tokenValue = data.access_token;
  _tokenExpiresAt = now + data.expires_in * 1_000;

  return _tokenValue;
}

// ── Grade extraction ──────────────────────────────────────────────────────────

/**
 * Attempt to extract a grading company + grade from a listing title.
 * Returns e.g. "PSA 10", "CGC 9.5", "BGS BLACK LABEL", or null.
 */
function extractGrade(title: string): string | null {
  // Match grader + numeric grade (e.g. PSA 10, CGC 9.5, BGS 8)
  const numMatch = title.match(/(PSA|CGC|BGS|BECKETT|ACE|TAG|SGC)\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4|3|2|1)/i);
  if (numMatch) return `${numMatch[1].toUpperCase()} ${numMatch[2]}`;

  // Black label variants (BGS/ACE/etc)
  if (/BLACK\s*LABEL/i.test(title)) {
    const graderMatch = title.match(/(BGS|BECKETT|ACE|TAG)\s*BLACK/i);
    return graderMatch ? `${graderMatch[1].toUpperCase()} BLACK LABEL` : "BLACK LABEL";
  }

  // Gem Mint 10 (used by some sellers without specifying grader)
  if (/GEM\s*MINT\s*10/i.test(title)) return "GEM MINT 10";

  return null;
}

// ── Graded-card filter ────────────────────────────────────────────────────────

const GRADED_KEYWORDS = ["PSA", "CGC", "BGS", "BECKETT", "ACE", "TAG", "SGC", "GRADED", "SLAB", "SLABBED"];

function isGradedListing(title: string): boolean {
  const upper = title.toUpperCase();
  return GRADED_KEYWORDS.some((kw) => upper.includes(kw));
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchEbayUkListings(
  cardName: string,
  cardNumber: string | null,
  _setName: string | null
): Promise<EbayListing[]> {
  const token = await getEbayAccessToken();

  // Include grading company OR operators so eBay's own relevance engine
  // prioritises graded results before we post-filter.
  const namePart = `"${cardName.replace(/"/g, "")}"`;
  const numberPart = cardNumber ? ` ${cardNumber}` : "";
  const q = `${namePart}${numberPart} (PSA OR CGC OR BGS OR ACE OR TAG)`;

  const params = new URLSearchParams({
    q,
    filter: "buyingOptions:{FIXED_PRICE},priceCurrency:GBP,deliveryCountry:GB",
    limit: "50", // fetch more so we have plenty after filtering
    sort: "price",
  });

  const resp = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
        "Content-Type": "application/json",
      },
    }
  );

  if (resp.status === 429) {
    console.warn("[eBay] Rate limit hit — returning empty results");
    return [];
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`eBay search failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { itemSummaries?: any[] };
  const items = data.itemSummaries || [];

  const cardNameLower = cardName.toLowerCase();
  const listings: EbayListing[] = [];

  for (const item of items) {
    // Must be GBP
    const priceValue: string | undefined = item.price?.value;
    const currency: string | undefined = item.price?.currency;
    if (!priceValue || currency !== "GBP") continue;

    // Title must contain card name
    const titleLower: string = (item.title || "").toLowerCase();
    if (!titleLower.includes(cardNameLower)) continue;

    // Must be a graded listing (double-filter)
    if (!isGradedListing(item.title || "")) continue;

    const pricePence = Math.round(parseFloat(priceValue) * 100);
    if (isNaN(pricePence) || pricePence <= 0) continue;

    listings.push({
      title: item.title || "",
      price_pence: pricePence,
      currency: "GBP",
      url: item.itemWebUrl || item.itemAffiliateWebUrl || "",
      image_url: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
      end_time: item.itemEndDate || null,
      condition: item.condition || "Unknown",
      grade: extractGrade(item.title || ""),
    });
  }

  // Return top 10 graded results
  return listings.slice(0, 10);
}

// ── Grade averages ────────────────────────────────────────────────────────────

function computeGradeAverages(
  listings: EbayListing[]
): Record<string, { averagePence: number; count: number }> {
  const buckets: Record<string, number[]> = {};
  for (const l of listings) {
    if (!l.grade) continue;
    if (!buckets[l.grade]) buckets[l.grade] = [];
    buckets[l.grade].push(l.price_pence);
  }
  const result: Record<string, { averagePence: number; count: number }> = {};
  for (const [grade, prices] of Object.entries(buckets)) {
    result[grade] = {
      averagePence: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
      count: prices.length,
    };
  }
  return result;
}

// ── Card key helper ───────────────────────────────────────────────────────────

export function buildCardKey(
  cardName: string,
  cardNumber: string | null,
  setName: string | null
): string {
  return [cardName, cardNumber || "", setName || ""]
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 200);
}

// ── Cache layer ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

export async function getCachedOrFreshEbayPrices(
  cardKey: string,
  cardName: string,
  cardNumber: string | null,
  setName: string | null
): Promise<EbayPriceResult> {
  const empty: EbayPriceResult = {
    averagePence: 0,
    gradeAverages: {},
    listings: [],
    cachedAt: new Date(),
  };

  // 1. Check cache
  let cached: any = null;
  try {
    const rows = await db.execute(sql`
      SELECT average_price_pence, listing_count, listings_json, last_updated_at
      FROM ebay_price_cache
      WHERE card_key = ${cardKey}
      LIMIT 1
    `);
    if (rows.rows.length > 0) cached = rows.rows[0];
  } catch (err: any) {
    console.error("[eBay cache] read error:", err.message);
  }

  const now = Date.now();
  const cacheAge = cached
    ? now - new Date(cached.last_updated_at).getTime()
    : Infinity;

  // 2. Cache is fresh — return it
  if (cached && cacheAge < CACHE_TTL_MS) {
    const listings: EbayListing[] = Array.isArray(cached.listings_json)
      ? cached.listings_json
      : (typeof cached.listings_json === "string" ? JSON.parse(cached.listings_json) : []);
    return {
      averagePence: cached.average_price_pence ?? 0,
      gradeAverages: computeGradeAverages(listings),
      listings,
      cachedAt: new Date(cached.last_updated_at),
    };
  }

  // 3. Cache stale or missing — fetch fresh
  let freshListings: EbayListing[] = [];
  let fetchError = false;
  try {
    freshListings = await searchEbayUkListings(cardName, cardNumber, setName);
  } catch (err: any) {
    console.error("[eBay] API call failed:", err.message);
    fetchError = true;
  }

  // 4. Fetch failed but stale cache exists — return stale with warning
  if (fetchError && cached) {
    console.warn("[eBay] Returning stale cache (API unavailable) for:", cardKey);
    const listings: EbayListing[] = Array.isArray(cached.listings_json)
      ? cached.listings_json
      : (typeof cached.listings_json === "string" ? JSON.parse(cached.listings_json) : []);
    return {
      averagePence: cached.average_price_pence ?? 0,
      gradeAverages: computeGradeAverages(listings),
      listings,
      cachedAt: new Date(cached.last_updated_at),
    };
  }

  // 5. Fetch failed, no cache
  if (fetchError) return empty;

  // 6. Compute averages
  const averagePence =
    freshListings.length > 0
      ? Math.round(freshListings.reduce((s, l) => s + l.price_pence, 0) / freshListings.length)
      : 0;

  // 7. Persist to cache (upsert)
  try {
    await db.execute(sql`
      INSERT INTO ebay_price_cache
        (card_key, card_name, card_number, set_name, average_price_pence, listing_count, listings_json, last_updated_at)
      VALUES
        (${cardKey}, ${cardName}, ${cardNumber}, ${setName}, ${averagePence}, ${freshListings.length}, ${JSON.stringify(freshListings)}::jsonb, NOW())
      ON CONFLICT (card_key) DO UPDATE SET
        card_name           = EXCLUDED.card_name,
        card_number         = EXCLUDED.card_number,
        set_name            = EXCLUDED.set_name,
        average_price_pence = EXCLUDED.average_price_pence,
        listing_count       = EXCLUDED.listing_count,
        listings_json       = EXCLUDED.listings_json,
        last_updated_at     = NOW()
    `);
  } catch (err: any) {
    console.error("[eBay cache] write error:", err.message);
  }

  return {
    averagePence,
    gradeAverages: computeGradeAverages(freshListings),
    listings: freshListings,
    cachedAt: new Date(),
  };
}

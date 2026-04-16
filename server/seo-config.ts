/**
 * SSR meta tag injection for MintVault.
 *
 * Maps URL pathnames to <title>, <meta description>, and <link canonical> values.
 * The static file server reads this map and replaces placeholder tags in index.html
 * before serving, so Google (and other crawlers) get real meta data without JS.
 */

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
}

const BASE = "https://mintvaultuk.com";
const DEFAULT_IMAGE = `${BASE}/images/collector-lifestyle.webp`;

const SEO_MAP: Record<string, SeoMeta> = {
  "/": {
    title: "MintVault UK — Professional Trading Card Grading | Verified Ownership",
    description: "The only UK grading company with verified card ownership. NFC-enabled slabs, online certificate verification, and an ownership registry. Grade your cards from £19.",
    canonical: BASE,
    ogImage: DEFAULT_IMAGE,
  },
  "/pricing": {
    title: "Pricing | MintVault UK — Card Grading Costs",
    description: "Transparent card grading pricing for UK collectors. Three tiers from £19 to £45 per card. Fully insured return shipping included. No hidden fees.",
    canonical: `${BASE}/pricing`,
    ogImage: DEFAULT_IMAGE,
  },
  "/cert": {
    title: "Certificate Lookup | MintVault UK",
    description: "Verify any MintVault graded card certificate. Search by certificate ID to check grade, card details, and ownership status.",
    canonical: `${BASE}/cert`,
  },
  "/why-mintvault": {
    title: "Why MintVault | UK Card Grading with Verified Ownership",
    description: "MintVault is the only UK grading company with a verified ownership registry and NFC-enabled slabs. Discover why collectors choose MintVault.",
    canonical: `${BASE}/why-mintvault`,
    ogImage: DEFAULT_IMAGE,
  },
  "/submit": {
    title: "Submit Cards for Grading | MintVault UK",
    description: "Submit your trading cards for professional grading with MintVault UK. Choose your service tier, pay securely online, and track your order.",
    canonical: `${BASE}/submit`,
  },
  "/guides": {
    title: "Card Grading Guides & Articles | MintVault UK",
    description: "Expert guides on Pokémon card grading, trading card collecting, grading costs, and how to prepare cards for grading in the UK.",
    canonical: `${BASE}/guides`,
  },
  "/ownership": {
    title: "Ownership Portal | MintVault UK",
    description: "Register and manage card ownership on MintVault's verified ownership registry. Claim, verify, and transfer ownership of your graded cards.",
    canonical: `${BASE}/ownership`,
  },
  "/claim": {
    title: "Claim Card Ownership | MintVault UK",
    description: "Register as the verified owner of your MintVault graded card. Enter your claim code and email to secure your ownership record.",
    canonical: `${BASE}/claim`,
  },
  "/transfer": {
    title: "Transfer Card Ownership | MintVault UK",
    description: "Transfer verified ownership of a MintVault graded card to a new owner. Secure two-step email-verified transfer process.",
    canonical: `${BASE}/transfer`,
  },
  "/dashboard": {
    title: "Customer Dashboard | MintVault UK",
    description: "Track your MintVault submissions, view your graded cards, and manage card ownership from your customer dashboard.",
    canonical: `${BASE}/dashboard`,
  },
  "/population": {
    title: "Population Report | MintVault UK",
    description: "Explore MintVault's population data — see how many cards of each set and grade have been submitted and certified.",
    canonical: `${BASE}/population`,
  },
  "/api-docs": {
    title: "Public Verification API | MintVault UK",
    description: "Use the MintVault public API to verify the authenticity of any graded certificate by cert ID. Free, no auth required, 100 req/min.",
    canonical: `${BASE}/api-docs`,
  },
  "/track": {
    title: "Track Your Submission | MintVault UK",
    description: "Track the status of your MintVault card grading submission. Enter your submission ID and email to see live updates.",
    canonical: `${BASE}/track`,
  },
  "/terms-and-conditions": {
    title: "Terms & Conditions | MintVault UK",
    description: "Read MintVault UK's terms and conditions of service for card grading, submissions, and the ownership registry.",
    canonical: `${BASE}/terms-and-conditions`,
  },
  "/liability-and-insurance": {
    title: "Liability & Insurance | MintVault UK",
    description: "MintVault's liability policy, insurance coverage, and how we protect your cards throughout the grading process.",
    canonical: `${BASE}/liability-and-insurance`,
  },
  "/labels": {
    title: "MintVault Grading Labels | UK Card Grading",
    description: "See MintVault's precision grading label design. One label type for all cards — clean, professional, and scannable.",
    canonical: `${BASE}/labels`,
  },
  // SEO pages
  "/pokemon-card-grading-uk": {
    title: "Pokemon Card Grading UK | Professional Grading Service | MintVault",
    description: "Professional Pokemon card grading in the UK. Fast turnaround, tamper-evident slabs, insured shipping. Grade your Pokemon cards with MintVault from £19 per card.",
    canonical: `${BASE}/pokemon-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/trading-card-grading-uk": {
    title: "Trading Card Grading UK | Professional TCG Grading | MintVault",
    description: "Professional trading card grading in the UK. All major TCGs accepted. Tamper-evident slabs, insured return shipping, fast turnaround from £19.",
    canonical: `${BASE}/trading-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/card-grading-service-uk": {
    title: "Card Grading Service UK | MintVault — Professional Grading",
    description: "MintVault is a professional UK card grading service for Pokémon, Yu-Gi-Oh!, Magic, and all major TCGs. Verified ownership, NFC slabs, fast turnaround.",
    canonical: `${BASE}/card-grading-service-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/psa-alternative-uk": {
    title: "PSA Alternative UK | UK Card Grading Instead of PSA | MintVault",
    description: "Skip PSA's long queues and international shipping. MintVault is the UK's professional PSA alternative — faster turnaround, no customs fees, verified ownership.",
    canonical: `${BASE}/psa-alternative-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/how-to-grade-pokemon-cards": {
    title: "How to Grade Pokemon Cards | Step-by-Step UK Guide | MintVault",
    description: "Learn how to grade Pokemon cards in the UK. Step-by-step guide to the grading process, what graders look for, and how to prepare your cards for submission.",
    canonical: `${BASE}/how-to-grade-pokemon-cards`,
  },
  "/tcg-grading-uk": {
    title: "TCG Grading UK | Trading Card Game Grading Service | MintVault",
    description: "Professional TCG grading in the UK for all major trading card games. Tamper-evident slabs, NFC verification, and verified ownership registry from MintVault.",
    canonical: `${BASE}/tcg-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/yugioh-card-grading-uk": {
    title: "Yu-Gi-Oh Card Grading UK | Professional YGO Grading | MintVault",
    description: "Professional Yu-Gi-Oh card grading in the UK. Grade your rarest YGO cards with MintVault — tamper-evident slabs, NFC verification, from £19 per card.",
    canonical: `${BASE}/yugioh-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/one-piece-card-grading-uk": {
    title: "One Piece Card Grading UK | Professional TCG Grading | MintVault",
    description: "Professional One Piece card grading in the UK. Protect and authenticate your rarest One Piece cards with MintVault — NFC-enabled slabs from £19.",
    canonical: `${BASE}/one-piece-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/sports-card-grading-uk": {
    title: "Sports Card Grading UK | Football & Basketball Card Grading | MintVault",
    description: "Professional sports card grading in the UK. Grade your football, basketball, and cricket cards with MintVault — verified ownership, tamper-evident slabs.",
    canonical: `${BASE}/sports-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/mtg-card-grading-uk": {
    title: "MTG Card Grading UK | Magic: The Gathering Grading | MintVault",
    description: "Professional Magic: The Gathering card grading in the UK. Grade your rarest MTG cards with MintVault — NFC-enabled slabs, verified ownership, from £19.",
    canonical: `${BASE}/mtg-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/best-card-grading-uk": {
    title: "Best Card Grading Company UK | MintVault Review & Comparison",
    description: "Looking for the best card grading company in the UK? MintVault offers verified ownership, NFC-enabled slabs, and fast turnaround. See how we compare.",
    canonical: `${BASE}/best-card-grading-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/card-grading-cost-uk": {
    title: "How Much Does Card Grading Cost UK | Grading Prices Explained",
    description: "Find out how much card grading costs in the UK. MintVault's pricing explained — from £19 per card with bulk discounts. Full breakdown with no hidden fees.",
    canonical: `${BASE}/card-grading-cost-uk`,
    ogImage: DEFAULT_IMAGE,
  },
  "/card-grading-near-me": {
    title: "Card Grading Near Me | UK Card Grading Service | MintVault",
    description: "Looking for card grading near you in the UK? MintVault is a UK-based professional grading service — no international shipping, fast turnaround, from £19.",
    canonical: `${BASE}/card-grading-near-me`,
    ogImage: DEFAULT_IMAGE,
  },
};

/** Default meta for unknown routes (404, cert detail pages, etc.) */
const DEFAULT_META: SeoMeta = {
  title: "MintVault UK — Professional Trading Card Grading",
  description: "Professional UK trading card grading. Tamper-evident slabs, NFC verification, verified ownership registry, and insured return shipping. From £19 per card.",
  canonical: BASE,
  ogImage: DEFAULT_IMAGE,
};

/**
 * Returns the SeoMeta for a given URL pathname.
 * Handles cert detail pages (/cert/:id) with a generic cert title.
 */
export function getSeoMeta(pathname: string): SeoMeta {
  const clean = pathname.split("?")[0].split("#")[0];

  if (SEO_MAP[clean]) return SEO_MAP[clean];

  // Cert detail: /cert/MV42
  const certMatch = clean.match(/^\/cert\/(.+)$/);
  if (certMatch) {
    const certId = certMatch[1].toUpperCase();
    return {
      title: `Certificate ${certId} | MintVault UK`,
      description: `Verify MintVault graded card certificate ${certId}. View grade, card details, and ownership status.`,
      canonical: `${BASE}/cert/${certId}`,
    };
  }

  // Guide detail: /guides/:slug
  const guideMatch = clean.match(/^\/guides\/(.+)$/);
  if (guideMatch) {
    return {
      title: "Card Grading Guide | MintVault UK",
      description: "Expert card grading guide from MintVault UK — professional trading card grading service.",
      canonical: `${BASE}${clean}`,
    };
  }

  return { ...DEFAULT_META, canonical: `${BASE}${clean}` };
}

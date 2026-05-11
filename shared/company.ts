/**
 * MintVault company information — single source of truth.
 *
 * Referenced by: footer, confirmation emails, legal markdown templates,
 * checkout legal block.
 *
 * Placeholders flagged with [PENDING] stay until real values arrive.
 * When Companies House / ICO numbers land, update this file, deploy, and
 * every reference across the app updates in lockstep.
 */

// Single canonical postal address. Registered office and trading address
// are identical as of 2026-05-11; both `registeredOffice` and `tradingAddress`
// on COMPANY reference this same object. If they ever diverge (e.g. a
// serviced-office registered address), split into two literal objects.
const POSTAL_ADDRESS = {
  line1: "2 Temple Gardens",
  line2: "Strood",
  city: "Kent",
  postcode: "ME2 2NG",
  country: "United Kingdom",
  displayName: "MintVault Grading",
} as const;

export const COMPANY = {
  legalName: "Mint Vault UK Ltd",
  tradingName: "MintVault",
  companyNumber: "17170013",
  icoRegistrationNumber: "ZC140242",
  // Canonical postal address used by shipping labels, packing slips, the
  // /submit/success page, /help/contact, /help/faq, and submission emails.
  postalAddress: POSTAL_ADDRESS,
  // Registered office and trading address both reference postalAddress.
  // Update postalAddress to update both in lockstep. If they diverge,
  // replace one of these with its own literal.
  registeredOffice: POSTAL_ADDRESS,
  tradingAddress: POSTAL_ADDRESS,
  supportEmail: "hello@mintvaultuk.com",
  website: "https://mintvaultuk.com",
} as const;

export type PostalAddress = typeof POSTAL_ADDRESS;

/**
 * Format a postal address for display.
 *
 * - multiline=true → newline-joined string. Callers needing JSX render
 *   should split on "\n" and interpose <br /> or <p> elements.
 * - multiline=false → comma-joined single line.
 *
 * includeDisplayName=true prepends the addressee line (e.g. "MintVault
 * Grading") so the result is a complete posting address.
 */
export function formatPostalAddress(
  addr: PostalAddress,
  opts: { multiline: boolean; includeDisplayName: boolean },
): string {
  const parts: string[] = [];
  if (opts.includeDisplayName && addr.displayName) parts.push(addr.displayName);
  parts.push(addr.line1);
  if (addr.line2) parts.push(addr.line2);
  parts.push(addr.city);
  parts.push(addr.postcode);
  parts.push(addr.country);
  return parts.join(opts.multiline ? "\n" : ", ");
}

export function isCompanyInfoComplete(): boolean {
  return !COMPANY.companyNumber.includes("[PENDING") &&
         !COMPANY.icoRegistrationNumber.includes("[PENDING");
}

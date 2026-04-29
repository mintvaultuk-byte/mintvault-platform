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

export const COMPANY = {
  legalName: "Mint Vault UK Ltd",
  tradingName: "MintVault",
  companyNumber: "17170013",
  icoRegistrationNumber: "[PENDING — ICO registration]",
  tradingAddress: {
    city: "Kent",
    country: "United Kingdom",
  },
  supportEmail: "hello@mintvaultuk.com",
  website: "https://mintvaultuk.com",
} as const;

export function isCompanyInfoComplete(): boolean {
  return !COMPANY.companyNumber.includes("[PENDING") &&
         !COMPANY.icoRegistrationNumber.includes("[PENDING");
}

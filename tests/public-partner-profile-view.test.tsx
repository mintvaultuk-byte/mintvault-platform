import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PublicPartnerProfileView } from "../client/src/components/public-partner-profile-view";
import type { PublicPartnerLocation } from "../shared/public-partner";

const storefront: PublicPartnerLocation = {
  publicRef: "storefront-ref-a",
  displayName: "A Cards",
  locationName: "Canterbury Shop",
  privacyState: "PUBLIC_STOREFRONT",
  address: "1 Public Street, Canterbury",
  serviceArea: null,
  designation: "MintVault Partner",
  websiteUrl: "https://cards.example.test/",
  phone: "+44 1227 123456",
  email: "public@example.test",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=1%20Public%20Street",
  cardsGraded: 0,
  cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location",
  partnerSince: null,
};

describe("exact public Partner profile renderer", () => {
  it("renders only authoritative conditional storefront actions and explains the zero count", () => {
    const html = renderToStaticMarkup(createElement(PublicPartnerProfileView, { location: storefront }));
    expect(html).toContain("1 Public Street, Canterbury");
    expect(html).toContain("Get directions");
    expect(html).toContain("Visit website");
    expect(html).toContain("Call shop");
    expect(html).toContain("Contact shop");
    expect(html).toContain("Cards graded through this MintVault Partner");
    expect(html).toContain(">0<");
    expect(html).toContain("MintVault approves the resulting grades and certificates");
  });

  it("renders service-area truth with no street-address or Maps action", () => {
    const html = renderToStaticMarkup(createElement(PublicPartnerProfileView, {
      location: {
        ...storefront,
        privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
        address: null,
        serviceArea: "Kent and East Sussex",
        mapsUrl: null,
        websiteUrl: null,
        phone: null,
        email: null,
      },
    }));
    expect(html).toContain("Serves Kent and East Sussex");
    expect(html).toContain("operating address is private");
    expect(html).not.toContain("1 Public Street");
    expect(html).not.toContain("Get directions");
    expect(html).toContain("No public contact action is currently available");
  });

  it("is the renderer mounted by public, Partner preview and Super Admin preview surfaces", () => {
    for (const file of [
      "client/src/pages/public-partner-profile.tsx",
      "client/src/pages/partner/public-profile.tsx",
      "client/src/pages/admin/partner-management-detail.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain("PublicPartnerProfileView");
    }
  });

  it("keeps the compact menu through tablet/1024 widths and exposes desktop navigation at xl", () => {
    const header = readFileSync("client/src/components/v2/header-v2.tsx", "utf8");
    expect(header).toContain('className="hidden xl:flex items-center gap-6"');
    expect(header).toContain('className="xl:hidden inline-flex items-center justify-center');
    expect(header).not.toContain('className="hidden md:flex items-center gap-6"');
  });
});

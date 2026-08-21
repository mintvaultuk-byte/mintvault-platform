import { describe, expect, it } from "vitest";
import {
  derivePublicLocationPublicationState,
  googleMapsAddressUrl,
  preferredGoogleMapsUrl,
  isValidPublicPartnerRef,
  safePublicEmail,
  safePublicPhone,
  safePublicWebsite,
  type PublicPartnerLocation,
} from "../server/partner/public-presence-service";
import { renderPublicHtmlWithPartnerPresence } from "../server/static";

const BASE_HTML = `<!doctype html><html><head>
<title>MintVault</title>
<meta name="description" content="base" />
<meta property="og:title" content="base" />
<meta property="og:description" content="base" />
<meta property="og:url" content="https://mintvaultuk.com" />
<meta name="twitter:title" content="base" />
<meta name="twitter:description" content="base" />
</head><body><div id="root"></div></body></html>`;

const location: PublicPartnerLocation = {
  publicRef: "11111111-1111-4111-8111-111111111111",
  displayName: "Cards & <Collectibles>",
  locationName: "Canterbury",
  privacyState: "PUBLIC_STOREFRONT",
  address: "1 High Street, Canterbury, CT1 1AA",
  serviceArea: null,
  designation: "MintVault Partner",
  websiteUrl: "https://example.test/",
  phone: "+44 1234 567890",
  email: "shop@example.test",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=1%20High%20Street",
  cardsGraded: 12,
  cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location",
  partnerSince: "2026-08-01",
};

describe("public Partner value safety", () => {
  it("uses one fail-closed readiness decision for every authenticated publication surface", () => {
    const complete = {
      organisationStatus: "ACTIVE",
      locationStatus: "ACTIVE",
      publicDisplayName: "A Trading",
      profileVersion: 1,
      profileConsentedAt: "2026-08-19T00:00:00Z",
      profileApprovedVersion: 1,
      profileListed: true,
      privacyState: "PUBLIC_STOREFRONT",
      publicLocationName: "Canterbury Shop",
      publicStreetAddress: "1 High Street, Canterbury CT1 1AA",
      publicServiceArea: null,
      publicWebsite: null,
      publicPhone: null,
      publicEmail: null,
      mapsEnabled: true,
      consentedFields: ["public_location_name", "public_street_address", "maps_enabled"],
      locationVersion: 2,
      locationConsentedAt: "2026-08-19T00:00:00Z",
      locationApprovedVersion: 2,
      locationListed: true,
      directoryEnabled: true,
    };
    expect(derivePublicLocationPublicationState(complete)).toEqual({
      readyForApproval: true,
      approved: true,
      partnerListed: true,
      locationListed: true,
      live: true,
      blockingReasons: [],
    });
    expect(derivePublicLocationPublicationState({ ...complete, publicDisplayName: null })).toEqual(
      expect.objectContaining({
        readyForApproval: false,
        live: false,
        blockingReasons: expect.arrayContaining(["PUBLIC_DISPLAY_NAME_REQUIRED"]),
      })
    );
    expect(derivePublicLocationPublicationState({ ...complete, organisationStatus: "SUSPENDED" }).live).toBe(false);
    expect(derivePublicLocationPublicationState({ ...complete, locationStatus: "SUSPENDED" }).live).toBe(false);
    expect(derivePublicLocationPublicationState({ ...complete, locationApprovedVersion: null }).blockingReasons)
      .toContain("LOCATION_APPROVAL_REQUIRED");
    expect(derivePublicLocationPublicationState({ ...complete, directoryEnabled: false }).blockingReasons)
      .toContain("DIRECTORY_DISABLED");
    const serviceArea = derivePublicLocationPublicationState({
      ...complete,
      privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
      publicStreetAddress: null,
      publicServiceArea: "Kent",
      publicEmail: "shop@example.test",
      mapsEnabled: false,
      consentedFields: ["public_location_name", "public_service_area", "public_email"],
    });
    expect(serviceArea.live).toBe(true);
    expect(derivePublicLocationPublicationState({
      ...complete,
      mapsEnabled: false,
      publicWebsite: null,
      publicPhone: null,
      publicEmail: null,
      consentedFields: ["public_location_name", "public_street_address"],
    }).blockingReasons).toContain("PUBLIC_CONTACT_ACTION_REQUIRED");
    expect(derivePublicLocationPublicationState({ ...complete, privacyState: "NOT_PUBLIC" }).live).toBe(false);
  });

  it("permits only absolute credential-free HTTP(S) website values", () => {
    expect(safePublicWebsite("https://shop.example/path")).toBe("https://shop.example/path");
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/x",
      "https://user:pass@shop.example/",
      "https://shop.example/\u0000x",
      "/relative",
      "not a url",
    ]) expect(safePublicWebsite(value)).toBeNull();
  });

  it("sanitizes contact values and constructs Maps links from a fixed origin", () => {
    expect(safePublicPhone("+44 (0)1227 123-456")).toBe("+44 (0)1227 123-456");
    expect(safePublicPhone("javascript:1")).toBeNull();
    expect(safePublicEmail(" SHOP@EXAMPLE.TEST ")).toBe("shop@example.test");
    expect(safePublicEmail("not-an-email")).toBeNull();
    expect(googleMapsAddressUrl("1 High Street & Lane")).toBe(
      "https://www.google.com/maps/search/?api=1&query=1%20High%20Street%20%26%20Lane"
    );
    expect(googleMapsAddressUrl("  ")).toBeNull();
    expect(preferredGoogleMapsUrl({
      mapsUri: "https://maps.google.com/?cid=123",
      placeId: "ChIJ-fallback",
      address: "1 High Street",
    })).toBe("https://maps.google.com/?cid=123");
    expect(preferredGoogleMapsUrl({
      mapsUri: "https://evil.example/maps",
      placeId: "ChIJ_12345",
      businessName: "Trusted Cards",
      address: "1 High Street",
    })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Trusted%20Cards&query_place_id=ChIJ_12345"
    );
    expect(preferredGoogleMapsUrl({
      mapsUri: "https://google.com.evil.example/maps",
      address: "1 High Street",
    })).toBe("https://www.google.com/maps/search/?api=1&query=1%20High%20Street");
  });

  it("accepts the stable external public-ref shape and rejects path/query injection", () => {
    expect(isValidPublicPartnerRef(location.publicRef)).toBe(true);
    expect(isValidPublicPartnerRef("shop_ref-123")).toBe(true);
    for (const value of ["x", "../admin", "shop?draft=true", "shop/ref", "<script>"]) {
      expect(isValidPublicPartnerRef(value)).toBe(false);
    }
  });
});

describe("public Partner direct-response SEO boundary", () => {
  it("returns a real 404/noindex for disabled directory and unpublished profiles", async () => {
    const resolver = { directoryEnabled: async () => false, profile: async () => null };
    const directory = await renderPublicHtmlWithPartnerPresence(BASE_HTML, "/find-a-partner", resolver);
    const profile = await renderPublicHtmlWithPartnerPresence(
      BASE_HTML,
      `/partners/location/${location.publicRef}`,
      resolver
    );
    for (const result of [directory, profile]) {
      expect(result.status).toBe(404);
      expect(result.noindex).toBe(true);
      expect(result.html).toContain('name="robots" content="noindex, nofollow"');
    }
  });

  it("renders unique escaped profile metadata/schema only for an eligible resolver result", async () => {
    const result = await renderPublicHtmlWithPartnerPresence(
      BASE_HTML,
      `/partners/location/${location.publicRef}?utm_source=test`,
      { directoryEnabled: async () => true, profile: async () => location }
    );
    expect(result.status).toBe(200);
    expect(result.noindex).toBe(false);
    expect(result.html).toContain("Cards &amp; &lt;Collectibles&gt; — Canterbury | MintVault Partner");
    expect(result.html).toContain(`rel="canonical" href="https://mintvaultuk.com/partners/location/${location.publicRef}"`);
    expect(result.html).toContain('<script type="application/ld+json">');
    expect(result.html).toContain('"@type":"LocalBusiness"');
    expect(result.html).toContain('"@context":"https://schema.org"');
    expect(result.html).not.toContain("<Collectibles>");
    expect(result.html).not.toContain('name="robots"');
  });

  it("uses areaServed and never fabricates a street address for private service-area profiles", async () => {
    const serviceAreaLocation: PublicPartnerLocation = {
      ...location,
      privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
      address: null,
      serviceArea: "Kent and East Sussex",
      mapsUrl: null,
    };
    const result = await renderPublicHtmlWithPartnerPresence(
      BASE_HTML,
      `/partners/location/${location.publicRef}`,
      { directoryEnabled: async () => true, profile: async () => serviceAreaLocation }
    );
    expect(result.html).toContain('"areaServed":"Kent and East Sussex"');
    expect(result.html).not.toContain('"streetAddress"');
    expect(result.html).not.toContain('"hasMap"');
  });

  it("renders the directory as indexable only when its global resolver is enabled", async () => {
    const result = await renderPublicHtmlWithPartnerPresence(BASE_HTML, "/find-a-partner?postcode=CT1", {
      directoryEnabled: async () => true,
      profile: async () => null,
    });
    expect(result.status).toBe(200);
    expect(result.html).toContain("Find a MintVault Partner | UK Grading Locations");
    expect(result.html).toContain('"@type":"CollectionPage"');
  });

  it("replaces static metadata even when unrelated malformed tags precede it", async () => {
    const malformedPrefix = '<meta name="twitter:description" '.repeat(2_000);
    const result = await renderPublicHtmlWithPartnerPresence(`${malformedPrefix}${BASE_HTML}`, "/find-a-partner", {
      directoryEnabled: async () => true,
      profile: async () => null,
    });
    expect(result.status).toBe(200);
    expect(result.html).toContain(
      'name="twitter:description" content="Search approved MintVault Partner shops, view public location details, and open directions in Google Maps."'
    );
  });
});

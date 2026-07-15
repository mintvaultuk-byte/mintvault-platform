import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SOCIAL_STUDIO_BACKGROUNDS,
  SOCIAL_STUDIO_FORMAT_DIMENSIONS,
  buildSocialStudioCaption,
  buildSocialStudioDownloadFilename,
  buildSocialStudioHashtags,
  escapeSocialStudioSearchTerm,
  resolveAutoBackground,
  resolveBackgroundVariant,
  sanitizeSocialStudioFilenamePart,
} from "../shared/social-studio";

const pageSource = readFileSync("client/src/pages/admin-social-studio.tsx", "utf8");
const routesSource = readFileSync("server/routes.ts", "utf8");
const navSource = readFileSync("client/src/components/admin/admin-shell.tsx", "utf8");
const appSource = readFileSync("client/src/App.tsx", "utf8");
const shareImageSource = readFileSync("server/share-image.ts", "utf8");

describe("Social Studio Phase 1 rules", () => {
  it("exposes only the approved Phase 1 formats and dimensions", () => {
    expect(SOCIAL_STUDIO_FORMAT_DIMENSIONS.feed).toEqual({ width: 1080, height: 1080 });
    expect(SOCIAL_STUDIO_FORMAT_DIMENSIONS.story).toEqual({ width: 1080, height: 1920 });
    expect(SOCIAL_STUDIO_FORMAT_DIMENSIONS["reel-cover"]).toEqual({ width: 1080, height: 1920 });
    expect(SOCIAL_STUDIO_FORMAT_DIMENSIONS["weekly-highlights"]).toEqual({ width: 1080, height: 1080 });

    expect(pageSource).toContain('"feed", "story", "reel-cover", "weekly-highlights"');
    expect(pageSource).toContain("Static 1080 x 1920 cover only");
    expect(pageSource).toContain("does not create one stitched weekly");
  });

  it("keeps the background catalogue small and curated", () => {
    expect(SOCIAL_STUDIO_BACKGROUNDS.map((bg) => bg.id)).toEqual([
      "auto",
      "gold-luxury",
      "black-luxury",
      "electric",
      "fire",
      "water",
      "grass-nature",
      "psychic-galaxy",
      "dark",
      "dragon",
      "crystal",
      "neutral-studio",
    ]);
    expect(SOCIAL_STUDIO_BACKGROUNDS).toHaveLength(12);
  });

  it("selects Auto backgrounds deterministically from local data", () => {
    expect(resolveAutoBackground({ certNumber: "MV1", cardName: "Pikachu", setName: "Base", grade: 9 })).toBe(
      "electric"
    );
    expect(resolveAutoBackground({ certNumber: "MV2", cardName: "Charizard", setName: "Base", grade: 9 })).toBe("fire");
    expect(resolveAutoBackground({ certNumber: "MV3", cardName: "Blastoise", setName: "Base", grade: 9 })).toBe(
      "water"
    );
    expect(resolveAutoBackground({ certNumber: "MV4", cardName: "Dragonite", setName: "Fossil", grade: 9 })).toBe(
      "dragon"
    );
    expect(resolveAutoBackground({ certNumber: "MV5", cardName: "Unknown", setName: "Promo", grade: 10 })).toBe(
      "gold-luxury"
    );
    expect(resolveBackgroundVariant("auto", { certNumber: "MV6", cardName: "Umbreon", grade: 9 })).toBe("poke-dark");
  });

  it("builds editable local captions and compact hashtags without AI", () => {
    const card = {
      certNumber: "MV10",
      cardName: "Charizard",
      setName: "Base Set",
      cardGame: "pokemon",
      grade: 10,
      gradeLabel: "PRISTINE",
    };
    expect(buildSocialStudioCaption(card)).toContain("Charizard");
    expect(buildSocialStudioCaption(card)).toContain("mintvaultuk.com/cert/MV10");
    expect(buildSocialStudioHashtags(card)).toContain("#PokemonTCG");
    expect(buildSocialStudioHashtags(card).split(" ")).toHaveLength(7);
  });

  it("escapes SQL LIKE search metacharacters completely", () => {
    expect(escapeSocialStudioSearchTerm("MV%_\\10")).toBe("MV\\%\\_\\\\10");
  });

  it("builds deterministic safe download filenames from hostile and normal names", () => {
    const hostileCases = [
      ["MV/10", "MV-10"],
      ["MV\\10", "MV-10"],
      ["MV///10", "MV-10"],
      ["../MV10", "MV10"],
      ["MV%2f10", "MV-2f10"],
      ["MV%5c10", "MV-5c10"],
      ["MV\r\n10", "MV-10"],
      ['"MV10"', "MV10"],
      ["MV∕10⁄A⧸B", "MV-10-A-B"],
      ["Pokemon Charizard 10", "Pokemon-Charizard-10"],
    ];
    for (const [input, expected] of hostileCases) {
      expect(sanitizeSocialStudioFilenamePart(input)).toBe(expected);
    }

    expect(sanitizeSocialStudioFilenamePart("///...")).toBe("asset");
    expect(sanitizeSocialStudioFilenamePart("A".repeat(120))).toHaveLength(80);
    expect(buildSocialStudioDownloadFilename({ certNumber: "MV/10" }, "weekly-highlights")).toBe(
      "mintvault_MV-10_weekly-highlights.jpg"
    );
  });
});

describe("Social Studio Phase 1 wiring", () => {
  it("adds a founder-visible admin navigation item and route", () => {
    expect(navSource).toContain('href: "/admin/social-studio"');
    expect(navSource).toContain('label: "Social Studio"');
    expect(navSource).toContain('label: "Advanced Reel Pipeline"');
    expect(appSource).toContain('const AdminSocialStudioPage = lazy(() => import("@/pages/admin-social-studio"))');
    expect(appSource).toContain('<Route path="/admin/social-studio" component={AdminSocialStudioPage} />');
  });

  it("keeps all Social Studio server endpoints admin-only and static-only", () => {
    const endpoints = [
      '"/api/admin/social-studio/backgrounds"',
      '"/api/admin/social-studio/backgrounds/:background/preview"',
      '"/api/admin/social-studio/certificates"',
      '"/api/admin/social-studio/certificate"',
      '"/api/admin/social-studio/caption"',
      '"/api/admin/social-studio/render"',
    ];
    for (const endpoint of endpoints) {
      expect(routesSource).toContain(endpoint);
    }
    expect(routesSource).not.toContain('"/api/admin/social-studio/certificates/:certNumber"');
    expect(routesSource).not.toContain('"/api/admin/social-studio/certificates/:certNumber/caption"');
    expect(routesSource).not.toContain('"/api/admin/social-studio/render/:certNumber/:format/:background"');
    expect(routesSource).toMatch(/\/api\/admin\/social-studio\/backgrounds[\s\S]{0,120}requireAdmin/);
    expect(routesSource).toMatch(/\/api\/admin\/social-studio\/certificates[\s\S]{0,120}requireAdmin/);
    expect(routesSource).toMatch(/\/api\/admin\/social-studio\/render"[\s\S]{0,120}requireAdmin/);
    expect(routesSource).toContain("socialStudioRenderRateLimit");
    expect(routesSource).toContain("socialStudioRenderBodySchema.safeParse(req.body)");
    expect(routesSource).toContain("allowProviderGeneration: false");
    expect(routesSource).toContain('"X-MintVault-Static-Only", "true"');
    expect(routesSource).toContain('"X-MintVault-Provider-Generation", "false"');
  });

  it("does not wire provider, AI or publishing clients into the Social Studio page", () => {
    expect(pageSource).not.toContain("Segmind");
    expect(pageSource).not.toContain("Anthropic");
    expect(pageSource).not.toContain("Post Now");
    expect(pageSource).not.toContain("Post Now");
    expect(pageSource).toContain("No publishing");
    expect(pageSource).toContain("No AI generation");
    expect(pageSource).toContain("No provider credits");
  });

  it("adds renderer support for zero-credit static-only fallback", () => {
    expect(shareImageSource).toContain("allowProviderGeneration?: boolean");
    expect(shareImageSource).toContain("if (!allowProviderGeneration)");
    expect(shareImageSource).toContain("static-only fallback");
    expect(shareImageSource).toContain("return variantFallback(variant);");
  });

  it("keeps downloads predictable and strips editor controls from the exported image path", () => {
    expect(pageSource).toContain("buildSocialStudioDownloadFilename(card, format)");
    expect(pageSource).toContain('fetch("/api/admin/social-studio/render"');
    expect(pageSource).toContain('method: "POST"');
    expect(pageSource).not.toContain("/api/admin/social-studio/render/${");
    expect(pageSource).toContain("Download {SOCIAL_STUDIO_FORMAT_LABELS[format]}");
    expect(pageSource).not.toContain("html2canvas");
  });
});

import { describe, expect, it } from "vitest";
import { storedImageFailureClassName, storedImageReloadSrc } from "../client/src/components/vault-quest/vq-stored-image-utils";

describe("VqStoredImage client helpers", () => {
  it("manual reload retries the same authenticated proxy route with a local nonce", () => {
    expect(storedImageReloadSrc("/api/admin/vault-quest/characters/GNV-F01-S1/candidate/42?v=3", 1))
      .toBe("/api/admin/vault-quest/characters/GNV-F01-S1/candidate/42?v=3&vq_img_reload=1");
  });

  it("reload nonce preserves signed/proxy URL parameters instead of replacing them", () => {
    const url = storedImageReloadSrc("/api/admin/vault-quest/artwork-revisions/7/image?token=abc&expires=never", 2);
    expect(url).toContain("token=abc");
    expect(url).toContain("expires=never");
    expect(url).toContain("vq_img_reload=2");
  });

  it("initial render uses the original stored src and therefore cannot loop automatically", () => {
    expect(storedImageReloadSrc("/api/admin/vault-quest/characters/c/pack/master_portrait", 0))
      .toBe("/api/admin/vault-quest/characters/c/pack/master_portrait");
  });

  it("failure placeholder keeps its non-black background after caller image classes", () => {
    const classes = storedImageFailureClassName("h-24 w-24 rounded bg-slate-950 object-contain");
    expect(classes.lastIndexOf("bg-slate-800/80")).toBeGreaterThan(classes.lastIndexOf("bg-slate-950"));
  });
});

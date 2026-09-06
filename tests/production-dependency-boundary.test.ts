import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

describe("production dependency classification", () => {
  it("keeps the Tailwind animation plugin available only to the builder", () => {
    expect(manifest.dependencies["tailwindcss-animate"]).toBeUndefined();
    expect(manifest.devDependencies["tailwindcss-animate"]).toBe("^1.0.7");
    expect(lock.packages[""].devDependencies["tailwindcss-animate"]).toBe(
      manifest.devDependencies["tailwindcss-animate"],
    );
    expect(readFileSync("tailwind.config.ts", "utf8")).toContain('require("tailwindcss-animate")');
  });

  it("does not promote the CSS configuration toolchain into the runtime lock graph", () => {
    for (const name of ["tailwindcss-animate", "tailwindcss", "postcss-load-config", "tsx"]) {
      expect(lock.packages[`node_modules/${name}`], name).toMatchObject({ dev: true });
    }
  });

  it("retains the actual native runtime dependencies", () => {
    for (const name of ["canvas", "sharp"]) {
      expect(manifest.dependencies[name], name).toBeTruthy();
      expect(lock.packages[`node_modules/${name}`].dev, name).not.toBe(true);
    }
  });
});

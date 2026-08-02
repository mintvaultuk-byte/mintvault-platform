/**
 * Project Control — UI invariants that a type-checker cannot catch.
 *
 * These are source-level guards, deliberately. The defects below are all things that COMPILE and
 * RENDER without error, and are only wrong once a human looks at the screen — which is exactly the
 * class of defect that survives a green build and reaches production.
 *
 * Two invariants are pinned here:
 *
 *   UX-2  a CSS gradient token must never be assigned to `color`;
 *   UX-3  Project Control must be reachable from the admin navigation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const ADMIN_PAGES = join(ROOT, "client/src/pages/admin");
const TOKENS = join(ROOT, "client/src/styles/admin-tokens.css");
const SHELL = join(ROOT, "client/src/components/admin/admin-shell.tsx");

function adminSourceFiles(): { file: string; source: string }[] {
  return readdirSync(ADMIN_PAGES)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => ({ file: f, source: readFileSync(join(ADMIN_PAGES, f), "utf8") }));
}

/**
 * Every custom property in admin-tokens.css whose VALUE is a gradient.
 *
 * Derived from the stylesheet rather than hardcoded, so a gradient token added later is covered
 * automatically instead of quietly escaping the guard.
 */
function gradientTokenNames(): string[] {
  const css = readFileSync(TOKENS, "utf8");
  const names: string[] = [];
  for (const match of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    const [, name, value] = match;
    if (/gradient\(/i.test(value)) names.push(name);
  }
  return [...new Set(names)];
}

describe("UX-2 — a gradient token is never used as a foreground colour", () => {
  it("finds the gradient tokens it is guarding (the guard is not vacuous)", () => {
    const tokens = gradientTokenNames();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("--admin-gold-text");
  });

  it("provides a solid on-gold ink token to use instead", () => {
    const css = readFileSync(TOKENS, "utf8");
    expect(css).toMatch(/--admin-on-gold:\s*#[0-9a-f]{6}/i);
  });

  it("assigns no gradient token to `color` anywhere in the admin pages", () => {
    // A gradient is not a valid <color>. The browser DISCARDS the declaration, and the var()
    // fallback does NOT apply — a fallback only fires when the property is unset, not when it is
    // set to something invalid. The text silently inherits --admin-ink: near-white on gold, about
    // 1.8:1, failing WCAG AA and AA-large. It renders, so nothing catches it but the eye.
    const tokens = gradientTokenNames();
    const offences: string[] = [];

    for (const { file, source } of adminSourceFiles()) {
      for (const token of tokens) {
        // Matches `color: "var(--token…)"` and the ternary form
        // `color: cond ? "var(--token…)" : "inherit"`.
        const re = new RegExp(`color:[^,;\\n]*var\\(\\s*${token}\\b`, "g");
        for (const _ of source.matchAll(re)) offences.push(`${file}: ${token} assigned to color`);
      }
    }

    expect(offences, `gradient tokens used as foreground colour:\n${offences.join("\n")}`).toEqual([]);
  });

  it("still allows a gradient token as a background (its legitimate use)", () => {
    const css = readFileSync(TOKENS, "utf8");
    expect(css).toMatch(/background:\s*var\(--admin-gold-text\)/);
  });
});

describe("UX-3 — Project Control is reachable from the admin navigation", () => {
  const shell = readFileSync(SHELL, "utf8");

  it("registers a Project Control entry in the admin shell nav", () => {
    // Without this the entire feature is reachable only by typing a URL, which is how it shipped.
    expect(shell).toContain("/admin/project-control");
  });

  it("labels it so an operator can recognise it", () => {
    expect(shell).toMatch(/label:\s*"Project Control"/);
  });

  it("uses an href entry, not a tab key", () => {
    // Project Control is a standalone route, not one of the /admin dashboard tabs. A tab-keyed
    // entry would land on /admin and drop the destination.
    expect(shell).toMatch(/href:\s*"\/admin\/project-control"/);
  });
});

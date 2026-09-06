import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

describe("canonical redirect token redaction", () => {
  it("preserves the full redirect target without writing its query string to logs", () => {
    const block = index.slice(
      index.indexOf('if (host === "mintvault.fly.dev"'),
      index.indexOf("\n  next();", index.indexOf('if (host === "mintvault.fly.dev"'))
    );
    expect(block).toContain("console.log(`[canonical-redirect] ${req.method} ${req.path} from host=${host}`)");
    expect(block).toContain("`https://mintvaultuk.com${req.originalUrl}`");
    expect(block).not.toContain("${req.originalUrl} from host=");
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_AI_ANALYZE_RETIRED_RESPONSE,
  LEGACY_AI_GRADE_UPLOAD_RETIRED_RESPONSE,
} from "../server/lib/retired-ai-grading";

const ROUTES_SOURCE = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const CERTIFICATE_FORM_SOURCE = readFileSync(
  new URL("../client/src/components/certificate-form.tsx", import.meta.url),
  "utf8"
);
const servers: Server[] = [];

const retiredRoutes = [
  {
    path: "/api/admin/certificates/:id/analyze-v1-legacy",
    responseName: "LEGACY_AI_ANALYZE_RETIRED_RESPONSE",
    response: LEGACY_AI_ANALYZE_RETIRED_RESPONSE,
  },
  {
    path: "/api/admin/certificates/grade-with-ai",
    responseName: "LEGACY_AI_GRADE_UPLOAD_RETIRED_RESPONSE",
    response: LEGACY_AI_GRADE_UPLOAD_RETIRED_RESPONSE,
  },
] as const;

function routeBlock(source: string, path: string): string | null {
  const start = source.indexOf(`app.post(\n    "${path}"`);
  if (start < 0) return null;
  const end = source.indexOf("\n  );", start);
  return end < 0 ? null : source.slice(start, end + "\n  );".length);
}

function tombstoneErrors(source: string): string[] {
  const errors: string[] = [];
  for (const route of retiredRoutes) {
    const block = routeBlock(source, route.path);
    if (!block) {
      errors.push(`${route.path}: missing route`);
      continue;
    }
    const executable = block.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
    const expected =
      `app.post( "${route.path}", requireAdmin, ` +
      `(_req, res) => res.status(410).json(${route.responseName}) );`;
    if (executable !== expected) errors.push(`${route.path}: middleware or handler drift`);
  }
  return errors;
}

function readTree(root: string): string {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? readTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

async function listen(app: express.Express): Promise<string> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("legacy AI route retirement", () => {
  it("defines stable, separately typed retirement responses", () => {
    expect(LEGACY_AI_ANALYZE_RETIRED_RESPONSE).toEqual({
      error: "Legacy AI analysis route is retired",
      code: "LEGACY_AI_ANALYZE_RETIRED",
    });
    expect(LEGACY_AI_GRADE_UPLOAD_RETIRED_RESPONSE).toEqual({
      error: "Legacy AI grading upload route is retired",
      code: "LEGACY_AI_GRADE_UPLOAD_RETIRED",
    });
  });

  it("mounts both identities as authenticated unconditional pre-body tombstones", () => {
    expect(tombstoneErrors(ROUTES_SOURCE)).toEqual([]);
    for (const route of retiredRoutes) {
      const block = routeBlock(ROUTES_SOURCE, route.path)!;
      expect(block).not.toMatch(
        /aiRateLimit|getFeatureFlag|uploadMemoryAdmission|gradeWithAiUpload|req\.(?:body|file|files)|storage\.|db\.|sql`|R2|uploadTo|anthropic|openai|identifyCard|analyzeCard|grading|prediction|audit/i
      );
    }
  });

  it("returns 410 before malformed multipart data can reach a route-local parser or downstream effect", async () => {
    for (const route of retiredRoutes) {
      const app = express();
      const parser = vi.fn((_req, _res, next) => next());
      const downstreamEffect = vi.fn((_req, res) => res.status(500).end());
      app.post(
        route.path,
        (_req, _res, next) => next(),
        (_req, res) => res.status(410).json(route.response),
        parser,
        downstreamEffect
      );
      const base = await listen(app);
      const requestPath = route.path.replace(":id", "123");
      const response = await fetch(`${base}${requestPath}`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=broken" },
        body: Buffer.alloc(2 * 1024 * 1024, 0x61),
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual(route.response);
      expect(parser).not.toHaveBeenCalled();
      expect(downstreamEffect).not.toHaveBeenCalled();
    }
  });

  it("preserves the mounted canonical grading command and removes client callers of retired identities", () => {
    expect(ROUTES_SOURCE).toContain('app.post("/api/admin/certificates/:id/grade", requireAdmin, async (req, res) =>');
    expect(CERTIFICATE_FORM_SOURCE).toContain(
      "adminFetch(`/api/admin/certificates/${certificate.id}/grade`,"
    );
    const clientSource = readTree(join(process.cwd(), "client", "src"));
    expect(clientSource).not.toContain("analyze-v1-legacy");
    expect(clientSource).not.toContain("grade-with-ai");
  });

  it("fails its contract for status, middleware, and single-route hostile mutations", () => {
    expect(
      tombstoneErrors(
        ROUTES_SOURCE.replace(
          "res.status(410).json(LEGACY_AI_ANALYZE_RETIRED_RESPONSE)",
          "res.status(503).json(LEGACY_AI_ANALYZE_RETIRED_RESPONSE)"
        )
      )
    ).not.toEqual([]);
    expect(
      tombstoneErrors(
        ROUTES_SOURCE.replace(
          '"/api/admin/certificates/grade-with-ai",\n    requireAdmin,',
          '"/api/admin/certificates/grade-with-ai",\n    requireAdmin,\n    uploadMemoryAdmission("revived", 512),'
        )
      )
    ).not.toEqual([]);
    expect(
      tombstoneErrors(
        ROUTES_SOURCE.replace('"/api/admin/certificates/:id/analyze-v1-legacy"', '"/removed-legacy-route"')
      )
    ).not.toEqual([]);
  });
});

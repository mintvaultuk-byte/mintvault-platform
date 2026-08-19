import { createHash, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  getAcquisitionPerformance,
  getCampaignPerformance,
  getGrowthSummary,
  isGrowthPeriod,
  type GrowthPeriod,
} from "../commercial-growth-service";
import {
  getCapacityStatus,
  getConversionSummary,
  getGrowthIntelligence,
  getLivePulse,
  getSeoSummary,
  getSiteHealth,
} from "../growth-intelligence-service";
import { getReviewSummary } from "../review-request-service";

export const GROWTH_MCP_PATH = "/mcp/growth";
export const GROWTH_MCP_PROTOCOL_VERSION = "2025-03-26";

const readLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: { jsonrpc: "2.0", id: null, error: { code: -32029, message: "Growth read rate limit exceeded" } },
});

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const PERIOD_SCHEMA = {
  type: "object",
  properties: { period: { type: "string", enum: ["today", "7d", "30d", "90d", "all"], default: "30d" } },
  additionalProperties: false,
} as const;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

export const GROWTH_MCP_TOOLS = [
  [
    "get_growth_summary",
    "Paid cards, verified revenue and Partner application totals for a bounded period.",
    PERIOD_SCHEMA,
  ],
  ["get_live_pulse", "Recent authoritative commercial events and truthful unavailable telemetry states.", EMPTY_SCHEMA],
  [
    "get_site_health",
    "Server readiness and provider-health states; unavailable metrics remain NOT_CONNECTED.",
    EMPTY_SCHEMA,
  ],
  [
    "get_capacity_status",
    "Read-only capacity status; never scales infrastructure or changes configuration.",
    EMPTY_SCHEMA,
  ],
  ["get_acquisition_performance", "Privacy-safe acquisition-category performance for a bounded period.", PERIOD_SCHEMA],
  ["get_campaign_performance", "Controlled campaign-code performance for a bounded period.", PERIOD_SCHEMA],
  [
    "get_partner_pipeline",
    "Aggregate Partner application state totals; never returns lead or contact details.",
    PERIOD_SCHEMA,
  ],
  ["get_seo_summary", "Technical SEO readiness and truthful Search Console connection states.", EMPTY_SCHEMA],
  [
    "get_conversion_summary",
    "Server-observed funnel stages and verified paid authority for a bounded period.",
    PERIOD_SCHEMA,
  ],
  ["get_review_summary", "Aggregate neutral review-request lifecycle without customer identity.", PERIOD_SCHEMA],
  ["get_growth_insights", "Deterministic, traceable Growth insights for a bounded period.", PERIOD_SCHEMA],
] as const;

export function growthMcpAuthState(): "READY" | "NOT_CONFIGURED" | "INVALID" {
  const configured = process.env.GROWTH_MCP_TOKEN_SHA256?.trim().toLowerCase() ?? "";
  if (!configured) return "NOT_CONFIGURED";
  return /^[a-f0-9]{64}$/.test(configured) ? "READY" : "INVALID";
}

export function authorizeGrowthMcp(header: unknown): boolean {
  if (growthMcpAuthState() !== "READY" || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (token.length < 32 || token.length > 256) return false;
  const actual = Buffer.from(createHash("sha256").update(token).digest("hex"), "hex");
  const expected = Buffer.from(process.env.GROWTH_MCP_TOKEN_SHA256!.trim().toLowerCase(), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rpcError(res: Response, id: JsonRpcId, code: number, message: string, status = 200): Response {
  return res.status(status).json({ jsonrpc: "2.0", id, error: { code, message } });
}

function rpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function parsePeriod(args: unknown): GrowthPeriod {
  if (args === undefined) return "30d";
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_ARGS");
  const values = args as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "period")) throw new Error("INVALID_ARGS");
  const period = values.period ?? "30d";
  if (!isGrowthPeriod(period)) throw new Error("INVALID_ARGS");
  return period;
}

function requireEmptyArgs(args: unknown): void {
  if (args === undefined) return;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args as object).length > 0) {
    throw new Error("INVALID_ARGS");
  }
}

async function auditMcpTool(tool: string, period?: GrowthPeriod): Promise<void> {
  const { storage } = await import("../storage");
  await storage.writeAuditLog("growth_mcp", "growth-read", "growth_mcp_tool_called", "mcp:growth-read", {
    tool,
    period: period ?? null,
    scope: "aggregate_read_only",
  });
}

export async function executeGrowthMcpTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "get_growth_summary": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return getGrowthSummary(period);
    }
    case "get_live_pulse":
      requireEmptyArgs(args);
      await auditMcpTool(name);
      return getLivePulse();
    case "get_site_health":
      requireEmptyArgs(args);
      await auditMcpTool(name);
      return getSiteHealth();
    case "get_capacity_status":
      requireEmptyArgs(args);
      await auditMcpTool(name);
      return getCapacityStatus();
    case "get_acquisition_performance": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return getAcquisitionPerformance(period);
    }
    case "get_campaign_performance": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return getCampaignPerformance(period);
    }
    case "get_partner_pipeline": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return (await getGrowthSummary(period)).partnerApplications;
    }
    case "get_seo_summary":
      requireEmptyArgs(args);
      await auditMcpTool(name);
      return getSeoSummary();
    case "get_conversion_summary": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return getConversionSummary(period);
    }
    case "get_review_summary": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return getReviewSummary(period);
    }
    case "get_growth_insights": {
      const period = parsePeriod(args);
      await auditMcpTool(name, period);
      return (await getGrowthIntelligence(period)).insights;
    }
    default:
      throw new Error("UNKNOWN_TOOL");
  }
}

function toolDefinitions() {
  return GROWTH_MCP_TOOLS.map(([name, description, inputSchema]) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

export function registerGrowthMcpRoutes(app: Express): void {
  app.post(GROWTH_MCP_PATH, readLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (growthMcpAuthState() !== "READY") {
      return rpcError(res, null, -32001, "Growth MCP is not configured", 503);
    }
    if (!authorizeGrowthMcp(req.headers.authorization)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="MintVault Growth Read"');
      return rpcError(res, null, -32000, "Unauthorized", 401);
    }
    const body = req.body as JsonRpcRequest;
    const id = rpcId(body?.id);
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(res, id, -32600, "Invalid Request", 400);
    }
    if (body.method === "notifications/initialized") return res.status(204).send();
    if (body.method === "ping") return res.json({ jsonrpc: "2.0", id, result: {} });
    if (body.method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: GROWTH_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mintvault-growth-read", version: "1.0.0" },
          instructions:
            "Aggregate Growth reads only. No customer detail, mutation, payment, Partner, Scanner or deployment access.",
        },
      });
    }
    if (body.method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: toolDefinitions() } });
    }
    if (body.method === "tools/call") {
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.name !== "string") return rpcError(res, id, -32602, "Invalid params");
      try {
        const value = await executeGrowthMcpTool(params.name, params.arguments);
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
            isError: false,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "UNKNOWN_TOOL")
          return rpcError(res, id, -32602, "Unknown tool");
        if (error instanceof Error && error.message === "INVALID_ARGS")
          return rpcError(res, id, -32602, "Invalid tool arguments");
        console.error("[growth-mcp] aggregate tool unavailable");
        return rpcError(res, id, -32603, "Growth aggregate unavailable");
      }
    }
    return rpcError(res, id, -32601, "Method not found");
  });
}

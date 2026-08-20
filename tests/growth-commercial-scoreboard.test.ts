import fs from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseCountTarget, parseGbpTargetToPence } from "../client/src/pages/admin/growth";
import {
  deriveCommercialTargetStatus,
  getCommercialScoreboard,
  setCurrentMonthCommercialTargets,
} from "../server/growth-scoreboard-service";
import { GROWTH_MCP_TOOLS } from "../server/routes/growth-mcp";
import { startPostgres17 } from "./helpers/postgres17-cluster";

const dialect = new PgDialect();

describe("Commercial Growth Targets scoreboard", () => {
  it("derives status from elapsed monthly pace rather than absolute target percentage", () => {
    const base = { target: 100, periodProgress: 0.5, elapsedMs: 15 * 24 * 60 * 60 * 1000 };
    expect(deriveCommercialTargetStatus({ ...base, actual: 60 })).toMatchObject({
      status: "GREEN",
      statusLabel: "ON_TRACK",
      paceRatio: 1.2,
    });
    expect(deriveCommercialTargetStatus({ ...base, actual: 40 })).toMatchObject({
      status: "AMBER",
      statusLabel: "ATTENTION",
      paceRatio: 0.8,
    });
    expect(deriveCommercialTargetStatus({ ...base, actual: 20 })).toMatchObject({
      status: "RED",
      statusLabel: "MATERIALLY_BEHIND",
      paceRatio: 0.4,
    });
    expect(deriveCommercialTargetStatus({ ...base, actual: 60, target: null })).toMatchObject({
      status: "GREY",
      statusLabel: "NO_TARGET_SET",
    });
    expect(deriveCommercialTargetStatus({ ...base, actual: null })).toMatchObject({
      status: "GREY",
      statusLabel: "INSUFFICIENT_DATA",
    });
  });

  it("builds monthly actual/target/status rows and never substitutes review-request activity for genuine reviews", async () => {
    const replies = [
      {
        rows: [
          {
            period_start: "2026-07-31T23:00:00.000Z",
            period_end: "2026-08-31T23:00:00.000Z",
            paid_cards: "60",
            revenue_pence: "3000",
            partner_applications: "4",
            qualified_partners: "2",
          },
        ],
      },
      {
        rows: [
          { metric: "PAID_CARDS", target_value: "100", created_at: "2026-08-01T10:00:00.000Z" },
          { metric: "REVENUE_GBP", target_value: "10000", created_at: "2026-08-01T10:00:00.000Z" },
          { metric: "PARTNER_APPLICATIONS", target_value: "10", created_at: "2026-08-01T10:00:00.000Z" },
          { metric: "GENUINE_REVIEWS", target_value: "5", created_at: "2026-08-01T10:00:00.000Z" },
        ],
      },
    ];
    let index = 0;
    const scoreboard = await getCommercialScoreboard({
      executor: { execute: async () => replies[index++] },
      observedAt: new Date("2026-08-16T11:00:00.000Z"),
    });
    expect(scoreboard.period).toMatchObject({ kind: "MONTHLY", timezone: "Europe/London" });
    expect(scoreboard.metrics.find((metric) => metric.key === "PAID_CARDS")).toMatchObject({
      actual: { state: "REAL", value: 60 },
      target: { state: "SET", value: 100, authority: "SUPER_ADMIN" },
      status: "GREEN",
    });
    expect(scoreboard.metrics.find((metric) => metric.key === "REVENUE_GBP")?.status).toBe("RED");
    expect(scoreboard.metrics.find((metric) => metric.key === "PARTNER_APPLICATIONS")?.status).toBe("AMBER");
    expect(scoreboard.metrics.find((metric) => metric.key === "QUALIFIED_PARTNERS")?.statusLabel).toBe("NO_TARGET_SET");
    expect(scoreboard.metrics.find((metric) => metric.key === "GENUINE_REVIEWS")).toMatchObject({
      actual: { state: "NOT_INSTRUMENTED" },
      target: { state: "SET", value: 5 },
      status: "GREY",
      statusLabel: "INSUFFICIENT_DATA",
    });
    expect(JSON.stringify(scoreboard)).not.toMatch(/review_requests|sent|clicked/i);
  });

  it("writes only changed target revisions and an audit record in one transaction", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    let call = 0;
    const executor = {
      transaction: async <T>(
        callback: (tx: { execute: (query: never) => Promise<{ rows: unknown[] }> }) => Promise<T>
      ) =>
        callback({
          execute: async (query) => {
            queries.push(dialect.sqlToQuery(query));
            call += 1;
            if (call === 1) return { rows: [{ period_start: "2026-07-31T23:00:00.000Z" }] };
            if (call === 3) {
              return {
                rows: [
                  { metric: "PAID_CARDS", target_value: "100", created_at: "2026-08-01T10:00:00.000Z" },
                  { metric: "PARTNER_APPLICATIONS", target_value: "8", created_at: "2026-08-01T10:00:00.000Z" },
                ],
              };
            }
            return { rows: [] };
          },
        }),
    };
    const result = await setCurrentMonthCommercialTargets(
      { PAID_CARDS: 100, PARTNER_APPLICATIONS: 12 },
      "owner@mintvault.test",
      { executor, observedAt: new Date("2026-08-16T11:00:00.000Z") }
    );
    expect(result).toEqual({ changed: true, changedMetrics: ["PARTNER_APPLICATIONS"] });
    expect(queries.some((query) => query.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(queries.filter((query) => query.sql.includes("INSERT INTO growth_commercial_targets"))).toHaveLength(1);
    expect(queries.some((query) => query.sql.includes("INSERT INTO audit_log"))).toBe(true);
    expect(queries.flatMap((query) => query.params)).toContain("owner@mintvault.test");
  });

  it("serializes real PostgreSQL revisions and preserves a null clear without deleting history", async () => {
    const cluster = await startPostgres17("growth-commercial-scoreboard");
    const client = new pg.Client({ connectionString: cluster.url });
    await client.connect();
    try {
      await client.query(`
          CREATE TABLE growth_commercial_targets (
            id bigserial PRIMARY KEY,
            metric text NOT NULL,
            period text NOT NULL,
            period_start timestamptz NOT NULL,
            target_value bigint,
            set_by text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE audit_log (
            id serial PRIMARY KEY,
            entity_type text NOT NULL,
            entity_id text NOT NULL,
            action text NOT NULL,
            admin_user text,
            details jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
          );
        `);
      const execute = async (query: SQL): Promise<{ rows: unknown[] }> => {
        const compiled = dialect.sqlToQuery(query);
        const result = await client.query(compiled.sql, compiled.params);
        return { rows: result.rows };
      };
      const executor = {
        transaction: async <T>(callback: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> => {
          await client.query("BEGIN");
          try {
            const result = await callback({ execute });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      };
      const options = { executor, observedAt: new Date("2026-08-16T11:00:00.000Z") };
      await setCurrentMonthCommercialTargets({ PAID_CARDS: 100, REVENUE_GBP: 10_000 }, "owner@test", options);
      expect(
        await setCurrentMonthCommercialTargets({ PAID_CARDS: 100, REVENUE_GBP: 12_000 }, "owner@test", options)
      ).toEqual({ changed: true, changedMetrics: ["REVENUE_GBP"] });
      await setCurrentMonthCommercialTargets({ REVENUE_GBP: null }, "owner@test", options);
      const rows = await client.query<{ metric: string; target_value: string | null }>(
        "SELECT metric, target_value FROM growth_commercial_targets ORDER BY id"
      );
      expect(rows.rows).toEqual([
        { metric: "PAID_CARDS", target_value: "100" },
        { metric: "REVENUE_GBP", target_value: "10000" },
        { metric: "REVENUE_GBP", target_value: "12000" },
        { metric: "REVENUE_GBP", target_value: null },
      ]);
      expect((await client.query("SELECT id FROM audit_log ORDER BY id")).rowCount).toBe(3);
    } finally {
      await client.end().catch(() => {});
      await cluster.stop().catch(() => {});
    }
  }, 30_000);

  it("parses GBP exactly, rejects invented/default targets and exposes no MCP target mutation", () => {
    expect(parseGbpTargetToPence("123.45")).toBe(12_345);
    expect(parseGbpTargetToPence("0.01")).toBe(1);
    expect(parseGbpTargetToPence("12.345")).toBeUndefined();
    expect(parseGbpTargetToPence("")).toBeNull();
    expect(parseCountTarget("43")).toBe(43);
    expect(parseCountTarget("1.5")).toBeUndefined();
    const names = GROWTH_MCP_TOOLS.map(([name]) => name);
    expect(names).toContain("get_commercial_scoreboard");
    expect(names.join(" ")).not.toMatch(/set_.*target|update_.*target|clear_.*target/i);
    const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(page).toContain("Blank clears a target by adding a revision");
    expect(page).not.toMatch(/defaultTarget|suggestedTarget|aiTarget/i);
  });
});

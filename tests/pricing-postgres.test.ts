/** Pricing contract against a newly owned PostgreSQL cluster, never configured databases. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import express from "express";
import type { Server } from "node:http";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let client: Client;
let server: Server;
let base: string;
let storage: typeof import("../server/storage").storage;
let closePool: (() => Promise<void>) | undefined;
beforeAll(async () => {
  cluster = await startPostgres17("pricing-contract");
  // This mandatory app alias is generated HERE, after env -i and owned cluster creation.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  process.env.TEST_DATABASE_URL = cluster.url;
  client = new Client({ connectionString: cluster.url });
  await client.connect();
  await client.query(`
    CREATE TABLE service_tiers (
      id serial PRIMARY KEY, service_type text NOT NULL, tier_id text NOT NULL, name text NOT NULL,
      price_per_card integer NOT NULL, turnaround_days integer NOT NULL, turnaround_label text,
      max_value_gbp integer NOT NULL, features text[] DEFAULT '{}', is_active boolean DEFAULT true,
      sort_order integer DEFAULT 0, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
    );
    CREATE TABLE tier_capacity (tier_id text, status text, paused_until timestamp, paused_message text);
    INSERT INTO service_tiers (service_type,tier_id,name,price_per_card,turnaround_days,turnaround_label,max_value_gbp,is_active,sort_order) VALUES
    ('grading','standard','Current grading',3729,17,'17 working days',4500,true,1),
    ('grading','inactive','Retired grading',1111,2,'2 working days',999,false,2),
    ('reholder','reholder','Other service',4567,9,'Special current label',2000,true,1);
    INSERT INTO tier_capacity VALUES ('standard','paused',NULL,'Test capacity pause');
  `);
  storage = (await import("../server/storage")).storage;
  const { pool } = await import("../server/db");
  closePool = () => pool.end();
  const { registerPublicRoutes } = await import("../server/routes/public");
  const app = express();
  registerPublicRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await closePool?.();
  await client?.end();
  await cluster?.stop();
});
describe("Live pricing SQL and public wire contract", () => {
  it("returns the same camel-case record after a real update and refreshes changed turnaround", async () => {
    const tier = (await storage.getServiceTiers("grading"))[0];
    const updated = await storage.updateServiceTier(tier.id, { pricePerCard: 4137, turnaroundDays: 23 });
    expect(updated).toMatchObject({ id: tier.id, pricePerCard: 4137, turnaroundDays: 23 });
    const persisted = await storage.getServiceTier("grading", "standard");
    const { serviceTierToPricingTier } = await import("../shared/schema");
    expect(serviceTierToPricingTier(persisted!)).toMatchObject({ pricePerCard: 4137, turnaround: "23 working days" });
    const other = (await storage.getServiceTiers("reholder"))[0];
    await storage.updateServiceTier(other.id, { pricePerCard: 4568, turnaroundDays: other.turnaroundDays });
    expect((await storage.getServiceTier("reholder", "reholder"))!.turnaroundLabel).toBe("Special current label");
  });
  it("defaults to active grading only and exposes capacity without stale caching", async () => {
    const response = await fetch(`${base}/api/service-tiers`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "standard",
      serviceType: "grading",
      capacityStatus: "paused",
      capacityMessage: "Test capacity pause",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const other = await fetch(`${base}/api/service-tiers?serviceType=reholder`).then((r) => r.json());
    expect(other).toHaveLength(1);
    expect(other[0].serviceType).toBe("reholder");
  });
  it("rejects malformed or unknown service selection without broadening the catalogue", async () => {
    for (const query of ["serviceType=unknown", "serviceType=grading&serviceType=reholder", "serviceType="]) {
      expect((await fetch(`${base}/api/service-tiers?${query}`)).status).toBe(400);
    }
  });
});

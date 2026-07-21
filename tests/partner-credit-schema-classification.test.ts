import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type PoolClient } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;

describe("G6D complete Partner accounting schema classification", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-credit-schema-classification");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("returns legacy only when all four accounting tables are absent", async () => {
    const { partnerCreditSchemaState } = await import("../server/partner/partner-submission-credit-lifecycle");
    await expect(partnerCreditSchemaState(admin as unknown as PoolClient)).resolves.toBe(
      "legacy_missing_credit_schema"
    );
  });

  it("fails explicitly for every partial accounting-schema phase", async () => {
    const { partnerCreditSchemaState, PartnerSubmissionCreditLifecycleError } =
      await import("../server/partner/partner-submission-credit-lifecycle");
    await admin.query("CREATE TABLE partner_wallets (id uuid)");
    await expect(partnerCreditSchemaState(admin as unknown as PoolClient)).rejects.toBeInstanceOf(
      PartnerSubmissionCreditLifecycleError
    );
    await admin.query("CREATE TABLE partner_credit_ledger (id uuid)");
    await expect(partnerCreditSchemaState(admin as unknown as PoolClient)).rejects.toMatchObject({
      code: "credit_schema_incomplete",
    });
    await admin.query("CREATE TABLE partner_credit_reservations (id uuid)");
    await expect(partnerCreditSchemaState(admin as unknown as PoolClient)).rejects.toMatchObject({
      code: "credit_schema_incomplete",
    });
  });

  it("returns ready only after wallet, ledger, reservation and event tables all exist", async () => {
    const { partnerCreditSchemaState } = await import("../server/partner/partner-submission-credit-lifecycle");
    await admin.query("CREATE TABLE partner_credit_reservation_events (id uuid)");
    await expect(partnerCreditSchemaState(admin as unknown as PoolClient)).resolves.toBe("ready");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { readFileSync } from "node:fs";

const FILENAMES = ["0116_nfc_physical_lock_integrity.sql", "0118_nfc_lock_intent_reconciliation.sql"];
let cluster: DisposablePostgres17;
let client: Client;

function migrations() {
  return FILENAMES.map((filename) => {
    const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
    if (!found) throw new Error(`${filename} was not discovered`);
    return found;
  });
}

describe("NFC physical-lock truth", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("nfc-physical-lock-integrity");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(`
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        nfc_uid text,
        nfc_enabled boolean DEFAULT false,
        nfc_chip_type text,
        nfc_url text,
        nfc_locked boolean DEFAULT false,
        nfc_written_at timestamptz,
        nfc_written_by text,
        nfc_locked_at timestamptz,
        nfc_last_verified_at timestamptz,
        nfc_scan_count integer DEFAULT 0
      )`);
    await client.query(`
      INSERT INTO certificates (
        certificate_number,nfc_uid,nfc_enabled,nfc_chip_type,nfc_url,nfc_written_at,nfc_written_by
      ) VALUES ('MV1','04:AA',true,'NTAG215','https://mintvaultuk.com/nfc/MV1',now(),'admin')`);
    await applyMigrations(client, migrations());
  }, 60_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("persists intent before makeReadOnly and provides confirmation-only retry", () => {
    const source = readFileSync("client/src/components/nfc-section.tsx", "utf8");
    const handler = source.slice(source.indexOf("const handleLock"), source.indexOf("const handleTest"));
    expect(handler.indexOf("prepareLockMutation.mutateAsync")).toBeLessThan(handler.indexOf("makeReadOnly()"));
    expect(handler.indexOf("makeReadOnly()")).toBeLessThan(handler.lastIndexOf("retainLockReceipt(receipt)"));
    expect(handler.lastIndexOf("retainLockReceipt(receipt)")).toBeLessThan(handler.indexOf("lockMutation.mutateAsync"));
    const physicalAttempt = source.slice(
      source.indexOf("const handleLock"),
      source.indexOf("const handleRetryLockConfirmation")
    );
    const ambiguousCatch = physicalAttempt.slice(physicalAttempt.indexOf("catch (err"));
    expect(ambiguousCatch).toContain("Physical lock outcome needs reconciliation");
    expect(ambiguousCatch).not.toContain("cancelNfcLock");
    expect(ambiguousCatch).not.toContain("cancelLockMutation");
    const retry = source.slice(
      source.indexOf("const handleRetryLockConfirmation"),
      source.indexOf("const handleOperatorRecovery")
    );
    expect(retry).toContain("lockMutation.mutateAsync");
    expect(retry).not.toContain("makeReadOnly");
    expect(source).toContain('const NFC_LOCK_METHOD = "web_nfc_make_read_only"');
    expect(source).toContain("physicalLockConfirmed: true");
    expect(source).toContain("lockMethod: NFC_LOCK_RECOVERY_METHOD");
    expect(source).toContain("Verified writable — cancel intent");
    expect(source).toContain('const NFC_LOCK_CANCEL_METHOD = "operator_verified_writable"');
    const cancel = source.slice(source.indexOf("const handleCancelLockIntent"), source.indexOf("const handleTest"));
    expect(cancel).toContain("verificationMethod: NFC_LOCK_CANCEL_METHOD");
    expect(source).toContain("independently verify whether the tag is read-only");
  });

  it("refuses an incomplete lock claim", async () => {
    await expect(
      client.query(`
        INSERT INTO certificates (certificate_number,nfc_locked,nfc_locked_at)
        VALUES ('MV2',true,now())`)
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows one complete lock transition and ordinary scan telemetry", async () => {
    const tokenHash = "a".repeat(64);
    await expect(
      client.query(
        `UPDATE certificates SET nfc_lock_pending_token_hash=$1, nfc_lock_pending_uid=nfc_uid,
          nfc_lock_pending_method='web_nfc_make_read_only', nfc_lock_pending_at=now(),
          nfc_lock_pending_by='admin' WHERE certificate_number='MV1'`,
        [tokenHash]
      )
    ).resolves.toBeTruthy();
    await client.query("SELECT set_config('mintvault.nfc_lock_confirm_token_hash',$1,false)", [tokenHash]);
    await expect(
      client.query(`UPDATE certificates SET nfc_locked=true,nfc_locked_at=now(),
      nfc_lock_pending_token_hash=NULL,nfc_lock_pending_uid=NULL,nfc_lock_pending_method=NULL,
      nfc_lock_pending_at=NULL,nfc_lock_pending_by=NULL WHERE certificate_number='MV1'`)
    ).resolves.toBeTruthy();
    await expect(
      client.query(
        "UPDATE certificates SET nfc_scan_count=nfc_scan_count+1,nfc_last_verified_at=now() WHERE certificate_number='MV1'"
      )
    ).resolves.toBeTruthy();
  });

  it("freezes a pending UID and rejects direct lock claims even under trigger-bypass mode", async () => {
    await client.query(`INSERT INTO certificates (
      certificate_number,nfc_uid,nfc_enabled,nfc_chip_type,nfc_url,nfc_written_at,nfc_written_by
    ) VALUES ('MV-PENDING','04:CC',true,'NTAG215','https://mintvaultuk.com/nfc/MV-PENDING',now(),'admin')`);
    await client.query(
      `UPDATE certificates SET nfc_lock_pending_token_hash=$1,
      nfc_lock_pending_uid=nfc_uid,nfc_lock_pending_method='web_nfc_make_read_only',
      nfc_lock_pending_at=now(),nfc_lock_pending_by='admin' WHERE certificate_number='MV-PENDING'`,
      ["b".repeat(64)]
    );
    await client.query("SET session_replication_role=replica");
    try {
      await expect(
        client.query("UPDATE certificates SET nfc_uid='04:DD' WHERE certificate_number='MV-PENDING'")
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query("UPDATE certificates SET nfc_lock_pending_token_hash=NULL WHERE certificate_number='MV-PENDING'")
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query("UPDATE certificates SET nfc_locked_at=now() WHERE certificate_number='MV-PENDING'")
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET session_replication_role=origin");
    }
  });

  it("rejects unlock, clear and overwrite even under replication-role bypass", async () => {
    await client.query("SET session_replication_role=replica");
    try {
      for (const statement of [
        "UPDATE certificates SET nfc_locked=false WHERE certificate_number='MV1'",
        "UPDATE certificates SET nfc_uid=NULL,nfc_enabled=false WHERE certificate_number='MV1'",
        "UPDATE certificates SET nfc_uid='04:BB' WHERE certificate_number='MV1'",
        "UPDATE certificates SET nfc_url='https://example.invalid' WHERE certificate_number='MV1'",
      ]) {
        await expect(client.query(statement)).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await client.query("SET session_replication_role=origin");
    }
  });
});

/**
 * THE SUPPLY CATALOGUE — editable, unlimited, and unable to rewrite history.
 *
 * WHAT THIS IS DEFENDING. The recovered build could only toggle a product's `active` flag and set a
 * price, and it refused outright to change the slab box because `pricing_mode = 'LOCKED'` pinned it
 * at 7500 pence. Worse, a CHECK constraint enumerated the only three permitted product codes with
 * their exact names and pack sizes, so a fourth product was impossible AT THE DATABASE — no admin
 * screen could ever have added one. Owner decision (2026-08-22) removed both.
 *
 * The properties below are PostgreSQL properties — a dropped CHECK, a real INSERT, and an order
 * line that no UPDATE ever touches — so they are proven against a real database built by the real
 * migration runner, not against a stub that would happily agree with whatever the code did.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let supply: typeof import("../server/partner/supply-service");
let savedEnv: Record<string, string | undefined> = {};

const actor = { userId: "00000000-0000-4000-8000-0000000000ab", email: "ops@mintvault.test" };

const CATALOGUE_MIGRATIONS = [
  ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  "0102_partner_public_presence",
  "0106_lineage_convergence_public_presence",
  "0107_partner_management_audit_idempotency_scope",
  "0111_partner_supply_commerce",
] as const;

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function priceOf(code: string): Promise<number | null> {
  const { rows } = await admin.query<{ p: number | null }>(
    "SELECT active_price_pence AS p FROM partner_supply_products WHERE code=$1",
    [code]
  );
  return rows[0]?.p ?? null;
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? "UNKNOWN" };
  }
}

describe("supply catalogue (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-supply-catalogue");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, CATALOGUE_MIGRATIONS);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    supply = await import("../server/partner/supply-service");
  }, 300_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ---- The seeded catalogue -----------------------------------------------------------------
  it("seeds the three products, with £75 as a STARTING value rather than a rule", async () => {
    const { rows } = await admin.query<{ code: string; active_price_pence: number | null }>(
      "SELECT code, active_price_pence FROM partner_supply_products ORDER BY sort_order"
    );
    expect(rows.map((r) => r.code)).toEqual(["plastic_mintvault_slab_box", "holographic_printing_paper", "nfc_tags"]);
    expect(rows[0].active_price_pence).toBe(7500);
    // The other two are catalogued and deliberately unpriced — visible, not buyable.
    expect(rows[1].active_price_pence).toBeNull();
    expect(rows[2].active_price_pence).toBeNull();
  });

  it("carries no constraint naming a product, so the catalogue is open-ended", async () => {
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='partner_supply_products'::regclass AND contype='c'`
    );
    const definitions = rows.map((r) => r.def).join(" ");
    for (const code of ["plastic_mintvault_slab_box", "holographic_printing_paper", "nfc_tags"]) {
      expect(definitions).not.toContain(code);
    }
    // And the pricing mode that made £75 immutable is gone entirely.
    const { rows: columns } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='partner_supply_products' AND column_name='pricing_mode'`
    );
    expect(columns).toEqual([]);
  });

  // ---- Editable pricing ----------------------------------------------------------------------
  it("lets Super Admin change the slabs price, which the old build refused", async () => {
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "plastic_mintvault_slab_box", {
      activePricePence: 8250,
    });
    expect(await priceOf("plastic_mintvault_slab_box")).toBe(8250);
    // And back again — nothing is one-way.
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "plastic_mintvault_slab_box", {
      activePricePence: 7500,
    });
    expect(await priceOf("plastic_mintvault_slab_box")).toBe(7500);
  });

  it("prices the other products too, and makes them purchasable only once priced", async () => {
    const before = await supply.listPartnerSupplyProducts();
    expect(before.products.find((p) => p.code === "nfc_tags")?.purchasable).toBe(false);

    await supply.updateSupplyCatalogueForSuperAdmin(actor, "nfc_tags", { activePricePence: 4999 });
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "holographic_printing_paper", { activePricePence: 3200 });

    const after = await supply.listPartnerSupplyProducts();
    expect(after.products.find((p) => p.code === "nfc_tags")?.purchasable).toBe(true);
    expect(after.products.find((p) => p.code === "holographic_printing_paper")?.active_price_pence).toBe(3200);
  });

  it("edits name and description, and treats undefined as leave-alone rather than clear", async () => {
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "nfc_tags", { displayName: "NFC verification tags" });
    const { rows } = await admin.query<{ display_name: string; description: string | null }>(
      "SELECT display_name, description FROM partner_supply_products WHERE code='nfc_tags'"
    );
    expect(rows[0].display_name).toBe("NFC verification tags");
    // The description was NOT sent, so it must survive untouched.
    expect(rows[0].description).toBe("Programmable NFC tags for slab verification.");
    // null is the explicit clear.
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "nfc_tags", { description: null });
    const cleared = await admin.query<{ description: string | null }>(
      "SELECT description FROM partner_supply_products WHERE code='nfc_tags'"
    );
    expect(cleared.rows[0].description).toBeNull();
  });

  it("refuses a price that is not a whole number of pence", async () => {
    for (const bad of [0, -1, 1.5, "75" as unknown as number]) {
      const result = await settle(
        supply.updateSupplyCatalogueForSuperAdmin(actor, "nfc_tags", { activePricePence: bad })
      );
      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false });
    }
  });

  // ---- Adding products ------------------------------------------------------------------------
  it("adds a FOURTH product, unpriced and therefore not yet purchasable", async () => {
    const created = await supply.createSupplyProductForSuperAdmin(actor, {
      displayName: "Card sleeves",
      description: "Penny sleeves, 100 per pack.",
      unitsPerPack: 100,
    });
    expect(created.code).toBe("card_sleeves");

    const catalogue = await supply.listPartnerSupplyProducts();
    expect(catalogue.products).toHaveLength(4);
    const sleeves = catalogue.products.find((p) => p.code === "card_sleeves");
    expect(sleeves).toMatchObject({ display_name: "Card sleeves", active: true, purchasable: false });
    expect(sleeves?.active_price_pence).toBeNull();

    // Priced afterwards, it becomes buyable — "catalogued" and "on sale" stay separate facts.
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { activePricePence: 599 });
    const priced = await supply.listPartnerSupplyProducts();
    expect(priced.products.find((p) => p.code === "card_sleeves")?.purchasable).toBe(true);
  });

  it("keeps adding products — there is no three-product ceiling", async () => {
    await supply.createSupplyProductForSuperAdmin(actor, { displayName: "Top loaders" });
    await supply.createSupplyProductForSuperAdmin(actor, { displayName: "Shipping boxes" });
    const catalogue = await supply.listPartnerSupplyProducts();
    expect(catalogue.products.length).toBeGreaterThanOrEqual(6);
  });

  it("refuses a duplicate product rather than overwriting a live one", async () => {
    const again = await settle(supply.createSupplyProductForSuperAdmin(actor, { displayName: "Card sleeves" }));
    expect(again).toMatchObject({ ok: false, code: "duplicate_product" });
    // The original is untouched, price included.
    expect(await priceOf("card_sleeves")).toBe(599);
  });

  it("refuses a product with no usable name", async () => {
    for (const name of ["", "   ", "!!", "a"]) {
      const result = await settle(supply.createSupplyProductForSuperAdmin(actor, { displayName: name }));
      expect({ name, ok: result.ok }).toEqual({ name, ok: false });
    }
  });

  // ---- Disable / re-enable ---------------------------------------------------------------------
  it("disables and re-enables a product without deleting anything", async () => {
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { active: false });
    const disabled = await supply.listPartnerSupplyProducts();
    const off = disabled.products.find((p) => p.code === "card_sleeves");
    // Still catalogued, still priced, simply not purchasable.
    expect(off).toMatchObject({ active: false, purchasable: false });
    expect(off?.active_price_pence).toBe(599);

    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { active: true });
    const back = await supply.listPartnerSupplyProducts();
    expect(back.products.find((p) => p.code === "card_sleeves")?.purchasable).toBe(true);
  });

  // ---- Images ------------------------------------------------------------------------------------
  it("accepts an image only when the BYTES are an image, whatever the file claims", async () => {
    // A renamed text file with an image mimetype — refused on magic bytes, before storage.
    const notAnImage = await settle(
      supply.setSupplyProductImageForSuperAdmin(actor, "card_sleeves", {
        buffer: Buffer.from("MZ this is not a picture"),
        mimetype: "image/png",
      })
    );
    expect(notAnImage).toMatchObject({ ok: false, code: "image_invalid" });

    // A PNG magic header with no decodable body — refused by the real decode, not the header.
    const truncated = await settle(
      supply.setSupplyProductImageForSuperAdmin(actor, "card_sleeves", {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
        mimetype: "image/png",
      })
    );
    expect(truncated).toMatchObject({ ok: false, code: "image_invalid" });
  });

  it("refuses an oversized image before decoding it", async () => {
    const huge = await settle(
      supply.setSupplyProductImageForSuperAdmin(actor, "card_sleeves", {
        buffer: Buffer.alloc(5 * 1024 * 1024, 1),
        mimetype: "image/png",
      })
    );
    expect(huge).toMatchObject({ ok: false, code: "image_too_large" });
  });

  it("detects each accepted format from its magic bytes alone", () => {
    expect(supply.detectSupplyImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png"
    );
    expect(supply.detectSupplyImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    expect(supply.detectSupplyImageType(webp)).toBe("image/webp");
    expect(supply.detectSupplyImageType(Buffer.from("GIF89a"))).toBeNull();
  });

  // ---- History ------------------------------------------------------------------------------------
  it("cannot rewrite the price on an order that has already been placed", async () => {
    const tenant = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_organisations (public_ref, legal_name, status)
         VALUES ('supply-hist','Supply History Ltd','ACTIVE') RETURNING id`
      )
    ).rows[0].id;
    const location = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
         VALUES ('supply-hist-loc',$1,$1,'Main','1 High Street','ACTIVE') RETURNING id`,
        [tenant]
      )
    ).rows[0].id;

    // An order placed while sleeves cost £5.99.
    const order = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_supply_orders
           (tenant_id, location_id, idempotency_key, status, delivery_address, gross_total_pence, tax_treatment)
         VALUES ($1,$2,gen_random_uuid(),'PAID','{"line1":"1 High Street"}'::jsonb, 599, 'UNCONFIGURED')
         RETURNING id`,
        [tenant, location]
      )
    ).rows[0].id;
    await admin.query(
      `INSERT INTO partner_supply_order_items
         (tenant_id, order_id, product_code, product_name_snapshot, units_per_pack_snapshot, quantity,
          gross_unit_price_pence, gross_line_total_pence)
       VALUES ($1,$2,'card_sleeves','Card sleeves',100,1,599,599)`,
      [tenant, order]
    );

    // Now the price changes to £7.99.
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { activePricePence: 799 });
    expect(await priceOf("card_sleeves")).toBe(799);

    // The historical line still says £5.99. Nothing writes to that column, ever.
    const { rows } = await admin.query<{ gross_unit_price_pence: number; product_name_snapshot: string }>(
      "SELECT gross_unit_price_pence, product_name_snapshot FROM partner_supply_order_items WHERE order_id=$1",
      [order]
    );
    expect(rows[0].gross_unit_price_pence).toBe(599);
    // The NAME is snapshotted too, so renaming a product cannot rewrite an old receipt either.
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { displayName: "Penny sleeves" });
    const after = await admin.query<{ product_name_snapshot: string }>(
      "SELECT product_name_snapshot FROM partner_supply_order_items WHERE order_id=$1",
      [order]
    );
    expect(after.rows[0].product_name_snapshot).toBe("Card sleeves");
  });

  it("keeps a disabled product's historical orders readable", async () => {
    await supply.updateSupplyCatalogueForSuperAdmin(actor, "card_sleeves", { active: false });
    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*) n FROM partner_supply_order_items WHERE product_code='card_sleeves'"
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

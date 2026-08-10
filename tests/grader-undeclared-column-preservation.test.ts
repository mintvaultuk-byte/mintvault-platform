/**
 * D-1 — the grading write must not destroy the three columns the schema model does not declare.
 *
 * WHAT THIS PINS
 * --------------
 * `auth_status`, `auth_notes` and `private_notes` are REAL columns on `certificates` that
 * `server/grader.ts` writes in raw SQL, but `shared/schema.ts` declares none of them. Drizzle's
 * `select()` therefore never materialises them, `cert.authStatus` / `cert.authNotes` /
 * `cert.privateNotes` are structurally `undefined`, and the old
 * `pick(a, b) = a === undefined ? (b ?? null) : a` collapsed to NULL on EVERY draft save:
 *
 *   • an HQ operator's admin-internal `private_notes` were destroyed, silently and unrecoverably;
 *   • an `authentic_altered` authenticity verdict was reset;
 *   • and on the read side `buildCertGradingPayload` fabricated `"genuine"` for every certificate,
 *     which the grading panel then wrote back — so the loss happened on the STAFF path too, not
 *     only the partner one.
 *
 * WHY IT RUNS AGAINST A REAL CLUSTER
 * ----------------------------------
 * The defect is invisible to a mock: it lives in the interaction between a Drizzle model that
 * omits a column and a raw `UPDATE` that names it. A stubbed `db.execute` proves nothing about
 * what PostgreSQL actually stores. So this suite starts its own disposable PostgreSQL 17, builds
 * `certificates` from the repo's own schema-derived fixture, and calls the REAL, unmodified
 * `applyCertGradeDraft` / `buildCertGradingPayload` exported by `server/grader.ts`. No HTTP layer,
 * no object storage, no mocks of the write path.
 *
 * NOT RE-IMPLEMENTED HERE: `server/grader.ts` is imported and executed, never copied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { createMintvaultCertificatesTable, alignCertificatesTableToSchema } from "./helpers/partner-realistic-db";

let cluster: DisposablePostgres17;
let admin: Client;
let grader: typeof import("../server/grader");
let closePool: (() => Promise<void>) | undefined;
let seq = 0;

const AA = "authentic_altered";

beforeAll(async () => {
  cluster = await startPostgres17("grader-d1-preservation");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();

  await createMintvaultCertificatesTable(admin);
  const aligned = await alignCertificatesTableToSchema(admin);
  for (const required of ["private_notes", "auth_status", "auth_notes"]) {
    expect(
      aligned.added.includes(required),
      `certificates.${required} must exist — it is the column this suite protects`
    ).toBe(true);
  }
  // The live table defaults auth_status to 'genuine'; the fixture builds it as a bare `text`.
  // Deliberately left WITHOUT the default so the `'genuine'` fallback under test is proven to
  // come from the COALESCE in server/grader.ts and not from a column default doing the work.

  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  grader = await import("../server/grader");
  const dbModule = await import("../server/db");
  closePool = () => dbModule.pool.end();
}, 180_000);

afterAll(async () => {
  await closePool?.();
  await admin.end();
  await cluster.stop();
});

/** Insert one certificate exactly as an HQ operator would have left it. */
async function seedCert(fields: {
  privateNotes?: string | null;
  authStatus?: string | null;
  authNotes?: string | null;
}): Promise<number> {
  seq += 1;
  const r = await admin.query<{ id: number }>(
    `INSERT INTO certificates
       (cert_id, status, grade_type, card_name, grader_status, private_notes, auth_status, auth_notes)
     VALUES ($1, 'active', 'numeric', 'Seed Card', 'assigned', $2, $3, $4)
     RETURNING id`,
    [`MV-D1-${seq}`, fields.privateNotes ?? null, fields.authStatus ?? null, fields.authNotes ?? null]
  );
  return r.rows[0].id;
}

async function row(certId: number): Promise<{
  private_notes: string | null;
  auth_status: string | null;
  auth_notes: string | null;
  card_name: string | null;
  grade: string | null;
}> {
  const r = await admin.query(
    "SELECT private_notes, auth_status, auth_notes, card_name, grade::text AS grade FROM certificates WHERE id=$1",
    [certId]
  );
  return r.rows[0];
}

// =====================================================================================
// GROUP A — the write no longer destroys the three undeclared columns
// =====================================================================================
describe("A · a draft save that never mentions the undeclared columns PRESERVES them", () => {
  it("A1: private_notes survives an ordinary draft save (the D-1 core)", async () => {
    const sentinel = "ADMIN-ONLY: customer disputes grade, do not disclose";
    const certId = await seedCert({ privateNotes: sentinel });

    expect(await grader.applyCertGradeDraft(certId, { card_name: "Charizard", overall_grade: "9" })).toBe(true);

    const after = await row(certId);
    expect(after.private_notes, "the admin-internal note must survive an unrelated grading save").toBe(sentinel);
    // Controls — the statement really executed, so this cannot pass vacuously.
    expect(after.card_name).toBe("Charizard");
    expect(after.grade).toBe("9.0");
  });

  it("A2: an authentic_altered verdict and its notes survive an ordinary draft save", async () => {
    const certId = await seedCert({ authStatus: AA, authNotes: "Trimmed edges observed under UV" });

    expect(await grader.applyCertGradeDraft(certId, { card_name: "Blastoise", overall_grade: "8" })).toBe(true);

    const after = await row(certId);
    expect(after.auth_status).toBe(AA);
    expect(after.auth_notes).toBe("Trimmed edges observed under UV");
    expect(after.card_name).toBe("Blastoise");
  });
});

// =====================================================================================
// GROUP B — the READ no longer fabricates a verdict, so the staff round-trip is safe
// =====================================================================================
describe("B · buildCertGradingPayload reports the STORED verdict, not a fabricated one", () => {
  it("B1: a stored authentic_altered certificate is reported as authentic_altered", async () => {
    const certId = await seedCert({ authStatus: AA, authNotes: "UV: trimmed", privateNotes: "HQ NOTE" });

    const payload = await grader.buildCertGradingPayload(certId);

    expect(payload.authStatus, "the panel must not be handed a verdict the database does not hold").toBe(AA);
    expect(payload.authNotes).toBe("UV: trimmed");
    // Unchanged and deliberate: a grader must NEVER receive admin-internal notes.
    expect(payload.privateNotes).toBe("");
  });

  it("B2: the full STAFF round-trip (read payload → panel sends it back) preserves the verdict", async () => {
    // This is the pre-existing production regression: the panel seeds auth_status from the
    // payload and posts it back on the next save. When the payload said "genuine" for every
    // certificate, an ordinary staff draft save silently downgraded an authentic_altered record.
    const certId = await seedCert({ authStatus: AA, authNotes: "UV: trimmed", privateNotes: "HQ NOTE" });

    const payload = await grader.buildCertGradingPayload(certId);
    const bodyThePanelWouldSend = {
      card_name: "Venusaur",
      overall_grade: "7",
      auth_status: payload.authStatus,
      auth_notes: payload.authNotes,
      // grader mode deletes private_notes from the body entirely
    };
    expect(await grader.applyCertGradeDraft(certId, bodyThePanelWouldSend)).toBe(true);

    const after = await row(certId);
    expect(after.auth_status, "a staff draft save must not downgrade authentic_altered to genuine").toBe(AA);
    expect(after.auth_notes).toBe("UV: trimmed");
    expect(after.private_notes).toBe("HQ NOTE");
    expect(after.card_name).toBe("Venusaur");
  });

  it("B3: a genuinely-NULL verdict still reads as 'genuine' (the fallback is kept, not removed)", async () => {
    const certId = await seedCert({ authStatus: null, authNotes: null });
    const payload = await grader.buildCertGradingPayload(certId);
    expect(payload.authStatus).toBe("genuine");
    expect(payload.authNotes).toBe("");
  });
});

// =====================================================================================
// GROUP C — preservation did NOT turn the columns into immovable values
// =====================================================================================
describe("C · a save that DOES send the fields still writes them", () => {
  it("C1: an explicit auth_status overwrites the stored verdict", async () => {
    const certId = await seedCert({ authStatus: "genuine" });
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Mewtwo", overall_grade: "6", auth_status: AA })).toBe(
      true
    );
    expect((await row(certId)).auth_status).toBe(AA);
  });

  it("C2: explicit auth_notes and private_notes overwrite the stored text", async () => {
    const certId = await seedCert({ authNotes: "old note", privateNotes: "old private" });
    expect(
      await grader.applyCertGradeDraft(certId, {
        card_name: "Gengar",
        overall_grade: "5",
        auth_notes: "new note",
        private_notes: "new private",
      })
    ).toBe(true);
    const after = await row(certId);
    expect(after.auth_notes).toBe("new note");
    expect(after.private_notes).toBe("new private");
  });
});

// =====================================================================================
// GROUP D — a brand-new certificate with a NULL verdict still lands on 'genuine'
// =====================================================================================
describe("D · NULL auth_status resolves to 'genuine' from the COALESCE, not from a column default", () => {
  it("D1: a never-verdicted certificate is stored as 'genuine' after its first draft save", async () => {
    const certId = await seedCert({ authStatus: null });
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Pikachu", overall_grade: "10" })).toBe(true);
    expect((await row(certId)).auth_status).toBe("genuine");
  });

  it("D2: auth_notes and private_notes stay NULL when there was nothing to preserve", async () => {
    const certId = await seedCert({});
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Snorlax", overall_grade: "4" })).toBe(true);
    const after = await row(certId);
    expect(after.auth_notes).toBeNull();
    expect(after.private_notes).toBeNull();
  });
});

// =====================================================================================
// GROUP E — the `""` decision, pinned explicitly because it is a deliberate trade
// =====================================================================================
describe("E · an explicit empty string PRESERVES on the grader path (deliberate, matches the admin route)", () => {
  /**
   * THIS IS A DELIBERATE CONSEQUENCE, NOT AN OVERSIGHT.
   *
   * `keepStoredText` is byte-identical to the `txt()` helper the shipped admin
   * certificate-update route already uses (server/routes.ts:2374, applied at 2677-2680), which
   * maps `""` to NULL so `COALESCE` keeps the stored value. Matching it is the whole point: the
   * grading panel seeds these fields empty before its data arrives and posts the empty seed back,
   * which is precisely how the data was being lost.
   *
   * The cost is that the grading screen cannot CLEAR these fields. That is accepted: blanking
   * admin-internal fields remains available on the admin certificate-update route, which is the
   * surface that owns them, and a grader is never meant to clear an HQ private note or an
   * authenticity verdict in the first place.
   */
  it('E1: auth_notes = "" preserves the stored note rather than blanking it', async () => {
    const certId = await seedCert({ authNotes: "UV: trimmed" });
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Eevee", overall_grade: "9", auth_notes: "" })).toBe(
      true
    );
    expect((await row(certId)).auth_notes).toBe("UV: trimmed");
  });

  it('E2: private_notes = "" preserves, and auth_status = "" does not reset the verdict', async () => {
    const certId = await seedCert({ privateNotes: "HQ NOTE", authStatus: AA });
    expect(
      await grader.applyCertGradeDraft(certId, {
        card_name: "Jolteon",
        overall_grade: "9",
        private_notes: "",
        auth_status: "",
      })
    ).toBe(true);
    const after = await row(certId);
    expect(after.private_notes).toBe("HQ NOTE");
    expect(after.auth_status).toBe(AA);
  });

  it("E3: blanking is still reachable — the admin certificate-update route uses the same helper shape", async () => {
    // Source pin, deliberately narrow: the admin route is the documented blanking surface, and
    // this repair copied its preservation form rather than inventing a new one.
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync("server/routes.ts", "utf8");
    expect(routes).toContain("auth_status         = COALESCE(${txt(b.auth_status)}, auth_status, 'genuine')");
    expect(routes).toContain("private_notes       = COALESCE(${txt(b.private_notes)},     private_notes)");
  });
});

// =====================================================================================
// GROUP F — nothing else about the write changed
// =====================================================================================
describe("F · the rest of the draft write is untouched", () => {
  it("F1: grade_explanation still uses the declared-column pick() path and is preserved on omission", async () => {
    const certId = await seedCert({});
    await admin.query("UPDATE certificates SET grade_explanation=$1 WHERE id=$2", ["strong corners", certId]);
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Lapras", overall_grade: "8" })).toBe(true);
    const r = await admin.query("SELECT grade_explanation FROM certificates WHERE id=$1", [certId]);
    expect(r.rows[0].grade_explanation).toBe("strong corners");
  });

  it("F2: an approved certificate is still unreachable by a draft save (approval lock unchanged)", async () => {
    const certId = await seedCert({ privateNotes: "locked" });
    await admin.query("UPDATE certificates SET grade_approved_at=now() WHERE id=$1", [certId]);
    expect(await grader.applyCertGradeDraft(certId, { card_name: "Nope", overall_grade: "1" })).toBe(false);
    const after = await row(certId);
    expect(after.card_name).toBe("Seed Card");
    expect(after.private_notes).toBe("locked");
  });
});

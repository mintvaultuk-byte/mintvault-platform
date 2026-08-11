/**
 * OWNER-AUTHORISED REPAIR (2026-08-11) — PARTNER CARD/IMAGE BINDING.
 *
 * The grading image lookup used to join `partner_submission_cards.sequence_number`
 * to `submission_items.card_index`. Those are DIFFERENT ordinals: the connector
 * importer expands each intake card by its `quantity` BEFORE numbering the
 * destination items, so they only coincide when every card has quantity 1 and the
 * sequence numbers are gapless. With card A (seq 1, qty 2) and card B (seq 2,
 * qty 1) the destination is [A, A, B] at card_index 1,2,3 — so item 2 (an A) was
 * handed B's photographs, and item 3 resolved nothing at all. Because the result
 * is spread AFTER the certificate's own images it OVERRODE them, so a partner
 * grader could assess the wrong card.
 *
 * These run against a real disposable PostgreSQL and drive the production
 * function, not a re-implementation of it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

// grading-routes.ts pulls in the app DB client, R2 and storage at module scope.
// None of them participate in the binding query under test, so they are stubbed
// to keep this suite hermetic — the function itself runs unmodified against a
// real PostgreSQL below.
vi.mock("../server/db", () => ({ db: { execute: vi.fn() } }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/r2", () => ({ getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed") }));

const { partnerCardImagesForCardIndex } = await import("../server/partner/grading-routes");

let cluster: DisposablePostgres17;
let pool: pg.Pool;

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const SUB = "33333333-3333-3333-3333-333333333333";
const DEST = 9001;

beforeAll(async () => {
  cluster = await startPostgres17("partner-card-image-binding");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
  await pool.query(`
    CREATE TABLE partner_submission_cards (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      submission_id uuid NOT NULL,
      sequence_number integer NOT NULL,
      quantity integer NOT NULL DEFAULT 1,
      front_image_key text,
      back_image_key text,
      removed_at timestamptz
    );
    CREATE TABLE submission_items (
      id serial PRIMARY KEY,
      submission_id integer NOT NULL,
      card_index integer NOT NULL
    );
  `);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

async function seed(cards: Array<{ seq: number; qty: number; key: string; removed?: boolean }>, destItems: number) {
  await pool.query("DELETE FROM partner_submission_cards");
  await pool.query("DELETE FROM submission_items");
  for (const c of cards) {
    await pool.query(
      `INSERT INTO partner_submission_cards
         (tenant_id, submission_id, sequence_number, quantity, front_image_key, back_image_key, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [TENANT, SUB, c.seq, c.qty, `${c.key}-front.jpg`, `${c.key}-back.jpg`, c.removed ? new Date() : null]
    );
  }
  for (let i = 1; i <= destItems; i++) {
    await pool.query("INSERT INTO submission_items (submission_id, card_index) VALUES ($1,$2)", [DEST, i]);
  }
}

const resolve = (cardIndex: number, tenantId = TENANT) =>
  partnerCardImagesForCardIndex(pool, {
    tenantId,
    partnerSubmissionId: SUB,
    destinationSubmissionId: DEST,
    cardIndex,
  });

describe("partner card→image binding survives quantity > 1", () => {
  it("gives every expanded unit ITS OWN card's front and back (A qty=2, B qty=1)", async () => {
    // Destination is [A, A, B] at card_index 1,2,3.
    await seed(
      [
        { seq: 1, qty: 2, key: "alpha" },
        { seq: 2, qty: 1, key: "bravo" },
      ],
      3
    );
    // card_index 2 is the REGRESSION: sequence_number = card_index returned Bravo.
    expect(await resolve(1)).toEqual({ front_image_key: "alpha-front.jpg", back_image_key: "alpha-back.jpg" });
    expect(await resolve(2)).toEqual({ front_image_key: "alpha-front.jpg", back_image_key: "alpha-back.jpg" });
    expect(await resolve(3)).toEqual({ front_image_key: "bravo-front.jpg", back_image_key: "bravo-back.jpg" });
  });

  it("handles a gap in sequence_number (removed middle card) without shifting images", async () => {
    // Live rows at seq 1 and 3; destination has 2 items. Under the old predicate
    // card_index 2 matched nothing (no seq 2) and the grader saw no images.
    await seed(
      [
        { seq: 1, qty: 1, key: "first" },
        { seq: 2, qty: 1, key: "gone", removed: true },
        { seq: 3, qty: 1, key: "third" },
      ],
      2
    );
    expect(await resolve(1)).toEqual({ front_image_key: "first-front.jpg", back_image_key: "first-back.jpg" });
    expect(await resolve(2)).toEqual({ front_image_key: "third-front.jpg", back_image_key: "third-back.jpg" });
  });

  it("treats quantity 0 / negative as one unit, exactly as the importer's Math.max(1, quantity) does", async () => {
    await seed(
      [
        { seq: 1, qty: 0, key: "zero" },
        { seq: 2, qty: -3, key: "negative" },
      ],
      2
    );
    expect(await resolve(1)).toEqual({ front_image_key: "zero-front.jpg", back_image_key: "zero-back.jpg" });
    expect(await resolve(2)).toEqual({ front_image_key: "negative-front.jpg", back_image_key: "negative-back.jpg" });
  });

  it("returns nothing for an out-of-range unit rather than a neighbour's photographs", async () => {
    await seed([{ seq: 1, qty: 2, key: "alpha" }], 2);
    expect(await resolve(3)).toBeNull();
    expect(await resolve(0)).toBeNull();
  });

  it("returns nothing across a tenant boundary — the tenant predicate is load-bearing", async () => {
    await seed([{ seq: 1, qty: 1, key: "alpha" }], 1);
    expect(await resolve(1, OTHER_TENANT)).toBeNull();
  });

  it("FAILS CLOSED when the intake rows no longer reconstruct the destination", async () => {
    // Expanded units (3) != destination items (2). Rather than hand back a
    // plausible-looking wrong card, the guard returns nothing — which makes
    // requireBothImages() block the submit instead of grading the wrong card.
    await seed(
      [
        { seq: 1, qty: 2, key: "alpha" },
        { seq: 2, qty: 1, key: "bravo" },
      ],
      2
    );
    expect(await resolve(1)).toBeNull();
    expect(await resolve(2)).toBeNull();
  });
});

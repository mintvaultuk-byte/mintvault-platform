/**
 * MintVault Document Reference Number generator.
 * 12-char alphanumeric (excluding I/O/0/1 to avoid confusion).
 * Format: XXXX-XXXX-XXXX
 * Plaintext — owner reads it off their PDF and types it into the transfer form.
 */
import crypto from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";

// Alphabet excluding ambiguous chars: I, O, 0, 1
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateReferenceNumber(): string {
  const bytes = crypto.randomBytes(12);
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${result.slice(0, 4)}-${result.slice(4, 8)}-${result.slice(8, 12)}`;
}

/**
 * Backfill reference numbers for all certs that don't have one.
 * Idempotent — only SELECTs certs WHERE reference_number IS NULL.
 * Retries up to 3 times on unique violation (Postgres 23505).
 */
export async function backfillReferenceNumbers(): Promise<void> {
  try {
    const rows = await db.execute(sql`
      SELECT id, certificate_number FROM certificates
      WHERE reference_number IS NULL AND deleted_at IS NULL
      ORDER BY id
      LIMIT 500
    `);

    let updated = 0;
    for (const row of rows.rows as any[]) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          const refNum = generateReferenceNumber();
          await db.execute(sql`
            UPDATE certificates SET reference_number = ${refNum}
            WHERE id = ${row.id} AND reference_number IS NULL
          `);
          updated++;
          break;
        } catch (e: any) {
          if (e.code === "23505") {
            // Unique violation — regenerate and retry
            attempts++;
            if (attempts >= 3) {
              console.warn(`[ref-number] cert ${row.certificate_number}: 3 unique violations, skipping`);
            }
          } else {
            console.error(`[ref-number] cert ${row.certificate_number}: ${e.message}`);
            break;
          }
        }
      }
    }

    if (updated > 0) {
      console.log(`[ref-number] backfilled ${updated} reference numbers`);
    }
  } catch (e: any) {
    console.error("[ref-number] backfill failed:", e.message);
  }
}

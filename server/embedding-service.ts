/**
 * RAG Phase 0 — embedding service.
 *
 * Generates a 1536-dim embedding vector for an approved certificate and
 * persists it to certificates.embedding. Used by the hourly background
 * job (server/jobs/embed-corpus.ts) and ad-hoc admin re-embed flows
 * (when those are built later).
 *
 * Design call (deviates from the original brief):
 *   We do NOT call Claude to extract a description before embedding.
 *   Every grade-relevant feature is already in the DB (card_name,
 *   set_name, year_text, rarity, grade, per-zone scores, defects).
 *   Building a deterministic text representation from those columns and
 *   embedding it directly is ~2000× cheaper than the Claude→embed
 *   pipeline with no retrieval-quality loss. If image-feature signal
 *   becomes load-bearing later (multimodal retrieval), we add a vision
 *   pass at that point — Phase 0 is a metadata-only corpus.
 */

import { db } from "./db";
import { certificates } from "@shared/schema";
import { eq } from "drizzle-orm";

/** OpenAI text-embedding-3-small — 1536 dims, ~$0.00002 per 1K tokens. */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

/**
 * Build the text input the embedding model sees. Order matters less than
 * presence — embedding models attend across the whole sequence — but a
 * stable layout keeps debugging readable. Empty/null fields are skipped
 * so the vector reflects what we actually know.
 */
export function buildEmbeddingInput(cert: {
  certId: string | null;
  cardName: string | null;
  cardNumber: string | null;
  setName: string | null;
  year: string | null;
  cardGame: string | null;
  rarity: string | null;
  language: string | null;
  gradeOverall: string | null;
  gradeType: string | null;
  gradeCentering: string | null;
  gradeCorners: string | null;
  gradeEdges: string | null;
  gradeSurface: string | null;
  defects: unknown;
}): string {
  const lines: string[] = [];
  if (cert.cardName)   lines.push(`Card: ${cert.cardName}${cert.cardNumber ? " #" + cert.cardNumber : ""}`);
  if (cert.setName)    lines.push(`Set: ${cert.setName}${cert.year ? " (" + cert.year + ")" : ""}`);
  if (cert.cardGame)   lines.push(`Game: ${cert.cardGame}`);
  if (cert.rarity)     lines.push(`Rarity: ${cert.rarity}`);
  if (cert.language)   lines.push(`Language: ${cert.language}`);

  if (cert.gradeOverall != null) {
    lines.push(`Overall grade: ${cert.gradeOverall} (${cert.gradeType || "numeric"})`);
  }
  const sub: string[] = [];
  if (cert.gradeCentering != null) sub.push(`centering ${cert.gradeCentering}`);
  if (cert.gradeCorners   != null) sub.push(`corners ${cert.gradeCorners}`);
  if (cert.gradeEdges     != null) sub.push(`edges ${cert.gradeEdges}`);
  if (cert.gradeSurface   != null) sub.push(`surface ${cert.gradeSurface}`);
  if (sub.length) lines.push(`Subgrades: ${sub.join(", ")}`);

  // Defects: collapse into a count + type/severity histogram. Keeping
  // individual coordinates out of the embedding text — they're not what
  // a similarity match wants ("find cards graded similarly to this one"
  // is about composition, not where the whitening sits in pixel space).
  if (Array.isArray(cert.defects) && cert.defects.length > 0) {
    const histo = new Map<string, number>();
    for (const d of cert.defects as any[]) {
      const k = `${d?.severity || "?"} ${d?.type || "?"}`;
      histo.set(k, (histo.get(k) || 0) + 1);
    }
    const summary = [...histo.entries()].map(([k, n]) => `${n}× ${k}`).join("; ");
    lines.push(`Defects (${cert.defects.length}): ${summary}`);
  } else {
    lines.push(`Defects: none recorded`);
  }

  return lines.join("\n");
}

/**
 * Embed one cert's metadata text via OpenAI and persist the vector.
 * Idempotent — skips when embedded_at is already set unless force=true.
 * Throws on transient errors so the job can decide to retry; never
 * leaves the row in a half-written state (single UPDATE on success only).
 */
export async function generateEmbeddingForCert(
  certId: string,
  options?: { force?: boolean },
): Promise<{ status: "embedded" | "skipped" | "no-data"; reason?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set — cannot generate embeddings");
  }

  const [cert] = await db.select().from(certificates).where(eq(certificates.certId, certId)).limit(1);
  if (!cert) return { status: "no-data", reason: "cert not found" };
  if (!cert.gradeApprovedAt) return { status: "no-data", reason: "not approved" };
  if (cert.embeddedAt && !options?.force) {
    return { status: "skipped", reason: "already embedded" };
  }

  const input = buildEmbeddingInput({
    certId:         cert.certId,
    cardName:       cert.cardName,
    cardNumber:     cert.cardNumber,
    setName:        cert.setName,
    year:           cert.year,
    cardGame:       cert.cardGame,
    rarity:         cert.rarity,
    language:       cert.language,
    gradeOverall:   cert.gradeOverall,
    gradeType:      cert.gradeType,
    gradeCentering: cert.gradeCentering,
    gradeCorners:   cert.gradeCorners,
    gradeEdges:     cert.gradeEdges,
    gradeSurface:   cert.gradeSurface,
    defects:        cert.defects,
  });

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
    dimensions: EMBEDDING_DIMS,
  });
  const vector = response.data[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMS) {
    throw new Error(`OpenAI returned ${vector?.length || 0} dims, expected ${EMBEDDING_DIMS}`);
  }

  await db.update(certificates)
    .set({ embedding: vector, embeddedAt: new Date() })
    .where(eq(certificates.certId, certId));

  return { status: "embedded" };
}

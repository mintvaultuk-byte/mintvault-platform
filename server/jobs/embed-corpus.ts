/**
 * RAG Phase 0 — hourly background job that embeds approved certs.
 *
 * Picks up to 50 approved-but-not-yet-embedded certs per tick, embeds
 * each, and persists the vector + embedded_at. Sequential per tick so
 * we don't hammer the OpenAI API or the DB; with ~$0.00001/cert and
 * sub-second latency the throughput is plenty for the corpus growth rate.
 *
 * Wired in server/index.ts via setInterval, matching the existing cron
 * pattern (no pg-boss / no new dep). On startup the first tick runs after
 * a short delay so request routes register first; subsequent ticks fire
 * hourly.
 */

import { db } from "./../db";
import { certificates } from "@shared/schema";
import { and, isNull, isNotNull, sql } from "drizzle-orm";
import { generateEmbeddingForCert } from "./../embedding-service";

const BATCH_SIZE = 50;

export async function runEmbedCorpusJob(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[embed-corpus] OPENAI_API_KEY not set — skipping tick");
    return;
  }

  let pending: { certId: string }[] = [];
  try {
    pending = await db
      .select({ certId: certificates.certId })
      .from(certificates)
      .where(and(
        isNotNull(certificates.gradeApprovedAt),
        isNull(certificates.embeddedAt),
        isNull(certificates.deletedAt),
      ))
      .orderBy(sql`${certificates.gradeApprovedAt} ASC`)
      .limit(BATCH_SIZE);
  } catch (err: any) {
    // Likely the embedding/embedded_at columns or pgvector ext don't
    // exist yet (migration hasn't run). Fail-soft so the boot sequence
    // doesn't crash the whole server over a deferred RAG feature.
    console.warn(`[embed-corpus] could not query pending certs (migration may be pending): ${err?.message || err}`);
    return;
  }

  if (pending.length === 0) {
    console.log("[embed-corpus] no certs pending embedding");
    return;
  }

  console.log(`[embed-corpus] embedding ${pending.length} cert(s)…`);
  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      const result = await generateEmbeddingForCert(row.certId);
      if (result.status === "embedded") embedded++;
      else skipped++;
    } catch (err: any) {
      failed++;
      console.warn(`[embed-corpus] cert=${row.certId} failed: ${err?.message || err}`);
    }
  }
  console.log(`[embed-corpus] tick complete — embedded=${embedded} skipped=${skipped} failed=${failed}`);
}

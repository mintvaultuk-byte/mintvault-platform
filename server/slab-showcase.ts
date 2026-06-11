/**
 * Slab showcase — public homepage hero data.
 *
 * Returns the top graded certs with their REAL label PNGs (front + back)
 * rendered by the existing label pipeline and cached in R2 under
 * public/slab-showcase/{certNumber}/{side}_label.png. No PII leaves this
 * module: cert number, grade, card identity, and signed image URLs only.
 *
 * Caching layers:
 *   - R2: label PNGs are generated once per cert and reused (HEAD check).
 *   - Memory: the assembled item list is cached for 5 minutes; the approve
 *     endpoint calls clearSlabShowcaseCache() so a freshly published cert
 *     appears on the next page load.
 */
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { uploadToR2, getR2SignedUrl, headR2 } from "./r2";
import { generateLabelPNG } from "./labels";
import { mvgsTierName } from "@shared/mvgs-scoring";

export interface SlabShowcaseItem {
  certNumber: string;
  dbId: number;
  grade: number;
  gradeLabel: string;
  gradeStrengthScore: number | null;
  cardName: string;
  setName: string | null;
  cardGame: string | null;
  labelType: string;
  frontLabelUrl: string;
  backLabelUrl: string | null;
  frontScanUrl: string | null;
}

const SIGNED_URL_TTL_S = 3600;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { items: SlabShowcaseItem[]; at: number } | null = null;

/** Called from the approve endpoint so new certs appear without the 5-min wait. */
export function clearSlabShowcaseCache(): void {
  cache = null;
}

/** MV-0000000206 → MV206 (same normalisation scan-ingest uses). */
function normaliseCertNumber(raw: string): string {
  return raw.replace(/^MV-?0+/, "MV");
}

/**
 * Render-or-reuse a label PNG in R2. Returns a signed URL, or null when the
 * label pipeline fails for this cert (caller skips the cert on front failure,
 * falls back to the branded back face on back failure).
 */
async function ensureLabelInR2(dbId: number, certNumber: string, side: "front" | "back"): Promise<string | null> {
  const key = `public/slab-showcase/${certNumber}/${side}_label.png`;
  try {
    const exists = await headR2(key);
    if (!exists) {
      const cert = await storage.getCertificate(dbId);
      if (!cert) return null;
      const png = await generateLabelPNG({ ...cert, certId: normaliseCertNumber(cert.certId) }, side);
      await uploadToR2(key, png, "image/png");
      console.log(
        `[slab-showcase] generated ${side} label for ${certNumber} (${(png.length / 1024).toFixed(0)}KB → ${key})`
      );
    }
    return await getR2SignedUrl(key, SIGNED_URL_TTL_S);
  } catch (err: any) {
    console.error(`[slab-showcase] ${side} label failed for ${certNumber}: ${err?.message || err}`);
    return null;
  }
}

export async function getSlabShowcaseItems(limit = 8): Promise<SlabShowcaseItem[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;

  const rows = (
    await db.execute(sql`
      SELECT id, certificate_number, grade, grade_strength_score,
             card_name, set_name, card_game, label_type,
             front_image_path, grading_front_display, grading_front_cropped
      FROM certificates
      WHERE deleted_at IS NULL
        AND status = 'active'
        AND grade IS NOT NULL
        AND front_image_path IS NOT NULL
      ORDER BY grade DESC NULLS LAST, issued_at DESC
      LIMIT ${limit}
    `)
  ).rows as any[];

  const items = (
    await Promise.all(
      rows.map(async (row): Promise<SlabShowcaseItem | null> => {
        const certNumber = normaliseCertNumber(String(row.certificate_number));
        const grade = parseFloat(String(row.grade));
        if (!Number.isFinite(grade)) return null;

        const [frontLabelUrl, backLabelUrl, frontScanUrl] = await Promise.all([
          ensureLabelInR2(Number(row.id), certNumber, "front"),
          ensureLabelInR2(Number(row.id), certNumber, "back"),
          (async () => {
            const scanKey = row.grading_front_display || row.grading_front_cropped || row.front_image_path || null;
            if (!scanKey) return null;
            try {
              return await getR2SignedUrl(String(scanKey), SIGNED_URL_TTL_S);
            } catch {
              return null;
            }
          })(),
        ]);

        // Front label is the slab's face — without it the slab is unusable.
        if (!frontLabelUrl) return null;

        return {
          certNumber,
          dbId: Number(row.id),
          grade,
          gradeLabel: mvgsTierName(grade),
          gradeStrengthScore: row.grade_strength_score != null ? Number(row.grade_strength_score) : null,
          cardName: String(row.card_name || "Graded Card"),
          setName: row.set_name ? String(row.set_name) : null,
          cardGame: row.card_game ? String(row.card_game) : null,
          labelType: String(row.label_type || "Standard"),
          frontLabelUrl,
          backLabelUrl,
          frontScanUrl,
        };
      })
    )
  ).filter((i): i is SlabShowcaseItem => i !== null);

  cache = { items, at: Date.now() };
  return items;
}

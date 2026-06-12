/**
 * Community wall — CRUD for the /community gallery + /admin/community panel.
 *
 * Posts live in community_posts; images in R2 at community/{id}.jpg. Manual
 * admin adds auto-approve (status="approved"); status="rejected" is the
 * soft-delete. Every status change is audit-logged.
 */
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { uploadToR2, getR2SignedUrl } from "./r2";

export interface CommunityPostPublic {
  id: number;
  certNumber: string | null;
  instagramHandle: string | null;
  instagramPostUrl: string | null;
  imageUrl: string | null;
  cardName: string | null;
  grade: number | null;
  featured: boolean;
  status: string;
  createdAt: string;
}

async function rowToPublic(row: any): Promise<CommunityPostPublic> {
  let imageUrl: string | null = null;
  if (row.image_r2_key) {
    try {
      imageUrl = await getR2SignedUrl(String(row.image_r2_key), 3600);
    } catch {
      imageUrl = null;
    }
  }
  return {
    id: Number(row.id),
    certNumber: row.cert_number ? String(row.cert_number) : null,
    instagramHandle: row.instagram_handle ? String(row.instagram_handle) : null,
    instagramPostUrl: row.instagram_post_url ? String(row.instagram_post_url) : null,
    imageUrl,
    cardName: row.card_name ? String(row.card_name) : null,
    grade: row.grade != null ? Number(row.grade) : null,
    featured: !!row.featured,
    status: String(row.status),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Public gallery — approved posts, featured first, then newest. Paginated. */
export async function listApprovedPosts(
  page = 1,
  limit = 20
): Promise<{ posts: CommunityPostPublic[]; total: number }> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const offset = Math.max(0, (Math.max(1, page) - 1) * safeLimit);
  const rows = (
    await db.execute(sql`
      SELECT * FROM community_posts
      WHERE status = 'approved'
      ORDER BY featured DESC, created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `)
  ).rows as any[];
  const totalRow = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM community_posts WHERE status = 'approved'`))
    .rows[0] as any;
  const posts = await Promise.all(rows.map(rowToPublic));
  return { posts, total: Number(totalRow.n) };
}

/** Admin list — optional status filter (all/approved/rejected/pending/featured). */
export async function listPostsAdmin(filter = "all"): Promise<CommunityPostPublic[]> {
  let rows: any[];
  if (filter === "featured") {
    rows = (
      await db.execute(sql`SELECT * FROM community_posts WHERE featured = true ORDER BY created_at DESC LIMIT 200`)
    ).rows as any[];
  } else if (["approved", "rejected", "pending"].includes(filter)) {
    rows = (
      await db.execute(sql`SELECT * FROM community_posts WHERE status = ${filter} ORDER BY created_at DESC LIMIT 200`)
    ).rows as any[];
  } else {
    rows = (await db.execute(sql`SELECT * FROM community_posts ORDER BY created_at DESC LIMIT 200`)).rows as any[];
  }
  return Promise.all(rows.map(rowToPublic));
}

/**
 * Admin manual add. Inserts the row first (to get the id for the R2 key),
 * uploads the image to community/{id}.jpg, then stores the key. Auto-approved.
 */
export async function createPostManual(
  data: {
    instagramHandle?: string | null;
    certNumber?: string | null;
    cardName?: string | null;
    grade?: number | null;
    instagramPostUrl?: string | null;
  },
  imageBuffer: Buffer,
  contentType: string,
  adminUser: string
): Promise<CommunityPostPublic> {
  const ext = contentType.includes("png") ? "png" : "jpg";
  // Insert placeholder row to obtain the id, then patch the real R2 key.
  const inserted = (
    await db.execute(sql`
      INSERT INTO community_posts (cert_number, instagram_handle, instagram_post_url, image_r2_key, card_name, grade, status, approved_at, approved_by)
      VALUES (
        ${data.certNumber ?? null},
        ${data.instagramHandle ?? null},
        ${data.instagramPostUrl ?? null},
        'pending-upload',
        ${data.cardName ?? null},
        ${data.grade ?? null},
        'approved',
        NOW(),
        ${adminUser}
      )
      RETURNING id
    `)
  ).rows[0] as any;
  const id = Number(inserted.id);

  const key = `community/${id}.${ext}`;
  await uploadToR2(key, imageBuffer, contentType);
  await db.execute(sql`UPDATE community_posts SET image_r2_key = ${key} WHERE id = ${id}`);

  await storage.writeAuditLog("community_post", String(id), "COMMUNITY_POST_CREATED", adminUser, {
    cert_number: data.certNumber ?? null,
    instagram_handle: data.instagramHandle ?? null,
    auto_approved: true,
  });

  const row = (await db.execute(sql`SELECT * FROM community_posts WHERE id = ${id}`)).rows[0];
  return rowToPublic(row);
}

/** Update status and/or featured flag. Audit-logged. */
export async function updatePostStatus(
  id: number,
  patch: { status?: "approved" | "rejected"; featured?: boolean },
  adminUser: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = (await db.execute(sql`SELECT id, status, featured FROM community_posts WHERE id = ${id}`))
    .rows[0] as any;
  if (!existing) return { ok: false, error: "Post not found" };

  if (patch.status !== undefined) {
    const approvedAt = patch.status === "approved" ? sql`NOW()` : sql`approved_at`;
    await db.execute(sql`
      UPDATE community_posts
      SET status = ${patch.status}, approved_at = ${approvedAt}, approved_by = ${adminUser}
      WHERE id = ${id}
    `);
  }
  if (patch.featured !== undefined) {
    await db.execute(sql`UPDATE community_posts SET featured = ${patch.featured} WHERE id = ${id}`);
  }

  await storage.writeAuditLog("community_post", String(id), "COMMUNITY_POST_STATUS_CHANGED", adminUser, {
    before: { status: existing.status, featured: !!existing.featured },
    after: { status: patch.status ?? existing.status, featured: patch.featured ?? !!existing.featured },
  });
  return { ok: true };
}

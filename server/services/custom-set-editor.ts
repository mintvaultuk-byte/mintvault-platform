import { sql } from "drizzle-orm";
import { db } from "../db";

export interface CustomSetRecord {
  setId: string;
  setName: string;
  series: string | null;
  releaseYear: number | null;
  totalCards: number | null;
}

export interface CustomSetEditInput {
  setId?: unknown;
  setName?: unknown;
  series?: unknown;
  releaseYear?: unknown;
  releaseDate?: unknown;
  totalCards?: unknown;
}

export interface CustomSetEditActor {
  user: string;
  role: "admin" | "staff";
}

export interface CustomSetEditResult {
  ok: true;
  setId: string;
  setName: string;
  series: string | null;
  releaseYear: number | null;
  totalCards: number | null;
  certificatesUpdated: 0;
  linkedCertificates: number;
}

export class CustomSetEditError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CustomSetEditError";
    this.status = status;
  }
}

export interface CustomSetEditorStore {
  transaction<T>(fn: (store: CustomSetEditorStore) => Promise<T>): Promise<T>;
  getCustomSet(setId: string): Promise<CustomSetRecord | null>;
  findByCode(setId: string, excludeSetId: string): Promise<CustomSetRecord | null>;
  findIdentical(input: CustomSetRecord, excludeSetId: string): Promise<CustomSetRecord | null>;
  updateCustomSet(oldSetId: string, input: CustomSetRecord): Promise<void>;
  countCertificatesForSet(oldSet: CustomSetRecord): Promise<number>;
  writeAuditLog(
    oldSet: CustomSetRecord,
    nextSet: CustomSetRecord,
    actor: CustomSetEditActor,
    linkedCertificates: number
  ): Promise<void>;
}

interface CustomSetRow {
  set_id: string;
  set_name: string;
  series: string | null;
  release_date: Date | string | null;
  total_cards: number | string | null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeCustomSetCode(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

export function normalizeCustomSetName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReleaseYear(input: CustomSetEditInput): number | null {
  const direct = input.releaseYear;
  if (direct === "" || direct === null || direct === undefined) {
    const releaseDate = cleanString(input.releaseDate);
    if (!releaseDate) return null;
    const match = releaseDate.match(/\d{4}/);
    return match ? Number(match[0]) : null;
  }
  const year = Number(direct);
  if (!Number.isFinite(year) || !Number.isInteger(year))
    throw new CustomSetEditError(400, "Year must be a whole number");
  return year;
}

function parseTotalCards(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const total = Number(value);
  if (!Number.isFinite(total) || !Number.isInteger(total)) {
    throw new CustomSetEditError(400, "Card count must be a whole number");
  }
  return total;
}

export function validateCustomSetEdit(input: CustomSetEditInput): CustomSetRecord {
  const setId = normalizeCustomSetCode(input.setId);
  const setName = cleanString(input.setName);
  const series = cleanString(input.series);
  const releaseYear = parseReleaseYear(input);
  const totalCards = parseTotalCards(input.totalCards);

  if (!setId) throw new CustomSetEditError(400, "Set code is required");
  if (!setName) throw new CustomSetEditError(400, "Set name is required");
  if (setId.length > 64 || setName.length > 200) throw new CustomSetEditError(400, "Set code/name too long");
  if (releaseYear !== null && (releaseYear < 1900 || releaseYear > 2100)) {
    throw new CustomSetEditError(400, "Year must be a valid four-digit year");
  }
  if (totalCards !== null && (totalCards < 1 || totalCards > 20000)) {
    throw new CustomSetEditError(400, "Card count must be a positive number");
  }

  return { setId, setName, series, releaseYear, totalCards };
}

export async function editCustomSetDetails(
  store: CustomSetEditorStore,
  targetSetId: string,
  input: CustomSetEditInput,
  actor: CustomSetEditActor
): Promise<CustomSetEditResult> {
  const normalizedTarget = normalizeCustomSetCode(targetSetId);
  if (!normalizedTarget) throw new CustomSetEditError(400, "Set code is required");

  return store.transaction(async (txStore) => {
    const oldSet = await txStore.getCustomSet(normalizedTarget);
    if (!oldSet) throw new CustomSetEditError(404, "Custom set not found");

    const nextSet = validateCustomSetEdit(input);
    const unchanged =
      oldSet.setId === nextSet.setId &&
      oldSet.setName === nextSet.setName &&
      oldSet.series === nextSet.series &&
      oldSet.releaseYear === nextSet.releaseYear &&
      oldSet.totalCards === nextSet.totalCards;
    if (unchanged) throw new CustomSetEditError(400, "No changes to save");

    const codeCollision = await txStore.findByCode(nextSet.setId, oldSet.setId);
    if (codeCollision) throw new CustomSetEditError(409, `Set code "${nextSet.setId}" is already in use`);

    const identical = await txStore.findIdentical(nextSet, oldSet.setId);
    if (identical) {
      throw new CustomSetEditError(409, `An identical set already exists: "${identical.setName}" (${identical.setId})`);
    }

    const linkedCertificates = await txStore.countCertificatesForSet(oldSet);
    await txStore.updateCustomSet(oldSet.setId, nextSet);
    await txStore.writeAuditLog(oldSet, nextSet, actor, linkedCertificates);

    return { ok: true, ...nextSet, certificatesUpdated: 0, linkedCertificates };
  });
}

function rowToCustomSet(row: CustomSetRow): CustomSetRecord {
  const releaseYear =
    row.release_date instanceof Date
      ? row.release_date.getUTCFullYear()
      : row.release_date
        ? Number(String(row.release_date).slice(0, 4))
        : null;
  return {
    setId: String(row.set_id),
    setName: String(row.set_name),
    series: row.series ?? null,
    releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
    totalCards: row.total_cards == null ? null : Number(row.total_cards),
  };
}

type SqlExecutor = Pick<typeof db, "execute">;

export function createDbCustomSetEditorStore(executor: SqlExecutor = db): CustomSetEditorStore {
  return {
    async transaction(fn) {
      if (executor !== db) return fn(createDbCustomSetEditorStore(executor));
      return db.transaction(async (tx) => fn(createDbCustomSetEditorStore(tx)));
    },

    async getCustomSet(setId) {
      const row = (
        await executor.execute(sql`
          SELECT set_id, set_name, series, release_date, total_cards
          FROM custom_sets
          WHERE LOWER(TRIM(set_id)) = ${normalizeCustomSetCode(setId)}
          LIMIT 1
        `)
      ).rows[0] as unknown as CustomSetRow | undefined;
      return row ? rowToCustomSet(row) : null;
    },

    async findByCode(setId, excludeSetId) {
      const row = (
        await executor.execute(sql`
          SELECT set_id, set_name, series, release_date, total_cards
          FROM custom_sets
          WHERE LOWER(TRIM(set_id)) = ${normalizeCustomSetCode(setId)}
            AND LOWER(TRIM(set_id)) <> ${normalizeCustomSetCode(excludeSetId)}
          UNION ALL
          SELECT set_id, set_name, series, release_date, total_cards
          FROM tcgdex_sets
          WHERE LOWER(TRIM(set_id)) = ${normalizeCustomSetCode(setId)}
          LIMIT 1
        `)
      ).rows[0] as unknown as CustomSetRow | undefined;
      return row ? rowToCustomSet(row) : null;
    },

    async findIdentical(input, excludeSetId) {
      const row = (
        await executor.execute(sql`
          SELECT set_id, set_name, series, release_date, total_cards
          FROM custom_sets
          WHERE LOWER(TRIM(set_id)) <> ${normalizeCustomSetCode(excludeSetId)}
            AND btrim(regexp_replace(LOWER(TRIM(translate(set_name, 'éÉ', 'eE'))), '[^[:alnum:]]+', ' ', 'g')) = ${normalizeCustomSetName(input.setName)}
            AND COALESCE(LOWER(TRIM(series)), '') = COALESCE(LOWER(TRIM(${input.series})), '')
            AND COALESCE(EXTRACT(YEAR FROM release_date)::int, 0) = COALESCE(${input.releaseYear}, 0)
            AND COALESCE(total_cards, 0) = COALESCE(${input.totalCards}, 0)
          UNION ALL
          SELECT set_id, set_name, series, release_date, total_cards
          FROM tcgdex_sets
          WHERE btrim(regexp_replace(LOWER(TRIM(translate(set_name, 'éÉ', 'eE'))), '[^[:alnum:]]+', ' ', 'g')) = ${normalizeCustomSetName(input.setName)}
            AND COALESCE(LOWER(TRIM(series)), '') = COALESCE(LOWER(TRIM(${input.series})), '')
            AND COALESCE(EXTRACT(YEAR FROM release_date)::int, 0) = COALESCE(${input.releaseYear}, 0)
            AND COALESCE(total_cards, 0) = COALESCE(${input.totalCards}, 0)
          LIMIT 1
        `)
      ).rows[0] as unknown as CustomSetRow | undefined;
      return row ? rowToCustomSet(row) : null;
    },

    async updateCustomSet(oldSetId, input) {
      const releaseDate = input.releaseYear ? `${input.releaseYear}-01-01` : null;
      await executor.execute(sql`
        UPDATE custom_sets
        SET
          set_id = ${input.setId},
          set_name = ${input.setName},
          series = ${input.series},
          release_date = ${releaseDate},
          total_cards = ${input.totalCards}
        WHERE LOWER(TRIM(set_id)) = ${normalizeCustomSetCode(oldSetId)}
      `);
    },

    async countCertificatesForSet(oldSet) {
      const result = await executor.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM certificates
        WHERE LOWER(TRIM(COALESCE(set_name, ''))) = LOWER(TRIM(${oldSet.setName}))
          AND LOWER(TRIM(COALESCE(card_game, 'pokemon'))) = 'pokemon'
          AND deleted_at IS NULL
      `);
      return Number((result.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    },

    async writeAuditLog(oldSet, nextSet, actor, linkedCertificates) {
      await executor.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES (
          'custom_set',
          ${oldSet.setId},
          'custom_set_update',
          ${actor.user},
          ${{
            old: oldSet,
            new: nextSet,
            user: actor.user,
            role: actor.role,
            timestamp: new Date().toISOString(),
            linkedCertificates,
            certificatesUpdated: 0,
            certificateSnapshotPolicy: "catalogue edit only; certificate set_name snapshots are not rewritten",
          }}::jsonb
        )
      `);
    },
  };
}

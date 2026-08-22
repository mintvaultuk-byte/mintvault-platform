/**
 * PERMANENT DELETION OF A SETUP-ONLY PARTNER — assessment, and the guarded act itself.
 *
 * ============================================================================================
 * THE PROBLEM
 * ============================================================================================
 * Every Partner on staging was undeletable, including genuinely empty ones, because creating a shop
 * necessarily writes rows into tables whose tenant foreign key is ON DELETE RESTRICT. That is the
 * right instinct expressed the wrong way: the schema was enforcing "never destroy audit", which is
 * correct, by means of "never delete a Partner", which is not the same thing. Migration 0108 split
 * the two — retained history now SURVIVES its Partner (ON DELETE SET NULL, plus `deleted_tenant_id`
 * and a tombstone so it stays attributable), and derivative profile state follows the organisation.
 *
 * This module is the other half. 0108 made deletion POSSIBLE for a setup-only shop; nothing yet
 * decided WHICH shops those are, or performed the deletion safely.
 *
 * ============================================================================================
 * THE DESIGN, AND WHY IT IS NOT A CURATED LIST OF TABLES
 * ============================================================================================
 * A hand-written list of "things that block deletion" is wrong the day after it is written. The next
 * migration adds a table, nobody updates the list, and the assessment cheerfully reports a Partner
 * as deletable until the DELETE fails at the database — or, far worse, until the list is "fixed" by
 * relaxing a constraint so the delete succeeds and takes real history with it.
 *
 * So the dependency model is READ FROM THE DATABASE. `pg_constraint` is walked from
 * partner_organisations outwards, following exactly the rules PostgreSQL itself will follow:
 *
 *   CASCADE / SET NULL   the child is fine — it either goes with the organisation by design, or
 *                        survives it by design (0108's retained history).
 *   RESTRICT / NO ACTION the child BLOCKS, unless it is one of the few explicitly classified
 *                        setup-only records this authority deletes itself, in order, first.
 *
 * The walk is transitive, which is the part a curated list always gets wrong. `partner_locations`
 * CASCADEs from the organisation, but `partner_credit_reservations` RESTRICTs into
 * partner_locations and has NO tenant foreign key of its own — so a Partner with reservations fails
 * at the location cascade, two edges away from anything a "which tables reference the organisation?"
 * list would have looked at.
 *
 * ANYTHING UNRECOGNISED BLOCKS. A dependency that carries rows and is not explicitly classified
 * produces OPERATIONAL_HISTORY_EXISTS. A future table cannot become silently deletable by being
 * forgotten; the worst case is a refusal with a generic reason, which is the safe direction.
 *
 * ============================================================================================
 * WHAT THIS MODULE NEVER DOES
 * ============================================================================================
 *  - It never weakens a constraint to make a deletion succeed. The RESTRICT foreign keys stay
 *    exactly as they are and remain the last line; this is a line in front of them, not instead.
 *  - It never deletes retained audit or security evidence. Those rows are re-attributed and kept.
 *  - It never deletes anything belonging to another tenant: every statement is keyed on the one
 *    organisation id, and the whole act runs in a single transaction that either completes or
 *    leaves the Partner exactly as it was.
 *  - It never deletes certificates, Card Jobs, credits, orders or stations. Those BLOCK.
 */
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import { G5RequestError } from "./partner-management-errors";
import type { ActorContext } from "./partner-management-service";
import type {
  PartnerDeletionAssessment,
  PartnerDeletionBlocker,
  PartnerDeletionBlockerCode,
  PartnerDeletionResult,
} from "@shared/partner-deletion";

/** Minimal query surface, so the walk runs identically on the pool and inside the delete transaction. */
type Queryer = {
  query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
};

const poolQueryer: Queryer = {
  query: (text, values) => partnerAdminQuery(text, values as unknown[]) as never,
};

/**
 * The three tables migration 0108 re-pointed to ON DELETE SET NULL.
 *
 * Named here as well as in the catalogue walk because this module must actively STAMP them — a
 * retained row whose tenant_id has just been nulled is unattributable unless the original id was
 * copied onto it first, and an unattributable audit row is a deleted one in every sense that matters.
 */
const RETAINED_HISTORY_TABLES = [
  "partner_management_audit",
  "partner_audit_events",
  "partner_security_events",
] as const;

/**
 * SETUP-ONLY records this authority may delete itself, in this order.
 *
 * Every one of these is created by the act of SETTING UP a shop and describes nothing that happened
 * afterwards. They are deleted explicitly rather than by relaxing their foreign keys to CASCADE,
 * because RESTRICT is the correct default for them: nothing else in the system should ever be able
 * to remove a Partner's contacts or invitations as a side effect, and this deliberate, audited,
 * confirmation-gated path is the single exception.
 *
 * ORDER IS DEPENDENCY ORDER, and it is load-bearing: `partner_wallets` is last because the walk
 * treats it as part of the deletion set, which means its own children (`partner_credit_ledger`,
 * `partner_credit_reservations`, `partner_credit_reservation_events`) are then assessed as blockers.
 * A wallet with so much as one ledger row therefore refuses the whole deletion. That is how "an
 * empty wallet is setup state, a used wallet is financial history" is enforced — as a consequence of
 * the real foreign keys, not as a special case somebody has to remember.
 *
 * NOT HERE, DELIBERATELY: partner_internal_notes. MintVault staff commentary about a Partner is a
 * record of our own decisions, not the shop's setup, so it blocks. A shop set up through the wizard
 * has none, so this costs nothing in the case that matters.
 */
const SETUP_ONLY_TABLES = ["partner_invitations", "partner_branding", "partner_contacts", "partner_wallets"] as const;

/** Human labels for the confirmation screen. Never table names in front of an operator. */
const REMOVES_LABELS = [
  "the shop record and its profile",
  "its locations, staff accounts, sessions and two-step sign-in enrolments",
  "its outstanding invitations, contacts and branding",
  "its empty credit wallet",
];
const RETAINS_LABELS = [
  "every management-audit row about this shop",
  "every partner audit event",
  "every partner security event",
  "an identity tombstone recording what was deleted, by whom, when and why",
];

/**
 * Dependency → blocker classification.
 *
 * The KEY is a table name from the live catalogue; the value is what its rows mean to the business.
 * Deliberately expressed as meaning rather than mechanism, because the operator reading this has to
 * decide what to do about it. Anything absent from this map still blocks — see `blockerFor`.
 */
const BLOCKER_BY_TABLE: Record<string, { code: PartnerDeletionBlockerCode; message: string }> = {
  partner_credit_ledger: {
    code: "FINANCIAL_HISTORY_EXISTS",
    message: "This shop has credit history, so its financial record cannot be destroyed.",
  },
  partner_credit_reservations: {
    code: "FINANCIAL_HISTORY_EXISTS",
    message: "This shop has held Grading Credits against cards, so its financial record cannot be destroyed.",
  },
  partner_credit_reservation_events: {
    code: "FINANCIAL_HISTORY_EXISTS",
    message: "This shop has credit movement evidence, so its financial record cannot be destroyed.",
  },
  partner_submission_credit_holds: {
    code: "FINANCIAL_HISTORY_EXISTS",
    message: "This shop has credit holds against submitted cards, so its financial record cannot be destroyed.",
  },
  partner_credit_checkout_sessions: {
    code: "CHECKOUT_HISTORY_EXISTS",
    message: "This shop has been through checkout, so its payment record cannot be destroyed.",
  },
  partner_card_jobs: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has started cards for grading, so its grading record cannot be destroyed.",
  },
  partner_card_job_op_keys: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has card-start records, so its grading record cannot be destroyed.",
  },
  partner_grading_leases: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has grading sessions on record, so its grading record cannot be destroyed.",
  },
  partner_submissions: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has submitted cards, so its grading record cannot be destroyed.",
  },
  partner_submission_cards: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has cards on submissions, so its grading record cannot be destroyed.",
  },
  partner_submission_events: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has submission history, so its grading record cannot be destroyed.",
  },
  partner_submission_handoffs: {
    code: "GRADING_HISTORY_EXISTS",
    message: "This shop has handed cards over to MintVault, so its grading record cannot be destroyed.",
  },
  partner_supplies_orders: {
    code: "ORDER_HISTORY_EXISTS",
    message: "This shop has ordered supplies, so its order record cannot be destroyed.",
  },
  partner_supplies_order_items: {
    code: "ORDER_HISTORY_EXISTS",
    message: "This shop has supplies order lines, so its order record cannot be destroyed.",
  },
  partner_supplies_order_events: {
    code: "ORDER_HISTORY_EXISTS",
    message: "This shop has supplies order history, so its order record cannot be destroyed.",
  },
  partner_supplies_order_notifications: {
    code: "ORDER_HISTORY_EXISTS",
    message: "This shop has supplies notifications on record, so its order record cannot be destroyed.",
  },
  partner_stations: {
    code: "STATION_HISTORY_RETAINED",
    message: "A Scanner station is enrolled at this shop, so its station record is retained.",
  },
  partner_station_events: {
    code: "STATION_HISTORY_RETAINED",
    message: "This shop has Scanner station history, which is retained.",
  },
  partner_station_calibrations: {
    code: "STATION_HISTORY_RETAINED",
    message: "This shop has Scanner calibration history, which is retained.",
  },
  scanner_capture_sessions: {
    code: "STATION_HISTORY_RETAINED",
    message: "This shop has Scanner capture history, which is retained.",
  },
  scanner_evidence_staging: {
    code: "STATION_HISTORY_RETAINED",
    message: "This shop has captured card evidence, which is retained.",
  },
  scanner_processing_jobs: {
    code: "STATION_HISTORY_RETAINED",
    message: "This shop has Scanner processing history, which is retained.",
  },
  partner_customers: {
    code: "CUSTOMER_HISTORY_EXISTS",
    message: "This shop has customer records, so it cannot be destroyed.",
  },
  partner_connector_customer_links: {
    code: "CUSTOMER_HISTORY_EXISTS",
    message: "This shop has linked customer records, so it cannot be destroyed.",
  },
  partner_connector_records: {
    code: "CONNECTOR_HISTORY_EXISTS",
    message: "This shop has connector import history, so it cannot be destroyed.",
  },
  partner_connector_imports: {
    code: "CONNECTOR_HISTORY_EXISTS",
    message: "This shop has connector imports, so it cannot be destroyed.",
  },
  partner_connector_import_attempts: {
    code: "CONNECTOR_HISTORY_EXISTS",
    message: "This shop has connector import evidence, so it cannot be destroyed.",
  },
  partner_connector_admin_actions: {
    code: "CONNECTOR_HISTORY_EXISTS",
    message: "This shop has connector administration history, so it cannot be destroyed.",
  },
  partner_connector_validation_runs: {
    code: "CONNECTOR_HISTORY_EXISTS",
    message: "This shop has connector validation history, so it cannot be destroyed.",
  },
  partner_public_profiles: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop has a public MintVault presence, so it must be unpublished first.",
  },
  partner_location_publications: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop has published locations, so they must be unpublished first.",
  },
  partner_google_connections: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop is connected to Google Business, so that must be disconnected first.",
  },
  partner_google_credentials: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop holds Google Business credentials, so they must be removed first.",
  },
  partner_google_oauth_states: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop has a Google Business connection in progress, so it must be finished or cancelled first.",
  },
  partner_google_profile_cache: {
    code: "PUBLIC_PRESENCE_EXISTS",
    message: "This shop has Google Business profile data, so it must be disconnected first.",
  },
  partner_internal_notes: {
    code: "INTERNAL_NOTES_EXIST",
    message: "MintVault staff have written internal notes about this shop, and those are kept.",
  },
};

/**
 * The single refusal used whenever the dependency model itself could not be established.
 *
 * Every path that cannot POSITIVELY prove a Partner is setup-only ends here. There is deliberately
 * no branch anywhere in this module that treats an error, an empty result or an unreadable
 * catalogue as permission to delete.
 */
function unreadable(dependency: string): PartnerDeletionBlocker {
  return {
    code: "DEPENDENCY_GRAPH_UNREADABLE",
    message: "MintVault could not confirm what depends on this shop, so it will not delete it.",
    dependency,
  };
}

function blockerFor(table: string): PartnerDeletionBlocker {
  const known = BLOCKER_BY_TABLE[table];
  if (known) return { code: known.code, message: known.message, dependency: table };
  /*
   * FAIL CLOSED. An unclassified dependency is not evidence that deletion is safe — it is evidence
   * that nobody has decided, and the safe answer to an undecided question about permanent deletion
   * is no. The table name is included so the next engineer can classify it in one step.
   */
  return {
    code: "OPERATIONAL_HISTORY_EXISTS",
    message: "This shop has operational records that are kept, so it cannot be permanently deleted.",
    dependency: table,
  };
}

/** One foreign key, as PostgreSQL's own catalogue describes it. */
interface FkEdge {
  child: string;
  childColumns: string[];
  parent: string;
  parentColumns: string[];
  /** confdeltype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT. */
  action: string;
}

async function loadForeignKeyGraph(db: Queryer): Promise<FkEdge[]> {
  const { rows } = await db.query<{
    child: string;
    parent: string;
    child_columns: string[];
    parent_columns: string[];
    action: string;
  }>(
    `SELECT child.relname   AS child,
            parent.relname  AS parent,
            -- ::text is load-bearing. pg_attribute.attname has type "name", so these arrays would
            -- come back as name[], which node-postgres does not parse into a JS array: the driver
            -- hands the raw literal {tenant_id} straight through and every column list silently
            -- becomes a string. Casting to text[] is what makes them real arrays.
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey)  WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid  AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS child_columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS parent_columns,
            c.confdeltype   AS action
       FROM pg_constraint c
       JOIN pg_class child  ON child.oid  = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace ncl ON ncl.oid = child.relnamespace
       JOIN pg_namespace npa ON npa.oid = parent.relnamespace
      WHERE c.contype = 'f' AND ncl.nspname = 'public' AND npa.nspname = 'public'`
  );
  return rows.map((row) => ({
    child: row.child,
    parent: row.parent,
    childColumns: row.child_columns,
    parentColumns: row.parent_columns,
    action: row.action,
  }));
}

interface Candidate {
  table: string;
  /** SQL predicate over alias `blocker` that is true for rows this deletion would strand. */
  predicate: string;
}

/** Tables carrying a `tenant_id` column, so a cascade-reachable node can be scoped directly. */
async function loadTenantScopedTables(db: Queryer): Promise<Set<string>> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'`
  );
  return new Set(rows.map((row) => row.table_name));
}

/**
 * A guard, not a tuning knob.
 *
 * The real graph is a handful of edges deep. The bound exists so that a future cycle of CASCADE
 * edges cannot turn this into an unbounded walk, and exceeding it is reported as an unreadable
 * graph — a refusal — rather than being silently truncated into a false "deletable".
 */
const MAX_DEPENDENCY_DEPTH = 8;
/** Same reasoning applied to breadth: a pathological graph must refuse, not build a vast query. */
const MAX_CANDIDATES = 400;

interface WalkNode {
  table: string;
  alias: string;
  /** FROM-clause fragment that reaches this node's rows, with every alias already concrete. */
  fromSql: string;
  /** WHERE fragment constraining that fragment to THIS Partner. */
  whereSql: string;
  depth: number;
}

/**
 * Walk outwards from one organisation and return every dependency that would REFUSE the delete.
 *
 * ALIASES ARE NUMBERED, not reused. An earlier version composed nested EXISTS clauses that all used
 * the alias `parent`, so at depth two the inner query shadowed the outer one and the predicate
 * collapsed to `parent.id = parent.tenant_id` — always false, which would have reported every
 * two-cascades-away blocker as absent. The generated SQL is a flat JOIN chain with unique aliases
 * for exactly that reason.
 *
 * A cascade-reachable table that carries `tenant_id` is scoped DIRECTLY (`alias.tenant_id = $1`)
 * rather than through the chain that discovered it. That is both simpler and strictly more complete:
 * a table reachable by two different cascade paths is assessed once, over all of its rows for this
 * Partner, instead of once per path over whichever subset that path happened to reach.
 */
function collectCandidates(edges: FkEdge[], tenantScoped: Set<string>, fail: (why: string) => void): Candidate[] {
  const byParent = new Map<string, FkEdge[]>();
  for (const edge of edges) {
    const list = byParent.get(edge.parent) ?? [];
    list.push(edge);
    byParent.set(edge.parent, list);
  }

  const candidates: Candidate[] = [];
  const visited = new Set<string>(["partner_organisations"]);
  let aliasCounter = 0;
  const nextAlias = () => `d${aliasCounter++}`;

  const rootAlias = nextAlias();
  let frontier: WalkNode[] = [
    {
      table: "partner_organisations",
      alias: rootAlias,
      fromSql: `partner_organisations ${rootAlias}`,
      // `$1` is the organisation id, bound once for every generated statement.
      whereSql: `${rootAlias}.id = $1`,
      depth: 0,
    },
  ];

  while (frontier.length > 0) {
    const next: WalkNode[] = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPENDENCY_DEPTH) {
        fail("dependency depth");
        return candidates;
      }
      for (const edge of byParent.get(node.table) ?? []) {
        // SET NULL / SET DEFAULT: the child survives by design and cannot block. 0108's retained
        // history is exactly this case, which is why it needs no special mention here.
        if (edge.action === "n" || edge.action === "d") continue;
        if (edge.childColumns.length !== edge.parentColumns.length || edge.childColumns.length === 0) {
          fail(`malformed foreign key on ${edge.child}`);
          return candidates;
        }

        const partOfDeletion = edge.action === "c" || (SETUP_ONLY_TABLES as readonly string[]).includes(edge.child);

        if (partOfDeletion) {
          if (visited.has(edge.child)) continue;
          visited.add(edge.child);
          const alias = nextAlias();
          const joinOn = edge.childColumns
            .map((col, i) => `${alias}.${col} = ${node.alias}.${edge.parentColumns[i]}`)
            .join(" AND ");
          next.push(
            tenantScoped.has(edge.child)
              ? {
                  table: edge.child,
                  alias,
                  fromSql: `${edge.child} ${alias}`,
                  whereSql: `${alias}.tenant_id = $1`,
                  depth: node.depth + 1,
                }
              : {
                  table: edge.child,
                  alias,
                  fromSql: `${node.fromSql} JOIN ${edge.child} ${alias} ON ${joinOn}`,
                  whereSql: node.whereSql,
                  depth: node.depth + 1,
                }
          );
          continue;
        }

        // RESTRICT / NO ACTION on a table this authority may not delete: a blocker if it holds any
        // row that points at what is about to disappear.
        const link = edge.childColumns
          .map((col, i) => `blocker.${col} = ${node.alias}.${edge.parentColumns[i]}`)
          .join(" AND ");
        candidates.push({
          table: edge.child,
          predicate: `EXISTS (SELECT 1 FROM ${node.fromSql} WHERE ${node.whereSql} AND ${link})`,
        });
        if (candidates.length > MAX_CANDIDATES) {
          fail("dependency breadth");
          return candidates;
        }
      }
    }
    frontier = next;
  }
  return candidates;
}

/**
 * Certificates are checked SEPARATELY and deliberately.
 *
 * `certificates.origin_partner_id` carries no foreign key — it is a permanent provenance SNAPSHOT
 * (migration 0035), so the certificate deliberately outlives whatever it was minted from. That means
 * the catalogue walk above cannot see it: deleting the organisation would succeed at the database
 * and leave live certificates pointing at a shop that no longer exists.
 *
 * A certificate is MintVault's public promise about a physical card, so a shop that has ever issued
 * one is not setup-only by any definition. It blocks.
 */
async function certificateBlocker(db: Queryer, partnerId: string): Promise<PartnerDeletionBlocker | null> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM certificates WHERE origin_partner_id = $1::uuid LIMIT 1
            ) AS present
      WHERE to_regclass('public.certificates') IS NOT NULL`,
    [partnerId]
  );
  // No row at all means this database has no certificates table — a partner-only harness. That is
  // not a certificate found, and not an unreadable authority either.
  if (rows.length === 0 || !rows[0].present) return null;
  return {
    code: "CERTIFICATE_HISTORY_EXISTS",
    message: "This shop has issued MintVault certificates, so its record cannot be destroyed.",
    dependency: "certificates",
  };
}

async function loadOrganisation(db: Queryer, partnerId: string) {
  const { rows } = await db.query<{
    id: string;
    legal_name: string;
    status: string;
    public_ref: string | null;
    created_at: string;
  }>(`SELECT id, legal_name, status, public_ref, created_at FROM partner_organisations WHERE id = $1`, [partnerId]);
  if (rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Partner organisation not found.");
  return rows[0];
}

/**
 * Can this Partner be permanently deleted, and if not, exactly why not?
 *
 * Read-only and side-effect free, so the Super Admin screen can call it on every render. It is also
 * re-run INSIDE the delete transaction — the same code, against the same catalogue, under a row lock
 * — because an assessment made when the page loaded says nothing about the state at the moment
 * somebody presses the button.
 */
export async function assessPartnerDeletion(
  partnerId: string,
  db: Queryer = poolQueryer
): Promise<PartnerDeletionAssessment> {
  const org = await loadOrganisation(db, partnerId);
  const base = {
    partnerId: org.id,
    legalName: org.legal_name,
    confirmationPhrase: org.legal_name,
    removes: REMOVES_LABELS,
    retains: RETAINS_LABELS,
  };

  let edges: FkEdge[];
  try {
    edges = await loadForeignKeyGraph(db);
  } catch {
    return { ...base, canDelete: false, blockers: [unreadable("pg_constraint")] };
  }

  let tenantScoped: Set<string>;
  try {
    tenantScoped = await loadTenantScopedTables(db);
  } catch {
    return { ...base, canDelete: false, blockers: [unreadable("tenant scoping")] };
  }

  let walkFailure: string | null = null;
  const candidates = collectCandidates(edges, tenantScoped, (why) => {
    walkFailure = why;
  });
  if (walkFailure !== null) {
    return { ...base, canDelete: false, blockers: [unreadable(walkFailure)] };
  }

  const blockers: PartnerDeletionBlocker[] = [];
  try {
    /*
     * One statement for every candidate rather than one round trip each: the answer must describe a
     * single moment, and forty separate queries describe forty of them. It also keeps an admin
     * screen that polls from generating forty round trips per render.
     */
    if (candidates.length > 0) {
      const union = candidates
        .map(
          (candidate, i) =>
            `SELECT $${i + 2}::text AS dependency, EXISTS (SELECT 1 FROM ${candidate.table} blocker WHERE ${candidate.predicate}) AS present`
        )
        .join(" UNION ALL ");
      const { rows } = await db.query<{ dependency: string; present: boolean }>(union, [
        partnerId,
        ...candidates.map((candidate) => candidate.table),
      ]);
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.present || seen.has(row.dependency)) continue;
        seen.add(row.dependency);
        blockers.push(blockerFor(row.dependency));
      }
    }
    const certificates = await certificateBlocker(db, partnerId);
    if (certificates) blockers.push(certificates);
  } catch {
    return { ...base, canDelete: false, blockers: [unreadable("dependency counts")] };
  }

  /*
   * Ordered most-serious-first so the first line an operator reads is the one most likely to end the
   * conversation, and de-duplicated by CODE so a shop with four kinds of grading row says "this shop
   * has grading history" once rather than four times.
   */
  const ORDER: PartnerDeletionBlockerCode[] = [
    "CERTIFICATE_HISTORY_EXISTS",
    "FINANCIAL_HISTORY_EXISTS",
    "CHECKOUT_HISTORY_EXISTS",
    "GRADING_HISTORY_EXISTS",
    "ORDER_HISTORY_EXISTS",
    "STATION_HISTORY_RETAINED",
    "CONNECTOR_HISTORY_EXISTS",
    "CUSTOMER_HISTORY_EXISTS",
    "PUBLIC_PRESENCE_EXISTS",
    "INTERNAL_NOTES_EXIST",
    "OPERATIONAL_HISTORY_EXISTS",
    "DEPENDENCY_GRAPH_UNREADABLE",
  ];
  const byCode = new Map<PartnerDeletionBlockerCode, PartnerDeletionBlocker>();
  for (const code of ORDER) {
    const first = blockers.find((blocker) => blocker.code === code);
    if (first) byCode.set(code, first);
  }
  const ordered = [...byCode.values()];
  return { ...base, canDelete: ordered.length === 0, blockers: ordered };
}

/**
 * PERMANENTLY DELETE A SETUP-ONLY PARTNER.
 *
 * Every gate below is deliberate, and none of them is a substitute for another:
 *
 *  SUPER ADMIN + STEP-UP     enforced at the route. Destroying a shop record is at least as serious
 *                            as suspending one, which already requires it.
 *  TYPED CONFIRMATION        the Partner's exact legal name. A fixed phrase proves the operator
 *                            meant to delete something; the legal name proves they meant to delete
 *                            THIS one, which is the mistake that actually happens.
 *  WRITTEN REASON            required, recorded on the audit row AND on the tombstone, so the
 *                            reason survives the Partner it explains.
 *  RE-ASSESSMENT UNDER LOCK  the assessment shown on screen describes when the page loaded. This one
 *                            describes now, with the organisation row locked FOR UPDATE, so a card
 *                            started or a payment taken in between cannot be deleted through.
 *  ONE TRANSACTION           the stamping, the tombstone, the setup-only deletes and the
 *                            organisation itself either all happen or none of them do. There is no
 *                            state in which a Partner is half-deleted.
 *
 * REPLAY. A tombstone already present for this id means the deletion happened, so the call reports
 * completion instead of a confusing "not found" — the same answer a retried mutation gets anywhere
 * else in this service.
 */
export async function deletePartnerPermanently(
  actor: ActorContext,
  partnerId: string,
  input: { reason: string; confirmLegalName: string }
): Promise<{ result: PartnerDeletionResult; alreadyCompleted: boolean }> {
  const tombstoned = await partnerAdminQuery<{ legal_name: string; deleted_at: string }>(
    `SELECT legal_name, deleted_at FROM partner_deleted_tombstones WHERE tenant_id = $1`,
    [partnerId]
  ).catch(() => {
    throw new G5RequestError(
      "PARTNER_DELETE_UNAVAILABLE",
      "Permanent Partner deletion is not available on this deployment."
    );
  });
  if (tombstoned.rows.length > 0) {
    return {
      result: {
        partnerId,
        legalName: tombstoned.rows[0].legal_name,
        deletedAt: tombstoned.rows[0].deleted_at,
        retainedAuditRows: 0,
        retainedSecurityRows: 0,
        retainedManagementAuditRows: 0,
      },
      alreadyCompleted: true,
    };
  }

  const preview = await assessPartnerDeletion(partnerId);
  if (input.confirmLegalName.trim() !== preview.confirmationPhrase.trim()) {
    throw new G5RequestError(
      "PARTNER_DELETE_CONFIRMATION_REQUIRED",
      "Type the shop's exact legal name to confirm permanent deletion."
    );
  }

  /*
   * THE ATTEMPT ROW, written BEFORE anything is destroyed and while tenant_id can still reference a
   * live organisation. It is one of the rows the stamping pass below re-attributes, so an attempt
   * that FAILS leaves a normal audit row on a surviving Partner, and one that SUCCEEDS leaves a
   * retained, attributed row on a Partner that no longer exists. Either way the attempt is on record
   * before the act, which is the only ordering that survives a crash mid-deletion.
   */
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key,
        entity_type, entity_id, before_state, reason, result)
     VALUES ($1::uuid,'partner_permanently_deleted',$2,$3,$4,$5,'partner',$1::text,$6::jsonb,'__attempt__','attempted')`,
    [
      partnerId,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      JSON.stringify({ legalName: preview.legalName, assessedBlockers: preview.blockers.map((b) => b.code) }),
    ]
  );

  try {
    return await runGuardedDeletion(actor, partnerId, input);
  } catch (err) {
    /*
     * A terminal FAILED row, so the ledger never shows an attempt with no outcome. Written on the
     * pool rather than in the (now rolled-back) transaction, and against the STILL-LIVE organisation
     * — a refusal changes nothing, so its tenant_id is valid. Its own failure is swallowed: losing
     * the audit row must not replace the operator's real error with an audit error.
     */
    const g5 = err as { code?: string; message?: string };
    await partnerAdminQuery(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key,
          entity_type, entity_id, reason, result, error_code, error_summary)
       VALUES ($1::uuid,'partner_permanently_deleted',$2,$3,$4,$5,'partner',$1::text,$6,'failed',$7,$8)`,
      [
        partnerId,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        input.reason,
        g5.code ?? "INTERNAL_ERROR",
        g5.message ?? "Permanent deletion failed.",
      ]
    ).catch(() => {});
    throw err;
  }
}

/** The transactional half of `deletePartnerPermanently`. Never called directly — see its guards. */
async function runGuardedDeletion(
  actor: ActorContext,
  partnerId: string,
  input: { reason: string; confirmLegalName: string }
): Promise<{ result: PartnerDeletionResult; alreadyCompleted: boolean }> {
  return withPartnerAdminTransaction(async (client) => {
    // The row lock is what makes the re-assessment below meaningful: it holds the organisation still
    // while its dependencies are counted, so nothing can be attached to a Partner mid-deletion.
    const locked = await client.query<{
      id: string;
      legal_name: string;
      status: string;
      public_ref: string | null;
      created_at: string;
    }>(`SELECT id, legal_name, status, public_ref, created_at FROM partner_organisations WHERE id = $1 FOR UPDATE`, [
      partnerId,
    ]);
    if (locked.rowCount === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Partner organisation not found.");
    const org = locked.rows[0];

    const assessment = await assessPartnerDeletion(partnerId, client as unknown as Queryer);
    if (!assessment.canDelete) {
      throw new G5RequestError(
        "PARTNER_DELETE_BLOCKED",
        assessment.blockers[0]?.message ?? "This shop has records that are kept, so it cannot be permanently deleted."
      );
    }

    /*
     * The security event is written BEFORE the organisation goes, while tenant_id can still be set.
     * It is then re-attributed by the same stamping pass as everything else, so the record of the
     * deletion is itself one of the retained rows the deletion produces.
     */
    await client.query(
      `INSERT INTO partner_security_events (tenant_id, severity, kind, detail)
       VALUES ($1, 'high', 'partner_permanently_deleted', $2::jsonb)`,
      [
        partnerId,
        JSON.stringify({
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          requestId: actor.requestId,
          legalName: org.legal_name,
          reason: input.reason,
        }),
      ]
    );

    /*
     * ATTRIBUTION BEFORE DESTRUCTION. `deleted_tenant_id` is stamped while tenant_id is still
     * readable; a moment later the foreign key nulls tenant_id and this copy is the only thing
     * connecting the retained row to the shop it describes. Doing it in the other order would leave
     * every retained row anonymous, which is retention in name only.
     */
    const retained: Record<string, number> = {};
    for (const table of RETAINED_HISTORY_TABLES) {
      const stamped = await client.query(
        `UPDATE ${table} SET deleted_tenant_id = tenant_id WHERE tenant_id = $1 AND deleted_tenant_id IS NULL`,
        [partnerId]
      );
      retained[table] = stamped.rowCount ?? 0;
    }

    const tombstone = await client.query<{ deleted_at: string }>(
      `INSERT INTO partner_deleted_tombstones
         (tenant_id, legal_name, public_ref, organisation_status, organisation_created_at,
          deleted_by_user_id, deleted_by_email, deletion_reason, environment, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING deleted_at`,
      [
        org.id,
        org.legal_name,
        org.public_ref,
        org.status,
        org.created_at,
        actor.actorUserId,
        actor.actorEmail,
        input.reason,
        process.env.FLY_APP_NAME ?? process.env.NODE_ENV ?? null,
        JSON.stringify({ requestId: actor.requestId, retained, assessedAt: new Date().toISOString() }),
      ]
    );

    /*
     * The setup-only records, in dependency order. Every statement is keyed on this one tenant, so
     * there is no shape of input that reaches another shop's rows — and the assessment above has
     * already proven that nothing operational hangs off any of them.
     */
    for (const table of SETUP_ONLY_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [partnerId]);
    }

    const deleted = await client.query(`DELETE FROM partner_organisations WHERE id = $1`, [partnerId]);
    if (deleted.rowCount !== 1) {
      // Unreachable while the row lock is held; if it ever happens, aborting is the only safe answer.
      throw new G5RequestError(
        "PARTNER_DELETE_BLOCKED",
        "The shop record could not be removed, so nothing was deleted."
      );
    }

    /*
     * THE TERMINAL AUDIT ROW, written INSIDE the transaction and after the organisation is gone.
     *
     * `tenant_id` is NULL and `deleted_tenant_id` carries the id, because the foreign key it would
     * otherwise use now points at nothing — that is precisely 0108's retention model, applied to the
     * record of the deletion itself. Writing it here rather than after the commit means there is no
     * window in which a Partner has been destroyed with no completed audit row explaining why.
     */
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, deleted_tenant_id, action_type, actor_user_id, actor_email, request_id,
          idempotency_key, entity_type, entity_id, after_state, reason, result)
       VALUES (NULL,$1::uuid,'partner_permanently_deleted',$2,$3,$4,$5,'partner',$1::text,$6::jsonb,$7,'succeeded')`,
      [
        partnerId,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        JSON.stringify({ legalName: org.legal_name, status: org.status, retained }),
        input.reason,
      ]
    );

    return {
      result: {
        partnerId: org.id,
        legalName: org.legal_name,
        deletedAt: tombstone.rows[0].deleted_at,
        retainedAuditRows: retained.partner_audit_events ?? 0,
        retainedSecurityRows: retained.partner_security_events ?? 0,
        retainedManagementAuditRows: retained.partner_management_audit ?? 0,
      },
      alreadyCompleted: false,
    };
  });
}

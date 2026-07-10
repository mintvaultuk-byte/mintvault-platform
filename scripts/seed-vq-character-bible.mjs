#!/usr/bin/env node
/**
 * Seed first-pass Vault Quest Character Bible DNA.
 *
 * Local/staging only. Refuses production. Dry-run by default:
 *   node scripts/seed-vq-character-bible.mjs
 *   node scripts/seed-vq-character-bible.mjs --commit
 *
 * VQ-only writes:
 * - vq_characters
 * - vq_character_revisions
 */
import fs from "node:fs";
import pg from "pg";

function loadEnvFile(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const COMMIT = process.argv.includes("--commit");
const FORCE = process.argv.includes("--force");
// Seeds the DEDICATED Vault Quest database only. Reads VAULT_QUEST_DATABASE_URL;
// never MINTVAULT_DATABASE_URL (no fallback to the grading database).
const DATABASE_URL = process.env.VAULT_QUEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error("VAULT_QUEST_DATABASE_URL is not set");

const parsed = new URL(DATABASE_URL);
const DB_HOST = parsed.hostname;
const DB_NAME = parsed.pathname.replace(/^\//, "");
// Belt-and-suspenders: refuse the grading production host in case the URL is
// ever mis-set. Add the Vault Quest prod host here once vaultquest-prod exists.
if (DB_HOST.includes("ep-wispy-morning") && process.env.ALLOW_PROD !== "1") {
  throw new Error("[vq-bible-seed] Refusing grading production DB host ep-wispy-morning — this seed targets the dedicated Vault Quest database only.");
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 30000,
});

const UNIVERSAL_NEGATIVE =
  "No card frame, no trading card layout, no text, no logo, no watermark, no signature, no UI, no border, no cropped limbs, no extra limbs, no duplicate body parts, no deformed anatomy, no scary horror, no weapons unless explicitly part of the character, no realistic violence, no photorealistic animal, no copyrighted characters, no franchise resemblance.";

const FAMILIES = [
  ["GNV-F01", "Flammi", "Blaze", ["Flammi", "Flammro", "Flamora"], "warm ember creature with friendly fire-sprite energy and glowing ember cheeks", "warm ember orange, soft red, golden yellow highlights, charcoal-dark tiny accents", "glowing ember cheek spots, small flame-shaped chest mark, soft heat shimmer accents", "large warm amber eyes with bright golden catchlights", "flame tuft, ember cheek glow, soft fire-tail that reads as magical energy", "friendly, brave, loyal, energetic, protective without being fierce", "Blaze identity comes from warm ember glow, controlled flame shapes, gentle heat shimmer and heroic firelight.", ["cute ember cub", "stronger flame runner", "elegant heroic flame guardian"], ["small rounded cub-like body with stubby legs and oversized head", "lean runner body with stronger legs and a longer flame tail", "tall elegant guardian body with proud posture, flowing flame mane and balanced heroic proportions"], ["round, simple, child-friendly ember-cub silhouette", "recognisable same cub evolved into a nimble runner silhouette", "same face and markings evolved into a graceful guardian silhouette"], ["standing with a small happy bounce", "mid-stride with controlled flame trails", "heroic three-quarter pose with calm flowing flame aura"]],
  ["GNV-F02", "Aquabub", "Tide", ["Aquabub", "Aquanix", "Aquadon"], "soft water bubble creature with rounded shapes, bubble fins and playful watery charm", "clear aqua, ocean blue, pale turquoise, pearly white bubble highlights", "round bubble spots, rippling cheek marks, translucent fin edges", "big bright blue eyes with glossy bubble-like reflections", "bubble fins, water-drop tail, small floating bubbles around the body", "playful, gentle, curious, cheerful, loves motion and splashing", "Tide identity comes from bubble forms, flowing fins, water-drop shapes and clean rolling wave motion.", ["tiny bubble pet", "agile water swimmer", "powerful graceful tide beast"], ["tiny rounded pet body with soft bubble fins and stubby feet", "sleeker swimmer body with longer fins and a stronger tail", "large graceful tide-beast body with flowing fins, broad chest and calm power"], ["round bubble-pet silhouette", "same bubble face stretched into an agile swimmer", "same bubble markings carried into a premium tide guardian silhouette"], ["floating happily above a small splash", "curving through water with bubble trails", "rising in a graceful wave arc with calm authority"]],
  ["GNV-F03", "Leafee", "Blossom", ["Leafee", "Leafflora", "Floraven"], "gentle plant creature with green leaf ears, soft floral markings and forest-companion warmth", "fresh leaf green, soft moss, pale cream, pink blossom accents", "leaf-vein cheek lines, petal spots, gentle floral chest marking", "soft green eyes with calm friendly highlights", "leaf ears, tiny blossom buds, vine-like tail with petal tip", "gentle, nurturing, curious, calm, protective of small creatures", "Blossom identity comes from leaves, petals, vine movement, floral accents and a healthy forest glow.", ["tiny leaf companion", "blooming woodland creature", "majestic floral forest guardian"], ["small rounded companion body with oversized leaf ears", "medium woodland body with blooming petals and stronger legs", "majestic guardian body with layered leaf mantle, floral crown and confident stance"], ["simple sprout-like leaf companion", "same leaf ears and face evolved into a blooming woodland silhouette", "same markings expanded into a premium forest guardian silhouette"], ["sitting in a soft patch of leaves", "stepping through petals with a gentle breeze", "standing beneath drifting blossoms with a protective forest aura"]],
  ["GNV-F04", "Zappi", "Spark", ["Zappi", "Zapstorm", "Zaptor"], "bright electric spark creature with golden energy, lightning tuft and fast playful confidence", "bright yellow, warm gold, white electric highlights, small orange spark accents", "zigzag lightning cheek stripes, small bolt chest mark, spark freckles", "wide golden eyes with lively white spark reflections", "lightning tuft, charged tail tip, tiny sparks around paws", "fast, playful, bold, excitable, optimistic and loyal", "Spark identity comes from little lightning arcs, gold glow, quick motion lines and playful electric crackle.", ["tiny spark pup", "speedy storm creature", "powerful lightning champion"], ["small pup-like body with a round head and tiny lightning tuft", "sleek speedster body with longer legs and sharper bolt shapes", "heroic champion body with strong shoulders, bright lightning mane and athletic posture"], ["tiny spark-pup silhouette", "same tuft and markings stretched into a swift storm silhouette", "same face and bolt language evolved into a powerful lightning champion"], ["hopping with a tiny spark pop", "dashing with safe electric trails", "landing heroically with controlled lightning effects"]],
  ["GNV-F05", "Rocko", "Earth", ["Rocko", "Rockron", "Rockazaur"], "sturdy rock creature with rounded stone plates and loyal grounded warmth", "soft stone grey, warm earthy brown, sandstone beige, mossy green accents", "rounded stone plate seams, pebble cheek dots, small carved chest mark", "kind dark brown eyes with warm amber highlights", "rounded stone plates, pebble tail, moss patches on shoulders", "steady, loyal, patient, dependable, brave when friends need help", "Earth identity comes from rounded stone plates, dusty ground, moss accents and heavy stable poses.", ["small pebble buddy", "armoured rock creature", "large heroic stone guardian"], ["small pebble-shaped buddy with stubby limbs and soft plate bumps", "stockier armoured body with larger stone shoulder plates", "large guardian body with strong stone armour, broad stance and kind expression"], ["round pebble-buddy silhouette", "same pebble face evolved into an armoured rock silhouette", "same plate pattern expanded into a heroic stone guardian silhouette"], ["sitting solidly with tiny dust puffs", "bracing confidently with stone plates catching light", "standing like a protector with earth glow at the feet"]],
  ["GNV-F06", "Galaxi", "Cosmos", ["Galaxi", "Galaxior", "Galaxora"], "friendly cosmic creature with deep purple-blue body, star markings and dreamy mystery", "deep violet, midnight blue, soft indigo, silver star glow, pink nebula accents", "small star freckles, crescent chest mark, nebula swirl patches", "glowing cosmic eyes with tiny star-like pupils", "star-tipped ears or horns, floating tiny star motes, comet-like tail", "mysterious, wise, gentle, curious, quietly playful", "Cosmos identity comes from star motes, nebula gradients, crescent shapes and soft outer-space glow.", ["small star creature", "nebula traveller", "cosmic guardian"], ["small rounded star creature with tiny star-tipped ears", "slender traveller body with longer tail and nebula mantle", "regal cosmic guardian body with flowing starry mane and calm balanced power"], ["tiny star-companion silhouette", "same star ears and eyes evolved into a travelling nebula silhouette", "same cosmic marks expanded into a premium cosmic guardian silhouette"], ["floating gently with tiny stars", "gliding through soft nebula mist", "hovering in a heroic cosmic pose with controlled galaxy light"]],
  ["GNV-F07", "Windo", "Wind", ["Windo", "Windash", "Windarius"], "light air creature with pale teal-white flowing shapes, feather-cloud features and agile breeze energy", "pale teal, cloud white, sky blue, soft silver highlights", "curved wind swirl cheek marks, feather-like flank lines, soft cloud chest patch", "clear sky-blue eyes with bright airy highlights", "feather ear tufts, cloudlike tail, ribbon-like wind wisps", "free, agile, playful, light-hearted, brave in motion", "Wind identity comes from flowing feathers, curved gust lines, cloud shapes and light lifted poses.", ["small breeze companion", "swift gust creature", "elegant storm-wind guardian"], ["small light companion body with rounded cloud tail and tiny feather tufts", "sleeker gust body with longer legs, larger feathers and flowing wisps", "elegant guardian body with winglike feather mantle and tall graceful stance"], ["soft breeze-companion silhouette", "same feather tufts stretched into a swift gust silhouette", "same wind marks evolved into a storm-wind guardian silhouette"], ["floating just above the ground in a soft breeze", "leaping forward with curved gust trails", "posing in a spiral of clean wind and cloud wisps"]],
  ["GNV-F08", "Voltex", "Electric", ["Voltex", "Voltrex", "Voltorix"], "blue-yellow voltage creature with charged markings, sharp friendly silhouette and heroic energy", "electric blue, bright yellow, cool navy shadows, white voltage highlights", "circuit-like cheek lines, bolt shoulder marks, charged stripe patterns", "focused cyan eyes with bright yellow spark reflections", "charged crest, voltage tail, small harmless electric arcs around the body", "confident, energetic, focused, brave, protective and upbeat", "Electric identity comes from blue-yellow voltage arcs, circuit markings, bright highlights and charged movement.", ["small electric sprite", "charged beast", "high-voltage heroic creature"], ["small sprite body with rounded head and little charged crest", "stronger beast body with sharper crest, longer tail and athletic legs", "high-voltage heroic body with powerful chest, flowing energy crest and controlled arcs"], ["small electric-sprite silhouette", "same crest and circuit marks evolved into a charged beast", "same markings expanded into a high-voltage heroic silhouette"], ["hovering with tiny blue sparks", "charging forward with controlled voltage trails", "standing heroically with arcs contained around the body"]],
  ["GNV-F09", "Crystab", "Ice", ["Crystab", "Crystane", "Crystalux"], "sparkling ice-crystal creature with pale blue-white body, crystal shards and calm kindness", "pale ice blue, snow white, translucent cyan, silver sparkle highlights", "faceted crystal cheek marks, snowflake chest marking, frosted shard patterns", "calm light-blue eyes with crystalline white highlights", "small crystal horns or shards, frosted tail, snow sparkle motes", "calm, thoughtful, resilient, gentle, quietly brave", "Ice identity comes from faceted crystal shapes, frost sparkle, snowflake markings and cool soft light.", ["small frost crystal pet", "icy crystal creature", "majestic frozen crystal guardian"], ["small frost pet body with rounded crystal nubs and soft paws", "medium icy body with longer crystal shards and graceful limbs", "majestic guardian body with crown-like crystal horns, broad icy mantle and serene posture"], ["small frost-crystal pet silhouette", "same crystal nubs evolved into an icy creature silhouette", "same face and facets expanded into a frozen crystal guardian"], ["standing on a little patch of frost sparkle", "moving through drifting snow with crystal light", "holding a calm heroic pose amid safe icy shimmer"]],
  ["GNV-F10", "Shadowix", "Dark", ["Shadowix", "Shadownyx", "Shadowraik"], "mischievous shadow creature with deep violet-black body, moon markings and non-scary night charm", "deep violet, soft black, midnight blue, lavender rim light, tiny silver moon accents", "crescent moon cheek mark, soft shadow stripes, small star-like speckles", "large violet eyes with gentle silver highlights", "soft shadow tail, moon-shaped ear tip, wispy harmless night aura", "mischievous, loyal, clever, playful, calm and not scary", "Dark identity comes from moon marks, soft shadow wisps, violet night glow and gentle mystery.", ["cute shadow cub", "sly night creature", "elegant shadow guardian"], ["cute compact cub body with rounded ears and soft shadow tail", "longer sly night body with flowing tail and sharper but friendly features", "elegant guardian body with moonlit mantle, tall silhouette and calm protective stance"], ["cute shadow-cub silhouette", "same moon marks evolved into a sly night silhouette", "same cub identity refined into an elegant shadow guardian"], ["peeking from a soft moonlit shadow", "stepping lightly with playful shadow wisps", "standing in calm moonlight with a protective night aura"]],
  ["GNV-F11", "Rooty", "Earth", ["Rooty", "Rootor", "Rooterra"], "root-and-tree creature with brown-green sprout body, leaf growth and earthy nature warmth", "warm root brown, leaf green, bark tan, moss green highlights", "bark grain cheek lines, leaf chest sprout, root-ring patterns", "soft hazel-green eyes with warm woodland highlights", "sprout leaves, root tail, small twig horns that remain friendly and rounded", "nurturing, steady, wise for its age, patient, protective", "Earth identity comes from roots, bark grain, sprouting leaves, moss and grounded forest strength.", ["tiny root sprout", "strong root creature", "ancient tree-root guardian"], ["tiny sprout body with little root feet and a leaf on top", "stronger root creature with bark-like torso and longer vine limbs", "ancient guardian body with tree-root armour, leafy crown and broad rooted stance"], ["tiny root-sprout silhouette", "same sprout and eyes evolved into a strong root silhouette", "same bark marks expanded into an ancient tree-root guardian"], ["standing happily with tiny root feet in soil", "bracing with growing vines and leaves", "rising from roots in a majestic forest guardian pose"]],
  ["GNV-F12", "Aquori", "Water", ["Aquori", "Aquorush", "Aquorion"], "clear elegant water creature with flowing stream body, blue-silver sheen and calm river personality", "clear blue, river teal, silver highlights, soft white foam accents", "streamline cheek marks, flowing wave chest mark, silver ripple patterns", "calm blue-silver eyes with reflective water highlights", "stream-like tail, flowing fin ribbons, small water droplets along the silhouette", "calm, adaptable, graceful, thoughtful, quietly protective", "Water identity comes from flowing stream shapes, silver ripples, clean droplets and graceful river motion.", ["small stream creature", "flowing river creature", "graceful water guardian"], ["small stream creature body with rounded fins and a little flowing tail", "longer river body with ribbon fins and stronger flowing tail", "graceful guardian body with elegant water mane, broad fins and serene heroic posture"], ["small stream-companion silhouette", "same water tail and face evolved into a river creature silhouette", "same ripple marks expanded into a graceful water guardian"], ["floating above a small stream ripple", "curving through a river-like flow", "standing in a graceful arc of clean water with calm authority"]],
];

const FIELDS = [
  "character_dna",
  "visual_description",
  "body_shape",
  "colours",
  "markings",
  "eyes",
  "tail_accessories",
  "personality",
  "stage_progression_notes",
  "element_identity",
  "negative_prompt",
  "master_artwork_prompt",
];

function seedFor(spec, stageNumber) {
  const idx = stageNumber - 1;
  const [familyId, familyName, element, names, concept, colours, markings, eyes, accessories, personality, elementIdentity, roles, bodies, silhouettes, motions] = spec;
  const name = names[idx];
  const previous = idx > 0 ? names[idx - 1] : null;
  const next = idx < 2 ? names[idx + 1] : null;
  const continuity = previous
    ? `${name} must clearly evolve from ${previous}: keep the same eye shape, family markings, core colours and signature accessories while increasing scale and confidence.`
    : `${name} establishes the family identity that later stages must preserve: eye shape, markings, colour palette and signature accessories.`;
  const nextLine = next ? ` Leave clear visual room for ${next} to evolve from this design.` : " This is the final heroic form, premium and complete while still recognisably the same family.";
  return {
    character_dna: `${name} is the Stage ${stageNumber} ${element} member of the ${familyName} family: a ${roles[idx]} built around ${concept}. Permanent DNA: ${colours}; ${markings}; ${eyes}; ${accessories}. ${continuity} No variants may alter the creature body, species, markings, colours, eyes or signature accessories.`,
    visual_description: `${name} appears as a ${roles[idx]} with ${bodies[idx]}. It keeps ${markings}, ${eyes}, and ${accessories}. The design is original, child-friendly, expressive and readable at small card-art size.`,
    body_shape: `${bodies[idx]}. The silhouette should read as ${silhouettes[idx]}.`,
    colours,
    markings,
    eyes,
    tail_accessories: accessories,
    personality,
    stage_progression_notes: `${continuity}${nextLine}`,
    element_identity: elementIdentity,
    negative_prompt: UNIVERSAL_NEGATIVE,
    master_artwork_prompt: `Standalone original character artwork of ${name}, the ${roles[idx]} from Vault Quest. Show ${bodies[idx]}, ${colours}, ${markings}, ${eyes}, and ${accessories}. ${motions[idx]}. Clean character-focused composition, premium toy-like fantasy creature illustration, soft cinematic lighting, polished game-art finish, full body visible, suitable for placing into a fixed card art window. Do not include a card frame, border, text, logo, watermark, UI, set symbol, stats, or trading card layout.`,
    _familyId: familyId,
  };
}

function isEmpty(value) {
  return value == null || String(value).trim() === "";
}

async function ensureCharacterRows(client) {
  const canonical = FAMILIES.map((f) => f[0]);
  const result = await client.query(
    `
      INSERT INTO vq_characters (
        character_id, set_code, family_id, family_name, card_id, stage_number,
        character_name, element, role, variant_card_ids, evolves_from_character_id,
        source_notes, personality, approval_status, locked
      )
      SELECT
        c.family_id || '-S' || c.stage_number,
        c.set_code,
        c.family_id,
        f.name,
        c.card_id,
        c.stage_number,
        c.name,
        c.element,
        c.life_stage,
        COALESCE((
          SELECT jsonb_agg(v.card_id ORDER BY v.card_id)
          FROM vq_cards v
          WHERE v.base_card_id = c.card_id
        ), '[]'::jsonb),
        CASE WHEN c.stage_number > 1 THEN c.family_id || '-S' || (c.stage_number - 1) ELSE NULL END,
        'Seeded from canonical Vault Quest family direction.',
        NULL,
        'draft',
        false
      FROM vq_cards c
      LEFT JOIN vq_families f ON f.family_id = c.family_id
      WHERE c.set_code = 'GNV'
        AND c.card_type = 'Creature'
        AND c.base_card_id IS NULL
        AND c.family_id = ANY($1)
        AND c.stage_number IN (1, 2, 3)
      ON CONFLICT DO NOTHING
    `,
    [canonical],
  );
  return result.rowCount ?? 0;
}

async function main() {
  console.log(`[vq-bible-seed] DB_HOST=${DB_HOST} DB_NAME=${DB_NAME}`);
  console.log(`[vq-bible-seed] mode=${COMMIT ? "commit" : "dry-run"} force=${FORCE ? "yes" : "no"}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await ensureCharacterRows(client);
    console.log(`[vq-bible-seed] ensured character rows: created=${created}`);

    const canonicalIds = FAMILIES.map((f) => f[0]);
    const { rows } = await client.query(
      `SELECT * FROM vq_characters WHERE set_code = 'GNV' ORDER BY family_id, stage_number`,
    );
    const byKey = new Map(rows.map((row) => [`${row.family_id}:${row.stage_number}`, row]));
    let wouldUpdate = 0;
    let updated = 0;
    const missing = [];
    const skipped = [];

    for (const spec of FAMILIES) {
      for (let stage = 1; stage <= 3; stage++) {
        const row = byKey.get(`${spec[0]}:${stage}`);
        if (!row) {
          missing.push(`${spec[0]}:S${stage}`);
          continue;
        }
        const seed = seedFor(spec, stage);
        const patch = {};
        for (const field of FIELDS) {
          if (FORCE || isEmpty(row[field])) patch[field] = seed[field];
        }
        if (FORCE || row.approval_status !== "draft") patch.approval_status = "draft";
        if (FORCE || row.locked !== false) patch.locked = false;
        const keys = Object.keys(patch);
        if (keys.length === 0) {
          skipped.push(row.character_id);
          continue;
        }
        wouldUpdate++;
        console.log(`[vq-bible-seed] ${COMMIT ? "update" : "would update"} ${row.character_id} ${row.card_id} ${row.character_name}: ${keys.join(", ")}`);
        if (COMMIT) {
          await client.query(
            `INSERT INTO vq_character_revisions (character_id, revision_json, edited_by, reason)
             VALUES ($1, $2::jsonb, $3, $4)`,
            [row.character_id, JSON.stringify(row), "local-vq-bible-seed", FORCE ? "force seed Character Bible DNA" : "seed empty Character Bible DNA"],
          );
          const setSql = keys.map((key, idx) => `${key} = $${idx + 2}`).join(", ");
          await client.query(
            `UPDATE vq_characters SET ${setSql}, updated_at = NOW() WHERE character_id = $1`,
            [row.character_id, ...keys.map((key) => patch[key])],
          );
          updated++;
        }
      }
    }

    if (COMMIT) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const after = await pool.query(
      `SELECT character_id, family_id, stage_number, approval_status, locked, ${FIELDS.join(", ")}
       FROM vq_characters
       WHERE set_code = 'GNV'
       ORDER BY family_id, stage_number`,
    );
    const canonical = after.rows.filter((row) => canonicalIds.includes(row.family_id));
    const complete = canonical.filter((row) => FIELDS.every((field) => !isEmpty(row[field])) && row.approval_status === "draft" && row.locked === false);
    const excluded = after.rows.filter((row) => row.family_id === "GNV-F13" || row.family_id === "GNV-F14").map((row) => row.character_id);

    console.log(`[vq-bible-seed] wouldUpdate=${wouldUpdate} updated=${updated} skipped=${skipped.length} missingRows=${missing.length}`);
    console.log(`[vq-bible-seed] canonicalComplete=${complete.length}/${canonical.length}`);
    console.log(`[vq-bible-seed] excludedPresent=${excluded.length ? excluded.join(", ") : "none"}`);
    if (missing.length) console.log(`[vq-bible-seed] missingRows=${missing.join(", ")}`);
    if (!COMMIT) console.log("[vq-bible-seed] dry-run only. Re-run with --commit to write.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

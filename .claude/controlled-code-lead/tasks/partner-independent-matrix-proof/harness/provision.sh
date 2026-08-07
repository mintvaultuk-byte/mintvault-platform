#!/usr/bin/env bash
# Provision one INDEPENDENT matrix environment (A or B) from nothing.
#
# Fresh containers, fresh anonymous volumes, fresh admin login role, fresh database names, fresh
# MinIO server. Nothing is reused from a previous run: the teardown script removes the containers
# AND their volumes, and this script refuses to start if a container of the same name still exists.
#
# Loopback-only, synthetic credentials, disposable by construction. Never point it anywhere real.
set -euo pipefail

LABEL="${1:?usage: provision.sh <A|B>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd)"
EVID="$HERE/../evidence"
mkdir -p "$EVID"

cd "$REPO"

read -r PG16_PORT PG17_PORT MINIO_PORT ADMIN_ROLE ADMIN_PW DB_PREFIX CPREFIX MINIO_USER MINIO_PW <<EOF
$(node -e "
import('$HERE/matrix-config.mjs').then(({matrixFor,assertDisposableCoordinates})=>{
  const m=matrixFor('$LABEL'); assertDisposableCoordinates(m);
  console.log([m.pg16Port,m.pg17Port,m.minioPort,m.adminRole,m.adminPassword,m.dbPrefix,m.containerPrefix,m.minioRootUser,m.minioRootPassword].join(' '));
});")
EOF

PG16="${CPREFIX}-pg16"; PG17="${CPREFIX}-pg17"; MINIO="${CPREFIX}-minio"
PG16_IMAGE="pgvector/pgvector:pg16"; PG17_IMAGE="postgres:17.10"; MINIO_IMAGE="quay.io/minio/minio:latest"

echo "=== [$LABEL] PRE-FLIGHT: no leftover state may exist ==="
for c in "$PG16" "$PG17" "$MINIO"; do
  if docker ps -aq --filter "name=^${c}$" | grep -q .; then
    echo "REFUSED: container $c already exists — run teardown.sh $LABEL first" >&2; exit 1
  fi
done
# Any other harness container from the OTHER matrix must also be gone: the whole point is that A
# and B never coexist, so a stale sibling would mean B could observe A's cluster.
if docker ps -aq --filter "name=^mvmx-" | grep -q .; then
  echo "REFUSED: other mvmx-* harness containers are still running:" >&2
  docker ps -a --filter "name=^mvmx-" --format '  {{.Names}} ({{.Status}})' >&2
  exit 1
fi
for p in "$PG16_PORT" "$PG17_PORT" "$MINIO_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "REFUSED: port $p is already in use" >&2; lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2; exit 1
  fi
done
echo "clean: no mvmx-* containers, ports $PG16_PORT/$PG17_PORT/$MINIO_PORT free"

echo
echo "=== [$LABEL] START CLUSTERS (fresh anonymous volumes) ==="
docker run -d --name "$PG16" \
  -e POSTGRES_DB=mintvault_vq_phase10_local \
  -e POSTGRES_USER="$ADMIN_ROLE" -e POSTGRES_PASSWORD="$ADMIN_PW" \
  -p "127.0.0.1:${PG16_PORT}:5432" "$PG16_IMAGE" >/dev/null
docker run -d --name "$PG17" \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER="$ADMIN_ROLE" -e POSTGRES_PASSWORD="$ADMIN_PW" \
  -p "127.0.0.1:${PG17_PORT}:5432" "$PG17_IMAGE" >/dev/null
docker run -d --name "$MINIO" \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -p "127.0.0.1:${MINIO_PORT}:9000" "$MINIO_IMAGE" server /data >/dev/null

export PGPASSWORD="$ADMIN_PW"
wait_pg() {
  local port="$1" name="$2"
  for _ in $(seq 1 90); do
    if psql "postgres://${ADMIN_ROLE}@127.0.0.1:${port}/postgres" -tAc "select 1" >/dev/null 2>&1; then
      echo "  $name ready on :$port"; return 0
    fi
    sleep 1
  done
  echo "REFUSED: $name never accepted connections on :$port" >&2; docker logs --tail 40 "$name" >&2; exit 1
}
psql_pg16() { psql "postgres://${ADMIN_ROLE}@127.0.0.1:${PG16_PORT}/${1}" -v ON_ERROR_STOP=1 "${@:2}"; }
psql_pg17() { psql "postgres://${ADMIN_ROLE}@127.0.0.1:${PG17_PORT}/${1}" -v ON_ERROR_STOP=1 "${@:2}"; }

wait_pg "$PG16_PORT" "$PG16"
wait_pg "$PG17_PORT" "$PG17"
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1 && { echo "  $MINIO ready on :$MINIO_PORT"; break; }
  sleep 1
done
curl -fsS "http://127.0.0.1:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1 || { echo "REFUSED: MinIO unhealthy" >&2; exit 1; }

echo
echo "=== [$LABEL] RUNTIME IDENTITY (recorded, not assumed) ==="
IDENT_JSON="$EVID/environment-${LABEL}.json"
{
  echo "{"
  echo "  \"label\": \"$LABEL\","
  echo "  \"capturedFor\": \"independent matrix ${LABEL}\","
  echo "  \"containers\": {"
  for pair in "pg16:$PG16:$PG16_IMAGE" "pg17:$PG17:$PG17_IMAGE" "minio:$MINIO:$MINIO_IMAGE"; do
    key="${pair%%:*}"; rest="${pair#*:}"; name="${rest%%:*}"; image="${rest#*:}"
    cid="$(docker inspect "$name" --format '{{.Id}}')"
    digest="$(docker inspect "$name" --format '{{.Image}}')"
    created="$(docker inspect "$name" --format '{{.Created}}')"
    mounts="$(docker inspect "$name" --format '{{range .Mounts}}{{.Name}} {{end}}')"
    printf '    "%s": {"container": "%s", "id": "%s", "image": "%s", "imageId": "%s", "created": "%s", "volumes": "%s"}%s\n' \
      "$key" "$name" "$cid" "$image" "$digest" "$created" "$(echo "$mounts" | tr -s ' ')" \
      "$([ "$key" = minio ] && echo "" || echo ",")"
  done
  echo "  },"
  printf '  "pg16": {"port": %s, "systemIdentifier": "%s", "version": "%s"},\n' "$PG16_PORT" \
    "$(psql_pg16 postgres -tAc 'select system_identifier from pg_control_system()')" \
    "$(psql_pg16 postgres -tAc 'show server_version')"
  printf '  "pg17": {"port": %s, "systemIdentifier": "%s", "version": "%s"},\n' "$PG17_PORT" \
    "$(psql_pg17 postgres -tAc 'select system_identifier from pg_control_system()')" \
    "$(psql_pg17 postgres -tAc 'show server_version')"
  printf '  "adminRole": "%s", "databasePrefix": "%s", "minioPort": %s\n' "$ADMIN_ROLE" "$DB_PREFIX" "$MINIO_PORT"
  echo "}"
} > "$IDENT_JSON"
cat "$IDENT_JSON"

pg17_major="$(psql_pg17 postgres -tAc 'show server_version_num')"
[ "$pg17_major" -ge 170000 ] || { echo "REFUSED: pg17 cluster is not PostgreSQL 17" >&2; exit 1; }

echo
echo "=== [$LABEL] CREATE PARTNER DATABASES ON pg17 ==="
DBS="$(node "$HERE/derive-env.mjs" "$LABEL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).pg17Databases.join(" ")))')"
# The per-suite matrix runner owns two databases ci.yml does not name; create them here too so a
# missing database can never look like a suite failure.
EXTRA_DBS="${DB_PREFIX}mintvault_partner_mgmt_rt ${DB_PREFIX}mintvault_partner_matrix_rlsproof"
for db in $DBS $EXTRA_DBS; do
  present="$(psql_pg17 postgres -tAc "select 1 from pg_database where datname='${db}'")"
  [ "$present" = "1" ] || psql_pg17 postgres -c "CREATE DATABASE \"${db}\"" >/dev/null
done
echo "created/verified $(echo $DBS $EXTRA_DBS | wc -w | tr -d ' ') databases with prefix ${DB_PREFIX}"

echo
echo "=== [$LABEL] ADMIN CAPABILITY PRECONDITIONS (mirrors ci.yml) ==="
psql_pg17 postgres -tAc "select rolcreatedb from pg_roles where rolname=current_user" | grep -qx t
psql_pg17 postgres -tAc "select rolcreaterole or rolsuper from pg_roles where rolname=current_user" | grep -qx t
psql_pg17 postgres -tAc "select rolbypassrls or rolsuper from pg_roles where rolname=current_user" | grep -qx t
echo "admin ${ADMIN_ROLE}: CREATEDB + CREATEROLE + BYPASSRLS ok (provisioning role, as in CI)"
# partner_runtime must be NOBYPASSRLS wherever it already exists, or every isolation proof is vacuous.
for db in $DBS; do
  bypass="$(psql_pg17 "$db" -tAc "select coalesce((select rolbypassrls from pg_roles where rolname='partner_runtime'), false)")"
  [ "$bypass" = "f" ] || { echo "REFUSED: partner_runtime is BYPASSRLS in $db" >&2; exit 1; }
done
echo "partner_runtime is NOBYPASSRLS (or not yet created) across all ${LABEL} databases"

echo
echo "=== [$LABEL] pg16 SHARED TEST DATABASE (drizzle push + VQ migrations) ==="
psql_pg16 mintvault_vq_phase10_local -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
DATABASE_URL="postgres://${ADMIN_ROLE}:${ADMIN_PW}@127.0.0.1:${PG16_PORT}/mintvault_vq_phase10_local" \
MINTVAULT_DATABASE_URL="postgres://${ADMIN_ROLE}:${ADMIN_PW}@127.0.0.1:${PG16_PORT}/mintvault_vq_phase10_local" \
  npx drizzle-kit push --force >/dev/null
for migration in migrations-vq/*.sql; do
  psql_pg16 mintvault_vq_phase10_local -f "$migration" >/dev/null
done
psql_pg16 mintvault_vq_phase10_local -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='vq_feature_flags_feature_check'" | grep -q "gen_action_pose"
psql_pg16 mintvault_vq_phase10_local -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='vq_feature_flags_feature_check'" | grep -q "auto_paid_retry"
echo "pg16 schema pushed and VQ migrations applied"

echo
echo "=== [$LABEL] OBJECT STORAGE: bucket created, namespace proven EMPTY ==="
eval "$(node "$HERE/derive-env.mjs" "$LABEL" shell)"
node scripts/ci/ensure-proof-bucket.mjs
node "$HERE/storage-inventory.mjs" "$LABEL" before | tee "$EVID/storage-before-${LABEL}.json"

echo
echo "=== [$LABEL] STUB BASE TABLES for the full-migration-set appliers ==="
npx tsx scripts/ci/ensure-stub-base-tables.mts \
  PARTNER_CONNECTOR_PLAN_ADMIN \
  PARTNER_CONNECTOR_MIGRATION_ADMIN \
  PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN \
  PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN \
  PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN \
  PARTNER_MANAGEMENT_MIGRATION_ADMIN \
  PARTNER_GRADING_BRIDGE_MIGRATION_ADMIN

echo
echo "=== [$LABEL] RUNTIME-ROLE SAFETY PROOF (before any test runs) ==="
npx tsx "$HERE/prove-runtime-safety.mts" "$LABEL" | tee "$EVID/runtime-safety-${LABEL}.txt"

echo
echo "=== [$LABEL] PROVISIONED ==="

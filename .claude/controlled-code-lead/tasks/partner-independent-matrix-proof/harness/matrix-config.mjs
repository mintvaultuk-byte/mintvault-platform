/**
 * INDEPENDENT MATRIX A/B — environment coordinates.
 *
 * Two runs of the SAME critical Partner assurance matrix from two environments that share no
 * state. Everything below is disposable, loopback-only and synthetic; nothing here may ever be
 * pointed at staging or production (see assertDisposableCoordinates()).
 *
 * WHAT GENUINELY DIFFERS BETWEEN A AND B
 *   • PostgreSQL cluster INSTANCES (fresh container + fresh volume => different system_identifier)
 *   • PostgreSQL 17 port
 *   • the superuser/admin LOGIN ROLE NAME (mxadmin_a vs mxadmin_b)
 *   • every provisioned database NAME (prefix mxa_ vs mxb_)
 *   • the MinIO SERVER instance, its port and its data volume
 *   • every tenant / location / customer / submission / certificate row (created inside the run)
 *
 * WHAT CANNOT DIFFER, AND WHY (recorded honestly rather than faked)
 *   • pg16 coordinate 127.0.0.1:55432/mintvault_vq_phase10_local — 27 suites HARD-REFUSE any other
 *     host/port/database ("REFUSED: TEST_DATABASE_URL must be the local throwaway DB"). A and B
 *     therefore reuse that coordinate, but never at the same time and never the same cluster: A's
 *     container and volume are destroyed before B's is created, which the teardown proof asserts.
 *   • the partner role NAMES (partner_runtime, pn_migrator, partner_definer, partner_app_test_*).
 *     They are created by migration 0001 and by tests/helpers/partner-realistic-db.ts, and several
 *     suites assert on them by name. In A and B these are distinct role OBJECTS in distinct
 *     clusters; only the names coincide.
 *   • the storage bucket NAME partner-real-r2-proof. tests/helpers/partner-test-storage.ts builds
 *     fixture buckets as `${PARTNER_REAL_R2_PROOF_BUCKET}-${suffix}` and validates the result
 *     against /^partner-real-r2-proof-[a-z0-9]{1,16}$/, so any prefix of our own makes every
 *     fixture bucket illegal. Namespace separation is achieved by a separate MinIO SERVER instead.
 */

export const MATRICES = {
  A: {
    label: "A",
    containerPrefix: "mvmx-a",
    adminRole: "mxadmin_a",
    adminPassword: "mxa-synthetic-loopback-pw",
    dbPrefix: "mxa_",
    pg16Port: 55432, // pinned by test code — see header
    pg17Port: 55443,
    minioPort: 9020,
    minioRootUser: "mxaminio",
    minioRootPassword: "mxaminio-synthetic",
  },
  B: {
    label: "B",
    containerPrefix: "mvmx-b",
    adminRole: "mxadmin_b",
    adminPassword: "mxb-synthetic-loopback-pw",
    dbPrefix: "mxb_",
    pg16Port: 55432, // pinned by test code — see header
    pg17Port: 55453,
    minioPort: 9030,
    minioRootUser: "mxbminio",
    minioRootPassword: "mxbminio-synthetic",
  },
};

/** Images are pinned so A and B are the same software and only the STATE differs. */
export const IMAGES = {
  pg16: "pgvector/pgvector:pg16",
  pg17: "postgres:17.10",
  minio: "quay.io/minio/minio:latest",
};

export function matrixFor(label) {
  const m = MATRICES[String(label).toUpperCase()];
  if (!m) throw new Error(`unknown matrix label '${label}' (expected A or B)`);
  return m;
}

/**
 * Hard stop. Every coordinate must be loopback and every port must be one of ours, so a
 * mis-edited config can never aim the harness at a real database or at real object storage.
 */
export function assertDisposableCoordinates(m) {
  const ports = [m.pg16Port, m.pg17Port, m.minioPort];
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 9000 || p > 60000) {
      throw new Error(`refusing matrix ${m.label}: port ${p} is outside the disposable range`);
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error(`refusing matrix ${m.label}: duplicate port in ${ports.join(",")}`);
  }
  if (!/^mx[a-z0-9]{1,6}_$/.test(m.dbPrefix)) {
    throw new Error(`refusing matrix ${m.label}: database prefix '${m.dbPrefix}' is not a safe identifier`);
  }
  if (!/^mxadmin_[a-z0-9]{1,8}$/.test(m.adminRole)) {
    throw new Error(`refusing matrix ${m.label}: admin role '${m.adminRole}' is not a harness role name`);
  }
  return true;
}

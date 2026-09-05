#!/usr/bin/env node
/** Owned PostgreSQL or object-store proof harness. Never adopts existing services. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MANAGED_DATABASE_ENVIRONMENT_KEYS } from "./partner-suite-env-matrix.mjs";
const PG16 = "pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b";
const PG17 = "postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317";
const LABEL = "mintvault.disposable.integration.run";
export const MINIO_IMAGE = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
export const R2_PROOF_CHECKS = Object.freeze([
  "upload-roundtrip",
  "stream-integrity",
  "head-readability",
  "listing",
  "stream",
  "signed-download",
  "conditional-collision",
  "conditional-race",
  "immutable-replay",
  "immutable-mismatch",
  "delete-missing",
]);
export const ADMIN_BROWSER_PROOF_CHECKS = Object.freeze([
  "rendered-login",
  "rendered-pin",
  "rendered-command-centre",
  "authenticated-dashboard",
  "mobile-containment",
  "rendered-logout",
  "post-logout-refusal",
]);
export function validateAdminBrowserReport(report, token) {
  let url;
  try {
    url = new URL(report?.url);
  } catch {
    throw new Error("invalid browser proof URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    report?.schemaVersion !== 1 ||
    report.runId !== token ||
    typeof report.browser !== "string" ||
    !report.browser ||
    report.passed !== ADMIN_BROWSER_PROOF_CHECKS.length ||
    report.failed !== 0 ||
    report.skipped !== 0 ||
    !Array.isArray(report.checks) ||
    report.checks.length !== ADMIN_BROWSER_PROOF_CHECKS.length ||
    !ADMIN_BROWSER_PROOF_CHECKS.every(
      (name, index) => report.checks[index]?.name === name && report.checks[index]?.status === "passed"
    )
  )
    throw new Error("browser proof report is incomplete, failed, or does not match the owned run");
  return report;
}
const PREPARATION_KEYS = new Set([
  ...MANAGED_DATABASE_ENVIRONMENT_KEYS,
  "PROJECT_CONTROL_TEST_ADMIN_URL",
  "MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_URL",
  "CORRECTION_TEST_DATABASE_URL",
]);
export function controlledEnvironment(base, additions = {}) {
  const keep = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "POSTGRES17_BIN"];
  for (const key of [...keep, "NODE_ENV"]) {
    if (Object.hasOwn(additions, key)) throw new Error(`test additions cannot override ${key}`);
  }
  const env = Object.fromEntries(keep.filter((key) => base[key]).map((key) => [key, base[key]]));
  return { ...env, LANG: "C", LC_ALL: "C", NODE_ENV: "test", ...additions };
}
function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
    env: controlledEnvironment(process.env, options.env),
    timeout: 60_000,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout || "").trim();
}
export function dockerDriver(context) {
  if (!context || context.startsWith("-")) throw new Error("--docker-context requires an explicit Docker context name");
  const call = (args, env) => checked("docker", ["--context", context, ...args], { env });
  return {
    run: call,
    inspect: (id, token) => call(["inspect", "--format", `{{ index .Config.Labels "${LABEL}" }}`, id]) === token,
    port: (id, port = "5432") => call(["port", id, port]),
    remove: (id) => call(["rm", "-f", "-v", id]),
  };
}
function startOwned(driver, ids, token, image, service) {
  const id = driver.run([
    "run",
    "-d",
    "--label",
    `${LABEL}=${token}`,
    "--label",
    `mintvault.service=${service}`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    image,
    "-c",
    "fsync=off",
  ]);
  if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error(`docker did not return a container id for ${service}`);
  ids.push(id);
  if (!driver.inspect(id, token)) throw new Error(`docker did not prove ownership of ${service}`);
  return id;
}
function loopbackPort(driver, id, containerPort = "5432") {
  const mappings = driver
    .port(id, containerPort)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());
  if (mappings.length !== 1 || !mappings.every((line) => /^127\.0\.0\.1:\d+$/.test(line)))
    throw new Error(`${id} has a non-loopback or ambiguous published port`);
  const port = Number(mappings[0].split(":").at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid published port");
  return port;
}

/** @param {{driver: ReturnType<typeof dockerDriver>, token?: string, signal?: AbortSignal, fetchReady?: typeof fetch}} options */
export async function startDisposableObjectStore({ driver, token = randomUUID(), signal, fetchReady = fetch }) {
  const ids = [];
  const startup = new AbortController();
  // Keep the process alive while awaiting network readiness, and bound startup.
  const deadline = setTimeout(() => startup.abort(new Error("owned MinIO startup timed out")), 20_000);
  signal = signal ? AbortSignal.any([signal, startup.signal]) : startup.signal;
  const credentials = {
    MINIO_ROOT_USER: `mvtest-${randomBytes(10).toString("hex")}`,
    MINIO_ROOT_PASSWORD: randomBytes(24).toString("hex"),
  };
  try {
    signal?.throwIfAborted();
    const id = driver.run(
      [
        "run",
        "-d",
        "--label",
        `${LABEL}=${token}`,
        "--label",
        "mintvault.service=minio",
        "-e",
        "MINIO_ROOT_USER",
        "-e",
        "MINIO_ROOT_PASSWORD",
        "-p",
        "127.0.0.1::9000",
        MINIO_IMAGE,
        "server",
        "/data",
      ],
      credentials
    );
    if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error("docker did not return a MinIO container id");
    ids.push(id);
    if (!driver.inspect(id, token)) throw new Error("docker did not prove MinIO ownership");
    const endpoint = `http://127.0.0.1:${loopbackPort(driver, id, "9000")}`;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      signal?.throwIfAborted();
      ready = await fetchReady(`${endpoint}/minio/health/ready`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
        redirect: "error",
      }).then(
        (response) => response.ok,
        () => false
      );
      if (ready) break;
      await delay(250, undefined, { signal });
    }
    if (!ready) throw new Error("owned MinIO did not become ready");
    return {
      ids,
      token,
      env: {
        R2_ENDPOINT: endpoint,
        R2_ACCESS_KEY_ID: credentials.MINIO_ROOT_USER,
        R2_SECRET_ACCESS_KEY: credentials.MINIO_ROOT_PASSWORD,
        R2_BUCKET_NAME: `proof-${token}`,
        MINTVAULT_OBJECT_PROOF_RUN_ID: token,
      },
    };
  } catch (error) {
    try {
      cleanup(driver, ids, token);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "object startup and cleanup failed");
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export function validateR2ProofReport(report, services) {
  if (
    report?.schemaVersion !== 1 ||
    report.runId !== services.token ||
    report.endpoint !== services.env.R2_ENDPOINT ||
    report.bucket !== services.env.R2_BUCKET_NAME ||
    report.image !== MINIO_IMAGE ||
    report.passed !== R2_PROOF_CHECKS.length ||
    report.failed !== 0 ||
    report.skipped !== 0 ||
    !Array.isArray(report.checks) ||
    report.checks.length !== R2_PROOF_CHECKS.length ||
    !R2_PROOF_CHECKS.every(
      (name, index) => report.checks[index]?.name === name && report.checks[index]?.status === "passed"
    )
  )
    throw new Error("object-store proof report is incomplete, failed, or does not match the owned run");
  return report;
}
function waitForPostgres(driver, id, major) {
  let last;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const version = driver.run([
        "exec",
        id,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-Atc",
        "SHOW server_version_num",
      ]);
      if (new RegExp(`^${major}\\d{4}$`).test(version)) return;
      throw new Error(`expected PostgreSQL ${major}, got ${version}`);
    } catch (error) {
      last = error;
      if (attempt < 29) checked("sleep", ["1"]);
    }
  }
  throw last;
}
export function cleanup(driver, ids, token) {
  const failures = [];
  for (const id of [...ids].reverse()) {
    try {
      if (!driver.inspect(id, token)) failures.push(new Error(`refusing to remove unowned container ${id}`));
      else driver.remove(id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "disposable container cleanup failed");
}
export async function startDisposableServices({ driver, token = randomUUID() }) {
  const ids = [];
  try {
    const pg16 = startOwned(driver, ids, token, PG16, "pg16");
    const pg17 = startOwned(driver, ids, token, PG17, "pg17");
    const pg16Port = loopbackPort(driver, pg16),
      pg17Port = loopbackPort(driver, pg17);
    waitForPostgres(driver, pg16, 16);
    waitForPostgres(driver, pg17, 17);
    if (
      driver.run([
        "exec",
        pg16,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-Atc",
        "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'",
      ]) !== "1"
    )
      throw new Error("owned PG16 service does not provide vector");
    return {
      ids,
      token,
      env: { MINTVAULT_TEST_PG16_PORT: String(pg16Port), MINTVAULT_TEST_PG17_PORT: String(pg17Port) },
    };
  } catch (error) {
    try {
      cleanup(driver, ids, token);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "startup and cleanup failed");
    }
    throw error;
  }
}
export function childStatus(result) {
  return result.code === 0 ? 0 : 1;
}
/** Await close, not only exit; uncertainty must retain the resources it uses. */
export function stopOwnedChild(
  child,
  { closed = false, graceMs = 2000, killMs = 2000, initialSignal = "SIGTERM" } = {}
) {
  if (closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false,
      timer;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!confirmed)
        console.error(
          `[owned-child] closure unconfirmed pid=${child.pid ?? "none"} exit=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"}`
        );
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(confirmed);
    };
    const onClose = () => finish(true),
      onError = () => finish(false);
    const terminate = (kind, wait, next) => {
      try {
        if (!child.kill(kind) && !settled) {
          // kill(false) also occurs after process exit but before stdio close.
          // Wait for that close within the same bound; never infer it succeeded.
          timer = setTimeout(() => finish(false), wait);
          return;
        }
      } catch {
        return finish(false);
      }
      if (!settled) timer = setTimeout(next, wait);
    };
    child.once("close", onClose);
    child.once("error", onError);
    terminate(initialSignal, graceMs, () => terminate("SIGKILL", killMs, () => finish(false)));
  });
}
export function runChild(args, env, spawnProcess = spawn, signal, { graceMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null });
    const child = spawnProcess(process.execPath, args, {
      stdio: "inherit",
      env,
      detached: process.platform !== "win32",
    });
    let timer,
      settled = false;
    const terminationUnknown = (error) => {
      done();
      const failure = new Error("child termination could not be confirmed; retain owned services", { cause: error });
      failure.retainOwnedServices = true;
      reject(failure);
    };
    const kill = (kind) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== "ESRCH") {
          terminationUnknown(error);
          return false;
        }
      }
      return true;
    };
    const abort = () => {
      if (settled || !kill("SIGTERM") || settled) return;
      timer = setTimeout(() => {
        if (settled || !kill("SIGKILL") || settled) return;
        timer = setTimeout(() => terminationUnknown(new Error("child did not close after SIGKILL")), 5000);
        timer.unref();
      }, graceMs);
      timer.unref();
    };
    const done = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      done();
      if (child.pid) terminationUnknown(error);
      else reject(error);
    });
    child.once("close", (code) => {
      done();
      resolve({ code });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export function parse(argv) {
  let context,
    prepare = false,
    r2Proof = false,
    adminBrowserProof = false;
  const selection = [],
    targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--docker-context" || arg === "--json") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (arg === "--docker-context") {
        if (context) throw new Error("duplicate Docker context");
        context = value;
      } else selection.push(arg, value);
    } else if (arg === "--admin-browser-proof") {
      if (adminBrowserProof) throw new Error("duplicate browser target");
      adminBrowserProof = true;
    } else if (arg === "--r2-proof") {
      if (r2Proof) throw new Error("duplicate object-store target");
      r2Proof = true;
    } else if (arg === "--prepare") prepare = true;
    else if (arg === "--all" || /^tests\/[\w./-]+\.test\.ts$/.test(arg)) {
      targets.push(arg);
      selection.push(arg);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (adminBrowserProof) {
    if (!context || r2Proof || prepare || selection.length)
      throw new Error("--admin-browser-proof requires only an explicit Docker context");
    return { context, prepare: false, selection: [], adminBrowserProof: true };
  }
  if (r2Proof) {
    if (!context || prepare || selection.length) throw new Error("--r2-proof requires only an explicit Docker context");
    return { context, prepare: false, selection: [], r2Proof: true };
  }
  if (!context || !targets.length || (targets.includes("--all") && targets.length !== 1))
    throw new Error("require --docker-context <name> and --all or explicit test paths");
  return { context, prepare, selection };
}

export function preparationExports(text, serviceEnv) {
  const ports = new Set([serviceEnv.MINTVAULT_TEST_PG16_PORT, serviceEnv.MINTVAULT_TEST_PG17_PORT]);
  const result = {};
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const at = line.indexOf("=");
    const key = line.slice(0, at),
      value = line.slice(at + 1);
    if (at < 1 || !PREPARATION_KEYS.has(key)) throw new Error(`invalid preparation export key: ${key}`);
    const url = new URL(value);
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !ports.has(url.port))
      throw new Error(`preparation export ${key} does not reference an owned PostgreSQL service`);
    result[key] = value;
  }
  return result;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { context, prepare, selection, r2Proof, adminBrowserProof } = parse(argv);
  const driver = deps.driver || dockerDriver(context);
  const controller = new AbortController(),
    signalSource = deps.signalSource || process;
  let services,
    retainServices = false,
    signalCode = 0;
  const interrupt = () => {
    signalCode = 130;
    controller.abort();
  };
  const terminate = () => {
    signalCode = 143;
    controller.abort();
  };
  signalSource.once("SIGINT", interrupt);
  signalSource.once("SIGTERM", terminate);
  const temp = mkdtempSync(join(tmpdir(), "mintvault-ci-env-")),
    envPath = join(temp, "github-env");
  try {
    if (r2Proof) {
      services = await startDisposableObjectStore({ driver, signal: controller.signal, fetchReady: deps.fetchReady });
      const reportPath = join(temp, "object-proof.json");
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 60_000);
      timeout.unref();
      let outcome;
      try {
        outcome = await runChild(
          ["--import", "tsx", "scripts/ci/run-r2-object-store-proof.mjs", reportPath],
          controlledEnvironment(process.env, services.env),
          deps.spawnProcess,
          controller.signal
        );
      } finally {
        clearTimeout(timeout);
      }
      if (signalCode || timedOut || childStatus(outcome)) return signalCode || 1;
      const report = validateR2ProofReport(JSON.parse(readFileSync(reportPath, "utf8")), services);
      console.log(`[disposable-ci] ${JSON.stringify(report)}`);
      return 0;
    }
    services = await startDisposableServices({ driver });
    console.log(
      `[disposable-ci] owned run ${services.token}; PG16 port=${services.env.MINTVAULT_TEST_PG16_PORT}, PG17 port=${services.env.MINTVAULT_TEST_PG17_PORT}`
    );
    if (adminBrowserProof) {
      const reportPath = join(temp, "admin-browser-proof.json");
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 180_000);
      timeout.unref();
      let outcome;
      try {
        outcome = await runChild(
          ["--import", "tsx", "scripts/command-centre-runtime-harness.ts", "--browser-proof", reportPath],
          controlledEnvironment(process.env, {
            MINTVAULT_COMMAND_CENTRE_RUNTIME_AUDIT: "1",
            MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_URL: `postgresql://postgres:postgres@127.0.0.1:${services.env.MINTVAULT_TEST_PG17_PORT}/postgres`,
            MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
            MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN: String(10000000 + (randomBytes(4).readUInt32BE() % 90000000)),
            MINTVAULT_BROWSER_PROOF_RUN_ID: services.token,
          }),
          deps.spawnProcess,
          controller.signal,
          { graceMs: 25_000 }
        );
      } finally {
        clearTimeout(timeout);
      }
      if (outcome.code === 75 || outcome.code === null) {
        const failure = new Error("browser termination could not be confirmed; retain owned services");
        failure.retainOwnedServices = true;
        throw failure;
      }
      if (signalCode || timedOut || childStatus(outcome)) return signalCode || 1;
      const report = validateAdminBrowserReport(JSON.parse(readFileSync(reportPath, "utf8")), services.token);
      console.log(`[disposable-ci] ${JSON.stringify(report)}`);
      return 0;
    }
    if (prepare) {
      const prepared = await runChild(
        ["scripts/ci/prepare-engineering-governance-db.mjs"],
        controlledEnvironment(process.env, { ...services.env, GITHUB_ENV: envPath, DOCKER_CONTEXT: context }),
        deps.spawnProcess,
        controller.signal
      );
      if (signalCode || childStatus(prepared)) return signalCode || 1;
    }
    const exported = prepare ? preparationExports(readFileSync(envPath, "utf8"), services.env) : {};
    const outcome = await runChild(
      ["scripts/ci/run-partner-suite.mjs", ...selection],
      controlledEnvironment(process.env, { ...services.env, ...exported, DOCKER_CONTEXT: context }),
      deps.spawnProcess,
      controller.signal
    );
    return signalCode || childStatus(outcome);
  } catch (error) {
    retainServices = error.retainOwnedServices === true;
    throw error;
  } finally {
    signalSource.removeListener("SIGINT", interrupt);
    signalSource.removeListener("SIGTERM", terminate);
    if (!retainServices) rmSync(temp, { recursive: true, force: true });
    if (services && !retainServices) cleanup(driver, services.ids, services.token);
    if (services && retainServices)
      console.error(
        `[disposable-ci] retained run ${services.token}; unconfirmed child termination; container IDs=${services.ids.join(",")}; proof directory=${temp}`
      );
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  try {
    // Top-level await must not silently exit zero on an unresolved proof promise.
    process.exit(await main());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

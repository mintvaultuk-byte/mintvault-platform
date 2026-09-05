#!/usr/bin/env node
/** Bounded PostgreSQL-only CI harness. It never adopts a pre-existing container. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MANAGED_DATABASE_ENVIRONMENT_KEYS } from "./partner-suite-env-matrix.mjs";
const PG16 = "pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b";
const PG17 = "postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317";
const LABEL = "mintvault.disposable.integration.run";
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
  const call = (args) => checked("docker", ["--context", context, ...args]);
  return {
    run: call,
    inspect: (id, token) => call(["inspect", "--format", `{{ index .Config.Labels "${LABEL}" }}`, id]) === token,
    port: (id) => call(["port", id, "5432"]),
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
function loopbackPort(driver, id) {
  const mappings = driver
    .port(id)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());
  if (mappings.length !== 1 || !mappings.every((line) => /^127\.0\.0\.1:\d+$/.test(line)))
    throw new Error(`${id} has a non-loopback or ambiguous published port`);
  return Number(mappings[0].split(":").at(-1));
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
export function runChild(args, env, spawnProcess = spawn, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null });
    const child = spawnProcess(process.execPath, args, {
      stdio: "inherit",
      env,
      detached: process.platform !== "win32",
    });
    let timer;
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
      if (!kill("SIGTERM")) return;
      timer = setTimeout(() => kill("SIGKILL"), 5000);
      timer.unref();
    };
    const done = () => {
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
    prepare = false;
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
    } else if (arg === "--prepare") prepare = true;
    else if (arg === "--all" || /^tests\/[\w./-]+\.test\.ts$/.test(arg)) {
      targets.push(arg);
      selection.push(arg);
    } else throw new Error(`unknown argument: ${arg}`);
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
  const { context, prepare, selection } = parse(argv);
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
    services = await startDisposableServices({ driver });
    console.log(
      `[disposable-ci] owned run ${services.token}; PG16 port=${services.env.MINTVAULT_TEST_PG16_PORT}, PG17 port=${services.env.MINTVAULT_TEST_PG17_PORT}`
    );
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
    rmSync(temp, { recursive: true, force: true });
    if (services && !retainServices) cleanup(driver, services.ids, services.token);
    if (services && retainServices)
      console.error(
        `[disposable-ci] retained run ${services.token}; unconfirmed child termination; container IDs=${services.ids.join(",")}`
      );
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });

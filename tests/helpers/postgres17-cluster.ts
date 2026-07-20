import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";

export interface DisposablePostgres17 {
  url: string;
  dataDir: string;
  port: number;
  stop: () => Promise<void>;
}

function postgres17Bin(): string | null {
  const candidates = [
    process.env.POSTGRES17_BIN,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const version = execFileSync(join(candidate, "postgres"), ["--version"], { encoding: "utf8" }).trim();
      if (/PostgreSQL\) 17\.10\b/.test(version)) return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  return null;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a disposable PostgreSQL port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function startPostgres17(suite: string): Promise<DisposablePostgres17> {
  const bin = process.env.POSTGRES17_FORCE_DOCKER === "1" ? null : postgres17Bin();
  const useDocker = bin === null;
  if (useDocker && !dockerAvailable()) {
    throw new Error(
      "G6A database tests require PostgreSQL 17.10. Install it, set POSTGRES17_BIN, or provide Docker; tests will not skip."
    );
  }
  const containerName = `mintvault-g6a-${suite.replace(/[^a-z0-9_.-]/gi, "-")}-${process.pid}-${Date.now()}`;
  const dataDir = useDocker ? `docker:${containerName}` : mkdtempSync(join(tmpdir(), `mintvault-${suite}-pg17-`));
  const port = await unusedPort();
  let running = false;
  const stopSync = () => {
    if (running) {
      try {
        if (useDocker) {
          execFileSync("docker", ["stop", "--time", "1", containerName], { stdio: "ignore" });
        } else {
          execFileSync(join(bin!, "pg_ctl"), ["-D", dataDir, "stop", "-m", "immediate", "-w"], {
            stdio: "ignore",
          });
        }
      } catch {
        // Teardown remains best-effort during process exit; afterAll surfaces normal stop failures.
      }
      running = false;
    }
    if (!useDocker) rmSync(dataDir, { recursive: true, force: true });
  };
  const onExit = () => stopSync();

  try {
    if (useDocker) {
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--detach",
          "--name",
          containerName,
          "--env",
          "POSTGRES_HOST_AUTH_METHOD=trust",
          "--publish",
          `127.0.0.1:${port}:5432`,
          "postgres:17.10",
        ],
        { stdio: "ignore" }
      );
    } else {
      execFileSync(
        join(bin!, "initdb"),
        ["-D", dataDir, "--username=postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"],
        { stdio: "ignore" }
      );
      execFileSync(
        join(bin!, "pg_ctl"),
        [
          "-D",
          dataDir,
          "start",
          "-w",
          "-t",
          "30",
          "-o",
          `-h 127.0.0.1 -p ${port} -F -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
        ],
        { stdio: "ignore" }
      );
    }
    running = true;
    process.once("exit", onExit);

    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    let client: Client | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      client = new Client({ connectionString: url });
      try {
        await client.connect();
        break;
      } catch {
        await client.end().catch(() => {});
        client = null;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!client) throw new Error("PostgreSQL 17.10 did not accept connections within 20 seconds.");
    try {
      const result = await client.query<{ server_version: string }>("SHOW server_version");
      if (!/^17\.10(?:\s|$)/.test(result.rows[0].server_version)) {
        throw new Error(`G6A database tests require PostgreSQL 17.10, started ${result.rows[0].server_version}.`);
      }
    } finally {
      await client.end();
    }

    return {
      url,
      dataDir,
      port,
      stop: async () => {
        process.off("exit", onExit);
        if (running) {
          try {
            if (useDocker) {
              execFileSync("docker", ["stop", "--time", "10", containerName], { stdio: "ignore" });
            } else {
              execFileSync(join(bin!, "pg_ctl"), ["-D", dataDir, "stop", "-m", "fast", "-w"], { stdio: "ignore" });
            }
          } catch (error) {
            try {
              if (useDocker) {
                execFileSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
              } else {
                execFileSync(join(bin!, "pg_ctl"), ["-D", dataDir, "stop", "-m", "immediate", "-w"], {
                  stdio: "ignore",
                });
              }
            } catch {
              throw error;
            }
          } finally {
            running = false;
          }
        }
        if (!useDocker) rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    process.off("exit", onExit);
    stopSync();
    throw error;
  }
}

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepository(): { repo: string; script: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "mintvault-safe-deploy-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  const script = join(repo, "scripts", "safe-deploy.sh");
  const fakeBin = join(root, "bin");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(fakeBin);
  copyFileSync(resolve(process.cwd(), "scripts/safe-deploy.sh"), script);
  writeFileSync(join(repo, "README.md"), "release candidate\n");

  // If a production guard regresses, these stubs keep the test incapable of
  // reaching a real Fly app or live HTTP endpoint.
  for (const command of ["curl", "fly"]) {
    const stub = join(fakeBin, command);
    writeFileSync(stub, "#!/usr/bin/env bash\nexit 97\n");
    chmodSync(stub, 0o755);
  }

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "MintVault Gate Test");
  git(repo, "config", "user.email", "gate-test@invalid.example");
  git(repo, "add", "README.md", "scripts/safe-deploy.sh");
  git(repo, "commit", "-m", "release candidate");
  git(root, "clone", "--bare", repo, join(root, "origin.git"));
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  git(repo, "fetch", "origin");

  return {
    repo,
    script,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  };
}

function runProduction(repo: string, script: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bash", [script, "prod", ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
}

describe("production deploy release boundary", () => {
  it("rejects the behind-main bypass before evaluating the repository", () => {
    const { repo, script, env } = makeRepository();
    const result = runProduction(repo, script, env, "--allow-behind");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--allow-behind is a staging-only diagnostic escape hatch");
  });

  it("rejects a clean but unmerged commit ahead of origin/main", () => {
    const { repo, script, env } = makeRepository();
    writeFileSync(join(repo, "README.md"), "unreviewed candidate\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "unreviewed candidate");

    const result = runProduction(repo, script, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production only accepts the exact origin/main commit");
  });

  it.each([
    ["modified tracked input", (repo: string) => writeFileSync(join(repo, "README.md"), "dirty\n")],
    ["untracked input", (repo: string) => writeFileSync(join(repo, "untracked-build-input.ts"), "export {};\n")],
  ])("rejects %s", (_name, mutate) => {
    const { repo, script, env } = makeRepository();
    mutate(repo);

    const result = runProduction(repo, script, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production builds require a completely clean worktree");
  });
});

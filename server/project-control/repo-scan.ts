/**
 * Project Control — live repository scanner.
 *
 * STRICTLY READ-ONLY. Every git invocation here is an inspection command with an explicit
 * allowlist; nothing in this file can check out, fetch, push, commit, or mutate the repository
 * in any way. It shells out with `execFile` (never a shell string), so no argument can be
 * interpreted as a command.
 *
 * It also never returns secrets: environment values are reported as PRESENT/ABSENT only, and
 * every string that leaves this module passes through the shared redactor.
 *
 * Results are cached in-process for a short window because a full scan across ~80 worktrees
 * costs real time and the dashboard polls.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "@shared/project-control";

const run = promisify(execFile);

/** Only these git subcommands may ever be invoked. Anything else is a programming error. */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "rev-parse",
  "branch",
  "log",
  "status",
  "worktree",
  "for-each-ref",
  "show-ref",
  "merge-base",
]);

const REPO_ROOT = process.cwd();
const GIT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;

async function git(args: string[]): Promise<string> {
  const sub = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(`Refusing to run non-inspection git subcommand: ${sub}`);
  }
  const { stdout } = await run("git", args, {
    cwd: REPO_ROOT,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // Never let git prompt for credentials or open an editor.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

async function gitSafe(args: string[]): Promise<string> {
  try {
    return await git(args);
  } catch {
    return "";
  }
}

export interface BranchInfo {
  name: string;
  commit: string;
  subject: string;
  committedAt: string;
  /** true when the branch tip is an ancestor of main (i.e. already merged). */
  mergedIntoMain: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  commit: string;
  detached: boolean;
}

export interface MigrationInfo {
  filename: string;
  number: string;
  /** Duplicate numbers are a hard failure in the runner — surface them loudly. */
  duplicateNumber: boolean;
}

export interface FeatureFlagInfo {
  name: string;
  /** Present/absent only. The dashboard NEVER shows an environment value. */
  configured: boolean;
}

export interface RepoScan {
  scannedAt: string;
  repoRoot: string;
  currentBranch: string;
  headCommit: string;
  dirtyFileCount: number;
  mainSha: string | null;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  migrations: MigrationInfo[];
  featureFlags: FeatureFlagInfo[];
  /** Non-fatal problems encountered during the scan (git unavailable, etc.). */
  warnings: string[];
}

let cache: { at: number; value: RepoScan } | null = null;

/**
 * The single in-flight scan, if one is running.
 *
 * REMEDIATION: `refresh=true` previously bypassed the cache unconditionally, so N concurrent
 * requests spawned N sets of `git` subprocesses. Concurrent callers now COALESCE onto one scan.
 */
let inFlight: Promise<RepoScan> | null = null;

/**
 * Server-side minimum interval between forced refreshes. A browser query parameter is a request,
 * not authority to spawn a subprocess — this is the floor the client cannot argue with.
 */
export const MIN_FORCED_REFRESH_MS = 10_000;
let lastForcedRefreshAt = 0;

export function invalidateRepoScanCache(): void {
  cache = null;
  lastForcedRefreshAt = 0;
}

export async function scanRepository(force = false): Promise<RepoScan> {
  const now = Date.now();

  // A forced refresh is honoured only outside the cooldown; inside it, the cached value is
  // returned instead. The caller still gets a well-formed answer, just not a new subprocess.
  const forceAllowed = force && now - lastForcedRefreshAt >= MIN_FORCED_REFRESH_MS;

  if (!forceAllowed && cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (!forceAllowed && cache && force) return cache.value;

  // Coalesce: whoever asks while a scan is running waits for THAT scan.
  if (inFlight) return inFlight;

  if (forceAllowed) lastForcedRefreshAt = now;

  inFlight = doScan()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function doScan(): Promise<RepoScan> {
  const warnings: string[] = [];

  const currentBranch = (await gitSafe(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "unknown";
  const headCommit = (await gitSafe(["rev-parse", "HEAD"])).trim() || "unknown";
  if (headCommit === "unknown") warnings.push("git is not available or this is not a git repository.");

  const statusOut = await gitSafe(["status", "--porcelain"]);
  const dirtyFileCount = statusOut.split("\n").filter((l) => l.trim().length > 0).length;

  const mainSha = (await gitSafe(["rev-parse", "main"])).trim() || null;

  const branches = await scanBranches(mainSha, warnings);
  const worktrees = await scanWorktrees();
  const migrations = scanMigrations(warnings);
  const featureFlags = scanFeatureFlags();

  return {
    scannedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    currentBranch,
    headCommit,
    dirtyFileCount,
    mainSha,
    branches,
    worktrees,
    migrations,
    featureFlags,
    warnings,
  };
}

async function scanBranches(mainSha: string | null, warnings: string[]): Promise<BranchInfo[]> {
  // %00 as a field separator — branch subjects can legitimately contain anything else.
  const out = await gitSafe([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)",
    "refs/heads",
  ]);
  if (!out.trim()) {
    warnings.push("No local branches could be read.");
    return [];
  }

  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, commit, subject, committedAt] = line.split("\0");
      return { name, commit, subject: redactSecrets(subject ?? ""), committedAt: committedAt ?? "" };
    });

  const merged = new Set<string>();
  if (mainSha) {
    const mergedOut = await gitSafe(["branch", "--merged", "main", "--format=%(refname:short)"]);
    mergedOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((b) => merged.add(b));
  }

  return rows.map((r) => ({ ...r, mergedIntoMain: merged.has(r.name) }));
}

async function scanWorktrees(): Promise<WorktreeInfo[]> {
  const out = await gitSafe(["worktree", "list", "--porcelain"]);
  const trees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) trees.push(finaliseWorktree(current));
      current = { path: line.slice("worktree ".length).trim(), detached: false, branch: null };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.trim() === "detached") {
      current.detached = true;
    }
  }
  if (current.path) trees.push(finaliseWorktree(current));
  return trees;
}

function finaliseWorktree(w: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: w.path ?? "",
    branch: w.branch ?? null,
    commit: w.commit ?? "",
    detached: w.detached ?? false,
  };
}

const MIGRATION_FILE_RE = /^(\d{4,})_.+\.sql$/;

function scanMigrations(warnings: string[]): MigrationInfo[] {
  const dir = join(REPO_ROOT, "migrations");
  if (!existsSync(dir)) {
    warnings.push("migrations/ directory not found.");
    return [];
  }
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();

  const counts = new Map<string, number>();
  for (const f of files) {
    const num = String(Number(f.match(MIGRATION_FILE_RE)![1]));
    counts.set(num, (counts.get(num) ?? 0) + 1);
  }

  const result = files.map((filename) => {
    const number = String(Number(filename.match(MIGRATION_FILE_RE)![1]));
    return { filename, number, duplicateNumber: (counts.get(number) ?? 0) > 1 };
  });

  const dupes = result.filter((m) => m.duplicateNumber);
  if (dupes.length > 0) {
    warnings.push(
      `Duplicate migration numbers present (${dupes.map((d) => d.filename).join(", ")}) — the migration runner rejects these.`
    );
  }
  return result;
}

/**
 * Feature flags are reported as configured/not-configured ONLY. Values never leave the server:
 * a flag value can be a secret-bearing string and this dashboard is not worth an exposure.
 */
const TRACKED_FLAG_PREFIXES = ["FEATURE_", "PARTNER_", "VQ_", "ENABLE_"];

function scanFeatureFlags(): FeatureFlagInfo[] {
  return Object.keys(process.env)
    .filter((k) => TRACKED_FLAG_PREFIXES.some((p) => k.startsWith(p)))
    .sort()
    .map((name) => ({ name, configured: (process.env[name] ?? "").length > 0 }));
}

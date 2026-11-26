import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { GitHubPulseRepo } from "./protocol.ts";

const PULSE_TTL_MS = 60_000;
const EXTRA_BIN_DIRS = [
  "/config/.local/bin",
  join(homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export interface PollPulseOptions {
  force?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  pathEnv?: string;
}

interface PulseCacheEntry {
  fetchedAt: number;
  pulses: GitHubPulseRepo[];
}

const pulseCache = new Map<string, PulseCacheEntry>();

export function clearGitHubPulseCache(): void {
  pulseCache.clear();
}

export function buildAugmentedPath(basePath = process.env.PATH ?? ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of [...basePath.split(delimiter), ...EXTRA_BIN_DIRS]) {
    const clean = dir.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    parts.push(clean);
  }
  return parts.join(delimiter);
}

export function resolveCliBinary(
  binary: string,
  basePath = process.env.PATH,
): string | null {
  for (const dir of buildAugmentedPath(basePath).split(delimiter)) {
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not executable here; keep searching PATH.
    }
  }
  return null;
}

function runGhJson(
  ghBin: string,
  args: string[],
  timeoutMs: number,
  pathEnv: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      ghBin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 512_000,
        env: { ...process.env, PATH: pathEnv },
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

function mapRunCiStatus(runsRaw: unknown): {
  ciStatus: GitHubPulseRepo["ciStatus"];
  branch?: string;
} {
  if (!Array.isArray(runsRaw) || runsRaw.length === 0) {
    return { ciStatus: "unknown" };
  }
  const latest = runsRaw[0] as Record<string, unknown>;
  const status = String(latest.status ?? "").toLowerCase();
  const conclusion = String(latest.conclusion ?? "").toLowerCase();
  const branch =
    typeof latest.headBranch === "string" && latest.headBranch.trim()
      ? latest.headBranch.trim()
      : undefined;
  if (
    status === "in_progress" ||
    status === "queued" ||
    status === "waiting" ||
    status === "pending"
  ) {
    return { ciStatus: "pending", branch };
  }
  if (conclusion === "success") return { ciStatus: "pass", branch };
  if (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "cancelled" ||
    conclusion === "action_required"
  ) {
    return { ciStatus: "fail", branch };
  }
  return { ciStatus: "unknown", branch };
}

async function fetchRepoPulse(
  ghBin: string,
  repoName: string,
  defaultBranch: string,
  updatedAt: string,
  timeoutMs: number,
  pathEnv: string,
): Promise<{ pulse: GitHubPulseRepo; anySucceeded: boolean }> {
  const issueArgs = [
    "issue",
    "list",
    "-R",
    repoName,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number",
  ];
  const prArgs = [
    "pr",
    "list",
    "-R",
    repoName,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number",
  ];
  const runArgs = [
    "run",
    "list",
    "-R",
    repoName,
    "--limit",
    "1",
    "--json",
    "status,conclusion,headBranch",
  ];
  const [issuesRes, prsRes, runsRes] = await Promise.allSettled([
    runGhJson(ghBin, issueArgs, timeoutMs, pathEnv),
    runGhJson(ghBin, prArgs, timeoutMs, pathEnv),
    runGhJson(ghBin, runArgs, timeoutMs, pathEnv),
  ]);
  const anySucceeded =
    issuesRes.status === "fulfilled" ||
    prsRes.status === "fulfilled" ||
    runsRes.status === "fulfilled";
  const openIssues =
    issuesRes.status === "fulfilled" && Array.isArray(issuesRes.value)
      ? issuesRes.value.length
      : 0;
  const openPrs =
    prsRes.status === "fulfilled" && Array.isArray(prsRes.value)
      ? prsRes.value.length
      : 0;
  const runMeta =
    runsRes.status === "fulfilled"
      ? mapRunCiStatus(runsRes.value)
      : { ciStatus: "unknown" as const };
  return {
    anySucceeded,
    pulse: {
      repo: repoName,
      branch: defaultBranch || runMeta.branch || "main",
      openIssues,
      openPrs,
      ciStatus: runMeta.ciStatus,
      updatedAt,
    },
  };
}

export async function pollGitHubPulse(
  repos?: string[],
  options: PollPulseOptions = {},
): Promise<GitHubPulseRepo[]> {
  const cleanRepos = (repos ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
  const cacheKey = cleanRepos.length > 0 ? cleanRepos.join(",") : "__default__";
  const ttlMs = options.ttlMs ?? PULSE_TTL_MS;
  const cached = pulseCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.pulses;
  }

  const ghBin = resolveCliBinary("gh", options.pathEnv);
  if (!ghBin) return [];
  const pathEnv = buildAugmentedPath(options.pathEnv);
  const timeoutMs = options.timeoutMs ?? 4500;

  try {
    let targets: Array<{ name: string; branch: string; updatedAt: string }> =
      [];
    let fromRepoList = false;
    if (cleanRepos.length > 0) {
      targets = cleanRepos.map((name) => ({
        name,
        branch: "main",
        updatedAt: new Date().toISOString(),
      }));
    } else {
      const listed = await runGhJson(
        ghBin,
        [
          "repo",
          "list",
          "--limit",
          "4",
          "--json",
          "nameWithOwner,defaultBranchRef,updatedAt",
        ],
        timeoutMs,
        pathEnv,
      );
      if (!Array.isArray(listed)) return [];
      fromRepoList = true;
      targets = listed
        .filter((r): r is Record<string, unknown> =>
          Boolean(r && typeof r === "object"),
        )
        .map((r) => {
          const ref =
            r.defaultBranchRef && typeof r.defaultBranchRef === "object"
              ? (r.defaultBranchRef as Record<string, unknown>)
              : {};
          const branch =
            typeof ref.name === "string" && ref.name.trim()
              ? ref.name.trim()
              : "main";
          const updatedAt =
            typeof r.updatedAt === "string" && r.updatedAt.trim()
              ? r.updatedAt.trim()
              : new Date().toISOString();
          return {
            name: String(r.nameWithOwner ?? "").trim(),
            branch,
            updatedAt,
          };
        })
        .filter((item) => item.name.length > 0);
    }

    const results = await Promise.all(
      targets.map((target) =>
        fetchRepoPulse(
          ghBin,
          target.name,
          target.branch,
          target.updatedAt,
          timeoutMs,
          pathEnv,
        ),
      ),
    );
    const pulses = results
      .filter((entry) => fromRepoList || entry.anySucceeded)
      .map((entry) => entry.pulse);
    pulseCache.set(cacheKey, { fetchedAt: Date.now(), pulses });
    return pulses;
  } catch {
    return [];
  }
}

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  buildAugmentedPath,
  clearGitHubPulseCache,
  type PollPulseOptions,
  pollGitHubPulse,
  resolveCliBinary,
} from "./github-pulse.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { HarnessId } from "./protocol.ts";
import { resolveAllowedCwd } from "./runner-cwd.ts";

export {
  buildAugmentedPath,
  clearGitHubPulseCache,
  type PollPulseOptions,
  pollGitHubPulse,
  resolveAllowedCwd,
  resolveCliBinary,
};

const MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

interface HarnessCliSpec {
  binary: string;
  buildArgs: (prompt: string, cwd: string) => string[];
}

const opencodeArgs = (prompt: string, cwd: string) => [
  "run",
  "--dir",
  cwd,
  "--format",
  "default",
  prompt,
];

const HARNESS_SPECS: Partial<Record<HarnessId, HarnessCliSpec>> = {
  antigravity: {
    binary: "agy",
    buildArgs: (prompt) => ["-p", prompt, "--output-format", "text"],
  },
  free_pool: { binary: "opencode", buildArgs: opencodeArgs },
  opencode: { binary: "opencode", buildArgs: opencodeArgs },
  claude_code: { binary: "claude", buildArgs: (prompt) => ["-p", prompt] },
  codex: { binary: "codex", buildArgs: (prompt) => ["exec", prompt] },
};

export interface LiveOutputEvent {
  runId: string;
  harness: HarnessId;
  repo: string;
  stream: "stdout" | "stderr";
  chunk: string;
  createdAt: string;
}

export interface LiveStatusEvent {
  runId: string;
  harness: HarnessId;
  repo: string;
  branch?: string;
  status: "running" | "completed" | "failed";
  cwd?: string;
  exitCode?: number | null;
  error?: string;
  createdAt: string;
}

export interface LivePromptRequest {
  runId?: string;
  harness: HarnessId;
  prompt: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface LivePromptResult {
  runId: string;
  started: boolean;
  rejected?: boolean;
  harness: HarnessId;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface LiveRunnerOptions {
  allowedDirs?: string[];
  memoryStore?: MemoryStore;
  onOutput?: (event: LiveOutputEvent) => void;
  onStatus?: (event: LiveStatusEvent) => void;
  envPath?: string;
}

export type StartLivePromptHandle =
  | {
      runId: string;
      started: false;
      rejected?: boolean;
      cwd?: string;
      error: string;
      done: Promise<LivePromptResult>;
    }
  | {
      runId: string;
      started: true;
      command: string;
      cwd: string;
      done: Promise<LivePromptResult>;
    };

export function createLiveRunner(options: LiveRunnerOptions = {}) {
  const allowedDirs = (options.allowedDirs ?? [])
    .map((d) => d.trim())
    .filter(Boolean);
  const activeChildren = new Map<string, ChildProcess>();
  const isHarnessAvailable = (harness: HarnessId) =>
    HARNESS_SPECS[harness]
      ? resolveCliBinary(HARNESS_SPECS[harness].binary, options.envPath) !==
        null
      : false;

  function failStart(
    runId: string,
    harness: HarnessId,
    error: string,
    extra: { rejected?: boolean; cwd?: string } = {},
  ): StartLivePromptHandle {
    return {
      runId,
      started: false,
      ...extra,
      error,
      done: Promise.resolve({
        runId,
        started: false,
        harness,
        error,
        ...extra,
      }),
    };
  }

  function recordSafe(
    req: LivePromptRequest,
    repo: string,
    action: string,
    goal?: string,
  ) {
    try {
      options.memoryStore?.recordActivity({
        repo,
        branch: req.branch,
        harness: req.harness,
        action,
        goal,
      });
    } catch {
      // Ignore if memoryStore closed during server shutdown.
    }
  }

  function emitStatus(
    runId: string,
    req: LivePromptRequest,
    repo: string,
    cwd: string,
    status: LiveStatusEvent["status"],
    extra: { exitCode?: number | null; error?: string } = {},
  ) {
    options.onStatus?.({
      runId,
      harness: req.harness,
      repo,
      branch: req.branch,
      status,
      cwd,
      ...extra,
      createdAt: new Date().toISOString(),
    });
  }

  function startLivePrompt(req: LivePromptRequest): StartLivePromptHandle {
    const runId = req.runId ?? randomUUID();
    const repo = req.repo?.trim() || "workspace";
    const cwdCheck = resolveAllowedCwd(req.cwd, allowedDirs);
    if (!cwdCheck.ok) {
      return failStart(runId, req.harness, cwdCheck.error, {
        rejected: cwdCheck.rejected,
      });
    }
    const spec = HARNESS_SPECS[req.harness];
    if (!spec) {
      return failStart(
        runId,
        req.harness,
        `Harness '${req.harness}' is not allowlisted`,
        { cwd: cwdCheck.cwd },
      );
    }
    const resolvedBin = resolveCliBinary(spec.binary, options.envPath);
    if (!resolvedBin) {
      return failStart(
        runId,
        req.harness,
        `CLI '${spec.binary}' not found in PATH`,
        { cwd: cwdCheck.cwd },
      );
    }

    const args = spec.buildArgs(req.prompt, cwdCheck.cwd);
    const commandLabel = `${spec.binary} ${args[0] ?? ""}`.trim();
    const timeoutMs = Math.max(
      100,
      Math.min(600_000, Math.round(req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)),
    );
    const startedAt = Date.now();
    const child = spawn(resolvedBin, args, {
      cwd: cwdCheck.cwd,
      env: { ...process.env, PATH: buildAugmentedPath(options.envPath) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    activeChildren.set(runId, child);
    recordSafe(
      req,
      repo,
      `Live run started: ${commandLabel}`,
      req.prompt.slice(0, 160),
    );
    emitStatus(runId, req, repo, cwdCheck.cwd, "running");

    const done = new Promise<LivePromptResult>((resolve) => {
      let output = "";
      let settled = false;
      const append = (stream: "stdout" | "stderr", buf: Buffer | string) => {
        const chunk = typeof buf === "string" ? buf : buf.toString("utf8");
        if (!chunk) return;
        if (output.length < MAX_OUTPUT_BYTES) {
          output += chunk.slice(0, MAX_OUTPUT_BYTES - output.length);
        }
        options.onOutput?.({
          runId,
          harness: req.harness,
          repo,
          stream,
          chunk,
          createdAt: new Date().toISOString(),
        });
      };
      const finish = (exitCode: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeChildren.delete(runId);
        const status = exitCode === 0 && !error ? "completed" : "failed";
        recordSafe(
          req,
          repo,
          `Live run ${status}: ${commandLabel} (exit ${exitCode ?? "null"})`,
        );
        emitStatus(runId, req, repo, cwdCheck.cwd, status, {
          exitCode,
          ...(error ? { error } : {}),
        });
        resolve({
          runId,
          started: true,
          harness: req.harness,
          command: commandLabel,
          cwd: cwdCheck.cwd,
          exitCode,
          output: output.trim(),
          ...(error ? { error } : {}),
          durationMs: Date.now() - startedAt,
        });
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(null, `Live execution timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (err) => finish(null, err.message));
      child.once("close", (code) => finish(code));
    });

    return {
      runId,
      started: true,
      command: commandLabel,
      cwd: cwdCheck.cwd,
      done,
    };
  }

  return {
    startLivePrompt,
    executeLivePrompt: (req: LivePromptRequest) => startLivePrompt(req).done,
    isHarnessAvailable,
    listActiveRuns: () => Array.from(activeChildren.keys()),
    stopAll: () => {
      for (const child of activeChildren.values()) child.kill("SIGTERM");
      activeChildren.clear();
    },
  };
}

export type LiveRunner = ReturnType<typeof createLiveRunner>;

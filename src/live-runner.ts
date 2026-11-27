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
import type { HarnessId, RunHistoryRecord } from "./protocol.ts";
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
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  "g",
);

const stripAnsi = (value: string) => value.replace(ANSI_ESCAPE_RE, "");

const defaultOpenCodeModel = () =>
  process.env.AGENTDECK_OPENCODE_MODEL?.trim() || "opencode/beam-free";

interface HarnessCliSpec {
  binary: string;
  buildArgs: (prompt: string, cwd: string) => string[];
}

const opencodeArgs = (prompt: string, cwd: string) => [
  "run",
  "-m",
  defaultOpenCodeModel(),
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
  threadId?: string;
  harness: HarnessId;
  prompt: string;
  rawPrompt?: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface LivePromptResult {
  runId: string;
  threadId?: string;
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
  onHistoryChange?: (record: RunHistoryRecord) => void;
  envPath?: string;
}

export type StartLivePromptHandle =
  | {
      runId: string;
      threadId?: string;
      started: false;
      rejected?: boolean;
      cwd?: string;
      error: string;
      done: Promise<LivePromptResult>;
    }
  | {
      runId: string;
      threadId: string;
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
    req: LivePromptRequest,
    repo: string,
    error: string,
    extra: { rejected?: boolean; cwd?: string } = {},
  ): StartLivePromptHandle {
    emitStatus(runId, req, repo, extra.cwd ?? "", "failed", { error });
    return {
      runId,
      started: false,
      ...extra,
      error,
      done: Promise.resolve({
        runId,
        started: false,
        harness: req.harness,
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
    if (repo === "workspace" || repo === "my-api-repo") return;
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
      return failStart(runId, req, repo, cwdCheck.error, {
        rejected: cwdCheck.rejected,
      });
    }
    const spec = HARNESS_SPECS[req.harness];
    if (!spec) {
      return failStart(
        runId,
        req,
        repo,
        `Harness '${req.harness}' is not allowlisted`,
        { cwd: cwdCheck.cwd },
      );
    }
    const resolvedBin = resolveCliBinary(spec.binary, options.envPath);
    if (!resolvedBin) {
      return failStart(
        runId,
        req,
        repo,
        `CLI '${spec.binary}' not found in PATH`,
        { cwd: cwdCheck.cwd },
      );
    }

    const threadId = req.threadId?.trim() || runId;
    const cleanPrompt = req.rawPrompt?.trim() || req.prompt;
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
    const startedRec = options.memoryStore?.history.recordRunStart({
      id: runId,
      threadId,
      repo,
      harness: req.harness,
      prompt: cleanPrompt,
    });
    if (startedRec) options.onHistoryChange?.(startedRec);
    recordSafe(req, repo, `Live run started: ${commandLabel}`);
    emitStatus(runId, req, repo, cwdCheck.cwd, "running");

    const done = new Promise<LivePromptResult>((resolve) => {
      let output = "";
      let settled = false;
      const pendingBuf: Record<"stdout" | "stderr", string> = {
        stdout: "",
        stderr: "",
      };
      const flushTimers: Partial<
        Record<"stdout" | "stderr", ReturnType<typeof setTimeout>>
      > = {};
      const flushStream = (stream: "stdout" | "stderr") => {
        const t = flushTimers[stream];
        if (t) {
          clearTimeout(t);
          delete flushTimers[stream];
        }
        const chunk = pendingBuf[stream];
        if (!chunk) return;
        pendingBuf[stream] = "";
        options.onOutput?.({
          runId,
          harness: req.harness,
          repo,
          stream,
          chunk,
          createdAt: new Date().toISOString(),
        });
      };
      const append = (stream: "stdout" | "stderr", buf: Buffer | string) => {
        const rawChunk = typeof buf === "string" ? buf : buf.toString("utf8");
        const chunk = stripAnsi(rawChunk);
        if (!chunk) return;
        if (output.length < MAX_OUTPUT_BYTES) {
          output += chunk.slice(0, MAX_OUTPUT_BYTES - output.length);
        }
        pendingBuf[stream] += chunk;
        if (
          pendingBuf[stream].includes("\n") ||
          pendingBuf[stream].length >= 512
        ) {
          flushStream(stream);
        } else if (!flushTimers[stream]) {
          flushTimers[stream] = setTimeout(() => flushStream(stream), 40);
        }
      };
      const finish = (exitCode: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushStream("stdout");
        flushStream("stderr");
        activeChildren.delete(runId);
        const status = exitCode === 0 && !error ? "completed" : "failed";
        const cleanOutput = stripAnsi(output).trim();
        const durationMs = Date.now() - startedAt;
        const finishedRec = options.memoryStore?.history.recordRunFinish({
          id: runId,
          output: cleanOutput,
          status,
          error,
          durationMs,
        });
        if (finishedRec) options.onHistoryChange?.(finishedRec);
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
          threadId,
          started: true,
          harness: req.harness,
          command: commandLabel,
          cwd: cwdCheck.cwd,
          exitCode,
          output: cleanOutput,
          ...(error ? { error } : {}),
          durationMs,
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
      threadId,
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

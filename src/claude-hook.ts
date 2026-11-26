import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { type ParsedClaudeHook, parseClaudeHookPayload } from "./protocol.ts";

export interface ClaudeHookOutput {
  hookEventName: "PermissionRequest" | "PreToolUse";
  decision?: {
    behavior: "allow" | "deny";
    message?: string;
  };
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  additionalContext?: string;
}

export interface ClaudeHookResponse {
  decision: "approve" | "deny" | "timeout";
  approvalId: string;
  replyNote?: string;
  hookSpecificOutput?: ClaudeHookOutput;
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

/** Derive a concise `1 file (+X -Y)` diff summary from Claude Edit/Write inputs. */
export function computeToolInputDiffSummary(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  if (
    toolName === "Edit" &&
    typeof toolInput.old_string === "string" &&
    typeof toolInput.new_string === "string"
  ) {
    const oldLines = countLines(toolInput.old_string);
    const newLines = countLines(toolInput.new_string);
    return `1 file (+${newLines} -${oldLines})`;
  }
  if (toolName === "Write" && typeof toolInput.content === "string") {
    const lines = countLines(toolInput.content);
    return `1 file (+${lines} -0)`;
  }
  return undefined;
}

function formatGitShortstat(shortstat: string): string | undefined {
  const filesMatch = shortstat.match(/(\d+)\s+files?\s+changed/);
  if (!filesMatch?.[1]) return undefined;
  const files = Number.parseInt(filesMatch[1], 10);
  const insMatch = shortstat.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = shortstat.match(/(\d+)\s+deletions?\(-\)/);
  const ins = insMatch?.[1] ? Number.parseInt(insMatch[1], 10) : 0;
  const del = delMatch?.[1] ? Number.parseInt(delMatch[1], 10) : 0;
  return `${files} file${files === 1 ? "" : "s"} (+${ins} -${del})`;
}

/** Enrich parsed Claude Code hook payload with Edit/Write diff or local git branch/shortstat. */
export function enrichClaudeHookPayload(raw: unknown): ParsedClaudeHook {
  const parsed = parseClaudeHookPayload(raw);
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const toolInput =
    obj.tool_input && typeof obj.tool_input === "object"
      ? (obj.tool_input as Record<string, unknown>)
      : {};
  const toolName =
    typeof obj.tool_name === "string" && obj.tool_name.trim()
      ? obj.tool_name.trim()
      : "Bash";
  const rawCwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";

  const hasExplicitBranch =
    typeof obj.branch === "string" && obj.branch.trim().length > 0;

  let branch = parsed.branch;
  let diffSummary = parsed.diffSummary;

  if (!diffSummary) {
    diffSummary = computeToolInputDiffSummary(toolName, toolInput);
  }

  let hasDirectory = false;
  if (rawCwd && existsSync(rawCwd)) {
    try {
      hasDirectory = statSync(rawCwd).isDirectory();
    } catch {
      hasDirectory = false;
    }
  }

  if (hasDirectory && (!hasExplicitBranch || !diffSummary)) {
    if (!hasExplicitBranch) {
      try {
        const gitBranch = execFileSync(
          "git",
          ["-C", rawCwd, "branch", "--show-current"],
          {
            encoding: "utf8",
            timeout: 500,
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim();
        if (gitBranch && gitBranch !== "HEAD") {
          branch = gitBranch;
        }
      } catch {
        // Not a git repository or git unavailable.
      }
    }

    if (!diffSummary) {
      try {
        const shortstat = execFileSync(
          "git",
          ["-C", rawCwd, "diff", "--shortstat", "HEAD"],
          {
            encoding: "utf8",
            timeout: 500,
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim();
        if (shortstat) {
          diffSummary = formatGitShortstat(shortstat);
        }
      } catch {
        // Repo has no HEAD commit yet or git unavailable.
      }
    }
  }

  const summary = parsed.requiresApproval
    ? `${parsed.repo} (${branch}): ${parsed.command}`
    : parsed.summary;

  return {
    ...parsed,
    branch,
    ...(diffSummary ? { diffSummary } : {}),
    summary,
  };
}

/** Build the bridge + Claude Code `hookSpecificOutput` JSON response for waiting hooks. */
export function buildClaudeHookResponse(params: {
  eventName: string;
  decision: "approve" | "deny" | "timeout";
  approvalId: string;
  replyNote?: string;
}): ClaudeHookResponse {
  const { eventName, decision, approvalId, replyNote } = params;
  const base: ClaudeHookResponse = {
    decision,
    approvalId,
    ...(replyNote ? { replyNote } : {}),
  };

  if (eventName === "PermissionRequest") {
    if (decision === "approve") {
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      };
    }
    if (decision === "deny") {
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: replyNote ?? "Denied remotely via AgentDeck",
          },
        },
      };
    }
    return base;
  }

  if (eventName === "PreToolUse") {
    if (decision === "approve") {
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          ...(replyNote
            ? {
                permissionDecisionReason: replyNote,
                additionalContext: replyNote,
              }
            : {}),
        },
      };
    }
    if (decision === "deny") {
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            replyNote ?? "Denied remotely via AgentDeck",
        },
      };
    }
    return {
      ...base,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    };
  }

  return base;
}

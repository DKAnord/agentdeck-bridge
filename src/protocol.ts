import { basename } from "node:path";

export type HarnessId =
  | "claude_code"
  | "antigravity"
  | "codex"
  | "openclaw"
  | "gemini_cli"
  | "opencode"
  | "custom";

export interface QuotaWindow {
  harness: HarnessId;
  label: string;
  remainingPct: number;
  resetsInMinutes?: number;
  tier: "free" | "pro" | "local";
  status: "active" | "idle" | "waiting" | "capped";
}

export interface ApprovalRequest {
  id: string;
  harness: HarnessId;
  repo: string;
  branch: string;
  command: string;
  diffSummary?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  replyNote?: string;
}

export interface BridgeEvent {
  id: string;
  type: string;
  harness: HarnessId;
  summary: string;
  createdAt: string;
}

export interface DeckSnapshot {
  protocolVersion: 1;
  host: string;
  updatedAt: string;
  harnesses: QuotaWindow[];
  pendingApprovals: ApprovalRequest[];
  recentEvents: BridgeEvent[];
}

export interface ParsedClaudeHook {
  eventName: string;
  requiresApproval: boolean;
  harness: HarnessId;
  repo: string;
  branch: string;
  command: string;
  diffSummary?: string;
  summary: string;
}

const VALID_HARNESSES = new Set<HarnessId>([
  "claude_code",
  "antigravity",
  "codex",
  "openclaw",
  "gemini_cli",
  "opencode",
  "custom",
]);

const VALID_TIERS = new Set<QuotaWindow["tier"]>(["free", "pro", "local"]);
const VALID_STATUSES = new Set<QuotaWindow["status"]>([
  "active",
  "idle",
  "waiting",
  "capped",
]);

export function createEmptySnapshot(host: string): DeckSnapshot {
  return {
    protocolVersion: 1,
    host,
    updatedAt: new Date().toISOString(),
    harnesses: [],
    pendingApprovals: [],
    recentEvents: [],
  };
}

function strOrFallback(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseClaudeHookPayload(raw: unknown): ParsedClaudeHook {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const toolInput =
    obj.tool_input && typeof obj.tool_input === "object"
      ? (obj.tool_input as Record<string, unknown>)
      : {};

  const eventName = strOrFallback(obj.hook_event_name, "Notification");
  const toolName = strOrFallback(obj.tool_name, "Bash");
  const cwd = strOrFallback(obj.cwd, "workspace");
  const repo = strOrFallback(obj.repo, basename(cwd) || "workspace");
  const branch = strOrFallback(obj.branch, "main");
  const command = strOrFallback(
    toolInput.command ?? toolInput.file_path ?? obj.message,
    `${toolName} action`,
  );
  const diffSummary =
    typeof obj.diff_summary === "string" && obj.diff_summary.trim()
      ? obj.diff_summary.trim()
      : undefined;

  const requiresApproval =
    eventName === "PermissionRequest" || eventName === "PreToolUse";

  const summary = requiresApproval
    ? `${repo} (${branch}): ${command}`
    : `${eventName}: ${strOrFallback(obj.message, "Claude Code event")}`;

  return {
    eventName,
    requiresApproval,
    harness: "claude_code",
    repo,
    branch,
    command,
    diffSummary,
    summary,
  };
}

export function normalizeQuotaWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const harness =
    typeof obj.harness === "string" &&
    VALID_HARNESSES.has(obj.harness as HarnessId)
      ? (obj.harness as HarnessId)
      : null;
  if (!harness) return null;

  const label = strOrFallback(obj.label, harness);
  const rawPct = typeof obj.remainingPct === "number" ? obj.remainingPct : 100;
  const remainingPct = Math.max(0, Math.min(100, Math.round(rawPct)));
  const resetsInMinutes =
    typeof obj.resetsInMinutes === "number" && obj.resetsInMinutes >= 0
      ? Math.round(obj.resetsInMinutes)
      : undefined;
  const tier =
    typeof obj.tier === "string" &&
    VALID_TIERS.has(obj.tier as QuotaWindow["tier"])
      ? (obj.tier as QuotaWindow["tier"])
      : "local";
  const status =
    typeof obj.status === "string" &&
    VALID_STATUSES.has(obj.status as QuotaWindow["status"])
      ? (obj.status as QuotaWindow["status"])
      : remainingPct === 0
        ? "capped"
        : "idle";

  return {
    harness,
    label,
    remainingPct,
    ...(resetsInMinutes !== undefined ? { resetsInMinutes } : {}),
    tier,
    status,
  };
}

import { basename } from "node:path";

export type HarnessId =
  | "claude_code"
  | "antigravity"
  | "codex"
  | "openclaw"
  | "gemini_cli"
  | "opencode"
  | "free_pool"
  | "custom";

export type TaskComplexity = "light" | "medium" | "heavy";

export interface FreeProviderSlot {
  id: string;
  label: string;
  remainingPct: number;
  resetsInMinutes?: number;
  cooldownUntil?: string;
}

export interface MemoryRecord {
  id: string;
  repo: string;
  scope: string;
  summary: string;
  tags: string[];
  sourceHarness: HarnessId;
  createdAt: string;
}

export interface HandoffCapsule {
  repo: string;
  branch: string;
  goal: string;
  lastHarness: HarnessId;
  diffSummary?: string;
  touchedFiles: string[];
  recentActions: string[];
  notes: string[];
  updatedAt: string;
}

export interface RouteDecision {
  selectedHarness: HarnessId;
  complexity: TaskComplexity;
  reason:
    | "pro_headroom"
    | "reset_harvest"
    | "reserve_floor_overflow"
    | "capped_failover"
    | "free_pool_default"
    | "preferred_harness";
  reserveFloorPct: number;
  freeProvider?: string;
  handoffPrompt: string;
  capsule?: HandoffCapsule;
  resetNudge?: string;
}

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

export interface GitHubPulseRepo {
  repo: string;
  branch: string;
  openIssues: number;
  openPrs: number;
  ciStatus: "pass" | "fail" | "pending" | "unknown";
  updatedAt: string;
}

export interface RunHistoryRecord {
  id: string;
  threadId: string;
  repo: string;
  harness: HarnessId;
  prompt: string;
  output: string;
  status: "running" | "completed" | "failed";
  error?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeckSnapshot {
  protocolVersion: 1;
  host: string;
  updatedAt: string;
  harnesses: QuotaWindow[];
  pendingApprovals: ApprovalRequest[];
  recentEvents: BridgeEvent[];
  handoffs: HandoffCapsule[];
  pulses: GitHubPulseRepo[];
  recentRuns: RunHistoryRecord[];
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
  "free_pool",
  "custom",
]);

const VALID_TIERS = new Set<QuotaWindow["tier"]>(["free", "pro", "local"]);
const VALID_STATUSES = new Set<QuotaWindow["status"]>([
  "active",
  "idle",
  "waiting",
  "capped",
]);

export function parseHarnessId(value: unknown): HarnessId | null {
  return typeof value === "string" && VALID_HARNESSES.has(value as HarnessId)
    ? (value as HarnessId)
    : null;
}

export function createEmptySnapshot(host: string): DeckSnapshot {
  return {
    protocolVersion: 1,
    host,
    updatedAt: new Date().toISOString(),
    harnesses: [],
    pendingApprovals: [],
    recentEvents: [],
    handoffs: [],
    pulses: [],
    recentRuns: [],
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
  const harness = parseHarnessId(obj.harness);
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

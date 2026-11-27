import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runLiveDispatchExecution } from "./live-routes.ts";
import type { LiveRunner } from "./live-runner.ts";
import type { MemoryStore } from "./memory-store.ts";
import {
  type ApprovalRequest,
  type BridgeEvent,
  type DeckSnapshot,
  normalizeQuotaWindow,
  parseHarnessId,
  type QuotaWindow,
  type TaskComplexity,
} from "./protocol.ts";
import type { RelayClientStatus } from "./relay-client.ts";
import {
  type createFreePoolManager,
  selectProactiveHarness,
} from "./router.ts";

const MAX_BODY_BYTES = 65_536;

export interface BridgeHttpResponse {
  status: number;
  body: unknown;
}

export interface PendingWaiter {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: {
    decision: "approve" | "deny" | "timeout";
    approvalId: string;
    replyNote?: string;
  }) => void;
}

export interface BridgeRouteContext {
  snapshot: DeckSnapshot;
  memoryStore: MemoryStore;
  freePool: ReturnType<typeof createFreePoolManager>;
  liveRunner: LiveRunner;
  waiters: Map<string, PendingWaiter>;
  delayTimers: Set<ReturnType<typeof setTimeout>>;
  defaultReserveFloorPct: number;
  webhookUrl?: string;
  authToken?: string;
  isStopped: () => boolean;
  getDirectBaseUrl: () => string;
  getRelayStatus: () => RelayClientStatus | null;
  pushRecentEvent: (event: BridgeEvent) => void;
  touchSnapshot: () => void;
  broadcast: (eventName: string, data: unknown) => void;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function isAuthorized(
  req: IncomingMessage,
  authToken?: string,
): boolean {
  if (!authToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(authToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function notifyWebhook(
  webhookUrl: string | undefined,
  approval: ApprovalRequest,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: `AgentDeck: ${approval.repo} (${approval.branch})`,
      },
      body: `Approval needed: ${approval.command}`,
    });
  } catch {
    // Best-effort notification webhook; never block hook pipeline.
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

export function extractHookFilePath(
  rawObj: Record<string, unknown>,
): string | undefined {
  const toolInput =
    rawObj.tool_input && typeof rawObj.tool_input === "object"
      ? (rawObj.tool_input as Record<string, unknown>)
      : {};
  return typeof toolInput.file_path === "string" && toolInput.file_path.trim()
    ? toolInput.file_path.trim()
    : undefined;
}

export function upsertQuotaWindow(
  snapshot: DeckSnapshot,
  quota: QuotaWindow,
): void {
  const idx = snapshot.harnesses.findIndex(
    (item) => item.harness === quota.harness,
  );
  if (idx >= 0) snapshot.harnesses[idx] = quota;
  else snapshot.harnesses.push(quota);
}

export const parseComplexity = (val: unknown): TaskComplexity | undefined =>
  val === "light" || val === "medium" || val === "heavy" ? val : undefined;

function parseHeaderMap(
  raw: unknown,
): Record<string, string | undefined> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function handleExtendedBridgeRoute(
  ctx: BridgeRouteContext,
  method: string,
  url: URL,
  obj: Record<string, unknown>,
): Promise<BridgeHttpResponse | null> {
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/quota") {
    const quota = normalizeQuotaWindow(obj);
    if (!quota)
      return { status: 400, body: { error: "Invalid quota payload" } };
    upsertQuotaWindow(ctx.snapshot, quota);
    ctx.touchSnapshot();
    ctx.broadcast("quota_updated", quota);
    return { status: 200, body: { ok: true, quota } };
  }

  if (method === "POST" && pathname === "/v1/dispatch") {
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!prompt) {
      return {
        status: 400,
        body: { error: "prompt must be a non-empty string" },
      };
    }
    const repo =
      typeof obj.repo === "string" && obj.repo.trim()
        ? obj.repo.trim()
        : "workspace";
    const branch =
      typeof obj.branch === "string" && obj.branch.trim()
        ? obj.branch.trim()
        : undefined;
    const reserveFloorPct =
      typeof obj.reserveFloorPct === "number"
        ? Math.max(0, Math.min(90, Math.round(obj.reserveFloorPct)))
        : ctx.defaultReserveFloorPct;
    const threadId =
      typeof obj.threadId === "string" && obj.threadId.trim()
        ? obj.threadId.trim()
        : randomUUID();

    const isGenericScope = repo === "workspace" || repo === "my-api-repo";
    const { capsule, block: rawBlock } = isGenericScope
      ? {
          capsule: undefined,
          block: "",
        }
      : ctx.memoryStore.buildHandoffContextBlock(repo, prompt);
    const contextParts: string[] = [];
    if (rawBlock) contextParts.push(rawBlock);
    if (isGenericScope) {
      if (ctx.snapshot.pulses.length > 0) {
        contextParts.push(
          `[Live GitHub Repo Pulse]\n${ctx.snapshot.pulses
            .map(
              (p) =>
                `- ${p.repo} (${p.branch}): CI=${p.ciStatus}, ${p.openIssues} open issues, ${p.openPrs} open PRs`,
            )
            .join("\n")}`,
        );
      }
      const memories = ctx.memoryStore.recall({ query: prompt, limit: 3 });
      if (memories.length > 0) {
        contextParts.push(
          `Recalled memories:\n${memories
            .map((m) => `- [${m.repo}/${m.scope}] ${m.summary}`)
            .join("\n")}`,
        );
      }
    }
    const threadBlock =
      ctx.memoryStore.history.buildThreadContextBlock(threadId);
    if (threadBlock) contextParts.push(threadBlock);
    const contextBlock = contextParts.join("\n\n");
    const route = selectProactiveHarness({
      prompt,
      harnesses: ctx.snapshot.harnesses,
      complexity: parseComplexity(obj.complexity),
      preferredHarness: parseHarnessId(obj.preferredHarness) ?? undefined,
      reserveFloorPct,
      freePool: ctx.freePool,
      contextBlock,
      capsule,
    });
    if (!isGenericScope) {
      ctx.memoryStore.recordActivity({
        repo,
        branch,
        harness: route.selectedHarness,
        goal: prompt.slice(0, 160),
        action: `Dispatched: ${prompt.slice(0, 120)}`,
      });
      ctx.snapshot.handoffs = ctx.memoryStore.listHandoffs();
    }
    ctx.touchSnapshot();
    ctx.broadcast("task_routed", route);

    if (obj.executeNow) {
      const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
      const waitMs = typeof obj.waitMs === "number" ? obj.waitMs : undefined;
      const execRes = await runLiveDispatchExecution(ctx, {
        harness: route.selectedHarness,
        prompt: route.handoffPrompt,
        rawPrompt: prompt,
        threadId,
        repo,
        branch,
        cwd,
        waitMs,
      });
      if (execRes.status === 403) {
        return {
          status: 403,
          body: {
            ok: false,
            error: execRes.run.error,
            threadId,
            route,
            run: execRes.run,
          },
        };
      }
      return {
        status: 200,
        body: { ok: true, threadId, route, run: execRes.run },
      };
    }
    const stagedId = randomUUID();
    const stagedStart = ctx.memoryStore.history.recordRunStart({
      id: stagedId,
      threadId,
      repo,
      harness: route.selectedHarness,
      prompt,
    });
    const stagedRecord =
      ctx.memoryStore.history.recordRunFinish({
        id: stagedId,
        output: `Staged prompt for ${route.selectedHarness}.`,
        status: "completed",
        durationMs: 0,
      }) ?? stagedStart;
    ctx.snapshot.recentRuns = ctx.memoryStore.history.listRuns({
      limit: 20,
      maxOutputChars: 4000,
    });
    ctx.touchSnapshot();
    ctx.broadcast("history_updated", stagedRecord);
    return { status: 200, body: { ok: true, threadId, route } };
  }

  if (method === "POST" && pathname === "/v1/free-pool") {
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id) {
      return {
        status: 400,
        body: { error: "id is required for free-pool slot" },
      };
    }
    const slot = ctx.freePool.upsertSlot({
      id,
      label: typeof obj.label === "string" ? obj.label : undefined,
      remainingPct:
        typeof obj.remainingPct === "number" ? obj.remainingPct : undefined,
      resetsInMinutes:
        typeof obj.resetsInMinutes === "number"
          ? obj.resetsInMinutes
          : undefined,
      rateLimitHeaders: parseHeaderMap(obj.rateLimitHeaders),
      status429: Boolean(obj.status429),
    });
    const quota = ctx.freePool.toQuotaWindow();
    upsertQuotaWindow(ctx.snapshot, quota);
    ctx.touchSnapshot();
    ctx.broadcast("quota_updated", quota);
    return {
      status: 200,
      body: { ok: true, slot, quota, slots: ctx.freePool.listSlots() },
    };
  }

  if (method === "GET" && pathname === "/v1/memory") {
    const repo = url.searchParams.get("repo")?.trim() || undefined;
    const q = url.searchParams.get("q")?.trim() || undefined;
    return {
      status: 200,
      body: {
        ok: true,
        handoff: repo ? ctx.memoryStore.getHandoff(repo) : null,
        handoffs: ctx.memoryStore.listHandoffs(),
        memories: ctx.memoryStore.recall({ query: q, repo }),
      },
    };
  }

  if (method === "POST" && pathname === "/v1/memory") {
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!summary)
      return { status: 400, body: { error: "summary is required" } };
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((item): item is string => typeof item === "string")
      : undefined;
    const memory = ctx.memoryStore.remember({
      repo: typeof obj.repo === "string" ? obj.repo : undefined,
      scope: typeof obj.scope === "string" ? obj.scope : undefined,
      summary,
      tags,
      sourceHarness: parseHarnessId(obj.harness) ?? "custom",
    });
    ctx.touchSnapshot();
    ctx.broadcast("memory_updated", memory);
    return { status: 201, body: { ok: true, memory } };
  }

  return null;
}

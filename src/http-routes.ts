import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryStore } from "./memory-store.ts";
import {
  type ApprovalRequest,
  type DeckSnapshot,
  normalizeQuotaWindow,
  parseHarnessId,
  type QuotaWindow,
  type TaskComplexity,
} from "./protocol.ts";
import {
  type createFreePoolManager,
  selectProactiveHarness,
} from "./router.ts";

const MAX_BODY_BYTES = 65_536;

export interface BridgeRouteContext {
  snapshot: DeckSnapshot;
  memoryStore: MemoryStore;
  freePool: ReturnType<typeof createFreePoolManager>;
  defaultReserveFloorPct: number;
  touchSnapshot: () => void;
  broadcastSse: (eventName: string, data: unknown) => void;
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

export async function readJsonObjectOrError(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody(req);
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch (err) {
    const tooBig = err instanceof Error && err.message === "PAYLOAD_TOO_LARGE";
    sendJson(res, tooBig ? 413 : 400, { error: "Invalid JSON payload" });
    return null;
  }
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

const parseComplexity = (val: unknown): TaskComplexity | undefined =>
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
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/quota") {
    const obj = await readJsonObjectOrError(req, res);
    if (!obj) return true;
    const quota = normalizeQuotaWindow(obj);
    if (!quota) {
      sendJson(res, 400, { error: "Invalid quota payload" });
      return true;
    }
    upsertQuotaWindow(ctx.snapshot, quota);
    ctx.touchSnapshot();
    ctx.broadcastSse("quota_updated", quota);
    sendJson(res, 200, { ok: true, quota });
    return true;
  }

  if (method === "POST" && pathname === "/v1/dispatch") {
    const obj = await readJsonObjectOrError(req, res);
    if (!obj) return true;
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!prompt) {
      sendJson(res, 400, { error: "prompt must be a non-empty string" });
      return true;
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

    const { capsule, block } = ctx.memoryStore.buildHandoffContextBlock(
      repo,
      prompt,
    );
    const route = selectProactiveHarness({
      prompt,
      harnesses: ctx.snapshot.harnesses,
      complexity: parseComplexity(obj.complexity),
      preferredHarness: parseHarnessId(obj.preferredHarness) ?? undefined,
      reserveFloorPct,
      freePool: ctx.freePool,
      contextBlock: block,
      capsule,
    });
    ctx.memoryStore.recordActivity({
      repo,
      branch,
      harness: route.selectedHarness,
      goal: prompt.slice(0, 160),
      action: `Dispatched: ${prompt.slice(0, 120)}`,
    });
    ctx.snapshot.handoffs = ctx.memoryStore.listHandoffs();
    ctx.touchSnapshot();
    ctx.broadcastSse("task_routed", route);
    sendJson(res, 200, { ok: true, route });
    return true;
  }

  if (method === "POST" && pathname === "/v1/free-pool") {
    const obj = await readJsonObjectOrError(req, res);
    if (!obj) return true;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id) {
      sendJson(res, 400, { error: "id is required for free-pool slot" });
      return true;
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
    ctx.broadcastSse("quota_updated", quota);
    sendJson(res, 200, {
      ok: true,
      slot,
      quota,
      slots: ctx.freePool.listSlots(),
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/memory") {
    const repo = url.searchParams.get("repo")?.trim() || undefined;
    const q = url.searchParams.get("q")?.trim() || undefined;
    sendJson(res, 200, {
      ok: true,
      handoff: repo ? ctx.memoryStore.getHandoff(repo) : null,
      handoffs: ctx.memoryStore.listHandoffs(),
      memories: ctx.memoryStore.recall({ query: q, repo }),
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/memory") {
    const obj = await readJsonObjectOrError(req, res);
    if (!obj) return true;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!summary) {
      sendJson(res, 400, { error: "summary is required" });
      return true;
    }
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
    ctx.broadcastSse("memory_updated", memory);
    sendJson(res, 201, { ok: true, memory });
    return true;
  }

  return false;
}

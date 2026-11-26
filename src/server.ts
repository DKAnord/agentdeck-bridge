import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import {
  buildClaudeHookResponse,
  enrichClaudeHookPayload,
} from "./claude-hook.ts";
import {
  type BridgeRouteContext,
  extractHookFilePath,
  handleExtendedBridgeRoute,
  isAuthorized,
  notifyWebhook,
  readJsonObjectOrError,
  sendJson,
} from "./http-routes.ts";
import { createMemoryStore } from "./memory-store.ts";
import {
  type ApprovalRequest,
  type BridgeEvent,
  createEmptySnapshot,
  type DeckSnapshot,
} from "./protocol.ts";
import { createFreePoolManager } from "./router.ts";

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  webhookUrl?: string;
  hostnameLabel?: string;
  memoryDbPath?: string;
  reserveFloorPct?: number;
}

export interface BridgeServerHandle {
  server: Server;
  start: () => Promise<{ host: string; port: number; url: string }>;
  stop: () => Promise<void>;
  getSnapshot: () => DeckSnapshot;
}

interface PendingWaiter {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: {
    decision: "approve" | "deny" | "timeout";
    approvalId: string;
    replyNote?: string;
  }) => void;
}

export function createBridgeServer(
  options: BridgeServerOptions = {},
): BridgeServerHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7742;
  const authToken = options.authToken?.trim() || undefined;
  const webhookUrl = options.webhookUrl?.trim() || undefined;
  const snapshot = createEmptySnapshot(options.hostnameLabel ?? hostname());
  const sseClients = new Set<ServerResponse>();
  const waiters = new Map<string, PendingWaiter>();
  const memoryStore = createMemoryStore(options.memoryDbPath ?? ":memory:");
  const freePool = createFreePoolManager();
  snapshot.handoffs = memoryStore.listHandoffs();

  const touchSnapshot = () => {
    snapshot.updatedAt = new Date().toISOString();
  };

  function pushRecentEvent(event: BridgeEvent): void {
    snapshot.recentEvents = [event, ...snapshot.recentEvents].slice(0, 25);
    touchSnapshot();
  }

  function broadcastSse(eventName: string, data: unknown): void {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(frame);
    }
  }

  function expireApproval(approval: ApprovalRequest): void {
    if (approval.status !== "pending") return;
    approval.status = "expired";
    touchSnapshot();
    broadcastSse("approval_expired", approval);
  }

  const routeCtx: BridgeRouteContext = {
    snapshot,
    memoryStore,
    freePool,
    defaultReserveFloorPct: options.reserveFloorPct ?? 20,
    touchSnapshot,
    broadcastSse,
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/v1/health") {
      sendJson(res, 200, {
        ok: true,
        protocolVersion: 1,
        pendingApprovals: snapshot.pendingApprovals.filter(
          (item) => item.status === "pending",
        ).length,
        sseClients: sseClients.size,
      });
      return;
    }

    if (!isAuthorized(req, authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (method === "GET" && pathname === "/v1/snapshot") {
      sendJson(res, 200, snapshot);
      return;
    }

    if (method === "GET" && pathname === "/v1/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (method === "POST" && pathname === "/v1/hooks/claude") {
      const rawObj = await readJsonObjectOrError(req, res);
      if (!rawObj) return;

      const parsed = enrichClaudeHookPayload(rawObj);
      memoryStore.recordActivity({
        repo: parsed.repo,
        branch: parsed.branch,
        harness: parsed.harness,
        action: parsed.command,
        filePath: extractHookFilePath(rawObj),
        diffSummary: parsed.diffSummary,
      });
      snapshot.handoffs = memoryStore.listHandoffs();

      const evt: BridgeEvent = {
        id: randomUUID(),
        type: parsed.eventName,
        harness: parsed.harness,
        summary: parsed.summary,
        createdAt: new Date().toISOString(),
      };
      pushRecentEvent(evt);

      if (!parsed.requiresApproval) {
        broadcastSse("hook_event", evt);
        sendJson(res, 200, { ok: true, eventId: evt.id });
        return;
      }

      const approval: ApprovalRequest = {
        id: randomUUID(),
        harness: parsed.harness,
        repo: parsed.repo,
        branch: parsed.branch,
        command: parsed.command,
        ...(parsed.diffSummary ? { diffSummary: parsed.diffSummary } : {}),
        createdAt: evt.createdAt,
        status: "pending",
      };
      snapshot.pendingApprovals = [
        approval,
        ...snapshot.pendingApprovals,
      ].slice(0, 20);
      touchSnapshot();
      broadcastSse("approval_requested", approval);
      void notifyWebhook(webhookUrl, approval);

      if (url.searchParams.get("wait") !== "1") {
        sendJson(res, 202, { ok: true, approvalId: approval.id });
        return;
      }

      const rawTimeout = Number.parseInt(
        url.searchParams.get("timeoutMs") ?? "600000",
        10,
      );
      const timeoutMs = Number.isNaN(rawTimeout)
        ? 600_000
        : Math.max(100, Math.min(900_000, rawTimeout));

      const result = await new Promise<{
        decision: "approve" | "deny" | "timeout";
        approvalId: string;
        replyNote?: string;
      }>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(approval.id);
          expireApproval(approval);
          resolve({ decision: "timeout", approvalId: approval.id });
        }, timeoutMs);
        waiters.set(approval.id, { timer, resolve });
        req.once("close", () => {
          const pending = waiters.get(approval.id);
          if (pending) {
            clearTimeout(pending.timer);
            waiters.delete(approval.id);
            expireApproval(approval);
            resolve({ decision: "timeout", approvalId: approval.id });
          }
        });
      });

      sendJson(
        res,
        200,
        buildClaudeHookResponse({
          eventName: parsed.eventName,
          decision: result.decision,
          approvalId: result.approvalId,
          replyNote: result.replyNote,
        }),
      );
      return;
    }

    const resolveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/resolve$/);
    if (method === "POST" && resolveMatch?.[1]) {
      const approvalId = decodeURIComponent(resolveMatch[1]);
      const obj = await readJsonObjectOrError(req, res);
      if (!obj) return;

      const decision =
        obj.decision === "approve" || obj.decision === "deny"
          ? obj.decision
          : null;
      if (!decision) {
        sendJson(res, 400, { error: "decision must be 'approve' or 'deny'" });
        return;
      }
      const replyNote =
        typeof obj.replyNote === "string" && obj.replyNote.trim()
          ? obj.replyNote.trim()
          : undefined;

      const approval = snapshot.pendingApprovals.find(
        (item) => item.id === approvalId,
      );
      if (!approval) {
        sendJson(res, 404, { error: "Approval not found" });
        return;
      }

      approval.status = decision === "approve" ? "approved" : "denied";
      if (replyNote) {
        approval.replyNote = replyNote;
        memoryStore.recordActivity({
          repo: approval.repo,
          branch: approval.branch,
          harness: approval.harness,
          note: replyNote,
        });
        snapshot.handoffs = memoryStore.listHandoffs();
      }
      touchSnapshot();
      broadcastSse("approval_resolved", approval);

      const waiter = waiters.get(approvalId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(approvalId);
        waiter.resolve({
          decision,
          approvalId,
          ...(replyNote ? { replyNote } : {}),
        });
      }
      sendJson(res, 200, { ok: true, approval });
      return;
    }

    if (await handleExtendedBridgeRoute(routeCtx, method, url, req, res))
      return;
    sendJson(res, 404, { error: "Not found" });
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          const boundPort = addr && typeof addr === "object" ? addr.port : port;
          resolve({
            host,
            port: boundPort,
            url: `http://${host}:${boundPort}`,
          });
        });
      }),
    stop: async () => {
      for (const [id, waiter] of waiters.entries()) {
        clearTimeout(waiter.timer);
        waiters.delete(id);
        waiter.resolve({ decision: "timeout", approvalId: id });
      }
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      memoryStore.close();
    },
    getSnapshot: () => snapshot,
  };
}

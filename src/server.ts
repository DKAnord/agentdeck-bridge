import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { hostname } from "node:os";
import {
  type ApprovalRequest,
  type BridgeEvent,
  createEmptySnapshot,
  type DeckSnapshot,
  normalizeQuotaWindow,
  parseClaudeHookPayload,
} from "./protocol.ts";

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  webhookUrl?: string;
  hostnameLabel?: string;
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

const MAX_BODY_BYTES = 65_536;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(authToken);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as unknown;
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

  function touchSnapshot(): void {
    snapshot.updatedAt = new Date().toISOString();
  }

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

  async function notifyWebhook(approval: ApprovalRequest): Promise<void> {
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
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const tooBig =
          err instanceof Error && err.message === "PAYLOAD_TOO_LARGE";
        sendJson(res, tooBig ? 413 : 400, { error: "Invalid JSON payload" });
        return;
      }

      const parsed = parseClaudeHookPayload(body);
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
      void notifyWebhook(approval);

      if (url.searchParams.get("wait") !== "1") {
        sendJson(res, 202, { ok: true, approvalId: approval.id });
        return;
      }

      const rawTimeout = Number.parseInt(
        url.searchParams.get("timeoutMs") ?? "30000",
        10,
      );
      const timeoutMs = Number.isNaN(rawTimeout)
        ? 30_000
        : Math.max(100, Math.min(300_000, rawTimeout));

      const result = await new Promise<{
        decision: "approve" | "deny" | "timeout";
        approvalId: string;
        replyNote?: string;
      }>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(approval.id);
          resolve({ decision: "timeout", approvalId: approval.id });
        }, timeoutMs);
        waiters.set(approval.id, { timer, resolve });
        req.once("close", () => {
          const pending = waiters.get(approval.id);
          if (pending) {
            clearTimeout(pending.timer);
            waiters.delete(approval.id);
            resolve({ decision: "timeout", approvalId: approval.id });
          }
        });
      });

      sendJson(res, 200, result);
      return;
    }

    const resolveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/resolve$/);
    if (method === "POST" && resolveMatch?.[1]) {
      const approvalId = decodeURIComponent(resolveMatch[1]);
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON payload" });
        return;
      }

      const obj =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const decision =
        obj.decision === "approve" || obj.decision === "deny"
          ? obj.decision
          : null;
      if (!decision) {
        sendJson(res, 400, {
          error: "decision must be 'approve' or 'deny'",
        });
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
      if (replyNote) approval.replyNote = replyNote;
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

    if (method === "POST" && pathname === "/v1/quota") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON payload" });
        return;
      }

      const quota = normalizeQuotaWindow(body);
      if (!quota) {
        sendJson(res, 400, { error: "Invalid quota payload" });
        return;
      }

      const idx = snapshot.harnesses.findIndex(
        (item) => item.harness === quota.harness,
      );
      if (idx >= 0) {
        snapshot.harnesses[idx] = quota;
      } else {
        snapshot.harnesses.push(quota);
      }
      touchSnapshot();
      broadcastSse("quota_updated", quota);
      sendJson(res, 200, { ok: true, quota });
      return;
    }

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
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
    getSnapshot: () => snapshot,
  };
}

import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { handleApprovalBridgeRoute } from "./approval-routes.ts";
import { pollGitHubPulse } from "./github-pulse.ts";
import {
  type BridgeHttpResponse,
  type BridgeRouteContext,
  handleExtendedBridgeRoute,
  isAuthorized,
  type PendingWaiter,
  readJsonBody,
  sendJson,
} from "./http-routes.ts";
import { handleLiveBridgeRoute } from "./live-routes.ts";
import { createLiveRunner } from "./live-runner.ts";
import { createMemoryStore } from "./memory-store.ts";
import {
  type BridgeEvent,
  createEmptySnapshot,
  type DeckSnapshot,
} from "./protocol.ts";
import {
  createRelayClient,
  type RelayClient,
  type RelayClientStatus,
} from "./relay-client.ts";
import { createFreePoolManager } from "./router.ts";

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  webhookUrl?: string;
  hostnameLabel?: string;
  memoryDbPath?: string;
  reserveFloorPct?: number;
  relayUrl?: string;
  relaySessionPath?: string;
  allowedDirs?: string[];
  enableGitHubPulse?: boolean;
  autoDetectHarnesses?: boolean;
}

export interface BridgeServerHandle {
  server: Server;
  start: () => Promise<{ host: string; port: number; url: string }>;
  stop: () => Promise<void>;
  getSnapshot: () => DeckSnapshot;
  handleRequest: (
    method: string,
    path: string,
    body?: unknown,
    abortSignal?: AbortSignal,
  ) => Promise<BridgeHttpResponse>;
  getRelayStatus: () => RelayClientStatus | null;
}

function coerceBodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  }
  return typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function createBridgeServer(
  options: BridgeServerOptions = {},
): BridgeServerHandle {
  const host = options.host ?? "127.0.0.1";
  const initialPort = options.port ?? 7742;
  let boundPort = initialPort;
  const authToken = options.authToken?.trim() || undefined;
  const webhookUrl = options.webhookUrl?.trim() || undefined;
  const snapshot = createEmptySnapshot(options.hostnameLabel ?? hostname());
  const sseClients = new Set<ServerResponse>();
  const waiters = new Map<string, PendingWaiter>();
  const delayTimers = new Set<ReturnType<typeof setTimeout>>();
  const memoryStore = createMemoryStore(options.memoryDbPath ?? ":memory:");
  const freePool = createFreePoolManager();
  snapshot.handoffs = memoryStore.listHandoffs();
  snapshot.recentRuns = memoryStore.history.listRuns({
    limit: 20,
    maxOutputChars: 4000,
  });

  let stopped = false;
  let pulseTimer: ReturnType<typeof setInterval> | null = null;
  let relayClient: RelayClient | null = null;

  const touchSnapshot = () => {
    snapshot.updatedAt = new Date().toISOString();
  };

  function pushRecentEvent(event: BridgeEvent): void {
    snapshot.recentEvents = [event, ...snapshot.recentEvents].slice(0, 25);
    touchSnapshot();
  }

  function broadcast(eventName: string, data: unknown): void {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(frame);
    }
    relayClient?.forwardEvent(eventName, data);
  }

  const liveRunner = createLiveRunner({
    allowedDirs: options.allowedDirs,
    memoryStore,
    onOutput: (evt) => broadcast("run_output", evt),
    onStatus: (evt) => {
      snapshot.handoffs = memoryStore.listHandoffs();
      pushRecentEvent({
        id: randomUUID(),
        type: `run_${evt.status}`,
        harness: evt.harness,
        summary: `${evt.repo}: ${evt.harness} ${evt.status}`,
        createdAt: evt.createdAt,
      });
      broadcast("run_status", evt);
    },
    onHistoryChange: (record) => {
      snapshot.recentRuns = memoryStore.history.listRuns({
        limit: 20,
        maxOutputChars: 4000,
      });
      touchSnapshot();
      broadcast("history_updated", record);
    },
  });

  if (options.autoDetectHarnesses) {
    if (liveRunner.isHarnessAvailable("antigravity")) {
      snapshot.harnesses.push({
        harness: "antigravity",
        label: "Antigravity (agy)",
        remainingPct: 100,
        tier: "pro",
        status: "idle",
      });
    }
    if (liveRunner.isHarnessAvailable("claude_code")) {
      snapshot.harnesses.push({
        harness: "claude_code",
        label: "Claude Code",
        remainingPct: 100,
        tier: "pro",
        status: "idle",
      });
    }
    if (liveRunner.isHarnessAvailable("codex")) {
      snapshot.harnesses.push({
        harness: "codex",
        label: "Codex CLI",
        remainingPct: 100,
        tier: "pro",
        status: "idle",
      });
    }
    snapshot.harnesses.push(freePool.toQuotaWindow());
  }

  const routeCtx: BridgeRouteContext = {
    snapshot,
    memoryStore,
    freePool,
    liveRunner,
    waiters,
    delayTimers,
    defaultReserveFloorPct: options.reserveFloorPct ?? 20,
    webhookUrl,
    authToken,
    isStopped: () => stopped,
    getDirectBaseUrl: () => `http://${host}:${boundPort}`,
    getRelayStatus: () => relayClient?.getStatus() ?? null,
    pushRecentEvent,
    touchSnapshot,
    broadcast,
  };

  async function handleRequest(
    rawMethod: string,
    rawPath: string,
    rawBody?: unknown,
    abortSignal?: AbortSignal,
  ): Promise<BridgeHttpResponse> {
    const method = rawMethod.toUpperCase();
    let url: URL;
    try {
      const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      url = new URL(normalized, `http://${host}`);
    } catch {
      return { status: 400, body: { error: "Invalid request path" } };
    }
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/v1/health") {
      return {
        status: 200,
        body: {
          ok: true,
          protocolVersion: 1,
          pendingApprovals: snapshot.pendingApprovals.filter(
            (item) => item.status === "pending",
          ).length,
          sseClients: sseClients.size,
        },
      };
    }
    if (method === "GET" && pathname === "/v1/snapshot") {
      return { status: 200, body: snapshot };
    }
    if (method === "GET" && pathname === "/v1/events") {
      return {
        status: 400,
        body: { error: "Use SSE HTTP endpoint or WebSocket stream for events" },
      };
    }

    let obj: Record<string, unknown>;
    try {
      obj = coerceBodyObject(rawBody);
    } catch {
      return { status: 400, body: { error: "Invalid JSON payload" } };
    }

    const handlers = [
      handleApprovalBridgeRoute,
      handleExtendedBridgeRoute,
      handleLiveBridgeRoute,
    ];
    for (const handler of handlers) {
      const result = await handler(routeCtx, method, url, obj, abortSignal);
      if (result) return result;
    }
    return { status: 404, body: { error: "Not found" } };
  }

  if (options.relayUrl?.trim()) {
    relayClient = createRelayClient({
      relayUrl: options.relayUrl.trim(),
      sessionPath: options.relaySessionPath,
      hostLabel: snapshot.host,
      getSnapshot: () => snapshot,
      handleRequest: (method, path, body) => handleRequest(method, path, body),
    });
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (method === "GET" && url.pathname === "/v1/health") {
      const result = await handleRequest(method, req.url ?? "/v1/health");
      sendJson(res, result.status, result.body);
      return;
    }
    if (!isAuthorized(req, authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    let bodyObj: unknown;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        bodyObj = await readJsonBody(req);
      } catch (err) {
        const tooBig =
          err instanceof Error && err.message === "PAYLOAD_TOO_LARGE";
        sendJson(res, tooBig ? 413 : 400, { error: "Invalid JSON payload" });
        return;
      }
    }

    const ac = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    const result = await handleRequest(
      method,
      req.url ?? "/",
      bodyObj,
      ac.signal,
    );
    sendJson(res, result.status, result.body);
  });

  async function refreshPulses(): Promise<void> {
    const pulses = await pollGitHubPulse();
    if (stopped) return;
    snapshot.pulses = pulses;
    touchSnapshot();
    broadcast("pulses_updated", pulses);
  }

  return {
    server,
    start: async () => {
      stopped = false;
      const bound = await new Promise<{
        host: string;
        port: number;
        url: string;
      }>((resolve, reject) => {
        server.once("error", reject);
        server.listen(initialPort, host, () => {
          server.off("error", reject);
          const addr = server.address();
          boundPort =
            addr && typeof addr === "object" ? addr.port : initialPort;
          resolve({
            host,
            port: boundPort,
            url: `http://${host}:${boundPort}`,
          });
        });
      });
      if (relayClient) await relayClient.start();
      if (options.enableGitHubPulse) {
        void refreshPulses();
        pulseTimer = setInterval(() => void refreshPulses(), 60_000);
        pulseTimer.unref?.();
      }
      return bound;
    },
    stop: async () => {
      stopped = true;
      if (pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      for (const timer of delayTimers) clearTimeout(timer);
      delayTimers.clear();
      for (const [id, waiter] of waiters.entries()) {
        clearTimeout(waiter.timer);
        waiters.delete(id);
        waiter.resolve({ decision: "timeout", approvalId: id });
      }
      relayClient?.stop();
      liveRunner.stopAll();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      memoryStore.close();
    },
    getSnapshot: () => snapshot,
    handleRequest,
    getRelayStatus: () => relayClient?.getStatus() ?? null,
  };
}

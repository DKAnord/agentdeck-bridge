import { hostname } from "node:os";
import {
  decryptE2eEnvelope,
  deriveSessionAesKey,
  encryptE2eEnvelope,
  isE2eEnvelope,
  isValidX25519Key,
} from "./e2e-crypto.ts";
import type { DeckSnapshot } from "./protocol.ts";
import {
  buildRelayPairingUri,
  DEFAULT_RELAY_SESSION_PATH,
  ensureRelaySession,
  loadRelaySession,
  normalizeRelayUrls,
  type RelaySession,
  saveRelaySession,
} from "./relay-session.ts";

export {
  buildRelayPairingUri,
  DEFAULT_RELAY_SESSION_PATH,
  ensureRelaySession,
  loadRelaySession,
  normalizeRelayUrls,
  type RelaySession,
  saveRelaySession,
};

export interface RelayClientStatus {
  relayUrl: string;
  roomId?: string;
  pairingUri?: string;
  bridgeConnected: boolean;
  clientPaired: boolean;
  hostLabel: string;
}

export interface RelayRpcResponse {
  status: number;
  body: unknown;
}

export interface RelayClientOptions {
  relayUrl: string;
  sessionPath?: string;
  hostLabel?: string;
  initialReconnectMs?: number;
  maxReconnectMs?: number;
  getSnapshot: () => DeckSnapshot;
  handleRequest: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<RelayRpcResponse>;
  onError?: (message: string) => void;
}

export function createRelayClient(options: RelayClientOptions) {
  const sessionPath = options.sessionPath ?? DEFAULT_RELAY_SESSION_PATH;
  const hostLabel = options.hostLabel?.trim() || hostname();
  const initialReconnectMs = options.initialReconnectMs ?? 1000;
  const maxReconnectMs = options.maxReconnectMs ?? 30_000;

  let session: RelaySession | null = null;
  let aesKey: Buffer | null = null;
  let ws: WebSocket | null = null;
  let stopped = false;
  let bridgeConnected = false;
  let txSeq = 0;
  let lastClientSeq = -1;
  let reconnectDelay = initialReconnectMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function pairWithClientKey(clientPubKey: string): boolean {
    if (!session || !isValidX25519Key(clientPubKey)) return false;
    aesKey = deriveSessionAesKey({
      myPrivKey: session.bridgePrivKey,
      peerPubKey: clientPubKey,
      myPubKey: session.bridgePubKey,
      roomId: session.roomId,
    });
    if (session.clientPubKey !== clientPubKey) {
      session = { ...session, clientPubKey };
      saveRelaySession(session, sessionPath);
    }
    lastClientSeq = -1;
    return true;
  }

  function sendEncrypted(payload: unknown): boolean {
    if (!session || !aesKey || !ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    txSeq += 1;
    const envelope = encryptE2eEnvelope({
      aesKey,
      roomId: session.roomId,
      sender: "bridge",
      seq: txSeq,
      plaintext: JSON.stringify(payload),
    });
    ws.send(JSON.stringify(envelope));
    return true;
  }

  function sendSnapshot(): void {
    sendEncrypted({ kind: "snapshot", snapshot: options.getSnapshot() });
  }

  async function handleIncomingMessage(rawData: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "client_hello" || msg.type === "peer_state") {
      const peerKey =
        msg.clientPublicKey ?? msg.clientPubKey ?? msg.publicKey ?? undefined;
      const newlyPaired =
        typeof peerKey === "string" ? pairWithClientKey(peerKey) : false;
      const online = Boolean(
        msg.clientOnline ?? msg.clientConnected ?? msg.online ?? msg.connected,
      );
      if (newlyPaired || (online && aesKey)) sendSnapshot();
      return;
    }

    if (!isE2eEnvelope(msg) || !session || !aesKey) return;
    if (msg.roomId !== session.roomId || msg.sender !== "client") return;
    if (msg.seq <= lastClientSeq) return;

    let inner: Record<string, unknown>;
    try {
      const plaintext = decryptE2eEnvelope({ aesKey, envelope: msg });
      lastClientSeq = msg.seq;
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      inner = parsed as Record<string, unknown>;
    } catch (err) {
      options.onError?.(
        err instanceof Error ? err.message : "Relay E2E decrypt failure",
      );
      return;
    }

    if (inner.kind === "rpc_request") {
      const reqId = typeof inner.reqId === "string" ? inner.reqId : "";
      const method =
        typeof inner.method === "string" ? inner.method.toUpperCase() : "GET";
      const path = typeof inner.path === "string" ? inner.path : "/v1/snapshot";
      try {
        const res = await options.handleRequest(method, path, inner.body);
        sendEncrypted({
          kind: "rpc_response",
          reqId,
          status: res.status,
          body: res.body,
        });
      } catch (err) {
        sendEncrypted({
          kind: "rpc_response",
          reqId,
          status: 500,
          body: {
            error: err instanceof Error ? err.message : "RPC execution error",
          },
        });
      }
      return;
    }

    if (inner.kind === "get_snapshot") sendSnapshot();
    else if (inner.kind === "ping")
      sendEncrypted({ kind: "pong", ts: Date.now() });
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(maxReconnectMs, reconnectDelay * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delay);
    reconnectTimer.unref?.();
  }

  function connectSocket(): void {
    if (stopped || !session) return;
    const { wssBase } = normalizeRelayUrls(session.relayUrl);
    const wsUrl =
      `${wssBase}/v1/rooms/${encodeURIComponent(session.roomId)}` +
      `/ws?role=bridge&token=${encodeURIComponent(session.bridgeToken)}`;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener("open", () => {
      if (stopped || ws !== socket) return;
      bridgeConnected = true;
      reconnectDelay = initialReconnectMs;
      lastClientSeq = -1;
      if (aesKey) sendSnapshot();
    });
    socket.addEventListener("message", (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : String(evt.data);
      void handleIncomingMessage(raw);
    });
    socket.addEventListener("close", () => {
      if (ws === socket) {
        bridgeConnected = false;
        ws = null;
        scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      options.onError?.("Relay WebSocket error");
    });
  }

  async function start(): Promise<RelaySession> {
    stopped = false;
    session = await ensureRelaySession({
      relayUrl: options.relayUrl,
      sessionPath,
      hostLabel,
    });
    if (session.clientPubKey) pairWithClientKey(session.clientPubKey);
    connectSocket();
    return session;
  }

  function stop(): void {
    stopped = true;
    bridgeConnected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  return {
    start,
    stop,
    forwardEvent: (event: string, data: unknown) =>
      sendEncrypted({ kind: "event", event, data }),
    sendSnapshot,
    getStatus: (): RelayClientStatus => ({
      relayUrl: session?.relayUrl ?? options.relayUrl,
      ...(session
        ? { roomId: session.roomId, pairingUri: session.pairingUri }
        : {}),
      bridgeConnected,
      clientPaired: aesKey !== null,
      hostLabel: session?.hostLabel ?? hostLabel,
    }),
  };
}

export type RelayClient = ReturnType<typeof createRelayClient>;

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  decryptE2eEnvelope,
  type E2eEnvelope,
  encryptE2eEnvelope,
} from "../src/e2e-crypto.ts";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MockRelayHandle {
  url: string;
  wssUrl: string;
  getCreatedRooms: () => Array<{
    roomId: string;
    bridgeToken: string;
    clientToken: string;
    bridgePublicKey: string;
    hostLabel: string;
  }>;
  sendToBridge: (payload: unknown) => void;
  waitForBridgeSocket: () => Promise<void>;
  waitForBridgeFrame: <T = Record<string, unknown>>(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<T>;
  sendEncryptedRpc: <T = unknown>(params: {
    aesKey: Buffer;
    roomId: string;
    seq: number;
    reqId: string;
    method: string;
    path: string;
    body?: unknown;
  }) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

function encodeTextFrame(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  }
  if (data.length < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(data.length, 2);
    return Buffer.concat([hdr, data]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81;
  hdr[1] = 127;
  hdr.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([hdr, data]);
}

function tryConsumeFrame(buf: Buffer): {
  opcode: number;
  payload: Buffer;
  rest: Buffer;
} | null {
  if (buf.length < 2) return null;
  const opcode = (buf[0] ?? 0) & 0x0f;
  const masked = ((buf[1] ?? 0) & 0x80) !== 0;
  let len = (buf[1] ?? 0) & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buf.length < offset + maskBytes + len) return null;
  const payload = Buffer.alloc(len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const data = buf.subarray(offset + 4, offset + 4 + len);
    for (let i = 0; i < len; i += 1) {
      payload[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
  } else {
    buf.copy(payload, 0, offset, offset + len);
  }
  return {
    opcode,
    payload,
    rest: buf.subarray(offset + maskBytes + len),
  };
}

export async function startMockRelayServer(): Promise<MockRelayHandle> {
  const rooms: Array<{
    roomId: string;
    bridgeToken: string;
    clientToken: string;
    bridgePublicKey: string;
    hostLabel: string;
  }> = [];
  const receivedFrames: Array<Record<string, unknown>> = [];
  const frameWaiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
  }> = [];
  let bridgeSocket: Duplex | null = null;
  let socketReadyResolve: (() => void) | null = null;

  function emitFrame(msg: Record<string, unknown>) {
    receivedFrames.push(msg);
    for (let i = frameWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = frameWaiters[i];
      if (waiter?.predicate(msg)) {
        frameWaiters.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/rooms") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        bridgePublicKey?: string;
        hostLabel?: string;
      };
      const roomId = `room_${randomBytes(6).toString("hex")}`;
      const bridgeToken = `btok_${randomBytes(8).toString("hex")}`;
      const clientToken = `ctok_${randomBytes(8).toString("hex")}`;
      rooms.push({
        roomId,
        bridgeToken,
        clientToken,
        bridgePublicKey: body.bridgePublicKey ?? "",
        hostLabel: body.hostLabel ?? "",
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          roomId,
          bridgeToken,
          clientToken,
          wsPath: `/v1/rooms/${roomId}/ws`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/ws$/);
    const roomId = match?.[1];
    const token = url.searchParams.get("token");
    const role = url.searchParams.get("role");
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room || role !== "bridge" || token !== room.bridgeToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1")
      .update(`${key}${WS_MAGIC}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );

    bridgeSocket = socket;
    socketReadyResolve?.();
    socketReadyResolve = null;

    let rxBuf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (true) {
        const frame = tryConsumeFrame(rxBuf);
        if (!frame) break;
        rxBuf = frame.rest;
        if (frame.opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(
            Buffer.concat([
              Buffer.from([0x8a, frame.payload.length]),
              frame.payload,
            ]),
          );
          continue;
        }
        if (frame.opcode === 0x1) {
          try {
            const parsed = JSON.parse(
              frame.payload.toString("utf8"),
            ) as unknown;
            if (parsed && typeof parsed === "object") {
              emitFrame(parsed as Record<string, unknown>);
            }
          } catch {
            // Ignore malformed JSON frames in mock.
          }
        }
      }
    });
    socket.on("close", () => {
      if (bridgeSocket === socket) bridgeSocket = null;
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;

  const waitForBridgeFrame = <T = Record<string, unknown>>(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<T> => {
    const existing = receivedFrames.find(predicate);
    if (existing) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for bridge relay frame"));
      }, timeoutMs);
      frameWaiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg as T);
        },
      });
    });
  };

  const sendToBridge = (payload: unknown) => {
    if (!bridgeSocket || bridgeSocket.destroyed) {
      throw new Error("Bridge WebSocket is not connected");
    }
    bridgeSocket.write(encodeTextFrame(JSON.stringify(payload)));
  };

  return {
    url: `http://127.0.0.1:${port}`,
    wssUrl: `ws://127.0.0.1:${port}`,
    getCreatedRooms: () => [...rooms],
    sendToBridge,
    waitForBridgeSocket: () => {
      if (bridgeSocket && !bridgeSocket.destroyed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        socketReadyResolve = resolve;
      });
    },
    waitForBridgeFrame,
    sendEncryptedRpc: async <T = unknown>(params: {
      aesKey: Buffer;
      roomId: string;
      seq: number;
      reqId: string;
      method: string;
      path: string;
      body?: unknown;
    }) => {
      sendToBridge(
        encryptE2eEnvelope({
          aesKey: params.aesKey,
          roomId: params.roomId,
          sender: "client",
          seq: params.seq,
          plaintext: JSON.stringify({
            kind: "rpc_request",
            reqId: params.reqId,
            method: params.method,
            path: params.path,
            body: params.body,
          }),
        }),
      );
      const frame = await waitForBridgeFrame<E2eEnvelope>((msg) => {
        if (msg.type !== "e2e") return false;
        try {
          const text = decryptE2eEnvelope({
            aesKey: params.aesKey,
            envelope: msg as unknown as E2eEnvelope,
          });
          const inner = JSON.parse(text) as { kind?: string; reqId?: string };
          return inner.kind === "rpc_response" && inner.reqId === params.reqId;
        } catch {
          return false;
        }
      });
      return JSON.parse(
        decryptE2eEnvelope({ aesKey: params.aesKey, envelope: frame }),
      ) as { status: number; body: T };
    },
    close: async () => {
      bridgeSocket?.destroy();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

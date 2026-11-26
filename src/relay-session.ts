import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { generateX25519KeyPair, isValidX25519Key } from "./e2e-crypto.ts";

export interface RelaySession {
  roomId: string;
  bridgeToken: string;
  clientToken: string;
  bridgePrivKey: string;
  bridgePubKey: string;
  clientPubKey?: string;
  hostLabel: string;
  relayUrl: string;
  pairingUri: string;
}

export const DEFAULT_RELAY_SESSION_PATH = join(
  homedir(),
  ".agentdeck",
  "relay-session.json",
);

export function normalizeRelayUrls(rawRelayUrl: string): {
  httpsBase: string;
  wssBase: string;
} {
  const trimmed = rawRelayUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("relayUrl must not be empty");
  if (trimmed.startsWith("https://")) {
    return { httpsBase: trimmed, wssBase: `wss://${trimmed.slice(8)}` };
  }
  if (trimmed.startsWith("wss://")) {
    return { httpsBase: `https://${trimmed.slice(6)}`, wssBase: trimmed };
  }
  if (trimmed.startsWith("http://")) {
    return { httpsBase: trimmed, wssBase: `ws://${trimmed.slice(7)}` };
  }
  if (trimmed.startsWith("ws://")) {
    return { httpsBase: `http://${trimmed.slice(5)}`, wssBase: trimmed };
  }
  return { httpsBase: `https://${trimmed}`, wssBase: `wss://${trimmed}` };
}

export function buildRelayPairingUri(params: {
  wssBase: string;
  roomId: string;
  clientToken: string;
  bridgePubKey: string;
  hostLabel: string;
}): string {
  return (
    `agentdeck://pair?relay=${encodeURIComponent(params.wssBase)}` +
    `&room=${encodeURIComponent(params.roomId)}` +
    `&token=${encodeURIComponent(params.clientToken)}` +
    `&bpub=${encodeURIComponent(params.bridgePubKey)}` +
    `&host=${encodeURIComponent(params.hostLabel)}`
  );
}

const REQUIRED_FIELDS: Array<keyof RelaySession> = [
  "roomId",
  "bridgeToken",
  "clientToken",
  "bridgePrivKey",
  "bridgePubKey",
  "hostLabel",
  "relayUrl",
  "pairingUri",
];

export function loadRelaySession(
  sessionPath = DEFAULT_RELAY_SESSION_PATH,
): RelaySession | null {
  if (!existsSync(sessionPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (REQUIRED_FIELDS.some((field) => typeof obj[field] !== "string")) {
      return null;
    }
    return {
      roomId: obj.roomId as string,
      bridgeToken: obj.bridgeToken as string,
      clientToken: obj.clientToken as string,
      bridgePrivKey: obj.bridgePrivKey as string,
      bridgePubKey: obj.bridgePubKey as string,
      ...(isValidX25519Key(obj.clientPubKey)
        ? { clientPubKey: obj.clientPubKey }
        : {}),
      hostLabel: obj.hostLabel as string,
      relayUrl: obj.relayUrl as string,
      pairingUri: obj.pairingUri as string,
    };
  } catch {
    return null;
  }
}

export function saveRelaySession(
  session: RelaySession,
  sessionPath = DEFAULT_RELAY_SESSION_PATH,
): void {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function ensureRelaySession(options: {
  relayUrl: string;
  sessionPath?: string;
  hostLabel?: string;
}): Promise<RelaySession> {
  const sessionPath = options.sessionPath ?? DEFAULT_RELAY_SESSION_PATH;
  const hostLabel = options.hostLabel?.trim() || hostname();
  const { httpsBase, wssBase } = normalizeRelayUrls(options.relayUrl);
  const existing = loadRelaySession(sessionPath);
  if (
    existing &&
    normalizeRelayUrls(existing.relayUrl).httpsBase === httpsBase &&
    isValidX25519Key(existing.bridgePubKey) &&
    isValidX25519Key(existing.bridgePrivKey)
  ) {
    return existing;
  }

  const keys = generateX25519KeyPair();
  const res = await fetch(`${httpsBase}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bridgePublicKey: keys.publicKey, hostLabel }),
  });
  if (!res.ok) {
    throw new Error(`Relay room creation failed (${res.status})`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  const roomId = typeof payload.roomId === "string" ? payload.roomId : "";
  const bridgeToken =
    typeof payload.bridgeToken === "string" ? payload.bridgeToken : "";
  const clientToken =
    typeof payload.clientToken === "string" ? payload.clientToken : "";
  if (!roomId || !bridgeToken || !clientToken) {
    throw new Error("Relay /v1/rooms response missing room credentials");
  }

  const session: RelaySession = {
    roomId,
    bridgeToken,
    clientToken,
    bridgePrivKey: keys.privateKey,
    bridgePubKey: keys.publicKey,
    hostLabel,
    relayUrl: httpsBase,
    pairingUri: buildRelayPairingUri({
      wssBase,
      roomId,
      clientToken,
      bridgePubKey: keys.publicKey,
      hostLabel,
    }),
  };
  saveRelaySession(session, sessionPath);
  return session;
}

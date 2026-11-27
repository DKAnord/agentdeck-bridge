import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptE2eEnvelope,
  deriveSessionAesKey,
  type E2eEnvelope,
  generateX25519KeyPair,
} from "../src/e2e-crypto.ts";
import { type BridgeServerHandle, createBridgeServer } from "../src/server.ts";
import {
  type MockRelayHandle,
  startMockRelayServer,
} from "./mock-relay-helper.ts";

describe("agentdeck-bridge v0.3.0 WebSocket Cloud Relay roundtrip", () => {
  const handles: BridgeServerHandle[] = [];
  const relays: MockRelayHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.stop();
    while (relays.length > 0) await relays.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes full mock WebSocket relay roundtrip and CLI --pair", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agentdeck-relay-"));
    tempDirs.push(sessionDir);
    const sessionPath = join(sessionDir, "relay-session.json");
    const cliSessionPath = join(sessionDir, "cli-session.json");

    const relay = await startMockRelayServer();
    relays.push(relay);

    const cliPath = fileURLToPath(
      new URL("../bin/agentdeck-bridge.mjs", import.meta.url),
    );
    const { stdout: pairOut } = await promisify(execFile)(
      process.execPath,
      [
        cliPath,
        "--pair",
        "--relay",
        relay.url,
        "--relay-session",
        cliSessionPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const pairJson = JSON.parse(pairOut) as { ok: boolean; pairingUri: string };
    expect(pairJson.ok).toBe(true);
    expect(pairJson.pairingUri).toContain("agentdeck://pair?");

    const bridge = createBridgeServer({
      port: 0,
      hostnameLabel: "relay-rig",
      relayUrl: relay.url,
      relaySessionPath: sessionPath,
    });
    handles.push(bridge);
    const { url } = await bridge.start();
    await relay.waitForBridgeSocket();

    const saved = JSON.parse(readFileSync(sessionPath, "utf8")) as {
      roomId: string;
      bridgePubKey: string;
      pairingUri: string;
    };
    const clientKeys = generateX25519KeyPair();
    const clientAes = deriveSessionAesKey({
      myPrivKey: clientKeys.privateKey,
      peerPubKey: saved.bridgePubKey,
      myPubKey: clientKeys.publicKey,
      roomId: saved.roomId,
    });

    relay.sendToBridge({
      type: "client_hello",
      clientPublicKey: clientKeys.publicKey,
    });
    const snapFrame = await relay.waitForBridgeFrame<E2eEnvelope>(
      (msg) => msg.type === "e2e",
    );
    const snapPlain = JSON.parse(
      decryptE2eEnvelope({ aesKey: clientAes, envelope: snapFrame }),
    ) as { kind: string; snapshot: { host: string } };
    expect(snapPlain.kind).toBe("snapshot");
    expect(snapPlain.snapshot.host).toBe("relay-rig");

    const pairInfo = (await (await fetch(`${url}/v1/pairing`)).json()) as {
      relayPairingUri: string;
      bridgeConnected: boolean;
      clientPaired: boolean;
    };
    expect(pairInfo.bridgeConnected).toBe(true);
    expect(pairInfo.clientPaired).toBe(true);
    expect(pairInfo.relayPairingUri).toBe(saved.pairingUri);

    const gateResp = await relay.sendEncryptedRpc<{ approvalId: string }>({
      aesKey: clientAes,
      roomId: saved.roomId,
      seq: 1,
      reqId: "req-gate-1",
      method: "POST",
      path: "/v1/demo-gate",
      body: { repo: "relay-repo", command: "npm run test" },
    });
    expect(gateResp.status).toBe(202);

    const resolveResp = await relay.sendEncryptedRpc<{
      approval: { status: string };
    }>({
      aesKey: clientAes,
      roomId: saved.roomId,
      seq: 2,
      reqId: "req-resolve-2",
      method: "POST",
      path: `/v1/approvals/${gateResp.body.approvalId}/resolve`,
      body: { decision: "approve", replyNote: "approved over e2e relay" },
    });
    expect(resolveResp.status).toBe(200);
    expect(resolveResp.body.approval.status).toBe("approved");

    const persistedAfter = JSON.parse(readFileSync(sessionPath, "utf8")) as {
      clientPubKey?: string;
    };
    expect(persistedAfter.clientPubKey).toBe(clientKeys.publicKey);
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
  });
});

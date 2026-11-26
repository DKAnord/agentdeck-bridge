import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  decryptE2eEnvelope,
  deriveRoomAesKey,
  deriveSessionAesKey,
  deriveSharedSecret,
  encryptE2eEnvelope,
  generateX25519KeyPair,
  keyPairFromRawPrivateHex,
  VECTOR_AES_HEX,
  VECTOR_BRIDGE_PRIV_HEX,
  VECTOR_BRIDGE_PUB_B64URL,
  VECTOR_CLIENT_PRIV_HEX,
  VECTOR_CLIENT_PUB_B64URL,
  VECTOR_CT_B64URL,
  VECTOR_IV_HEX,
  VECTOR_PLAINTEXT,
  VECTOR_ROOM_ID,
  VECTOR_SENDER,
  VECTOR_SEQ,
  VECTOR_SHARED_HEX,
} from "../src/e2e-crypto.ts";
import {
  clearGitHubPulseCache,
  createLiveRunner,
  pollGitHubPulse,
} from "../src/live-runner.ts";
import { createBridgeServer } from "../src/server.ts";
import { startMockRelayServer } from "./mock-relay-helper.ts";

describe("agentdeck-bridge v0.3.0 standalone Node 22 suite", () => {
  const handles = [];
  const relays = [];
  const tempDirs = [];

  afterEach(async () => {
    clearGitHubPulseCache();
    while (handles.length > 0) {
      const h = handles.pop();
      if (h) await h.stop();
    }
    while (relays.length > 0) {
      const r = relays.pop();
      if (r) await r.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies deterministic E2E vector and rejects mismatched AAD or keys", () => {
    const bridgePair = keyPairFromRawPrivateHex(VECTOR_BRIDGE_PRIV_HEX);
    const clientPair = keyPairFromRawPrivateHex(VECTOR_CLIENT_PRIV_HEX);
    assert.equal(bridgePair.publicKey, VECTOR_BRIDGE_PUB_B64URL);
    assert.equal(clientPair.publicKey, VECTOR_CLIENT_PUB_B64URL);

    const shared = deriveSharedSecret(
      clientPair.privateKey,
      bridgePair.publicKey,
      clientPair.publicKey,
    );
    assert.equal(shared.toString("hex"), VECTOR_SHARED_HEX);

    const aes = deriveRoomAesKey(shared, VECTOR_ROOM_ID);
    assert.equal(aes.toString("hex"), VECTOR_AES_HEX);

    const env = encryptE2eEnvelope({
      aesKey: aes,
      roomId: VECTOR_ROOM_ID,
      sender: VECTOR_SENDER,
      seq: VECTOR_SEQ,
      plaintext: VECTOR_PLAINTEXT,
      iv: Buffer.from(VECTOR_IV_HEX, "hex"),
    });
    assert.equal(env.ct, VECTOR_CT_B64URL);
    assert.equal(
      decryptE2eEnvelope({ aesKey: aes, envelope: env }),
      VECTOR_PLAINTEXT,
    );

    assert.throws(() =>
      decryptE2eEnvelope({ aesKey: aes, envelope: { ...env, seq: 99 } }),
    );
    const attacker = generateX25519KeyPair();
    const wrongAes = deriveSessionAesKey({
      myPrivKey: attacker.privateKey,
      peerPubKey: bridgePair.publicKey,
      myPubKey: attacker.publicKey,
      roomId: VECTOR_ROOM_ID,
    });
    assert.throws(() =>
      decryptE2eEnvelope({ aesKey: wrongAes, envelope: env }),
    );
  });

  it("rejects traversal (/etc and symlink) in executeLivePrompt", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "agentdeck-allow-standalone-"));
    tempDirs.push(allowed);
    const link = join(allowed, "etc-link");
    symlinkSync("/etc", link);

    const runner = createLiveRunner({ allowedDirs: [allowed] });
    const res1 = await runner.executeLivePrompt({
      harness: "opencode",
      prompt: "test",
      cwd: "/etc",
    });
    assert.equal(res1.started, false);
    assert.ok(res1.error?.includes("outside allowedDirs"));

    const res2 = await runner.executeLivePrompt({
      harness: "opencode",
      prompt: "test",
      cwd: link,
    });
    assert.equal(res2.started, false);
  });

  it("handles /v1/demo-gate, /v1/triage, /v1/pairing, and graceful gh fallback", async () => {
    const emptyPulses = await pollGitHubPulse(["DKAnord/missing"], {
      force: true,
      pathEnv: "/nonexistent-bin",
    });
    assert.deepEqual(emptyPulses, []);

    const workDir = mkdtempSync(join(tmpdir(), "agentdeck-work-"));
    const binDir = mkdtempSync(join(tmpdir(), "agentdeck-mockbin-"));
    tempDirs.push(workDir, binDir);

    const mockOpenCode = join(binDir, "opencode");
    writeFileSync(mockOpenCode, '#!/bin/sh\necho "NODE22_TRIAGE_OK"\n', "utf8");
    chmodSync(mockOpenCode, 0o755);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const bridge = createBridgeServer({
        port: 0,
        hostnameLabel: "standalone-rig",
        allowedDirs: [workDir],
      });
      handles.push(bridge);
      const { url } = await bridge.start();

      const pair = await (await fetch(`${url}/v1/pairing`)).json();
      assert.equal(pair.ok, true);
      assert.equal(pair.host, "standalone-rig");
      assert.ok(pair.directUri.startsWith("agentdeck://direct?"));

      const gate = await fetch(`${url}/v1/demo-gate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(gate.status, 202);
      const gateData = await gate.json();
      assert.equal(gateData.approval.repo, "my-api-repo");

      const triage = await fetch(`${url}/v1/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "my-api-repo",
          executeNow: true,
          cwd: workDir,
        }),
      });
      assert.equal(triage.status, 200);
      const triageData = await triage.json();
      assert.equal(triageData.run.started, true);
      assert.ok(triageData.run.output.includes("NODE22_TRIAGE_OK"));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("completes full mock WebSocket relay E2E RPC roundtrip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-ws-standalone-"));
    tempDirs.push(dir);
    const sessionPath = join(dir, "relay-session.json");

    const relay = await startMockRelayServer();
    relays.push(relay);

    const bridge = createBridgeServer({
      port: 0,
      hostnameLabel: "ws-standalone",
      relayUrl: relay.url,
      relaySessionPath: sessionPath,
    });
    handles.push(bridge);
    await bridge.start();
    await relay.waitForBridgeSocket();

    const saved = JSON.parse(readFileSync(sessionPath, "utf8"));
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
    const snapEnv = await relay.waitForBridgeFrame((m) => m.type === "e2e");
    const snap = JSON.parse(
      decryptE2eEnvelope({ aesKey: clientAes, envelope: snapEnv }),
    );
    assert.equal(snap.kind, "snapshot");

    const r1 = await relay.sendEncryptedRpc({
      aesKey: clientAes,
      roomId: saved.roomId,
      seq: 1,
      reqId: "r1",
      method: "POST",
      path: "/v1/demo-gate",
      body: {},
    });
    assert.equal(r1.status, 202);

    const r2 = await relay.sendEncryptedRpc({
      aesKey: clientAes,
      roomId: saved.roomId,
      seq: 2,
      reqId: "r2",
      method: "POST",
      path: `/v1/approvals/${r1.body.approvalId}/resolve`,
      body: { decision: "approve", replyNote: "standalone ok" },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.approval.status, "approved");
  });
});

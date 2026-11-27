import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { clearGitHubPulseCache, pollGitHubPulse } from "../src/github-pulse.ts";
import { createLiveRunner } from "../src/live-runner.ts";
import { cleanCapsuleGoal } from "../src/memory-store.ts";
import { type BridgeServerHandle, createBridgeServer } from "../src/server.ts";

describe("agentdeck-bridge v0.3.0 E2E crypto, live runner & routes", () => {
  const handles: BridgeServerHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearGitHubPulseCache();
    while (handles.length > 0) await handles.pop()?.stop();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies deterministic X25519 + HKDF + AES-GCM vector and rejects wrong AAD/key", () => {
    const bridgePair = keyPairFromRawPrivateHex(VECTOR_BRIDGE_PRIV_HEX);
    const clientPair = keyPairFromRawPrivateHex(VECTOR_CLIENT_PRIV_HEX);
    expect(bridgePair.publicKey).toBe(VECTOR_BRIDGE_PUB_B64URL);
    expect(clientPair.publicKey).toBe(VECTOR_CLIENT_PUB_B64URL);
    expect(bridgePair.publicKey).toHaveLength(43);

    const shared = deriveSharedSecret(
      clientPair.privateKey,
      bridgePair.publicKey,
      clientPair.publicKey,
    );
    expect(shared.toString("hex")).toBe(VECTOR_SHARED_HEX);
    const aes = deriveRoomAesKey(shared, VECTOR_ROOM_ID);
    expect(aes.toString("hex")).toBe(VECTOR_AES_HEX);

    const env = encryptE2eEnvelope({
      aesKey: aes,
      roomId: VECTOR_ROOM_ID,
      sender: VECTOR_SENDER,
      seq: VECTOR_SEQ,
      plaintext: VECTOR_PLAINTEXT,
      iv: Buffer.from(VECTOR_IV_HEX, "hex"),
    });
    expect(env.ct).toBe(VECTOR_CT_B64URL);
    expect(decryptE2eEnvelope({ aesKey: aes, envelope: env })).toBe(
      VECTOR_PLAINTEXT,
    );
    expect(() =>
      decryptE2eEnvelope({ aesKey: aes, envelope: { ...env, seq: 2 } }),
    ).toThrow();
    expect(() =>
      decryptE2eEnvelope({
        aesKey: aes,
        envelope: { ...env, roomId: "wrong_room" },
      }),
    ).toThrow();

    const attacker = generateX25519KeyPair();
    const wrongAes = deriveSessionAesKey({
      myPrivKey: attacker.privateKey,
      peerPubKey: bridgePair.publicKey,
      myPubKey: attacker.publicKey,
      roomId: VECTOR_ROOM_ID,
    });
    expect(() =>
      decryptE2eEnvelope({ aesKey: wrongAes, envelope: env }),
    ).toThrow();
  });

  it("rejects allowlist traversal (/etc and symlink) in executeLivePrompt & /v1/dispatch", async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), "agentdeck-allow-"));
    tempDirs.push(allowedDir);
    const symlinkEscape = join(allowedDir, "escape-etc");
    symlinkSync("/etc", symlinkEscape);

    const runner = createLiveRunner({ allowedDirs: [allowedDir] });
    const etcRes = await runner.executeLivePrompt({
      harness: "opencode",
      prompt: "test",
      cwd: "/etc",
    });
    expect(etcRes.started).toBe(false);
    expect(etcRes.error).toContain("outside allowedDirs");

    const symRes = await runner.executeLivePrompt({
      harness: "opencode",
      prompt: "test",
      cwd: symlinkEscape,
    });
    expect(symRes.started).toBe(false);
    expect(symRes.error).toContain("outside allowedDirs");

    const bridge = createBridgeServer({ port: 0, allowedDirs: [allowedDir] });
    handles.push(bridge);
    const { url } = await bridge.start();
    const dispatchRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-api-repo",
        prompt: "Check status",
        executeNow: true,
        cwd: "/etc",
      }),
    });
    expect(dispatchRes.status).toBe(403);
  });

  it("serves /v1/demo-gate, /v1/triage (live CLI), /v1/pairing, and /v1/pulses", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "agentdeck-live-"));
    const binDir = mkdtempSync(join(tmpdir(), "agentdeck-bin-"));
    tempDirs.push(workDir, binDir);

    const mockOpencode = join(binDir, "opencode");
    writeFileSync(mockOpencode, '#!/bin/sh\necho "TRIAGE_OK:$*"\n', "utf8");
    chmodSync(mockOpencode, 0o755);

    const mockGh = join(binDir, "gh");
    writeFileSync(
      mockGh,
      [
        "#!/bin/sh",
        'case "$1:$2" in',
        '  repo:list) echo \'[{"nameWithOwner":"DKAnord/agentdeck","defaultBranchRef":{"name":"main"},"updatedAt":"2026-11-26T10:00:00Z"}]\' ;;',
        '  issue:list) echo \'[{"number":1},{"number":2}]\' ;;',
        "  pr:list) echo '[{\"number\":9}]' ;;",
        '  run:list) echo \'[{"status":"completed","conclusion":"success","headBranch":"main"}]\' ;;',
        "  *) echo '[]' ;;",
        "esac",
      ].join("\n"),
      "utf8",
    );
    chmodSync(mockGh, 0o755);

    const pulses = await pollGitHubPulse(undefined, {
      force: true,
      pathEnv: binDir,
    });
    expect(pulses[0]).toMatchObject({
      repo: "DKAnord/agentdeck",
      openIssues: 2,
      openPrs: 1,
      ciStatus: "pass",
    });
    expect(
      await pollGitHubPulse(["DKAnord/missing"], {
        force: true,
        pathEnv: "/nonexistent-bin-dir",
      }),
    ).toEqual([]);

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const bridge = createBridgeServer({
        port: 0,
        authToken: "pair-secret",
        hostnameLabel: "rig-one",
        allowedDirs: [workDir],
      });
      handles.push(bridge);
      const { url } = await bridge.start();
      const authHdr = { Authorization: "Bearer pair-secret" };

      expect((await fetch(`${url}/v1/pairing`)).status).toBe(401);
      const pairBody = (await (
        await fetch(`${url}/v1/pairing`, { headers: authHdr })
      ).json()) as { ok: boolean; host: string; directUri: string };
      expect(pairBody.ok).toBe(true);
      expect(pairBody.host).toBe("rig-one");
      expect(pairBody.directUri).toContain("agentdeck://direct?");

      const pulsesRes = (await (
        await fetch(`${url}/v1/pulses?refresh=1`, { headers: authHdr })
      ).json()) as { ok: boolean; pulses: Array<{ repo: string }> };
      expect(pulsesRes.ok).toBe(true);
      expect(pulsesRes.pulses[0]?.repo).toBe("DKAnord/agentdeck");

      const gateRes = await fetch(`${url}/v1/demo-gate`, {
        method: "POST",
        headers: { ...authHdr, "Content-Type": "application/json" },
        body: JSON.stringify({ delayMs: 15 }),
      });
      expect(gateRes.status).toBe(202);
      const gateBody = (await gateRes.json()) as {
        approval: { repo: string; status: string };
      };
      expect(gateBody.approval.repo).toBe("my-api-repo");
      expect(gateBody.approval.status).toBe("pending");

      const waitGate = fetch(`${url}/v1/demo-gate?wait=1&timeoutMs=5000`, {
        method: "POST",
        headers: { ...authHdr, "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "wait-repo", command: "echo hi" }),
      });
      let waitId = "";
      for (let i = 0; i < 20 && !waitId; i += 1) {
        const snap = (await (
          await fetch(`${url}/v1/snapshot`, { headers: authHdr })
        ).json()) as { pendingApprovals: Array<{ id: string; repo: string }> };
        waitId =
          snap.pendingApprovals.find((a) => a.repo === "wait-repo")?.id ?? "";
        if (!waitId) await new Promise((r) => setTimeout(r, 15));
      }
      await fetch(`${url}/v1/approvals/${waitId}/resolve`, {
        method: "POST",
        headers: { ...authHdr, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve", replyNote: "go" }),
      });
      const waitGateBody = (await (await waitGate).json()) as {
        decision: string;
        replyNote: string;
      };
      expect(waitGateBody.decision).toBe("approve");
      expect(waitGateBody.replyNote).toBe("go");

      const snapAfterGate = (await (
        await fetch(`${url}/v1/snapshot`, { headers: authHdr })
      ).json()) as { handoffs: Array<{ repo: string }> };
      expect(snapAfterGate.handoffs.some((h) => h.repo === "my-api-repo")).toBe(
        false,
      );

      expect(
        cleanCapsuleGoal(
          "[AgentDeck Shared Memory · Seamless Handoff]\nRepo: x\n\n[Task]\nCheck repo status",
        ),
      ).toBe("Check repo status");

      const wsDispatch = await fetch(`${url}/v1/dispatch`, {
        method: "POST",
        headers: { ...authHdr, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "status?", repo: "workspace" }),
      });
      const wsBody = (await wsDispatch.json()) as {
        route: { handoffPrompt: string };
      };
      expect(wsBody.route.handoffPrompt).toContain("[Live GitHub Repo Pulse]");
      expect(wsBody.route.handoffPrompt).not.toContain("my-api-repo");

      const triageRes = await fetch(`${url}/v1/triage`, {
        method: "POST",
        headers: { ...authHdr, "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "DKAnord/agentdeck",
          executeNow: true,
          cwd: workDir,
        }),
      });
      expect(triageRes.status).toBe(200);
      const triageBody = (await triageRes.json()) as {
        route: { selectedHarness: string };
        run: { started: boolean; exitCode: number; output: string };
      };
      expect(triageBody.route.selectedHarness).toBe("free_pool");
      expect(triageBody.run.started).toBe(true);
      expect(triageBody.run.output).toContain("TRIAGE_OK:");
    } finally {
      process.env.PATH = origPath;
    }
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createBridgeServer } from "../src/server.ts";

describe("agentdeck-bridge standalone Node 22 suite", () => {
  const handles = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.stop();
    }
  });

  it("exposes /v1/health and enforces Bearer auth on /v1/snapshot", async () => {
    const bridge = createBridgeServer({
      port: 0,
      authToken: "standalone-token",
      hostnameLabel: "dev-rig",
    });
    handles.push(bridge);
    const { url } = await bridge.start();

    const health = await fetch(`${url}/v1/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.protocolVersion, 1);

    const unauth = await fetch(`${url}/v1/snapshot`);
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${url}/v1/snapshot`, {
      headers: { Authorization: "Bearer standalone-token" },
    });
    assert.equal(authed.status, 200);
    const snap = await authed.json();
    assert.equal(snap.protocolVersion, 1);
    assert.equal(snap.host, "dev-rig");
  });

  it("streams PermissionRequest over SSE and unblocks waiting hook on resolve", async () => {
    const bridge = createBridgeServer({
      port: 0,
      hostnameLabel: "workstation",
    });
    handles.push(bridge);
    const { url } = await bridge.start();

    const sseController = new AbortController();
    const sseRes = await fetch(`${url}/v1/events`, {
      signal: sseController.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body?.getReader();
    assert.ok(reader);

    const waitHookPromise = fetch(
      `${url}/v1/hooks/claude?wait=1&timeoutMs=5000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          cwd: "/home/dev/my-api-repo",
          branch: "feat/auth",
          diff_summary: "3 files (+42 -11)",
          tool_input: { command: "npm run deploy:preview --env staging" },
        }),
      },
    );

    let approvalId = "";
    const decoder = new TextDecoder();
    let buffer = "";
    while (!approvalId) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.includes("event: approval_requested")) {
          const dataLine = block
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (dataLine) {
            const parsed = JSON.parse(dataLine.slice(6));
            assert.equal(parsed.repo, "my-api-repo");
            assert.equal(parsed.branch, "feat/auth");
            assert.equal(parsed.diffSummary, "3 files (+42 -11)");
            approvalId = parsed.id;
          }
        }
      }
    }
    assert.ok(approvalId.length > 0);

    const resolveRes = await fetch(
      `${url}/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          replyNote: "staging ok",
        }),
      },
    );
    assert.equal(resolveRes.status, 200);

    const hookResult = await (await waitHookPromise).json();
    assert.deepEqual(hookResult, {
      decision: "approve",
      approvalId,
      replyNote: "staging ok",
    });

    sseController.abort();
  });

  it("aggregates multi-harness quota and reset windows in /v1/snapshot", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const quotas = [
      {
        harness: "claude_code",
        label: "Claude Code",
        remainingPct: 18,
        resetsInMinutes: 42,
        tier: "pro",
        status: "waiting",
      },
      {
        harness: "antigravity",
        label: "Antigravity",
        remainingPct: 84,
        tier: "pro",
        status: "active",
      },
      {
        harness: "codex",
        label: "Codex CLI",
        remainingPct: 100,
        tier: "free",
        status: "idle",
      },
      {
        harness: "gemini_cli",
        label: "Gemini CLI",
        remainingPct: 100,
        tier: "free",
        status: "idle",
      },
    ];

    for (const q of quotas) {
      const res = await fetch(`${url}/v1/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(q),
      });
      assert.equal(res.status, 200);
    }

    const snap = await (await fetch(`${url}/v1/snapshot`)).json();
    assert.equal(snap.harnesses.length, 4);
    assert.equal(snap.harnesses[0].remainingPct, 18);
    assert.equal(snap.harnesses[0].resetsInMinutes, 42);
  });
});

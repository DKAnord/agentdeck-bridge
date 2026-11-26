import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { handleMcpJsonRpc } from "../src/mcp-stdio.ts";
import {
  createMemoryStore,
  syncAgentInstructionStubs,
} from "../src/memory-store.ts";
import { createBridgeServer } from "../src/server.ts";

describe("agentdeck-bridge v1.1 standalone Node 22 suite", () => {
  const handles = [];
  const tempDirs = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes around reserve floor on medium tasks and defaults light tasks to Free Pool", async () => {
    const bridge = createBridgeServer({ port: 0, reserveFloorPct: 20 });
    handles.push(bridge);
    const { url } = await bridge.start();

    await fetch(`${url}/v1/quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "claude_code",
        label: "Claude Code",
        remainingPct: 18,
        resetsInMinutes: 120,
        tier: "pro",
        status: "waiting",
      }),
    });

    const medRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Add regression tests for JWT validation",
      }),
    });
    assert.equal(medRes.status, 200);
    const med = await medRes.json();
    assert.equal(med.route.complexity, "medium");
    assert.equal(med.route.selectedHarness, "free_pool");
    assert.equal(med.route.reason, "reserve_floor_overflow");
    assert.equal(med.route.freeProvider, "opencode_zen");

    const lightRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Triage issue #42 and fix README typo",
      }),
    });
    const light = await lightRes.json();
    assert.equal(light.route.complexity, "light");
    assert.equal(light.route.selectedHarness, "free_pool");
    assert.equal(light.route.reason, "free_pool_default");
  });

  it("proactively harvests Pro quota expiring within 30m", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    await fetch(`${url}/v1/quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "claude_code",
        label: "Claude Code",
        remainingPct: 38,
        resetsInMinutes: 20,
        tier: "pro",
        status: "idle",
      }),
    });

    const res = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Implement token refresh helper",
      }),
    });
    const body = await res.json();
    assert.equal(body.route.selectedHarness, "claude_code");
    assert.equal(body.route.reason, "reset_harvest");
    assert.ok(body.route.resetNudge.includes("38% unused"));
  });

  it("fails over from capped harness with seamless Handoff Capsule", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const hookRes = await fetch(`${url}/v1/hooks/claude?wait=0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        cwd: "/tmp/my-cli-tool",
        branch: "feat/clock-skew",
        tool_input: {
          file_path: "auth/verify.ts",
          old_string: "const leeway = 0;",
          new_string: "const leeway = 30;\nexport { leeway };",
        },
      }),
    });
    const { approvalId } = await hookRes.json();

    await fetch(
      `${url}/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          replyNote: "Keep 30s JWT leeway",
        }),
      },
    );

    await fetch(`${url}/v1/quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "claude_code",
        label: "Claude Code",
        remainingPct: 0,
        resetsInMinutes: 42,
        tier: "pro",
        status: "capped",
      }),
    });
    await fetch(`${url}/v1/quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "antigravity",
        label: "Antigravity",
        remainingPct: 84,
        tier: "pro",
        status: "active",
      }),
    });

    const dispatchRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        preferredHarness: "claude_code",
        prompt: "Run unit tests and stage PR #88",
      }),
    });
    const data = await dispatchRes.json();
    assert.equal(data.route.selectedHarness, "antigravity");
    assert.equal(data.route.reason, "capped_failover");
    assert.ok(data.route.handoffPrompt.includes("auth/verify.ts"));
    assert.ok(data.route.handoffPrompt.includes("1 file (+2 -1)"));
    assert.ok(data.route.handoffPrompt.includes("Keep 30s JWT leeway"));
  });

  it("rotates Free Pool providers via rate-limit headers and 429 cooldown", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    await fetch(`${url}/v1/free-pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "groq_free",
        label: "Groq Llama Free",
        rateLimitHeaders: {
          "x-ratelimit-remaining-requests": "75",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-reset-requests": "15m",
        },
      }),
    });

    await fetch(`${url}/v1/free-pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "opencode_zen",
        status429: true,
        rateLimitHeaders: { "retry-after": "90" },
      }),
    });

    const res = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Format docs changelog",
      }),
    });
    const routed = await res.json();
    assert.equal(routed.route.selectedHarness, "free_pool");
    assert.equal(routed.route.freeProvider, "groq_free");
  });

  it("handles MCP JSON-RPC, FTS5 special-char queries, /v1/memory, and rule sync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-standalone-mcp-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "AGENTS.md"), "# Workspace Rules\n", "utf8");

    const sync1 = syncAgentInstructionStubs(dir);
    assert.deepEqual(sync1.updatedFiles, [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
    ]);
    assert.ok(
      readFileSync(join(dir, "AGENTS.md"), "utf8").includes(
        "# Workspace Rules",
      ),
    );
    assert.deepEqual(syncAgentInstructionStubs(dir).updatedFiles, []);

    const store = createMemoryStore(join(dir, "memory.sqlite"));
    try {
      const init = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      assert.equal(init.result.serverInfo.name, "agentdeck-memory");

      const list = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      assert.equal(list.result.tools.length, 4);

      handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_remember",
          arguments: {
            repo: "my-cli-tool",
            summary: "Preserve JWT clock skew leeway in auth/verify.ts",
            tags: ["jwt", "auth"],
          },
        },
      });

      const recall = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "memory_recall",
          arguments: { repo: "my-cli-tool", query: "auth/verify.ts:42?" },
        },
      });
      assert.ok(recall.result.content[0].text.includes("auth/verify.ts"));

      handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "handoff_update",
          arguments: {
            repo: "my-cli-tool",
            branch: "feat/clock-skew",
            goal: "Verify clock skew",
            harness: "codex",
          },
        },
      });

      const getHandoff = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "handoff_get", arguments: { repo: "my-cli-tool" } },
      });
      assert.ok(getHandoff.result.content[0].text.includes("feat/clock-skew"));
    } finally {
      store.close();
    }

    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();
    const saveMem = await fetch(`${url}/v1/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        scope: "testing",
        summary: "Always run vitest before deploy",
        harness: "claude_code",
      }),
    });
    assert.equal(saveMem.status, 201);
    const queryMem = await fetch(`${url}/v1/memory?repo=my-cli-tool&q=vitest`);
    const memPayload = await queryMem.json();
    assert.equal(memPayload.memories.length, 1);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpJsonRpc, startMcpStdioServer } from "../src/mcp-stdio.ts";
import {
  createMemoryStore,
  syncAgentInstructionStubs,
} from "../src/memory-store.ts";
import { type BridgeServerHandle, createBridgeServer } from "../src/server.ts";

describe("AgentDeck v1.1 proactive router, Free Pool & shared MCP memory", () => {
  const handles: BridgeServerHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop();
      if (h) await h.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("protects Pro reserve floor on medium tasks and defaults light tasks to Free Pool", async () => {
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
        prompt: "Add unit test coverage for JWT leeway handling",
      }),
    });
    expect(medRes.status).toBe(200);
    const med = (await medRes.json()) as {
      route: {
        selectedHarness: string;
        complexity: string;
        reason: string;
        freeProvider?: string;
      };
    };
    expect(med.route.complexity).toBe("medium");
    expect(med.route.selectedHarness).toBe("free_pool");
    expect(med.route.reason).toBe("reserve_floor_overflow");
    expect(med.route.freeProvider).toBe("opencode_zen");

    const lightRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Triage issue #42 and update README typo",
      }),
    });
    const light = (await lightRes.json()) as {
      route: { selectedHarness: string; complexity: string; reason: string };
    };
    expect(light.route.complexity).toBe("light");
    expect(light.route.selectedHarness).toBe("free_pool");
    expect(light.route.reason).toBe("free_pool_default");
  });

  it("proactively harvests Pro quota expiring within 30m with >=25% headroom", async () => {
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
        prompt: "Refactor session token validator",
      }),
    });
    const body = (await res.json()) as {
      route: {
        selectedHarness: string;
        reason: string;
        resetNudge?: string;
      };
    };
    expect(body.route.selectedHarness).toBe("claude_code");
    expect(body.route.reason).toBe("reset_harvest");
    expect(body.route.resetNudge).toContain("38% unused");
    expect(body.route.resetNudge).toContain("20m");
  });

  it("fails over on capped preferred harness with seamless Handoff Capsule", async () => {
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
    const { approvalId } = (await hookRes.json()) as { approvalId: string };

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
        prompt: "Run auth tests and finish PR #88",
      }),
    });
    const data = (await dispatchRes.json()) as {
      route: {
        selectedHarness: string;
        reason: string;
        handoffPrompt: string;
        capsule?: { touchedFiles: string[]; notes: string[] };
      };
    };

    expect(data.route.selectedHarness).toBe("antigravity");
    expect(data.route.reason).toBe("capped_failover");
    expect(data.route.handoffPrompt).toContain(
      "[AgentDeck Shared Memory · Seamless Handoff]",
    );
    expect(data.route.handoffPrompt).toContain("feat/clock-skew");
    expect(data.route.handoffPrompt).toContain("auth/verify.ts");
    expect(data.route.handoffPrompt).toContain("1 file (+2 -1)");
    expect(data.route.handoffPrompt).toContain("Keep 30s JWT leeway");
  });

  it("rotates Free Pool providers using rate-limit headers and 429 cooldowns", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const groqRes = await fetch(`${url}/v1/free-pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "groq_free",
        label: "Groq Llama Free",
        rateLimitHeaders: {
          "x-ratelimit-remaining-requests": "80",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-reset-requests": "12m",
        },
      }),
    });
    expect(groqRes.status).toBe(200);
    const groqData = (await groqRes.json()) as {
      slot: { remainingPct: number; resetsInMinutes?: number };
    };
    expect(groqData.slot.remainingPct).toBe(80);
    expect(groqData.slot.resetsInMinutes).toBe(12);

    const zenCapRes = await fetch(`${url}/v1/free-pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "opencode_zen",
        status429: true,
        rateLimitHeaders: { "retry-after": "120" },
      }),
    });
    const capData = (await zenCapRes.json()) as {
      quota: { harness: string; remainingPct: number };
    };
    expect(capData.quota.harness).toBe("free_pool");
    expect(capData.quota.remainingPct).toBe(80);

    const dispatchRes = await fetch(`${url}/v1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-cli-tool",
        prompt: "Update docs changelog",
      }),
    });
    const routed = (await dispatchRes.json()) as {
      route: { selectedHarness: string; freeProvider?: string };
    };
    expect(routed.route.selectedHarness).toBe("free_pool");
    expect(routed.route.freeProvider).toBe("groq_free");
  });

  it("serves stdio MCP tools with safe FTS5 recall and syncs agent rule stubs idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-mcp-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "# Existing Claude Rules\n", "utf8");

    const sync1 = syncAgentInstructionStubs(dir);
    expect(sync1.updatedFiles).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    const claudeContent = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeContent).toContain("# Existing Claude Rules");
    expect(claudeContent).toContain("<!-- agentdeck:memory:start -->");
    expect(readFileSync(sync1.memoryFile, "utf8")).toContain(
      "Shared Workspace Memory",
    );

    const sync2 = syncAgentInstructionStubs(dir);
    expect(sync2.updatedFiles).toEqual([]);

    const dbPath = join(dir, "memory.sqlite");
    const store = createMemoryStore(dbPath);
    try {
      expect(
        handleMcpJsonRpc(store, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      ).toBeNull();

      const init = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("agentdeck-memory");

      const list = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }) as { result: { tools: Array<{ name: string }> } };
      expect(list.result.tools.map((t) => t.name)).toEqual([
        "memory_remember",
        "memory_recall",
        "handoff_get",
        "handoff_update",
      ]);

      handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_remember",
          arguments: {
            repo: "my-cli-tool",
            scope: "auth",
            summary: "Always preserve 30s clock skew leeway in auth/verify.ts",
            tags: ["jwt", "verify"],
            harness: "claude_code",
          },
        },
      });

      const recallResp = handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "memory_recall",
          arguments: { repo: "my-cli-tool", query: "auth/verify.ts:42?" },
        },
      }) as { result: { content: Array<{ text: string }> } };
      const recalled = JSON.parse(
        recallResp.result.content[0]?.text ?? "{}",
      ) as {
        memories: Array<{ summary: string }>;
      };
      expect(recalled.memories[0]?.summary).toContain("auth/verify.ts");

      handleMcpJsonRpc(store, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "handoff_update",
          arguments: {
            repo: "my-cli-tool",
            branch: "feat/clock-skew",
            goal: "Fix JWT verification",
            harness: "opencode",
            filePath: "auth/verify.ts",
          },
        },
      });

      const input = new PassThrough();
      const output = new PassThrough();
      const rl = startMcpStdioServer(store, input, output);
      const linePromise = new Promise<string>((resolve) => {
        output.once("data", (chunk) => resolve(chunk.toString("utf8")));
      });
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "handoff_get", arguments: { repo: "my-cli-tool" } },
        })}\n`,
      );
      const line = await linePromise;
      const rpcResp = JSON.parse(line) as {
        id: number;
        result: { content: Array<{ text: string }> };
      };
      expect(rpcResp.id).toBe(6);
      expect(rpcResp.result.content[0]?.text).toContain("feat/clock-skew");
      rl.close();
    } finally {
      store.close();
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeServerHandle, createBridgeServer } from "../src/server.ts";

describe("agentdeck-bridge Protocol v1 server", () => {
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

  it("serves /v1/health openly and enforces Bearer auth on /v1/snapshot", async () => {
    const bridge = createBridgeServer({
      port: 0,
      authToken: "secret-bridge-token",
      hostnameLabel: "dev-rig",
    });
    handles.push(bridge);
    const { url } = await bridge.start();

    const health = await fetch(`${url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      protocolVersion: 1,
    });

    const unauth = await fetch(`${url}/v1/snapshot`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`${url}/v1/snapshot`, {
      headers: { Authorization: "Bearer secret-bridge-token" },
    });
    expect(authed.status).toBe(200);
    const snap = (await authed.json()) as {
      protocolVersion: number;
      host: string;
    };
    expect(snap.protocolVersion).toBe(1);
    expect(snap.host).toBe("dev-rig");
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
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body?.getReader();
    expect(reader).toBeDefined();

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

    let capturedApprovalId = "";
    const decoder = new TextDecoder();
    let buffer = "";
    while (reader && !capturedApprovalId) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.includes("event: approval_requested")) {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (dataLine) {
            const parsed = JSON.parse(dataLine.slice(6)) as {
              id: string;
              repo: string;
              branch: string;
              diffSummary?: string;
            };
            expect(parsed.repo).toBe("my-api-repo");
            expect(parsed.branch).toBe("feat/auth");
            expect(parsed.diffSummary).toBe("3 files (+42 -11)");
            capturedApprovalId = parsed.id;
          }
        }
      }
    }
    expect(capturedApprovalId).not.toBe("");

    const resolveRes = await fetch(
      `${url}/v1/approvals/${encodeURIComponent(capturedApprovalId)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          replyNote: "staging ok",
        }),
      },
    );
    expect(resolveRes.status).toBe(200);

    const hookResult = (await (await waitHookPromise).json()) as {
      decision: string;
      approvalId: string;
      replyNote?: string;
      hookSpecificOutput?: unknown;
    };
    expect(hookResult).toEqual({
      decision: "approve",
      approvalId: capturedApprovalId,
      replyNote: "staging ok",
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    sseController.abort();
  });

  it("returns Claude PreToolUse hookSpecificOutput on deny and replyNote", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const waitHookPromise = fetch(
      `${url}/v1/hooks/claude?wait=1&timeoutMs=5000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          cwd: "/home/dev/my-api-repo",
          branch: "main",
          tool_input: { command: "rm -rf build" },
        }),
      },
    );

    let approvalId = "";
    for (let i = 0; i < 20 && !approvalId; i += 1) {
      const snap = (await (await fetch(`${url}/v1/snapshot`)).json()) as {
        pendingApprovals: Array<{ id: string }>;
      };
      approvalId = snap.pendingApprovals[0]?.id ?? "";
      if (!approvalId) await new Promise((r) => setTimeout(r, 20));
    }
    expect(approvalId).not.toBe("");

    await fetch(
      `${url}/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "deny",
          replyNote: "Run unit tests instead",
        }),
      },
    );

    const hookResult = await (await waitHookPromise).json();
    expect(hookResult).toEqual({
      decision: "deny",
      approvalId,
      replyNote: "Run unit tests instead",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Run unit tests instead",
      },
    });
  });

  it("expires timed-out approvals and clears pendingApprovals count", async () => {
    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const preRes = await fetch(`${url}/v1/hooks/claude?wait=1&timeoutMs=120`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: "/home/dev/my-api-repo",
        tool_input: { command: "npm test" },
      }),
    });
    expect(preRes.status).toBe(200);
    const preBody = (await preRes.json()) as {
      decision: string;
      approvalId: string;
      hookSpecificOutput?: unknown;
    };
    expect(preBody.decision).toBe("timeout");
    expect(preBody.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
    });

    const permRes = await fetch(`${url}/v1/hooks/claude?wait=1&timeoutMs=120`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        cwd: "/home/dev/my-api-repo",
        tool_input: { command: "npm test" },
      }),
    });
    const permBody = (await permRes.json()) as {
      decision: string;
      hookSpecificOutput?: unknown;
    };
    expect(permBody.decision).toBe("timeout");
    expect(permBody.hookSpecificOutput).toBeUndefined();

    const health = (await (await fetch(`${url}/v1/health`)).json()) as {
      pendingApprovals: number;
    };
    expect(health.pendingApprovals).toBe(0);

    const snap = (await (await fetch(`${url}/v1/snapshot`)).json()) as {
      pendingApprovals: Array<{ status: string }>;
    };
    expect(
      snap.pendingApprovals.every((item) => item.status === "expired"),
    ).toBe(true);
  });

  it("computes Edit diffSummary and reads real git branch when omitted", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "agentdeck-git-"));
    tempDirs.push(repoDir);
    execFileSync("git", ["-C", repoDir, "init", "-b", "feat/hook-diff"], {
      stdio: "ignore",
    });

    const bridge = createBridgeServer({ port: 0 });
    handles.push(bridge);
    const { url } = await bridge.start();

    const res = await fetch(`${url}/v1/hooks/claude?wait=0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        cwd: repoDir,
        tool_input: {
          file_path: `${repoDir}/index.ts`,
          old_string: "const a = 1;",
          new_string: "const a = 1;\nconst b = 2;",
        },
      }),
    });
    expect(res.status).toBe(202);

    const snap = (await (await fetch(`${url}/v1/snapshot`)).json()) as {
      pendingApprovals: Array<{ branch: string; diffSummary?: string }>;
    };
    expect(snap.pendingApprovals[0]?.branch).toBe("feat/hook-diff");
    expect(snap.pendingApprovals[0]?.diffSummary).toBe("1 file (+2 -1)");
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
      expect(res.status).toBe(200);
    }

    const snapRes = await fetch(`${url}/v1/snapshot`);
    const snap = (await snapRes.json()) as {
      harnesses: Array<{ harness: string; remainingPct: number }>;
    };
    expect(snap.harnesses).toHaveLength(4);
    expect(snap.harnesses.map((h) => h.harness)).toEqual([
      "claude_code",
      "antigravity",
      "codex",
      "gemini_cli",
    ]);
    expect(snap.harnesses[0]?.remainingPct).toBe(18);
  });
});

import { randomUUID } from "node:crypto";
import { submitApproval } from "./approval-routes.ts";
import { pollGitHubPulse } from "./github-pulse.ts";
import {
  type BridgeHttpResponse,
  type BridgeRouteContext,
  parseComplexity,
} from "./http-routes.ts";
import { type HarnessId, parseHarnessId } from "./protocol.ts";
import { selectProactiveHarness } from "./router.ts";

export async function runLiveDispatchExecution(
  ctx: BridgeRouteContext,
  params: {
    harness: HarnessId;
    prompt: string;
    rawPrompt?: string;
    threadId?: string;
    repo: string;
    branch?: string;
    cwd?: string;
    waitMs?: number;
  },
): Promise<{ status: number; run: Record<string, unknown> }> {
  const fallbackOrder: HarnessId[] = [
    "antigravity",
    "free_pool",
    "opencode",
    "claude_code",
    "codex",
  ];
  const resolvedHarness = ctx.liveRunner.isHarnessAvailable(params.harness)
    ? params.harness
    : (fallbackOrder.find((h) => ctx.liveRunner.isHarnessAvailable(h)) ??
      params.harness);

  const launch = ctx.liveRunner.startLivePrompt({
    harness: resolvedHarness,
    prompt: params.prompt,
    rawPrompt: params.rawPrompt,
    threadId: params.threadId,
    repo: params.repo,
    branch: params.branch,
    cwd: params.cwd,
  });
  if (!launch.started) {
    const res = await launch.done;
    return {
      status: launch.rejected ? 403 : 200,
      run: res as unknown as Record<string, unknown>,
    };
  }
  const waitMs = Math.max(0, Math.min(5000, Math.round(params.waitMs ?? 1000)));
  if (waitMs === 0) {
    return {
      status: 200,
      run: {
        runId: launch.runId,
        threadId: launch.threadId,
        started: true,
        status: "running",
        harness: resolvedHarness,
        command: launch.command,
        cwd: launch.cwd,
      },
    };
  }
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    launch.done.then((res) => ({ done: true as const, res })),
    new Promise<{ done: false }>((resolve) => {
      waitTimer = setTimeout(() => resolve({ done: false }), waitMs);
    }),
  ]);
  if (waitTimer) clearTimeout(waitTimer);
  if (settled.done) {
    return {
      status: 200,
      run: settled.res as unknown as Record<string, unknown>,
    };
  }
  return {
    status: 200,
    run: {
      runId: launch.runId,
      threadId: launch.threadId,
      started: true,
      status: "running",
      harness: resolvedHarness,
      command: launch.command,
      cwd: launch.cwd,
    },
  };
}

function waitDelay(ctx: BridgeRouteContext, delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.delayTimers.delete(timer);
      resolve();
    }, delayMs);
    ctx.delayTimers.add(timer);
  });
}

function strOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export async function handleLiveBridgeRoute(
  ctx: BridgeRouteContext,
  method: string,
  url: URL,
  obj: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<BridgeHttpResponse | null> {
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/demo-gate") {
    const rawDelay =
      typeof obj.delayMs === "number"
        ? obj.delayMs
        : Number.parseInt(url.searchParams.get("delayMs") ?? "0", 10);
    const delayMs = Number.isFinite(rawDelay)
      ? Math.max(0, Math.min(10_000, Math.round(rawDelay)))
      : 0;
    await waitDelay(ctx, delayMs);
    if (ctx.isStopped()) {
      return { status: 503, body: { error: "Bridge stopped" } };
    }

    const repo = strOrDefault(obj.repo, "my-api-repo");
    const branch = strOrDefault(obj.branch, "feat/auth");
    const command = strOrDefault(
      obj.command,
      "npm run deploy:preview --env staging",
    );
    const diffSummary = strOrDefault(obj.diffSummary, "3 files (+42 -11)");
    const harness = parseHarnessId(obj.harness) ?? "claude_code";
    const wait =
      url.searchParams.get("wait") === "1" ||
      obj.wait === 1 ||
      obj.wait === true ||
      obj.wait === "1";
    const rawTimeout =
      typeof obj.timeoutMs === "number"
        ? obj.timeoutMs
        : Number.parseInt(url.searchParams.get("timeoutMs") ?? "600000", 10);
    const timeoutMs = Number.isNaN(rawTimeout) ? 600_000 : rawTimeout;
    const createdAt = new Date().toISOString();

    ctx.pushRecentEvent({
      id: randomUUID(),
      type: "PermissionRequest",
      harness,
      summary: `${repo} (${branch}): ${command}`,
      createdAt,
    });

    const { approval, waitResult } = await submitApproval(ctx, {
      harness,
      repo,
      branch,
      command,
      diffSummary,
      createdAt,
      wait,
      timeoutMs,
      abortSignal,
    });
    if (!waitResult) {
      return {
        status: 202,
        body: { ok: true, approvalId: approval.id, approval },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        decision: waitResult.decision,
        approvalId: waitResult.approvalId,
        ...(waitResult.replyNote ? { replyNote: waitResult.replyNote } : {}),
        approval,
      },
    };
  }

  if (method === "POST" && pathname === "/v1/triage") {
    const repo = typeof obj.repo === "string" ? obj.repo.trim() : "";
    if (!repo) {
      return {
        status: 400,
        body: { error: "repo must be a non-empty string" },
      };
    }
    const pulse = ctx.snapshot.pulses.find(
      (p) => p.repo === repo || p.repo.endsWith(`/${repo}`),
    );
    const branch =
      typeof obj.branch === "string" && obj.branch.trim()
        ? obj.branch.trim()
        : pulse?.branch;
    const prompt =
      typeof obj.prompt === "string" && obj.prompt.trim()
        ? obj.prompt.trim()
        : pulse
          ? `Triage ${repo} (${pulse.branch}): ${pulse.openIssues} open issues, ${pulse.openPrs} open PRs, CI=${pulse.ciStatus}. Inspect failing checks or top issue and propose next action.`
          : `Triage ${repo}${branch ? ` (${branch})` : ""}: inspect open issues, PRs, and CI status and propose next action.`;
    const reserveFloorPct =
      typeof obj.reserveFloorPct === "number"
        ? Math.max(0, Math.min(90, Math.round(obj.reserveFloorPct)))
        : ctx.defaultReserveFloorPct;
    const { capsule, block } = ctx.memoryStore.buildHandoffContextBlock(
      repo,
      prompt,
    );
    const route = selectProactiveHarness({
      prompt,
      harnesses: ctx.snapshot.harnesses,
      complexity: parseComplexity(obj.complexity),
      preferredHarness: parseHarnessId(obj.preferredHarness) ?? undefined,
      reserveFloorPct,
      freePool: ctx.freePool,
      contextBlock: block,
      capsule,
    });
    ctx.memoryStore.recordActivity({
      repo,
      branch,
      harness: route.selectedHarness,
      goal: `Triage ${repo}`,
      action: `Triaged via ${route.selectedHarness}`,
    });
    ctx.snapshot.handoffs = ctx.memoryStore.listHandoffs();
    ctx.pushRecentEvent({
      id: randomUUID(),
      type: "triage_routed",
      harness: route.selectedHarness,
      summary: `Triage ${repo} -> ${route.selectedHarness} (${route.reason})`,
      createdAt: new Date().toISOString(),
    });
    ctx.broadcast("task_routed", route);

    if (obj.executeNow) {
      const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
      const waitMs = typeof obj.waitMs === "number" ? obj.waitMs : undefined;
      const execRes = await runLiveDispatchExecution(ctx, {
        harness: route.selectedHarness,
        prompt: route.handoffPrompt,
        rawPrompt: prompt,
        repo,
        branch,
        cwd,
        waitMs,
      });
      if (execRes.status === 403) {
        return {
          status: 403,
          body: {
            ok: false,
            error: execRes.run.error,
            route,
            run: execRes.run,
          },
        };
      }
      return { status: 200, body: { ok: true, route, run: execRes.run } };
    }
    return { status: 200, body: { ok: true, route } };
  }

  if (method === "GET" && pathname === "/v1/pairing") {
    const directBase = ctx.getDirectBaseUrl();
    const directUri =
      `agentdeck://direct?url=${encodeURIComponent(directBase)}` +
      `&host=${encodeURIComponent(ctx.snapshot.host)}` +
      `${ctx.authToken ? `&token=${encodeURIComponent(ctx.authToken)}` : ""}`;
    const relay = ctx.getRelayStatus();
    return {
      status: 200,
      body: {
        ok: true,
        host: ctx.snapshot.host,
        directUri,
        ...(relay?.pairingUri ? { relayPairingUri: relay.pairingUri } : {}),
        ...(relay?.roomId ? { roomId: relay.roomId } : {}),
        bridgeConnected: relay?.bridgeConnected ?? false,
        clientPaired: relay?.clientPaired ?? false,
      },
    };
  }

  if (method === "GET" && pathname === "/v1/pulses") {
    const refresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("refresh") === "true";
    const reposParam = url.searchParams.get("repos")?.trim();
    const repos = reposParam
      ? reposParam
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
    const pulses = await pollGitHubPulse(repos, { force: refresh });
    ctx.snapshot.pulses = pulses;
    ctx.touchSnapshot();
    ctx.broadcast("pulses_updated", pulses);
    return { status: 200, body: { ok: true, pulses } };
  }

  if (method === "GET" && pathname === "/v1/history") {
    const threadId = url.searchParams.get("threadId")?.trim() || undefined;
    const repo = url.searchParams.get("repo")?.trim() || undefined;
    const rawLim = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const runs = ctx.memoryStore.history.listRuns({
      threadId,
      repo,
      limit: Number.isNaN(rawLim) ? 20 : rawLim,
    });
    return { status: 200, body: { ok: true, runs } };
  }

  if (
    (method === "DELETE" && pathname === "/v1/history") ||
    (method === "POST" && pathname === "/v1/history/clear")
  ) {
    const threadId =
      (typeof obj.threadId === "string" ? obj.threadId.trim() : "") ||
      url.searchParams.get("threadId")?.trim() ||
      undefined;
    const clearHandoffs =
      obj.clearHandoffs === true ||
      obj.clearHandoffs === "true" ||
      url.searchParams.get("clearHandoffs") === "1";
    const deleted = ctx.memoryStore.history.clearHistory(
      threadId ? { threadId } : undefined,
    );
    if (clearHandoffs) {
      ctx.memoryStore.clearHandoffs();
      ctx.snapshot.handoffs = [];
    }
    if (!threadId) ctx.snapshot.recentEvents = [];
    ctx.snapshot.recentRuns = ctx.memoryStore.history.listRuns({
      limit: 20,
      maxOutputChars: 4000,
    });
    ctx.touchSnapshot();
    ctx.broadcast("history_cleared", { threadId: threadId ?? null });
    ctx.broadcast("snapshot", ctx.snapshot);
    return {
      status: 200,
      body: { ok: true, deleted, recentRuns: ctx.snapshot.recentRuns },
    };
  }

  return null;
}

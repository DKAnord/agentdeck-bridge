import { randomUUID } from "node:crypto";
import {
  buildClaudeHookResponse,
  enrichClaudeHookPayload,
} from "./claude-hook.ts";
import {
  type BridgeHttpResponse,
  type BridgeRouteContext,
  extractHookFilePath,
  notifyWebhook,
} from "./http-routes.ts";
import type { ApprovalRequest, BridgeEvent, HarnessId } from "./protocol.ts";

function expireApproval(
  ctx: BridgeRouteContext,
  approval: ApprovalRequest,
): void {
  if (approval.status !== "pending") return;
  approval.status = "expired";
  ctx.touchSnapshot();
  ctx.broadcast("approval_expired", approval);
}

export async function submitApproval(
  ctx: BridgeRouteContext,
  params: {
    harness: HarnessId;
    repo: string;
    branch: string;
    command: string;
    diffSummary?: string;
    createdAt?: string;
    wait: boolean;
    timeoutMs: number;
    abortSignal?: AbortSignal;
  },
): Promise<{
  approval: ApprovalRequest;
  waitResult?: {
    decision: "approve" | "deny" | "timeout";
    approvalId: string;
    replyNote?: string;
  };
}> {
  const approval: ApprovalRequest = {
    id: randomUUID(),
    harness: params.harness,
    repo: params.repo,
    branch: params.branch,
    command: params.command,
    ...(params.diffSummary ? { diffSummary: params.diffSummary } : {}),
    createdAt: params.createdAt ?? new Date().toISOString(),
    status: "pending",
  };
  ctx.snapshot.pendingApprovals = [
    approval,
    ...ctx.snapshot.pendingApprovals,
  ].slice(0, 20);
  ctx.touchSnapshot();
  ctx.broadcast("approval_requested", approval);
  void notifyWebhook(ctx.webhookUrl, approval);

  if (!params.wait) return { approval };

  const timeoutMs = Math.max(100, Math.min(900_000, params.timeoutMs));
  const waitResult = await new Promise<{
    decision: "approve" | "deny" | "timeout";
    approvalId: string;
    replyNote?: string;
  }>((resolve) => {
    const onAbort = () => {
      const pending = ctx.waiters.get(approval.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      ctx.waiters.delete(approval.id);
      expireApproval(ctx, approval);
      resolve({ decision: "timeout", approvalId: approval.id });
    };
    const timer = setTimeout(() => {
      params.abortSignal?.removeEventListener("abort", onAbort);
      ctx.waiters.delete(approval.id);
      expireApproval(ctx, approval);
      resolve({ decision: "timeout", approvalId: approval.id });
    }, timeoutMs);
    ctx.waiters.set(approval.id, {
      timer,
      resolve: (res) => {
        params.abortSignal?.removeEventListener("abort", onAbort);
        resolve(res);
      },
    });
    if (params.abortSignal?.aborted) {
      onAbort();
    } else {
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }
  });
  return { approval, waitResult };
}

export function resolveApprovalRequest(
  ctx: BridgeRouteContext,
  approvalId: string,
  obj: Record<string, unknown>,
): BridgeHttpResponse {
  const decision =
    obj.decision === "approve" || obj.decision === "deny" ? obj.decision : null;
  if (!decision) {
    return {
      status: 400,
      body: { error: "decision must be 'approve' or 'deny'" },
    };
  }
  const replyNote =
    typeof obj.replyNote === "string" && obj.replyNote.trim()
      ? obj.replyNote.trim()
      : undefined;

  const approval = ctx.snapshot.pendingApprovals.find(
    (item) => item.id === approvalId,
  );
  if (!approval) return { status: 404, body: { error: "Approval not found" } };

  approval.status = decision === "approve" ? "approved" : "denied";
  if (replyNote) {
    approval.replyNote = replyNote;
    if (approval.repo !== "my-api-repo") {
      ctx.memoryStore.recordActivity({
        repo: approval.repo,
        branch: approval.branch,
        harness: approval.harness,
        note: replyNote,
      });
      ctx.snapshot.handoffs = ctx.memoryStore.listHandoffs();
    }
  }
  ctx.touchSnapshot();
  ctx.broadcast("approval_resolved", approval);

  const waiter = ctx.waiters.get(approvalId);
  if (waiter) {
    clearTimeout(waiter.timer);
    ctx.waiters.delete(approvalId);
    waiter.resolve({
      decision,
      approvalId,
      ...(replyNote ? { replyNote } : {}),
    });
  }
  return { status: 200, body: { ok: true, approval } };
}

export async function handleApprovalBridgeRoute(
  ctx: BridgeRouteContext,
  method: string,
  url: URL,
  obj: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<BridgeHttpResponse | null> {
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/hooks/claude") {
    const parsed = enrichClaudeHookPayload(obj);
    ctx.memoryStore.recordActivity({
      repo: parsed.repo,
      branch: parsed.branch,
      harness: parsed.harness,
      action: parsed.command,
      filePath: extractHookFilePath(obj),
      diffSummary: parsed.diffSummary,
    });
    ctx.snapshot.handoffs = ctx.memoryStore.listHandoffs();

    const evt: BridgeEvent = {
      id: randomUUID(),
      type: parsed.eventName,
      harness: parsed.harness,
      summary: parsed.summary,
      createdAt: new Date().toISOString(),
    };
    ctx.pushRecentEvent(evt);

    if (!parsed.requiresApproval) {
      ctx.broadcast("hook_event", evt);
      return { status: 200, body: { ok: true, eventId: evt.id } };
    }

    const rawTimeout = Number.parseInt(
      url.searchParams.get("timeoutMs") ?? "600000",
      10,
    );
    const { approval, waitResult } = await submitApproval(ctx, {
      harness: parsed.harness,
      repo: parsed.repo,
      branch: parsed.branch,
      command: parsed.command,
      diffSummary: parsed.diffSummary,
      createdAt: evt.createdAt,
      wait: url.searchParams.get("wait") === "1",
      timeoutMs: Number.isNaN(rawTimeout) ? 600_000 : rawTimeout,
      abortSignal,
    });
    if (!waitResult) {
      return { status: 202, body: { ok: true, approvalId: approval.id } };
    }
    return {
      status: 200,
      body: buildClaudeHookResponse({
        eventName: parsed.eventName,
        decision: waitResult.decision,
        approvalId: waitResult.approvalId,
        replyNote: waitResult.replyNote,
      }),
    };
  }

  const resolveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && resolveMatch?.[1]) {
    return resolveApprovalRequest(
      ctx,
      decodeURIComponent(resolveMatch[1]),
      obj,
    );
  }

  return null;
}

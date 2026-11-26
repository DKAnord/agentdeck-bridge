import { createInterface } from "node:readline";
import type { MemoryStore } from "./memory-store.ts";
import { parseHarnessId } from "./protocol.ts";

const MCP_TOOLS = [
  {
    name: "memory_remember",
    description:
      "Save a durable decision, convention, or debugging lesson into shared cross-agent SQLite memory.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" },
        repo: { type: "string" },
        scope: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        harness: { type: "string" },
      },
    },
  },
  {
    name: "memory_recall",
    description:
      "Search shared cross-agent memories using SQLite FTS5 across Claude Code, Antigravity, Codex, and OpenCode.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        repo: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "handoff_get",
    description:
      "Fetch the active Handoff Capsule (branch, goal, touched files, diff, notes) for a repo.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: { repo: { type: "string" } },
    },
  },
  {
    name: "handoff_update",
    description:
      "Update the rolling Handoff Capsule for a repo so any downstream AI harness resumes seamlessly.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        repo: { type: "string" },
        branch: { type: "string" },
        goal: { type: "string" },
        harness: { type: "string" },
        diffSummary: { type: "string" },
        filePath: { type: "string" },
        action: { type: "string" },
        note: { type: "string" },
      },
    },
  },
];

const toolOk = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

const toolErr = (message: string) => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

function strArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = args[key];
  return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

function runToolCall(
  store: MemoryStore,
  name: string,
  args: Record<string, unknown>,
) {
  if (name === "memory_remember") {
    const summary = strArg(args, "summary");
    if (!summary) return toolErr("summary is required");
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((item): item is string => typeof item === "string")
      : undefined;
    return toolOk({
      ok: true,
      memory: store.remember({
        summary,
        repo: strArg(args, "repo"),
        scope: strArg(args, "scope"),
        tags,
        sourceHarness: parseHarnessId(args.harness) ?? "custom",
      }),
    });
  }
  if (name === "memory_recall") {
    const query = strArg(args, "query");
    if (!query) return toolErr("query is required");
    return toolOk({
      ok: true,
      memories: store.recall({
        query,
        repo: strArg(args, "repo"),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
    });
  }
  if (name === "handoff_get") {
    const repo = strArg(args, "repo");
    if (!repo) return toolErr("repo is required");
    return toolOk({ ok: true, handoff: store.getHandoff(repo) });
  }
  if (name === "handoff_update") {
    const repo = strArg(args, "repo");
    if (!repo) return toolErr("repo is required");
    return toolOk({
      ok: true,
      handoff: store.recordActivity({
        repo,
        branch: strArg(args, "branch"),
        goal: strArg(args, "goal"),
        harness: parseHarnessId(args.harness) ?? "custom",
        diffSummary: strArg(args, "diffSummary"),
        filePath: strArg(args, "filePath"),
        action: strArg(args, "action"),
        note: strArg(args, "note"),
      }),
    });
  }
  return toolErr(`Unknown tool: ${name}`);
}

export function handleMcpJsonRpc(
  store: MemoryStore,
  rawMsg: unknown,
): Record<string, unknown> | null {
  if (!rawMsg || typeof rawMsg !== "object") {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  const msg = rawMsg as Record<string, unknown>;
  const hasId =
    Object.hasOwn(msg, "id") && msg.id !== undefined && msg.id !== null;
  if (!hasId) return null;

  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params =
    msg.params && typeof msg.params === "object"
      ? (msg.params as Record<string, unknown>)
      : {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentdeck-memory", version: "0.2.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    return { jsonrpc: "2.0", id, result: runToolCall(store, name, args) };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function startMcpStdioServer(
  store: MemoryStore,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })}\n`,
      );
      return;
    }
    const response = handleMcpJsonRpc(store, parsed);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  });
  return rl;
}

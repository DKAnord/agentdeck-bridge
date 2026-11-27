import type { DatabaseSync } from "node:sqlite";
import type { HarnessId, RunHistoryRecord } from "./protocol.ts";

const MAX_STORED_OUTPUT_CHARS = 16_384;

interface HistoryRow {
  id: string;
  thread_id: string;
  repo: string;
  harness: string;
  prompt: string;
  output: string;
  status: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface RecordRunStartInput {
  id: string;
  threadId: string;
  repo: string;
  harness: HarnessId;
  prompt: string;
}

export interface RecordRunFinishInput {
  id: string;
  output: string;
  status: "completed" | "failed";
  error?: string;
  durationMs?: number;
}

export interface ListRunsInput {
  threadId?: string;
  repo?: string;
  limit?: number;
  maxOutputChars?: number;
}

function rowToHistoryRecord(
  row: HistoryRow,
  maxOutputChars?: number,
): RunHistoryRecord {
  let output = row.output;
  if (maxOutputChars && output.length > maxOutputChars) {
    output = `${output.slice(0, maxOutputChars - 3)}...`;
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    repo: row.repo,
    harness: row.harness as HarnessId,
    prompt: row.prompt,
    output,
    status: row.status as RunHistoryRecord["status"],
    ...(row.error ? { error: row.error } : {}),
    ...(typeof row.duration_ms === "number"
      ? { durationMs: row.duration_ms }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createHistoryStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_history (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      harness TEXT NOT NULL,
      prompt TEXT NOT NULL,
      output TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_history_created ON dispatch_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatch_history_thread ON dispatch_history(thread_id, created_at ASC);
  `);

  const insertRun = db.prepare(`
    INSERT INTO dispatch_history (
      id, thread_id, repo, harness, prompt, output, status, error, duration_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id, repo = excluded.repo,
      harness = excluded.harness, prompt = excluded.prompt,
      updated_at = excluded.updated_at
  `);
  const updateRun = db.prepare(`
    UPDATE dispatch_history
    SET output = ?, status = ?, error = ?, duration_ms = ?, updated_at = ?
    WHERE id = ?
  `);
  const getRunStmt = db.prepare("SELECT * FROM dispatch_history WHERE id = ?");
  const delThreadStmt = db.prepare(
    "DELETE FROM dispatch_history WHERE thread_id = ?",
  );
  const delAllStmt = db.prepare("DELETE FROM dispatch_history");

  function recordRunStart(input: RecordRunStartInput): RunHistoryRecord {
    const now = new Date().toISOString();
    const threadId = input.threadId.trim() || input.id;
    const repo = input.repo.trim() || "workspace";
    const prompt = input.prompt.trim();
    insertRun.run(
      input.id,
      threadId,
      repo,
      input.harness,
      prompt,
      "",
      now,
      now,
    );
    return {
      id: input.id,
      threadId,
      repo,
      harness: input.harness,
      prompt,
      output: "",
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
  }

  function recordRunFinish(
    input: RecordRunFinishInput,
  ): RunHistoryRecord | null {
    const now = new Date().toISOString();
    const capped =
      input.output.length > MAX_STORED_OUTPUT_CHARS
        ? input.output.slice(0, MAX_STORED_OUTPUT_CHARS)
        : input.output;
    updateRun.run(
      capped,
      input.status,
      input.error ?? null,
      typeof input.durationMs === "number"
        ? Math.round(input.durationMs)
        : null,
      now,
      input.id,
    );
    const row = getRunStmt.get(input.id) as unknown as HistoryRow | undefined;
    return row ? rowToHistoryRecord(row) : null;
  }

  function listRuns(input: ListRunsInput = {}): RunHistoryRecord[] {
    const limit = Math.max(1, Math.min(50, Math.round(input.limit ?? 20)));
    const threadId = input.threadId?.trim() || undefined;
    const repo = input.repo?.trim() || undefined;
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (threadId) {
      clauses.push("thread_id = ?");
      args.push(threadId);
    }
    if (repo) {
      clauses.push("repo = ?");
      args.push(repo);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = threadId ? "ASC, rowid ASC" : "DESC, rowid DESC";
    const sql = `SELECT * FROM dispatch_history ${where} ORDER BY created_at ${order} LIMIT ?`;
    args.push(limit);
    const rows = db.prepare(sql).all(...args) as unknown as HistoryRow[];
    return rows.map((row) => rowToHistoryRecord(row, input.maxOutputChars));
  }

  function buildThreadContextBlock(
    threadId: string,
    maxTurns = 4,
    maxChars = 2200,
  ): string {
    const cleanId = threadId.trim();
    if (!cleanId) return "";
    const turns = listRuns({ threadId: cleanId, limit: 20 })
      .filter((r) => r.status !== "running" && (r.output.trim() || r.error))
      .slice(-maxTurns);
    if (turns.length === 0) return "";

    const lines = ["[Recent CLI Thread History]"];
    for (const turn of turns) {
      const reply = (turn.output || `Error: ${turn.error ?? "failed"}`)
        .trim()
        .slice(0, 600);
      lines.push(`User: ${turn.prompt.slice(0, 240)}`);
      lines.push(`Assistant (${turn.harness}): ${reply}`);
    }
    const joined = lines.join("\n");
    return joined.length <= maxChars
      ? joined
      : `${joined.slice(0, maxChars - 3)}...`;
  }

  function clearHistory(opts: { threadId?: string } = {}): number {
    const tid = opts.threadId?.trim();
    const res = tid ? delThreadStmt.run(tid) : delAllStmt.run();
    return Number(res.changes ?? 0);
  }

  return {
    recordRunStart,
    recordRunFinish,
    listRuns,
    buildThreadContextBlock,
    clearHistory,
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;

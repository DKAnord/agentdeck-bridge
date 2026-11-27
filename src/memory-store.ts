import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HandoffCapsule, HarnessId, MemoryRecord } from "./protocol.ts";

export { syncAgentInstructionStubs } from "./rule-sync.ts";

const FTS_RESERVED = new Set(["and", "or", "not", "near"]);
const MAX_HANDOFF_BLOCK_CHARS = 1800;

export interface RememberInput {
  repo?: string;
  scope?: string;
  summary: string;
  tags?: string[];
  sourceHarness?: HarnessId;
}

export interface RecallInput {
  query?: string;
  repo?: string;
  limit?: number;
}

export interface RecordActivityInput {
  repo: string;
  branch?: string;
  harness: HarnessId;
  goal?: string;
  action?: string;
  filePath?: string;
  diffSummary?: string;
  note?: string;
}

interface MemoryRow {
  id: string;
  repo: string;
  scope: string;
  summary: string;
  tags_json: string;
  source_harness: string;
  created_at: string;
}

interface CapsuleRow {
  repo: string;
  branch: string;
  goal: string;
  last_harness: string;
  diff_summary: string | null;
  touched_files_json: string;
  recent_actions_json: string;
  notes_json: string;
  updated_at: string;
}

export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw.match(/[a-z0-9_]{2,}/gi) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (FTS_RESERVED.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    unique.push(`"${token}"*`);
    if (unique.length >= 8) break;
  }
  return unique.join(" OR ");
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mergeRecent(
  existing: string[],
  incoming: string | undefined,
  max: number,
): string[] {
  const clean = incoming?.trim();
  if (!clean) return existing.slice(0, max);
  return [clean, ...existing.filter((item) => item !== clean)].slice(0, max);
}

export function cleanCapsuleGoal(raw: string): string {
  const taskMarker = "\n\n[Task]\n";
  const afterTask = raw.includes(taskMarker)
    ? raw.slice(raw.lastIndexOf(taskMarker) + taskMarker.length)
    : raw;
  const lines = afterTask
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.includes("[AgentDeck Shared Memory") &&
        !line.startsWith("Repo:") &&
        !line.startsWith("Diff:") &&
        !line.startsWith("Touched files:") &&
        !line.startsWith("Recent actions:") &&
        !line.startsWith("Operator notes:") &&
        !line.startsWith("Recalled memories:") &&
        !line.startsWith("[Live GitHub Repo Pulse]"),
    );
  const clean = lines.join(" ").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? clean.slice(0, 160) : clean;
}

function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    repo: row.repo,
    scope: row.scope,
    summary: row.summary,
    tags: parseJsonStringArray(row.tags_json),
    sourceHarness: row.source_harness as HarnessId,
    createdAt: row.created_at,
  };
}

function rowToCapsule(row: CapsuleRow): HandoffCapsule {
  return {
    repo: row.repo,
    branch: row.branch,
    goal: cleanCapsuleGoal(row.goal) || "Active session",
    lastHarness: row.last_harness as HarnessId,
    ...(row.diff_summary ? { diffSummary: row.diff_summary } : {}),
    touchedFiles: parseJsonStringArray(row.touched_files_json),
    recentActions: parseJsonStringArray(row.recent_actions_json),
    notes: parseJsonStringArray(row.notes_json),
    updatedAt: row.updated_at,
  };
}

export function createMemoryStore(dbPath = ":memory:") {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 3000 });
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, scope TEXT NOT NULL,
      summary TEXT NOT NULL, tags_json TEXT NOT NULL,
      source_harness TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, repo, summary, tags);
    CREATE TABLE IF NOT EXISTS handoff_capsules (
      repo TEXT PRIMARY KEY, branch TEXT NOT NULL, goal TEXT NOT NULL,
      last_harness TEXT NOT NULL, diff_summary TEXT,
      touched_files_json TEXT NOT NULL, recent_actions_json TEXT NOT NULL,
      notes_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  let closed = false;
  const insertMem = db.prepare(
    "INSERT INTO memories (id, repo, scope, summary, tags_json, source_harness, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO memories_fts (id, repo, summary, tags) VALUES (?, ?, ?, ?)",
  );
  const upsertCapsule = db.prepare(`
    INSERT INTO handoff_capsules (
      repo, branch, goal, last_harness, diff_summary,
      touched_files_json, recent_actions_json, notes_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      branch = excluded.branch, goal = excluded.goal,
      last_harness = excluded.last_harness, diff_summary = excluded.diff_summary,
      touched_files_json = excluded.touched_files_json,
      recent_actions_json = excluded.recent_actions_json,
      notes_json = excluded.notes_json, updated_at = excluded.updated_at
  `);
  const getCapsuleStmt = db.prepare(
    "SELECT * FROM handoff_capsules WHERE repo = ?",
  );
  const listCapsulesStmt = db.prepare(
    "SELECT * FROM handoff_capsules ORDER BY updated_at DESC LIMIT ?",
  );
  const deleteCapsuleStmt = db.prepare(
    "DELETE FROM handoff_capsules WHERE repo = ?",
  );

  function remember(input: RememberInput): MemoryRecord {
    const summary = input.summary.trim();
    if (!summary) throw new Error("Memory summary must not be empty");
    const repo = input.repo?.trim() || "global";
    const scope = input.scope?.trim() || "context";
    const tags = Array.from(
      new Set(
        (input.tags ?? [])
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 12),
      ),
    );
    const sourceHarness = input.sourceHarness ?? "custom";
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    insertMem.run(
      id,
      repo,
      scope,
      summary,
      JSON.stringify(tags),
      sourceHarness,
      createdAt,
    );
    insertFts.run(id, repo, summary, tags.join(" "));
    return { id, repo, scope, summary, tags, sourceHarness, createdAt };
  }

  function recall(input: RecallInput = {}): MemoryRecord[] {
    const limit = Math.max(1, Math.min(50, Math.round(input.limit ?? 10)));
    const repo = input.repo?.trim() || undefined;
    const ftsQuery = input.query ? sanitizeFtsQuery(input.query) : "";
    if (ftsQuery) {
      const sql = repo
        ? `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
           WHERE memories_fts MATCH ? AND (m.repo = ? OR m.repo = 'global')
           ORDER BY CASE WHEN m.repo = ? THEN 0 ELSE 1 END, bm25(memories_fts), m.created_at DESC LIMIT ?`
        : `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
           WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?`;
      const rows = (repo
        ? db.prepare(sql).all(ftsQuery, repo, repo, limit)
        : db.prepare(sql).all(ftsQuery, limit)) as unknown as MemoryRow[];
      return rows.map(rowToMemory);
    }
    const sql = repo
      ? "SELECT * FROM memories WHERE repo = ? OR repo = 'global' ORDER BY CASE WHEN repo = ? THEN 0 ELSE 1 END, created_at DESC LIMIT ?"
      : "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?";
    const rows = (repo
      ? db.prepare(sql).all(repo, repo, limit)
      : db.prepare(sql).all(limit)) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  function getHandoff(repo: string): HandoffCapsule | null {
    const row = getCapsuleStmt.get(repo.trim()) as unknown as
      | CapsuleRow
      | undefined;
    return row ? rowToCapsule(row) : null;
  }

  function listHandoffs(limit = 10): HandoffCapsule[] {
    const safeLimit = Math.max(1, Math.min(50, Math.round(limit)));
    return (listCapsulesStmt.all(safeLimit) as unknown as CapsuleRow[]).map(
      rowToCapsule,
    );
  }

  function recordActivity(input: RecordActivityInput): HandoffCapsule {
    const repo = input.repo.trim() || "workspace";
    const existing = getHandoff(repo);
    const branch = input.branch?.trim() || existing?.branch || "main";
    const cleanedIncomingGoal = input.goal ? cleanCapsuleGoal(input.goal) : "";
    const existingGoal = existing ? cleanCapsuleGoal(existing.goal) : "";
    const goal =
      cleanedIncomingGoal ||
      existingGoal ||
      input.action?.trim() ||
      "Active session";
    const diffSummary = input.diffSummary?.trim() || existing?.diffSummary;
    const touchedFiles = mergeRecent(
      existing?.touchedFiles ?? [],
      input.filePath,
      8,
    );
    const recentActions = mergeRecent(
      existing?.recentActions ?? [],
      input.action,
      6,
    );
    const notes = mergeRecent(existing?.notes ?? [], input.note, 5);
    const updatedAt = new Date().toISOString();

    upsertCapsule.run(
      repo,
      branch,
      goal,
      input.harness,
      diffSummary ?? null,
      JSON.stringify(touchedFiles),
      JSON.stringify(recentActions),
      JSON.stringify(notes),
      updatedAt,
    );
    return {
      repo,
      branch,
      goal,
      lastHarness: input.harness,
      ...(diffSummary ? { diffSummary } : {}),
      touchedFiles,
      recentActions,
      notes,
      updatedAt,
    };
  }

  function buildHandoffContextBlock(repo: string, prompt: string) {
    const cleanRepo = repo.trim();
    const capsule = cleanRepo
      ? (getHandoff(cleanRepo) ?? undefined)
      : undefined;
    let memories = recall({
      query: prompt,
      repo: cleanRepo || undefined,
      limit: 3,
    });
    if (memories.length === 0)
      memories = recall({ repo: cleanRepo || undefined, limit: 3 });
    if (!capsule && memories.length === 0) return { memories: [], block: "" };

    const lines = ["[AgentDeck Shared Memory · Seamless Handoff]"];
    if (capsule) {
      lines.push(
        `Repo: ${capsule.repo} (${capsule.branch}) · Last harness: ${capsule.lastHarness}`,
      );
      lines.push(`Goal: ${capsule.goal}`);
      if (capsule.diffSummary) lines.push(`Diff: ${capsule.diffSummary}`);
      if (capsule.touchedFiles.length > 0)
        lines.push(`Touched files: ${capsule.touchedFiles.join(", ")}`);
      if (capsule.recentActions.length > 0)
        lines.push(`Recent actions: ${capsule.recentActions.join(" | ")}`);
      if (capsule.notes.length > 0)
        lines.push(`Operator notes: ${capsule.notes.join(" | ")}`);
    }
    if (memories.length > 0) {
      lines.push("Recalled memories:");
      for (const mem of memories)
        lines.push(`- [${mem.repo}/${mem.scope}] ${mem.summary}`);
    }
    const joined = lines.join("\n");
    const block =
      joined.length <= MAX_HANDOFF_BLOCK_CHARS
        ? joined
        : `${joined.slice(0, MAX_HANDOFF_BLOCK_CHARS - 3)}...`;
    return { ...(capsule ? { capsule } : {}), memories, block };
  }

  return {
    remember,
    recall,
    recordActivity,
    getHandoff,
    deleteHandoff: (repo: string) => {
      deleteCapsuleStmt.run(repo.trim());
    },
    listHandoffs,
    buildHandoffContextBlock,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;

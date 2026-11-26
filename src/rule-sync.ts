import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MEMORY_MARKER_START = "<!-- agentdeck:memory:start -->";
const MEMORY_MARKER_END = "<!-- agentdeck:memory:end -->";
const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

function buildManagedSection(): string {
  return [
    MEMORY_MARKER_START,
    "## Shared AgentDeck Memory",
    "- Read `.agentdeck/MEMORY.md` before starting cross-harness tasks.",
    "- When the `agentdeck-memory` stdio MCP server is attached, call `handoff_get` / `memory_recall` at session start and save key decisions with `memory_remember` / `handoff_update`.",
    MEMORY_MARKER_END,
  ].join("\n");
}

export function syncAgentInstructionStubs(workspaceDir: string): {
  memoryFile: string;
  updatedFiles: string[];
} {
  const memoryDir = join(workspaceDir, ".agentdeck");
  const memoryFile = join(memoryDir, "MEMORY.md");
  mkdirSync(memoryDir, { recursive: true });
  if (!existsSync(memoryFile)) {
    writeFileSync(
      memoryFile,
      "# AgentDeck Shared Workspace Memory\n\nRecord durable repo conventions, architecture choices, and active handoff context shared across Claude Code, Antigravity, Codex, and OpenCode.\n",
      "utf8",
    );
  }

  const section = buildManagedSection();
  const blockRe = new RegExp(
    `${MEMORY_MARKER_START}[\\s\\S]*?${MEMORY_MARKER_END}`,
  );
  const updatedFiles: string[] = [];

  for (const filename of AGENT_INSTRUCTION_FILES) {
    const filePath = join(workspaceDir, filename);
    const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    let next: string;
    if (blockRe.test(current)) {
      next = current.replace(blockRe, section);
    } else if (current.trim().length > 0) {
      next = `${current.trimEnd()}\n\n${section}\n`;
    } else {
      next = `${section}\n`;
    }
    if (next !== current) {
      writeFileSync(filePath, next, "utf8");
      updatedFiles.push(filename);
    }
  }

  return { memoryFile, updatedFiles };
}

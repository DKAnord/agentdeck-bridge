# `agentdeck-bridge` (MIT)

Zero-dependency local bridge daemon implementing **AgentDeck Protocol v1**.
Runs strictly on `127.0.0.1` by default, accepts Claude Code / Codex / OpenClaw
hooks and quota updates, proactively routes tasks across Pro + OpenCode Free Pool
windows, and exposes a shared `node:sqlite` FTS5 **Handoff Capsule & MCP memory server**.

## Quickstart (Node 22+, Zero `npm install`)

```bash
git clone https://github.com/DKAnord/agentdeck-bridge.git
cd agentdeck-bridge
npm test             # runs built-in node --test SSE, router & MCP checks
npm run demo         # simulates a blocking ?wait=1 approval end-to-end
node bin/agentdeck-bridge.mjs
```

Landing page & Android early-access deck: https://agentdeck.dkanord.workers.dev

See [SECURITY.md](./SECURITY.md) for the loopback threat model and X25519 + AES-256-GCM relay verification contract.

Environment variables:
- `AGENTDECK_HOST` (default `127.0.0.1`)
- `AGENTDECK_PORT` (default `7742`)
- `AGENTDECK_TOKEN` (optional Bearer token for `/v1/*` routes)
- `AGENTDECK_WEBHOOK_URL` (optional BYO `ntfy.sh` / UnifiedPush / webhook URL fired when an approval request arrives)
- `AGENTDECK_MEMORY_DB` (optional SQLite path, default `~/.agentdeck/memory.sqlite`)
- `AGENTDECK_RESERVE_FLOOR` (default `20` — percentage of Pro quota held back for deep work)
- `AGENTDECK_TIMEOUT_MS` (hook wait timeout in ms, default `600000` / 10 min, max `900000`)
- `AGENTDECK_FAIL_OPEN` (`1` by default in `hooks/claude-hook.sh` so stopping the bridge never blocks local Claude Code calls)

## Proactive Quota Autopilot & Shared Memory (`--mcp` / `--sync-rules`)

- **Shared `stdio` MCP (`node bin/agentdeck-bridge.mjs --mcp`):** Wire the same SQLite FTS5 store into Claude Code, Antigravity, Codex, and OpenCode (`memory_remember`, `memory_recall`, `handoff_get`, `handoff_update`).
- **Rule Stub Sync (`node bin/agentdeck-bridge.mjs --sync-rules [dir]`):** Creates `.agentdeck/MEMORY.md` and appends an idempotent managed memory block across `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.

### MCP Config (Claude Code `~/.claude.json`, Antigravity `mcp_config.json`, OpenCode)

```json
{
  "mcpServers": {
    "agentdeck-memory": {
      "command": "node",
      "args": ["/path/to/agentdeck-bridge/bin/agentdeck-bridge.mjs", "--mcp"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`) & Proactive Dispatch

```toml
[mcp_servers.agentdeck]
command = "node"
args = ["/path/to/agentdeck-bridge/bin/agentdeck-bridge.mjs", "--mcp"]
```

```bash
curl -fsS http://127.0.0.1:7742/v1/dispatch -H 'Content-Type: application/json' \
  -d '{"repo":"my-cli-tool","prompt":"Fix JWT clock skew test"}'
```

## Claude Code Hook Configuration (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "/path/to/agentdeck-bridge/hooks/claude-hook.sh" }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "AGENTDECK_WAIT=0 /path/to/agentdeck-bridge/hooks/claude-hook.sh" }]
    }]
  }
}
```

## Protocol v1 Endpoints

- `GET /v1/health` — liveness & queue counts
- `GET /v1/snapshot` — current `DeckSnapshot` (`harnesses`, `pendingApprovals`, `recentEvents`, `handoffs`)
- `GET /v1/events` — `text/event-stream` SSE stream (`snapshot`, `approval_requested`, `approval_resolved`, `quota_updated`, `hook_event`, `task_routed`, `memory_updated`)
- `POST /v1/hooks/claude?wait=1` — accepts Claude Code hook JSON, enriches branch/diffs, updates repo `HandoffCapsule`, and returns `hookSpecificOutput` JSON on resolution or timeout
- `POST /v1/approvals/:id/resolve` — `{ "decision": "approve" | "deny", "replyNote"?: "..." }`
- `POST /v1/quota` — upsert multi-tool quota & reset countdown (`claude_code`, `antigravity`, `codex`, `gemini_cli`, `openclaw`, `opencode`, `free_pool`)
- `POST /v1/dispatch` — select best available harness via complexity × reserve-floor waterfall + reset harvest and prepend `[AgentDeck Shared Memory · Seamless Handoff]`
- `POST /v1/free-pool` — register or update free-tier API providers (supports `x-ratelimit-*` headers & `429` cooldown rotation)
- `GET /v1/memory` / `POST /v1/memory` — inspect repo handoff capsules or store/search FTS5 shared memories

## Transport Modes

- **Direct LAN / Tailscale (Free):** Point your Android AgentDeck client directly at your Tailscale Serve HTTPS URL.
- **Zero-Knowledge E2E Cloud Relay + FCM:** For Doze-mode wake pushes without maintaining Tailscale SSE sockets or Firebase sender keys, pair via outbound `wss://` with X25519 QR encryption (or self-host on your own Cloudflare Free account).

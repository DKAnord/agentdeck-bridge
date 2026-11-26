# `agentdeck-bridge` (MIT)

Zero-dependency local bridge daemon implementing **AgentDeck Protocol v1**.
Runs strictly on `127.0.0.1` by default, accepts Claude Code / Codex / OpenClaw
hooks and quota updates, and streams normalized snapshots over HTTP + SSE.

## Quickstart (Node 22+, Zero `npm install`)

```bash
git clone https://github.com/DKAnord/agentdeck-bridge.git
cd agentdeck-bridge
npm test             # runs built-in node --test SSE & auth checks
npm run demo         # simulates a blocking ?wait=1 approval end-to-end
node bin/agentdeck-bridge.mjs
```

Landing page & Android early-access deck: https://agentdeck.dkanord.workers.dev

See [SECURITY.md](./SECURITY.md) for the loopback threat model and X25519 + AES-256-GCM relay verification contract.

Environment variables:
- `AGENTDECK_HOST` (default `127.0.0.1`)
- `AGENTDECK_PORT` (default `7742`)
- `AGENTDECK_TOKEN` (optional Bearer token for `/v1/snapshot`, `/v1/events`, `/v1/hooks/*`, `/v1/approvals/*`, `/v1/quota`)
- `AGENTDECK_WEBHOOK_URL` (optional BYO `ntfy.sh` / UnifiedPush / webhook URL fired when an approval request arrives)
- `AGENTDECK_TIMEOUT_MS` (hook wait timeout in ms, default `600000` / 10 min, max `900000`)
- `AGENTDECK_FAIL_OPEN` (`1` by default in `hooks/claude-hook.sh` so stopping the bridge never blocks local Claude Code calls)

## Claude Code Hook Configuration (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/agentdeck-bridge/hooks/claude-hook.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "AGENTDECK_WAIT=0 /path/to/agentdeck-bridge/hooks/claude-hook.sh"
          }
        ]
      }
    ]
  }
}
```

## Protocol v1 Endpoints

- `GET /v1/health` — liveness & queue counts
- `GET /v1/snapshot` — current `DeckSnapshot` (`harnesses`, `pendingApprovals`, `recentEvents`)
- `GET /v1/events` — `text/event-stream` SSE stream (`snapshot`, `approval_requested`, `approval_resolved`, `quota_updated`, `hook_event`)
- `POST /v1/hooks/claude?wait=1` — accepts Claude Code hook JSON (`PermissionRequest` or `PreToolUse`), enriches branch/Edit/Write diffs automatically, holds open up to `AGENTDECK_TIMEOUT_MS` (default `600000`), and returns Claude `hookSpecificOutput` JSON (`decision.behavior` / `permissionDecision`) on resolution or timeout
- `POST /v1/approvals/:id/resolve` — `{ "decision": "approve" | "deny", "replyNote"?: "..." }`
- `POST /v1/quota` — upsert multi-tool quota & reset countdown (`claude_code`, `antigravity`, `codex`, `gemini_cli`, `openclaw`)

## Transport Modes

- **Direct LAN / Tailscale (Free):** Point your Android AgentDeck client directly at your Tailscale Serve HTTPS URL.
- **Zero-Knowledge E2E Cloud Relay + FCM:** For Doze-mode wake pushes without maintaining Tailscale SSE sockets or Firebase sender keys, pair via outbound `wss://` with X25519 QR encryption (or self-host on your own Cloudflare Free account).

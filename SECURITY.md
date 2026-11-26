# Security & Threat Model (`agentdeck-bridge`)

`agentdeck-bridge` is intentionally small and zero-dependency so you can audit every line before wiring it to local coding agent hooks.

## Threat Model & Local Controls

- **Loopback-only by default:** The HTTP/SSE server binds strictly to `127.0.0.1` (`AGENTDECK_HOST=127.0.0.1`). It never exposes `0.0.0.0` unless explicitly overridden.
- **Constant-time Bearer authentication:** Setting `AGENTDECK_TOKEN` enforces `Authorization: Bearer <token>` across `/v1/snapshot`, `/v1/events`, `/v1/hooks/*`, `/v1/approvals/*`, `/v1/quota`, `/v1/dispatch`, `/v1/free-pool`, and `/v1/memory` using `crypto.timingSafeEqual`. Only `/v1/health` (returning `{ ok, protocolVersion, pendingApprovals, sseClients }`) remains unauthenticated.
- **Bounded input parsing & allowlisted execution:** Request bodies are capped at `65,536` bytes (`413` on overflow), and hook execution never invokes a shell (`shell: false`). Live CLI prompts (`executeNow: true`) are fail-closed unless `AGENTDECK_ALLOWED_DIRS` / `--allowed-dirs` is explicitly configured, canonicalize `cwd` with `fs.realpathSync` to block symlink/path traversal (`403`), and allow only explicit harness CLIs (`agy`, `opencode`, `claude`, `codex`).
- **Local-only SQLite memory (`~/.agentdeck/memory.sqlite`) & session file (`0600`):** `--mcp` runs strictly over local `stdio` and HTTP memory/pairing routes stay behind loopback + Bearer auth (`timingSafeEqual`). Persisted relay keys (`~/.agentdeck/relay-session.json`) are written with `0600` permissions; `agentdeck-bridge` makes zero direct LLM API calls.
- **Keyless Free Pool telemetry:** `/v1/free-pool` stores only quota percentages, reset countdowns, and `x-ratelimit-*` header counts — BYO provider API keys stay inside your local CLI environment (`opencode`), never in `DeckSnapshot` or relay envelopes.
- **No inbound ports required:** Direct mode works over LAN or your existing Tailscale HTTPS tunnel. Optional `AGENTDECK_WEBHOOK_URL` sends only short alert summaries (`repo`, `branch`, `command`) to your configured `ntfy` / UnifiedPush endpoint.

## Phase 1 Cloud Relay Security Contract (Zero-Knowledge E2E)

When using the optional outbound `wss://` Cloud Relay for Android Doze wakeups:

1. **Client-to-Bridge Key Exchange:** QR pairing (`agentdeck://pair?...`) exchanges raw 32-byte **X25519** keys (43-char unpadded `base64url`) between the phone (Android Keystore) and your local bridge session.
2. **Authenticated Encryption (HKDF-SHA256 + AES-256-GCM):** Both sides derive the 32-byte AES key via `HKDF-SHA256(ikm = X25519(priv, peerPub), salt = roomId, info = "agentdeck-e2e-v1")` and bind `{ type: "e2e", roomId, sender, seq, iv, ct }` envelopes with `AAD = "${roomId}:${sender}:${seq}"` before leaving your workstation or phone.
3. **Spoof-Resistant Relay:** Because every approval decision and `rpc_request` must decrypt and authenticate against your paired device key and monotonic `seq` locally inside the bridge, a compromised or malicious cloud relay cannot read your diffs or forge an `Approve` event.

## Reporting a Vulnerability

Please open a private GitHub Security Advisory or issue at https://github.com/DKAnord/agentdeck-bridge/security with reproduction steps.

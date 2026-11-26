# Security & Threat Model (`agentdeck-bridge`)

`agentdeck-bridge` is intentionally small and zero-dependency so you can audit every line before wiring it to local coding agent hooks.

## Threat Model & Local Controls

- **Loopback-only by default:** The HTTP/SSE server binds strictly to `127.0.0.1` (`AGENTDECK_HOST=127.0.0.1`). It never exposes `0.0.0.0` unless explicitly overridden.
- **Constant-time Bearer authentication:** Setting `AGENTDECK_TOKEN` enforces `Authorization: Bearer <token>` across `/v1/snapshot`, `/v1/events`, `/v1/hooks/*`, `/v1/approvals/*`, and `/v1/quota` using `crypto.timingSafeEqual`. Only `/v1/health` (returning `{ ok, protocolVersion, pendingApprovals, sseClients }`) remains unauthenticated.
- **Bounded input parsing:** Request bodies are capped at `65,536` bytes (`413` on overflow), and hook execution does not invoke a shell from remote approval payloads.
- **No inbound ports required:** Direct mode works over LAN or your existing Tailscale HTTPS tunnel. Optional `AGENTDECK_WEBHOOK_URL` sends only short alert summaries (`repo`, `branch`, `command`) to your configured `ntfy` / UnifiedPush endpoint.

## Phase 1 Cloud Relay Security Contract (Zero-Knowledge E2E)

When using the optional outbound `wss://` Cloud Relay for Android Doze wakeups:

1. **Client-to-Bridge Key Exchange:** QR pairing exchanges **X25519** keys between the phone (Android Keystore) and your local bridge config.
2. **Authenticated Encryption (AES-256-GCM):** Prompts, diffs, quota telemetry, and `Approve` / `Deny` / `Reply` commands are encrypted and authenticated end-to-end before leaving your workstation or phone.
3. **Spoof-Resistant Relay:** Because every approval decision must decrypt and authenticate against your device key locally inside the bridge, a compromised or malicious cloud relay cannot read your diffs or forge an `Approve` event.

## Reporting a Vulnerability

Please open a private GitHub Security Advisory or issue at https://github.com/DKAnord/agentdeck-bridge/security with reproduction steps.

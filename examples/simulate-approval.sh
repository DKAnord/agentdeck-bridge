#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${AGENTDECK_DEMO_PORT:-7749}"
BASE_URL="http://127.0.0.1:${PORT}"

LOG_FILE="$(mktemp)"
HOOK_OUT="$(mktemp)"
BRIDGE_PID=""

cleanup() {
  if [[ -n "${BRIDGE_PID}" ]]; then
    kill "${BRIDGE_PID}" >/dev/null 2>&1 || true
    wait "${BRIDGE_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}" "${HOOK_OUT}"
}
trap cleanup EXIT

AGENTDECK_HOST="127.0.0.1" AGENTDECK_PORT="${PORT}" \
  node "${ROOT_DIR}/bin/agentdeck-bridge.mjs" >"${LOG_FILE}" 2>&1 &
BRIDGE_PID="$!"

for _ in $(seq 1 40); do
  if curl -fsS "${BASE_URL}/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

curl -fsS -X POST "${BASE_URL}/v1/quota" -H "Content-Type: application/json" \
  -d '{"harness":"claude_code","label":"Claude Code","remainingPct":18,"resetsInMinutes":42,"tier":"pro","status":"waiting"}' >/dev/null
curl -fsS -X POST "${BASE_URL}/v1/quota" -H "Content-Type: application/json" \
  -d '{"harness":"antigravity","label":"Antigravity","remainingPct":84,"tier":"pro","status":"active"}' >/dev/null
curl -fsS -X POST "${BASE_URL}/v1/quota" -H "Content-Type: application/json" \
  -d '{"harness":"codex","label":"Codex CLI","remainingPct":100,"tier":"free","status":"idle"}' >/dev/null

echo "1) Sending blocking PermissionRequest hook (?wait=1)..."
curl -fsS -X POST "${BASE_URL}/v1/hooks/claude?wait=1&timeoutMs=10000" \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PermissionRequest","tool_name":"Bash","cwd":"/home/dev/my-api-repo","branch":"feat/auth","diff_summary":"3 files (+42 -11)","tool_input":{"command":"npm run deploy:preview --env staging"}}' \
  >"${HOOK_OUT}" &
HOOK_PID="$!"

APPROVAL_ID=""
for _ in $(seq 1 30); do
  SNAP="$(curl -fsS "${BASE_URL}/v1/snapshot")"
  APPROVAL_ID="$(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.pendingApprovals?.[0]?.id ?? "");' "${SNAP}")"
  if [[ -n "${APPROVAL_ID}" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "${APPROVAL_ID}" ]]; then
  echo "Failed to observe pending approval in /v1/snapshot" >&2
  exit 1
fi

echo "2) Resolving approval ${APPROVAL_ID} remotely..."
curl -fsS -X POST "${BASE_URL}/v1/approvals/${APPROVAL_ID}/resolve" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","replyNote":"staging verified"}' >/dev/null

wait "${HOOK_PID}"
echo "3) Unblocked hook response:"
cat "${HOOK_OUT}"
echo ""

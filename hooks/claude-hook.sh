#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${AGENTDECK_BRIDGE_URL:-http://127.0.0.1:7742}"
WAIT_PARAM="${AGENTDECK_WAIT:-1}"
PAYLOAD="$(cat)"

AUTH_ARGS=()
if [[ -n "${AGENTDECK_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${AGENTDECK_TOKEN}")
fi

curl -fsS --max-time 35 -X POST \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  -d "${PAYLOAD}" \
  "${BRIDGE_URL}/v1/hooks/claude?wait=${WAIT_PARAM}"

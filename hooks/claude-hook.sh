#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${AGENTDECK_BRIDGE_URL:-http://127.0.0.1:7742}"
WAIT_PARAM="${AGENTDECK_WAIT:-1}"
TIMEOUT_MS="${AGENTDECK_TIMEOUT_MS:-600000}"
FAIL_OPEN="${AGENTDECK_FAIL_OPEN:-1}"
MAX_TIME_SEC=$(( (TIMEOUT_MS / 1000) + 10 ))
PAYLOAD="$(cat)"

AUTH_ARGS=()
if [[ -n "${AGENTDECK_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${AGENTDECK_TOKEN}")
fi

if ! curl -fsS --max-time "${MAX_TIME_SEC}" -X POST \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  -d "${PAYLOAD}" \
  "${BRIDGE_URL}/v1/hooks/claude?wait=${WAIT_PARAM}&timeoutMs=${TIMEOUT_MS}"; then
  if [[ "${FAIL_OPEN}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi

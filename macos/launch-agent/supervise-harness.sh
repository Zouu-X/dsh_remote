#!/bin/zsh
# LaunchAgent wrapper that keeps DeepSeek Harness alive on 127.0.0.1:3080.
# If a Harness is already listening (for example one started manually in a
# terminal), this supervisor leaves it alone.
set -euo pipefail

NODE_BIN="${DSH_REMOTE_NODE:-node}"
NPX_BIN="$(dirname "$NODE_BIN")/npx"
HARNESS_PORT="${DSH_REMOTE_HARNESS_PORT:-3080}"
TRUSTED_HOST="${DSH_REMOTE_TRUSTED_HOST:-}"

echo "harness supervisor: node=$NODE_BIN port=$HARNESS_PORT trustedHost=${TRUSTED_HOST:-none}" >&2

while true; do
  if /usr/sbin/lsof -nP -iTCP:"$HARNESS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    sleep 15
    continue
  fi

  echo "harness supervisor: port $HARNESS_PORT is down; starting Harness" >&2
  if [[ -n "$TRUSTED_HOST" ]]; then
    "$NPX_BIN" @deepseek-ai/dsh web --trusted-host "$TRUSTED_HOST"
  else
    "$NPX_BIN" @deepseek-ai/dsh web
  fi

  echo "harness supervisor: Harness exited; will restart after 5s" >&2
  sleep 5
done

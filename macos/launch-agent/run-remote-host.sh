#!/bin/zsh
# Follows Harness: run only while 127.0.0.1:3080 is listening.
# Harness itself is managed manually by the user, not by this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${DSH_REMOTE_NODE:-node}"
HARNESS_PORT="${DSH_REMOTE_HARNESS_PORT:-3080}"
POLL_SECONDS="${DSH_REMOTE_HARNESS_POLL_SECONDS:-15}"
cd "$REPO_ROOT"

is_harness_up() {
  /usr/sbin/lsof -nP -iTCP:"$HARNESS_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

while true; do
  if ! is_harness_up; then
    echo "dsh-remote-host: waiting for Harness on $HARNESS_PORT" >&2
    sleep "$POLL_SECONDS"
    continue
  fi

  echo "dsh-remote-host: Harness detected; starting Remote Host" >&2
  if [[ "${DSH_REMOTE_CAFFEINATE:-off}" == "always" ]]; then
    /usr/bin/caffeinate -i "$NODE_BIN" "$REPO_ROOT/packages/remote-host/dist/cli.js" &
  else
    "$NODE_BIN" "$REPO_ROOT/packages/remote-host/dist/cli.js" &
  fi
  child_pid=$!

  while kill -0 "$child_pid" >/dev/null 2>&1 && is_harness_up; do
    sleep "$POLL_SECONDS"
  done

  if kill -0 "$child_pid" >/dev/null 2>&1; then
    echo "dsh-remote-host: Harness stopped; stopping Remote Host" >&2
    kill "$child_pid"
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
done

#!/bin/zsh
# Installs the user LaunchAgent (not a root LaunchDaemon).
# Run from the repository root: macos/launch-agent/install.sh
#
# Optional configuration is read from:
#   macos/launch-agent/launch-agent.env
# See macos/launch-agent/launch-agent.env.example for available variables.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/macos/launch-agent/com.dshbox.remote-host.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.dshbox.remote-host.plist"
LABEL="com.dshbox.remote-host"
HARNESS_TEMPLATE="$REPO_ROOT/macos/launch-agent/com.dshbox.harness.plist.template"
HARNESS_TARGET="$HOME/Library/LaunchAgents/com.dshbox.harness.plist"
HARNESS_LABEL="com.dshbox.harness"
CONFIG_FILE="$REPO_ROOT/macos/launch-agent/launch-agent.env"

if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

NODE_BIN="${DSH_REMOTE_NODE:-$(node -p 'process.execPath' 2>/dev/null || command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH; install Node first" >&2
  exit 1
fi

# Resolve the MagicDNS hostname from Tailscale when the user has not set one.
tailscale_self_dns() {
  /usr/bin/python3 - <<'PY'
import json, subprocess

def resolve():
    try:
        status = json.loads(subprocess.check_output(
            ['tailscale', 'status', '--json'], stderr=subprocess.DEVNULL, timeout=5))
    except Exception:
        return ''
    dns = (status.get('Self') or {}).get('DNSName') or ''
    return dns.rstrip('.')

print(resolve())
PY
}

HARNESS_URL="${DSH_REMOTE_HARNESS_URL:-http://127.0.0.1:3080}"
HARNESS_POLL_SECONDS="${DSH_REMOTE_HARNESS_POLL_SECONDS:-15}"
REMOTE_PORT="${DSH_REMOTE_PORT:-3090}"
STATIC_DIR="${DSH_REMOTE_STATIC_DIR:-$REPO_ROOT/apps/mobile-web/dist}"
STATE_FILE="${DSH_REMOTE_STATE_FILE:-$HOME/.dsh-remote/host-state.json}"
CAFFEINATE_MODE="${DSH_REMOTE_CAFFEINATE:-auto}"
IDENTITY_PROVIDER="${DSH_REMOTE_IDENTITY_PROVIDER:-tailscale}"
ALLOWED_DEVICE_IDS="${DSH_REMOTE_ALLOWED_DEVICE_IDS:-}"
SECRET_STORE="${DSH_REMOTE_SECRET_STORE:-mac-keychain}"
TRUSTED_HOST="${DSH_REMOTE_TRUSTED_HOST:-$(tailscale_self_dns)}"

mkdir -p "$HOME/.dsh-remote/logs" "$HOME/Library/LaunchAgents"

sed -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
    -e "s#__HOME__#$HOME#g" \
    -e "s#__NODE_BIN__#$NODE_BIN#g" \
    -e "s#__HARNESS_URL__#$HARNESS_URL#g" \
    -e "s#__HARNESS_POLL_SECONDS__#$HARNESS_POLL_SECONDS#g" \
    -e "s#__REMOTE_PORT__#$REMOTE_PORT#g" \
    -e "s#__STATIC_DIR__#$STATIC_DIR#g" \
    -e "s#__STATE_FILE__#$STATE_FILE#g" \
    -e "s#__CAFFEINATE__#$CAFFEINATE_MODE#g" \
    -e "s#__IDENTITY_PROVIDER__#$IDENTITY_PROVIDER#g" \
    -e "s#__ALLOWED_DEVICE_IDS__#$ALLOWED_DEVICE_IDS#g" \
    -e "s#__SECRET_STORE__#$SECRET_STORE#g" \
    "$TEMPLATE" > "$TARGET"

# Free the configured port if a temporary/manual Remote Host is still running.
for pid in $(/usr/sbin/lsof -tiTCP:"$REMOTE_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  echo "stopping existing Remote Host pid $pid" >&2
  kill "$pid" >/dev/null 2>&1 || true
done
sleep 1

# Replace the Remote Host job and remove any previous Harness supervisor
# unless the user explicitly opts back in with DSH_INSTALL_HARNESS_SUPERVISOR=1.
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$UID/$HARNESS_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$TARGET"
launchctl kickstart -k "gui/$UID/$LABEL"

if [[ "${DSH_INSTALL_HARNESS_SUPERVISOR:-0}" == "1" ]]; then
  sed -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
      -e "s#__HOME__#$HOME#g" \
      -e "s#__NODE_BIN__#$NODE_BIN#g" \
      -e "s#__TRUSTED_HOST__#$TRUSTED_HOST#g" \
      "$HARNESS_TEMPLATE" > "$HARNESS_TARGET"
  launchctl bootstrap "gui/$UID" "$HARNESS_TARGET"
  launchctl kickstart -k "gui/$UID/$HARNESS_LABEL"
  echo "installed: $LABEL, $HARNESS_LABEL"
else
  rm -f "$HARNESS_TARGET"
  echo "installed: $LABEL"
  echo "harness supervisor: disabled (manual Harness management)"
fi

if [[ -n "$TRUSTED_HOST" ]]; then
  echo "phone URL: https://$TRUSTED_HOST"
else
  echo "warning: could not detect a Tailscale MagicDNS hostname" >&2
fi
if [[ -n "$ALLOWED_DEVICE_IDS" ]]; then
  echo "allowed device IDs: $ALLOWED_DEVICE_IDS"
else
  echo "device allowlist: empty (all devices on your tailnet are allowed)"
fi
echo "node: $NODE_BIN"
echo "logs: $HOME/.dsh-remote/logs/"

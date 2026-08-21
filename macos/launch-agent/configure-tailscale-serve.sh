#!/bin/zsh
# Configures Tailscale Serve to terminate TLS on port 443 and forward to the
# loopback Remote Host Adapter with PROXY protocol v1.
#
# Usage:
#   macos/launch-agent/configure-tailscale-serve.sh [port]
#
# The default target port is 3090, or DSH_REMOTE_PORT when set.
set -euo pipefail

PORT="${1:-${DSH_REMOTE_PORT:-3090}}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: tailscale command not found; install Tailscale first" >&2
  exit 1
fi

# An older HTTPS serve entry can conflict with the TCP mode used by this project.
tailscale serve --https=443 off >/dev/null 2>&1 || true

tailscale serve --bg --yes --tls-terminated-tcp=443 --proxy-protocol=1 "$PORT"

echo "Tailscale Serve configured: https://<your-mac>.<your-tailnet>.ts.net -> 127.0.0.1:$PORT"
echo
echo "Current serve status:"
tailscale serve status

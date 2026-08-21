#!/bin/zsh
# One-command guided setup for DSH Remote on macOS.
#
#   ./macos/launch-agent/setup.sh
#
# The script installs what can be automated and pauses only for steps that
# require your account or GUI interaction (Tailscale sign-in and the DeepSeek
# API credential). It is idempotent: rerun it after changing settings.
#
# Useful overrides:
#   DSH_INSTALL_HARNESS_SUPERVISOR=0  keep manual Harness management
#   DSH_SETUP_SKIP_BUILD=1            skip pnpm install/build
#   DSH_REMOTE_PORT=3090              custom Remote Host port
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAILSCALE_BIN=""
TAILSCALE_UP_LOG="${TMPDIR:-/tmp}/dsh-setup-tailscale-up.log"
CONFIG_FILE="$REPO_ROOT/macos/launch-agent/launch-agent.env"
if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "DSH Remote currently supports macOS only."
fi

# --- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    info "Node.js not found; installing node@24 with Homebrew..."
    brew install node@24
    HOMEBREW_PREFIX="$(brew --prefix)"
    NODE_DIR="$HOMEBREW_PREFIX/opt/node@24/bin"
    if [[ -x "$NODE_DIR/node" ]]; then
      export PATH="$NODE_DIR:$PATH"
    fi
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  die "Node.js 24+ is required. Install it with: brew install node@24"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  die "Node.js 24+ is required; current version is $(node --version)."
fi

if ! command -v corepack >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    info "Installing corepack..."
    npm install -g corepack
  fi
fi
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || warn "could not run corepack enable; continuing"
fi

# --- Tailscale --------------------------------------------------------------
find_tailscale() {
  local candidate
  for candidate in \
    "$(command -v tailscale 2>/dev/null || true)" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      TAILSCALE_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

if ! find_tailscale; then
  if command -v brew >/dev/null 2>&1; then
    info "Tailscale not found; installing the Tailscale Mac app with Homebrew..."
    brew install --cask tailscale
  else
    die "Tailscale is required. Install it from https://tailscale.com/download, then rerun this script."
  fi
  find_tailscale || die "Tailscale was installed but its CLI was not found; open Tailscale once and rerun this script."
fi
export PATH="$(dirname "$TAILSCALE_BIN"):$PATH"

tailscale_dns() {
  "$TAILSCALE_BIN" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; s=json.load(sys.stdin); d=(s.get("Self") or {}).get("DNSName") or ""; print(d.rstrip("."))'
}

info "Using Tailscale at $TAILSCALE_BIN"
if ! tailscale status >/dev/null 2>&1 || [[ -z "$(tailscale_dns)" ]]; then
  info "Opening Tailscale and starting sign-in. Complete the browser sign-in if prompted."
  open -a Tailscale >/dev/null 2>&1 || open /Applications/Tailscale.app >/dev/null 2>&1 || true
  "$TAILSCALE_BIN" up >"$TAILSCALE_UP_LOG" 2>&1 &
  TAILSCALE_UP_PID=$!
  for _ in {1..120}; do
    if "$TAILSCALE_BIN" status --json >/dev/null 2>&1 && [[ -n "$(tailscale_dns)" ]]; then
      break
    fi
    sleep 1
  done
  kill "$TAILSCALE_UP_PID" >/dev/null 2>&1 || true
  wait "$TAILSCALE_UP_PID" >/dev/null 2>&1 || true
fi

DNS_NAME="$(tailscale_dns)"
if [[ -z "$DNS_NAME" ]]; then
  echo "Tailscale is not signed in or MagicDNS is not enabled." >&2
  echo "1. Sign in to Tailscale on this Mac and on your phone with the same account." >&2
  echo "2. In the Tailscale admin console, enable MagicDNS for your tailnet." >&2
  echo "3. Rerun: $0" >&2
  echo "Tailscale log: $TAILSCALE_UP_LOG" >&2
  exit 1
fi
info "Tailscale is online; MagicDNS hostname: $DNS_NAME"

# --- DeepSeek credential (existence check only; contents are never read) ----
if [[ ! -f "$HOME/.dsh/.credentials.yaml" ]]; then
  warn "DeepSeek Harness credential not found at ~/.dsh/.credentials.yaml."
  warn "Follow the DeepSeek Harness README to configure your API credential first."
fi

# --- Dependencies and build -------------------------------------------------
cd "$REPO_ROOT"
if [[ "${DSH_SETUP_SKIP_BUILD:-0}" != "1" ]]; then
  info "Installing Node dependencies with pnpm..."
  corepack pnpm install
  info "Building packages and the mobile PWA..."
  corepack pnpm -r build
fi

# --- LaunchAgent ------------------------------------------------------------
SUPERVISOR="${DSH_INSTALL_HARNESS_SUPERVISOR:-1}"
info "Installing the user LaunchAgent (Harness supervisor: $([[ "$SUPERVISOR" == "1" ]] && echo on || echo off))..."
DSH_INSTALL_HARNESS_SUPERVISOR="$SUPERVISOR" "$REPO_ROOT/macos/launch-agent/install.sh"

# Wait for the Remote Host to come up. With supervisor on, the first Harness
# download through npx can take a while.
REMOTE_PORT="${DSH_REMOTE_PORT:-3090}"
REMOTE_UP=0
for _ in {1..180}; do
  if /usr/sbin/lsof -nP -iTCP:"$REMOTE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    REMOTE_UP=1
    break
  fi
  sleep 1
done
if [[ "$REMOTE_UP" != "1" ]]; then
  warn "Remote Host Adapter is not listening on 127.0.0.1:$REMOTE_PORT yet."
  if [[ "$SUPERVISOR" == "1" ]]; then
    warn "Check: tail -f ~/.dsh-remote/logs/harness-supervisor.err.log"
  else
    warn "Start Harness manually, then the LaunchAgent will follow it: npx @deepseek-ai/dsh web --trusted-host \"$DNS_NAME\""
  fi
fi

# --- Tailscale Serve ---------------------------------------------------------
info "Configuring Tailscale Serve (https -> 127.0.0.1:$REMOTE_PORT)..."
"$REPO_ROOT/macos/launch-agent/configure-tailscale-serve.sh" "$REMOTE_PORT"

# --- Done --------------------------------------------------------------------
info "Setup complete."
echo
echo "  Phone URL:  https://$DNS_NAME"
echo
echo "On your phone:"
echo "  1. Install Tailscale from the App Store / Play Store and sign in to the same tailnet."
echo "  2. Open the URL above and add it to the home screen."
echo
echo "Optional hardening: restrict access to one device"
echo "  tailscale status"
echo "  $REPO_ROOT/macos/launch-agent/devices.sh add <phone-device-id>"

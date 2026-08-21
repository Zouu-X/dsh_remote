# DSH Remote

Control a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent running on your Mac from your phone, over your private Tailscale network (tailnet).

> **Independent community project.** DSH Remote is not affiliated with or endorsed by DeepSeek.
>
> **Status:** A1 single-user developer preview. It is functional on your own Mac, but it is not a multi-user SaaS product.

[中文说明](README.zh-CN.md)

## What it does

DSH Remote keeps DeepSeek Harness bound to `127.0.0.1` on your Mac and puts a mobile-friendly PWA in front of it through a private Tailscale connection:

- Mobile pages for **Hosts**, **Tasks**, **Approvals**, and **Review**
- Create workspaces and sessions, send prompts, steer running sessions
- Real-time agent messages, tool calls, terminal output, diffs, and test results
- Answer agent questions and approve/reject one-shot permission requests
- Offline PWA shell with reconnect handling, event de-duplication, and gap backfill
- User-level LaunchAgent that starts with the Mac and follows a manually managed Harness
- Device identity derived from Tailscale peers, with an optional device allowlist

## Architecture

```text
Phone PWA
  │  HTTPS/WSS over Tailscale
  ▼
Tailscale Serve on Mac  (https://<your-mac>.<your-tailnet>.ts.net:443)
  │  TLS termination + PROXY protocol
  ▼
Remote Host Adapter  127.0.0.1:3090  (mobile UI + versioned remote RPC/events)
  │  allowlisted methods only
  ▼
DeepSeek Harness Adapter
  │
  ▼
DeepSeek Harness Web  127.0.0.1:3080  (loopback only)
  ▼
Workspaces / Agent loop / Shell / Files
```

## Security model

- DeepSeek Harness and the Remote Host Adapter listen on loopback only. Nothing is bound to `0.0.0.0` and nothing is exposed to the public internet.
- Only Tailscale Serve reaches the Remote Host Adapter.
- `--trusted-host` on Harness is treated as reachability/origin protection, not authentication.
- Client-supplied identity headers are never trusted. The source IP is taken from Tailscale Serve's PROXY protocol line and resolved through `tailscale status --json`.
- Only a fixed set of remote RPC methods is proxied. Privileged loopback-only methods (`settings.*`, `credentials.*`, file/directory pickers, preset mutations) always return `forbidden`.
- Device private keys are stored in the macOS Keychain. The DeepSeek API key is never read, logged, or moved by this project; it stays in Harness' own credential file.
- Device revocation, QR pairing, cloud relay, and push notifications are **not** part of this preview. Protect your tailnet accordingly.

## Prerequisites

- macOS (this project uses LaunchAgents, Keychain, and `caffeinate`)
- Node.js 24+ and pnpm 11 (`corepack enable` is usually enough)
- DeepSeek Harness with your DeepSeek API credential configured (see the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)). DSH Remote never touches that credential.
- **Tailscale on both the Mac and the phone, signed in to the same tailnet, with MagicDNS enabled.** This is mandatory: the phone connects through your private Tailscale network, never through the public internet.
- A phone with Tailscale installed and signed in to the same tailnet

## One-command setup (recommended)

### 1. Install and sign in to Tailscale

On your Mac:

```bash
brew install --cask tailscale
open -a Tailscale
tailscale up
```

If the `tailscale` command is not available after installation, open the Tailscale app and sign in from its menu bar icon.

On your phone, install Tailscale from the App Store / Play Store and sign in to the same account.

In the [Tailscale admin console](https://login.tailscale.com/admin/dns), make sure **MagicDNS** is enabled for your tailnet.

### 2. Clone and run the setup script

```bash
git clone https://github.com/Zouu-X/dsh_remote.git dsh-remote
cd dsh-remote
./macos/launch-agent/setup.sh
```

The script checks/installs prerequisites, signs in Tailscale, installs dependencies, builds the PWA, installs the Remote Host LaunchAgent in manual-Harness follow mode, configures Tailscale Serve, and prints your phone URL.

### 3. Start DeepSeek Harness manually

The setup script prints the exact command for your Mac. It looks like:

```bash
npx @deepseek-ai/dsh web --trusted-host <your-mac>.<your-tailnet>.ts.net
```

Keep it running. The Remote Host LaunchAgent follows `127.0.0.1:3080` automatically.

### 4. Open the app on your phone

Open the printed `https://<your-mac>.<your-tailnet>.ts.net` URL on your phone and add it to the home screen.

---

## Manual quick start

### 1. Install dependencies and build

```bash
git clone https://github.com/Zouu-X/dsh_remote.git dsh-remote
cd dsh-remote
corepack pnpm install
corepack pnpm -r build
```

### 2. Find your Mac's Tailscale hostname

```bash
DSH_TS_HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "$DSH_TS_HOST"
```

You should see something like `your-mac.your-tailnet.ts.net`.

### 3. Start DeepSeek Harness on loopback

In a dedicated terminal:

```bash
npx @deepseek-ai/dsh web --trusted-host "$DSH_TS_HOST"
```

Keep it running. The LaunchAgent intentionally follows your manually managed Harness. If you prefer automatic supervision instead, see [Harness supervisor](#optional-harness-supervisor).

### 4. Install the Remote Host LaunchAgent

```bash
macos/launch-agent/install.sh
```

This installs a user-level LaunchAgent (not a root daemon). It waits for Harness on `127.0.0.1:3080`, then starts the Remote Host Adapter on `127.0.0.1:3090`.

### 5. Point Tailscale Serve at the Remote Host

```bash
# Optional: turn off an older HTTPS serve entry first.
tailscale serve --https=443 off 2>/dev/null || true

tailscale serve --bg --yes --tls-terminated-tcp=443 --proxy-protocol=1 3090
tailscale serve status
```

You can use the included helper instead:

```bash
macos/launch-agent/configure-tailscale-serve.sh
```

### 6. Open the app on your phone

On a phone connected to the same tailnet, open:

```text
https://<your-mac>.<your-tailnet>.ts.net
```

Add it to the home screen to use it as a PWA.

## Device allowlist

By default every device signed in to your tailnet can reach the Remote Host. For a tighter A1 setup, allow only your phone:

```bash
# Find the phone's Tailscale node ID.
tailscale status

# Allow one device by its node ID.
macos/launch-agent/devices.sh add <tailscale-device-id>

# Show the current allowlist.
macos/launch-agent/devices.sh list

# Go back to "allow every device on the tailnet".
macos/launch-agent/devices.sh allow-all
```

Changes are applied by restarting the LaunchAgent automatically.

## Configuration

`install.sh` reads these environment variables. You can export them before running it, or copy `macos/launch-agent/launch-agent.env.example` to `macos/launch-agent/launch-agent.env` and edit that file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_REMOTE_HARNESS_URL` | `http://127.0.0.1:3080` | Harness HTTP base URL |
| `DSH_REMOTE_PORT` | `3090` | Remote Host Adapter listen port |
| `DSH_REMOTE_STATIC_DIR` | `<repo>/apps/mobile-web/dist` | Built PWA files served by the host |
| `DSH_REMOTE_STATE_FILE` | `~/.dsh-remote/host-state.json` | Persistent Mac host identity |
| `DSH_REMOTE_ALLOWED_DEVICE_IDS` | empty | Comma-separated Tailscale device IDs; empty means all same-tailnet devices |
| `DSH_REMOTE_IDENTITY_PROVIDER` | `tailscale` | `tailscale` resolves peers via `tailscale status --json`; `none` disables non-loopback remote access |
| `DSH_REMOTE_SECRET_STORE` | `mac-keychain` | Store the host device private key in Keychain; `none` disables it for testing |
| `DSH_REMOTE_CAFFEINATE` | `auto` in the installed LaunchAgent (`off` for a manual CLI start) | `auto` keeps the Mac awake only while sessions are running |
| `DSH_REMOTE_TRUSTED_HOST` | auto-detected | MagicDNS name passed to the optional Harness supervisor |
| `DSH_REMOTE_HARNESS_POLL_SECONDS` | `15` | How often the LaunchAgent checks Harness availability |
| `DSH_INSTALL_HARNESS_SUPERVISOR` | `0` | Set to `1` to install the optional Harness supervisor |
| `DSH_REMOTE_NODE` | install-time `node` path | Node binary used by the LaunchAgent |

The Remote Host CLI accepts the same values as flags:

```bash
node packages/remote-host/dist/cli.js --help
```

## Optional Harness supervisor

If you do not want to manage Harness manually:

```bash
DSH_INSTALL_HARNESS_SUPERVISOR=1 macos/launch-agent/install.sh
```

The supervisor starts `dsh web` only when nothing is already listening on `127.0.0.1:3080`. Manual Harness management remains the default and is less surprising during an upgrade.

## Repository layout

| Path | Description |
| --- | --- |
| `apps/mobile-web` | Mobile PWA (React + Vite) |
| `packages/remote-protocol` | Versioned RPC/event envelope and codecs |
| `packages/remote-domain` | Host/session/approval/review domain models |
| `packages/remote-client` | `AgentHostTransport` + Tailscale transport |
| `packages/remote-host` | Loopback Remote Host HTTP/WebSocket server |
| `packages/auth-core` | `RemotePrincipal`, capabilities, and RPC allowlist |
| `packages/adapter-deepseek` | The only package that talks to DeepSeek Harness |
| `macos/launch-agent` | One-command setup, LaunchAgent templates, installer, device manager, Tailscale Serve helper |
| `spikes/` | A0/A1 connectivity and smoke-test tools |

## Remote API boundary

The Remote Host only proxies methods declared in `packages/auth-core` (`host.describe`, `workspace.list`, `workspace.create`, `session.list`, `session.search`, `session.create`, `session.history`, `session.prompt`, `session.updateQueue`, `session.cancel`, `approval.respond`, `question.respond`).

`settings.*`, `credentials.*`, directory pickers, file openers, and preset mutations are always `forbidden` remotely.

## Development

```bash
corepack pnpm install
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm -r build

# Local mobile dev server (127.0.0.1:5173)
corepack pnpm dev:mobile

# Local host against a running Harness
corepack pnpm dev:host
```

Smoke tests:

```bash
# Remote Host locally, after `pnpm -r build`
node spikes/a1/smoke.mjs --base http://127.0.0.1:3090

# Remote Host through Tailscale Serve
node spikes/a1/smoke.mjs --base https://<your-mac>.<your-tailnet>.ts.net
```

## Known limitations

- Single-user tailnet model. There is no account system, device revocation UI, QR pairing, cloud relay, or push notification yet.
- Primarily validated on iOS. Android should work through the PWA but has not gone through full device QA.
- DeepSeek Harness is a developer preview and may change its wire protocol; all upstream dependencies are isolated in `packages/adapter-deepseek`.
- This preview does not replace the Agent sandbox and approval policy configured in DeepSeek Harness.

## License

[MIT](LICENSE)

DeepSeek Harness and DeepSeek are trademarks or registered trademarks of their respective owners.

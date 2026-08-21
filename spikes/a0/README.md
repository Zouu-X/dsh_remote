# A0 Spike

A0 is a connectivity spike for validating the “Tailscale Serve → 127.0.0.1:3080” path to the existing DeepSeek Harness web UI and API. The scripts in this directory are validation tools, not part of the mobile app runtime.

## Local smoke test

```bash
node spikes/a0/smoke.mjs
```

Defaults to `http://127.0.0.1:3080` and checks the web UI, PWA manifest, unary RPCs, both WebSocket endpoints, the browser-trust fence, and the loopback-only RPC lockdown.

## Remote smoke test

```bash
node spikes/a0/smoke.mjs --base https://<your-mac>.<your-tailnet>.ts.net
```

## Single-task event stream test

```bash
node spikes/a0/task.mjs   --base https://<your-mac>.<your-tailnet>.ts.net   --session <session-id>   --prompt "<prompt>"   [--auto-approval allowed-once|rejected]   [--answer-first]   [--steer-after <ms>]   [--steer "<text>"]   [--reconnect-after <ms>]
```

It consumes `/api/events.mux` and is useful for validating long tasks, steering, questions, approvals, and reconnects.

## Security notes

- Never add `--host 0.0.0.0` to Harness.
- `--trusted-host` is reachability/origin protection, not authentication; use the real MagicDNS hostname for your Mac.
- Do not call privileged loopback-only RPCs (`settings.*`, `credentials.*`, `host.openPath`, directory pickers, preset mutations) from a phone.
- Do not store keys, tokens, cookies, or unredacted phone screenshots in this directory.

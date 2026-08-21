#!/bin/zsh
# Local device-allowlist manager for com.dshbox.remote-host.
# B will replace this with QR pairing and a device-registry UI.
#
# Usage:
#   macos/launch-agent/devices.sh list
#   macos/launch-agent/devices.sh add <tailscale-device-id> [name]
#   macos/launch-agent/devices.sh remove <tailscale-device-id>
#   macos/launch-agent/devices.sh allow-all
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.dshbox.remote-host.plist"
LABEL="com.dshbox.remote-host"
KEY="DSH_REMOTE_ALLOWED_DEVICE_IDS"

if [[ ! -f "$PLIST" ]]; then
  echo "error: $PLIST not found; run macos/launch-agent/install.sh first" >&2
  exit 1
fi

cmd="${1:-list}"
shift || true

case "$cmd" in
  list)
    /usr/bin/python3 - "$PLIST" "$KEY" <<'PY'
import json, plistlib, subprocess, sys
plist = plistlib.load(open(sys.argv[1], 'rb'))
env = plist.get('EnvironmentVariables') or {}
raw = env.get(sys.argv[2], '')
allowed = [x.strip() for x in str(raw).split(',') if x.strip()]
if not allowed:
    print('allowlist: EMPTY (all same-tailnet devices allowed)')
    sys.exit(0)
print('allowlist:')
try:
    status = json.loads(subprocess.check_output(['tailscale', 'status', '--json'], timeout=5))
except Exception:
    status = {}
def node_by_id(nid):
    for node in [status.get('Self'), *status.get('Peer', {}).values()]:
        if isinstance(node, dict) and node.get('ID') == nid:
            host = node.get('HostName') or ''
            dns = node.get('DNSName') or ''
            name = host if host and host != 'localhost' else dns.split('.')[0]
            return f'{name or "unknown"} ({nid})'
    return nid
for device in allowed:
    print(' ', node_by_id(device))
PY
    ;;
  add)
    device_id="${1:-}"
    [[ -n "$device_id" ]] || { echo "usage: $0 add <device-id>" >&2; exit 1; }
    /usr/bin/python3 - "$PLIST" "$KEY" "$device_id" <<'PY'
import plistlib, sys
path, key, new = sys.argv[1], sys.argv[2], sys.argv[3].strip()
plist = plistlib.load(open(path, 'rb'))
env = plist.setdefault('EnvironmentVariables', {})
raw = str(env.get(key, ''))
ids = [x.strip() for x in raw.split(',') if x.strip()]
if new in ids:
    print(f'{new} is already allowed')
else:
    ids.append(new)
    env[key] = ','.join(ids)
    plistlib.dump(plist, open(path, 'wb'))
    print(f'added {new}')
PY
    launchctl kickstart -k "gui/$UID/$LABEL"
    ;;
  remove)
    device_id="${1:-}"
    [[ -n "$device_id" ]] || { echo "usage: $0 remove <device-id>" >&2; exit 1; }
    /usr/bin/python3 - "$PLIST" "$KEY" "$device_id" <<'PY'
import plistlib, sys
path, key, target = sys.argv[1], sys.argv[2], sys.argv[3].strip()
plist = plistlib.load(open(path, 'rb'))
env = plist.setdefault('EnvironmentVariables', {})
raw = str(env.get(key, ''))
ids = [x.strip() for x in raw.split(',') if x.strip()]
if target not in ids:
    print(f'{target} was not in the allowlist')
else:
    ids.remove(target)
    env[key] = ','.join(ids)
    plistlib.dump(plist, open(path, 'wb'))
    print(f'removed {target}')
PY
    launchctl kickstart -k "gui/$UID/$LABEL"
    ;;
  allow-all)
    /usr/bin/python3 - "$PLIST" "$KEY" <<'PY'
import plistlib, sys
path, key = sys.argv[1], sys.argv[2]
plist = plistlib.load(open(path, 'rb'))
env = plist.setdefault('EnvironmentVariables', {})
env[key] = ''
plistlib.dump(plist, open(path, 'wb'))
print('allowlist cleared: all same-tailnet devices allowed')
PY
    launchctl kickstart -k "gui/$UID/$LABEL"
    ;;
  *)
    echo "usage: $0 list|add <id>|remove <id>|allow-all" >&2
    exit 2
    ;;
esac

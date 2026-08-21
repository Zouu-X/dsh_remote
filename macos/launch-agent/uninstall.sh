#!/bin/zsh
# Unloads and removes the user LaunchAgent.
set -euo pipefail

LABELS=("com.dshbox.remote-host" "com.dshbox.harness")
TARGETS=(
  "$HOME/Library/LaunchAgents/com.dshbox.remote-host.plist"
  "$HOME/Library/LaunchAgents/com.dshbox.harness.plist"
)

for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
done
for target in "${TARGETS[@]}"; do
  rm -f "$target"
done

echo "removed: ${LABELS[*]}"

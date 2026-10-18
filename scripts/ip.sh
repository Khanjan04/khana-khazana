#!/usr/bin/env bash
# Print the host's LAN IPv4 addresses: networkInterfaces -> ip -4 addr -> ifconfig (Day 4).
cd "$(dirname "$0")/.." || exit 1
ips=$(node server/ip.js 2>/dev/null)
if [ -z "$ips" ] && command -v ip >/dev/null 2>&1; then
  ips=$(ip -4 addr 2>/dev/null | awk '/inet / {sub(/\/.*/, "", $2); print $2}' | grep -Ev '^127\.')
fi
if [ -z "$ips" ] && command -v ifconfig >/dev/null 2>&1; then
  ips=$(ifconfig 2>/dev/null | awk '/inet / {for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\./ || $i ~ /^addr:/) {sub("addr:", "", $i); print $i; break}}' | grep -Ev '^127\.')
fi
if [ -z "$ips" ]; then
  echo "Could not detect the LAN IP. Find it in Android Settings → Wi-Fi → (network) → IP address." >&2
  exit 1
fi
echo "$ips"

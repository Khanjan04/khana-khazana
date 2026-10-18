#!/usr/bin/env bash
# Start the POS host (GUIDE §5.5). Used by the runit service and by hand.
# Termux: termux-exec makes /usr/bin/env work; on a laptop this script works unchanged.
cd "${POS_HOME:-$HOME/pos}" 2>/dev/null || cd "$(dirname "$0")/.." || exit 1
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
mkdir -p data/logs
# log rotation: keep server.log < 5 MB, 3 old copies
if [ -f data/logs/server.log ] && [ "$(wc -c < data/logs/server.log)" -gt 5242880 ]; then
  for i in 2 1; do [ -f "data/logs/server.log.$i" ] && mv "data/logs/server.log.$i" "data/logs/server.log.$((i+1))"; done
  mv data/logs/server.log data/logs/server.log.1
fi
exec node --disable-warning=ExperimentalWarning server/server.js >>data/logs/server.log 2>&1

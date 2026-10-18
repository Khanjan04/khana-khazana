#!/data/data/com.termux/files/usr/bin/bash
# Idempotent host installer for Termux (Day 24). Safe to re-run.
#  - checks versions, installs + holds nodejs-lts, unpacks the release, npm ci --omit=dev,
#  - creates data dirs, the runit service and the Termux:Boot script, prints QR + checklist.
# Usage (inside Termux):  bash install.sh [release.tar.gz]
set -euo pipefail
POS_HOME="${POS_HOME:-$HOME/pos}"
TARBALL="${1:-}"
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] || { echo "Run this inside Termux (F-Droid/GitHub build)."; exit 1; }

say "Packages (nodejs-lts, git, termux-services, termux-api)"
pkg update -y >/dev/null || true
if dpkg -s nodejs >/dev/null 2>&1 && ! dpkg -s nodejs-lts >/dev/null 2>&1; then
  echo "Found 'nodejs' (current). Replacing with 'nodejs-lts' (do not install both)."; pkg uninstall -y nodejs
fi
pkg install -y nodejs-lts git termux-services termux-api
apt-mark hold nodejs-lts >/dev/null && echo "nodejs-lts held (upgrade only via this installer)"

say "Versions"
node -v
node -e "const [M,m]=process.versions.node.split('.').map(Number); if (M<22||(M===22&&m<13)) { console.error('Node >= 22.13 required'); process.exit(1) }"
node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); console.log('node:sqlite OK')"

say "Release -> $POS_HOME"
mkdir -p "$POS_HOME"
if [ -n "$TARBALL" ]; then
  if [ -f "$TARBALL.sha256" ]; then (cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256"); fi
  tar -xzf "$TARBALL" -C "$POS_HOME" --strip-components=1
elif [ -f "$(dirname "$0")/../package.json" ] && [ "$(cd "$(dirname "$0")/.." && pwd)" != "$POS_HOME" ]; then
  cp -r "$(dirname "$0")/.."/. "$POS_HOME"/
fi
cd "$POS_HOME"
[ -d node_modules/ws ] || npm ci --omit=dev
mkdir -p data/backups data/images data/logs
chmod +x scripts/*.sh

say "runit service 'pos' (auto-restart on crash)"
SV="$PREFIX/var/service/pos"
mkdir -p "$SV/log"
cat > "$SV/run" <<RUN
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
export POS_HOME="$POS_HOME"
exec "$POS_HOME/scripts/start.sh"
RUN
chmod +x "$SV/run"
ln -sf "$PREFIX/share/termux-services/svlogger" "$SV/log/run" 2>/dev/null || true
# shellcheck disable=SC1091
. "$PREFIX/etc/profile.d/start-services.sh" 2>/dev/null || true
sv-enable pos 2>/dev/null || true
sv up pos 2>/dev/null || true

say "Termux:Boot script (~/.termux/boot/10-pos)"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/10-pos" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
. $PREFIX/etc/profile.d/start-services.sh
BOOT
chmod +x "$HOME/.termux/boot/10-pos"

say "Health"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then curl -s http://127.0.0.1:8080/health; echo; break; fi
  sleep 1
done

IP=$(bash scripts/ip.sh | head -n1 || true)
say "Join"
echo "Host phone browser:  http://127.0.0.1:8080   (first run: create the owner here)"
if [ -n "$IP" ]; then
  echo "Staff phones:        http://$IP:8080"
  node -e "import('./web/vendor/qr.js').then(m => process.stdout.write(m.qrTerminal('http://$IP:8080/')))"
fi

say "Host phone checklist (docs/HOST_CHECKLIST.md) — do these by hand:"
cat <<'LIST'
 [ ] Developer options ON -> "Disable child process restrictions" (Android 14+) or ADB phantom fix (12/12L/13)
 [ ] Developer options -> "Stay awake" ON; phone on a dedicated charger
 [ ] Battery: Termux, Termux:API, Termux:Boot = Unrestricted; OEM autostart ON; lock Termux in recents
 [ ] Opened Termux:Boot once
 [ ] Wi-Fi: "Use device MAC" + DHCP reservation on the router (or hotspot with auto-off disabled)
 [ ] Reboot -> server up within 60 s untouched (http://127.0.0.1:8080/health)
 [ ] Screen off 30 min -> captain sends KOT -> kitchen receives
 [ ] Record host IP, Android, Termux and Node versions on docs/INSTALL_SHEET.md
LIST
echo
echo "Troubleshooting: sv restart pos   |   logs: $POS_HOME/data/logs/server.log"

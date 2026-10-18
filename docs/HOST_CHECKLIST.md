# Host phone setup checklist (print one per install)

Restaurant: ____________________  Date: __________  Installer: __________

| # | Step | ✓ |
|---|---|---|
| 1 | Android 12+ phone, ≥4 GB RAM, ≥32 GB free, **dedicated charger**; OS auto-updates off during service hours | ☐ |
| 2 | Install **Termux, Termux:API, Termux:Boot** — all from F-Droid *or* all from GitHub releases (never mix; signatures must match). Open Termux:Boot once | ☐ |
| 3 | Developer options ON → **"Disable child process restrictions"** (Android 14+) — or ADB phantom fix on 12/12L/13 (below) → **"Stay awake"** ON | ☐ |
| 4 | Battery: all three Termux apps **Unrestricted**; OEM autostart ON; lock Termux in recents (see OEM notes) | ☐ |
| 5 | Network: restaurant SSID + "Use device MAC" + **DHCP reservation** on the router — or hotspot with fixed SSID/password and **auto-off disabled** | ☐ |
| 6 | Run `bash install.sh` (installs + holds nodejs-lts, unpacks release, `npm ci --omit=dev`, runit service, boot script, prints QR) | ☐ |
| 7 | Reboot → server up within 60 s untouched (`http://127.0.0.1:8080/health`) | ☐ |
| 8 | Screen off 30 min → captain sends KOT → kitchen receives | ☐ |
| 9 | Record host IP, Android, Termux and Node versions on the install sheet | ☐ |

**ADB phantom-process fix (Android 12L/13)**, from a laptop with platform-tools:
```
adb shell settings put global settings_enable_monitor_phantom_procs false
adb shell device_config set_sync_disabled_for_tests persistent
```
Android 12: `adb shell device_config put activity_manager max_phantom_processes 2147483647`.
Turning Developer options OFF re-enables killing on Android 14+.

**OEM notes:** Xiaomi/POCO — Autostart ON, battery "No restrictions", lock in recents. Samsung — remove from
Sleeping/Deep sleeping apps, add to "Never sleeping". Realme/Oppo/Vivo — allow auto-launch + background activity.
OnePlus — "Don't optimise" + lock in recents. **Re-verify after every OS update.**

**Node in Termux:** `pkg install nodejs-lts` (never both `nodejs` and `nodejs-lts`). Verify
`node -e "require('node:sqlite')"`. Keep it held: `apt-mark hold nodejs-lts`.

**Kitchen phone:** on a charger, Developer options → "Stay awake", Chrome tab in front, tap **Start shift**.
Optional per phone: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add `http://<host-ip>:8080` →
Relaunch (enables Wake Lock / service worker on that phone; re-enter if the IP changes).

**Fallback host:** keep a spare phone or old laptop with the same release and yesterday's backup (budget ₹6–10k).

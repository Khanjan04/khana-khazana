# Troubleshooting card

| Symptom | Do this |
|---|---|
| Any phone shows a red dot | Is the host phone on, charging, same Wi-Fi? On the host in Termux: `sv restart pos` |
| Host shows "Process completed (signal 9)" | Phantom process killer: Developer options → "Disable child process restrictions" (14+) or the ADB fix (HOST_CHECKLIST.md). Then `sv restart pos` |
| Server not up after reboot | Open Termux:Boot once; check `~/.termux/boot/10-pos` exists; Battery → Termux* → Unrestricted |
| Check it is alive | Host Chrome: `http://127.0.0.1:8080/health` (shows uptime, restarts, last backup) |
| Logs | `tail -50 ~/pos/data/logs/server.log` |
| Phones can't connect after hotspot restart | Host: open **/join**, scan the new QR on every phone (hotspot IP changes every time) |
| "This phone was unpaired" | The owner revoked it. Admin → Devices → Add device and pair again |
| Kitchen not beeping | Tap **Start shift** again after any reload; volume up; tab must stay in front |
| KOT stuck "New" > 2 min | Billers/managers get an alert; check the kitchen phone is awake and online |
| Printer not printing | Admin → Printing → Test print; check printer IP + port 9100, same network; failed jobs → Retry |
| Bluetooth printer | Use RawBT on that phone: Admin → Printing → this phone prints via **rawbt** |
| Wrong totals vs old app | STOP billing on the new app, use the old app, report the bill — golden parity must be fixed in code |
| Restore yesterday | Admin → Backups → Restore → type RESTORE (a pre-restore backup is kept) |
| Node got upgraded by `pkg upgrade` | `pkg install nodejs-lts` + `apt-mark hold nodejs-lts`; re-run `install.sh` |
| Fallback without runit | `cd ~/pos && while true; do node server/server.js; sleep 2; done` |

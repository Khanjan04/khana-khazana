# TASKS — one line per agent task

Status: ✅ implemented + tested in this repo · 🧑 needs you (hardware, real data, or a real restaurant) · ⚠️ implemented, verify on device

| ID | Task | Status | Where / proof |
|---|---|---|---|
| D01-T1 | Create repo structure per GUIDE §2, package.json scripts, jsconfig checkJs; no logic | ✅ | repo root |
| D01-T2 | POC server → server/server.js + db.js adapter (§5.1); static web/; /health {ok,seq,node,uptime}; test/health.test.js on random port | ✅ | `server/server.js`, `server/db.js`, `test/health.test.js` |
| D01-M | You: CLAUDE.md, rules, hook, pre-commit, copy legacy/ and a real backup to test/golden/backup_v13.json | ✅ 🧑 | `legacy/khanakhajana_v13.html` added; backup is a sample made by the legacy code — swap in a real one |
| D02-T1 | 001_init.sql (settings, counters, ops, events, users, devices, orders, order_lines, kots, kot_status_log) + migration runner | ✅ | `server/migrations/001_init.sql` |
| D02-T2 | engine.js per §5.2; tests: duplicate opId → one event, same result; failing handler rolls back; seq strictly increasing | ✅ | `test/engine.test.js` |
| D02-T3 | kot.create (order auto-open, KOT no from counters, daily reset) + kot.status machine; invalid → BAD_TRANSITION | ✅ | `server/commands/kot.js`, `test/kot.test.js` |
| D03-T1 | WS hello/cmd/ack/evt/sync/synced per PROTOCOL; snapshot if gap too old | ✅ | `server/server.js`, `test/server.test.js` |
| D03-T2 | web/net.js per §5.4 | ✅ | `web/net.js` |
| D03-T3 | Captain screen (table, items, qty, note, Send KOT) + KDS screen (cards by status, Accept/Preparing/Ready/Served/Reject-with-reason, beep after Start-shift tap); http LAN origin | ✅ | `web/screens/order.js`, `web/screens/kds.js`, `test/e2e/three-phones.e2e.js` |
| D04-T1 | scripts/ip.sh (networkInterfaces → ip -4 addr → ifconfig) + /join page with QR (vendored pure-JS QR encoder) | ✅ | `scripts/ip.sh`, `server/ip.js`, `web/vendor/qr.js`, `web/screens/join.js` |
| D04-T2 | Client known-hosts list with retry, then 'Scan host QR'; /whoami capability page | ✅ | `web/app.js` (onUnreachable), `web/screens/whoami.js` |
| D04-M | You: host checklist 1–5, copy to Termux, npm ci --omit=dev, start.sh; router + hotspot round-trip; chrome://flags on kitchen phone | 🧑 | docs/HOST_CHECKLIST.md |
| D05-T1 | scripts/soak.js: N captains, random KOTs + disconnects for M minutes; assert unique KOT numbers per day, contiguous seq, each opId once | ✅ | `scripts/soak.js`, `test/soak.test.js` |
| D05-M | You: host screen off 30 min, airplane-mode captain mid-order, restart Termux; POC exit checks; tag v0.1-poc | 🧑 | |
| D06-T1 | 002_full.sql: every PLAN §7 table, money INTEGER paise, FKs, indexes | ✅ | `server/migrations/002_full.sql` |
| D06-T2 | rights.js with 24 rights + default roles; rights.test.js asserts PLAN §8 exactly | ✅ | `server/rights.js`, `test/rights.test.js` |
| D07-T1 | import/v13.js: every entity; scrypt PINs; images → data/images/<sha1>; counters continue; legacy KOTs 'accepted'; legacy_import hash; re-run no-op; counts equal source | ✅ | `server/import/v13.js` (real format, docs/V13_FORMAT.md), `test/import.test.js`, HTTP `POST /api/import/legacy` + Admin › Backups |
| D08-T1 | Export calcTotals/r2 unchanged; scripts/make-golden.js runs LEGACY calcTotals via node:vm → expected_totals.json | ✅ | `server/domain/totals.js` is the verbatim legacy function; `scripts/make-golden.js` runs it from `legacy/khanakhajana_v13.html` |
| D08-T2 | totals.golden.test.js compares every bill field; 0 differences | ✅ | `test/totals.golden.test.js` vs the real legacy calcTotals (70 bills / open orders) |
| D09-T1..T3 | Menu CRUD with legacy limits, layout CRUD, settings.update, users CRUD (≤100, PIN 4–8); right checks + tests | ✅ | `server/commands/admin.js`, `test/admin.test.js` |
| D10-T1 | auth.js: pair.create, pair.claim → device token, login → session, scrypt + timingSafeEqual, lockout, logout, device.revoke | ✅ | `server/auth.js`, `test/auth.test.js` |
| D10-T2 | Login + pair screens | ✅ | `web/screens/{setup,pair,login}.js` |
| D11-T1 | order.open, line.add/update, line.void (reason), hold/unhold, persons, comment, table.transfer, order.customer, delivery/pickup with manual platform | ✅ | `server/commands/order.js`, `test/order.test.js` |
| D11-T2 | Approval {userId,pin} inside cmd; host verifies 'approve' + right; void_log records approver | ✅ | `server/engine.js`, `server/auth.js#verifyApproval` |
| D12-T1 | app.js router, store.js (snapshot + events), h.js; table view with status colours and timers | ✅ | `web/app.js`, `web/store.js`, `web/h.js`, `web/screens/tables.js` |
| D13-T1..T2 | Groups/sub-groups, search, short codes, favourites, diet icons, variants/extras/notes modal, kitchen-note chips, open item | ✅ 🧑 | `web/screens/order.js`. **You:** father's speed test |
| D14-T1 | Full KDS: columns, age timer 5/10 min colours, repeat beep 30 s while New, reject reason, recall 2 min; captain/biller toast + vibrate on Ready; kds device boots into KDS | ✅ ⚠️ | `web/screens/kds.js`, `web/app.js` |
| D14-T2 | KOT unacknowledged > 2 min → alert event to managers/billers | ✅ | `server/server.js` (timer → `{t:'alert',kind:'kot_unack'}`) |
| D15-T1 | bill.print via domain/totals.js; host FY bill series ≤16 chars; totals snapshot; bill.reprint; discount pct/fixed + reason; complimentary; service charge only if toggled; composition → Bill of Supply | ✅ | `server/commands/bill.js`, `test/bill.test.js` |
| D15-T2 | Bill preview + 58/80 mm print CSS | ✅ | `web/print.js#billHtml`, `web/style.css` |
| D16-T1 | bill.settle with payments, part payments, tip, waive-off (approval), equal split (host numbers), customer dues, due.receive; sums exact in paise | ✅ | `test/settle.test.js` (50 random settlements) |
| D17-T1 | Day-end tally by pay mode, visitors, table time, most-ordered, deleted items, CSV; dayclose locks the date and resets the daily KOT counter | ✅ 🧑 | `server/reports.js`, `server/commands/day.js`, `test/reports.test.js`. **You:** compare with legacy for 3 dates |
| D18-T1 | print/escpos.js (init, align, bold, double, cut, 32/48 cols) + print/lan.js (→ ip:9100, 3 s timeout, retry queue); print.kot/print.bill per station | ✅ 🧑 | `server/print/*`, `test/print.test.js`. **You:** real printer |
| D18-T2 | Client adapters 'host-lan' / 'rawbt' (rawbt:base64 of /api/print/render) / 'browser'; per-device setting + test print | ✅ | `web/print.js`, Admin → Printing |
| D19-T1 | Nightly + day-close VACUUM INTO data/backups/YYYYMMDD.sqlite (keep 30), owner JSON export, restore with confirmation | ✅ | `server/backup.js`, `test/backup.test.js`, `test/server.test.js` |
| D19-T2 | Admin screens (menu, layout, users, roles, settings, devices) | ✅ | `web/screens/admin.js` |
| D20-T1 | manifest.json; optional sw.js registered only if isSecureContext | ✅ | `web/manifest.json`, `web/sw.js`, `web/app.js` |
| D20-T2 | start.sh, runit service, boot script (§5.5), log rotation, /health with restarts and last backup | ✅ ⚠️ | `scripts/start.sh`, `scripts/install.sh`. **You:** reboot < 60 s, kill -9 < 5 s |
| D21 | Test marathon | ✅ 🧑 | `npm test`, `npm run soak`, `npm run test:e2e`; overnight soak on the phone |
| D22–D23 | Pilots | 🧑 | docs/PILOT.md |
| D24-T1 | Idempotent scripts/install.sh; owner guide, install sheet, troubleshooting card | ✅ ⚠️ | `scripts/install.sh` (syntax-checked, not run on a phone here), docs/ |
| D25 | Launch checklist, tag v1.0.0, tarball + checksum | ✅ 🧑 | `scripts/release.sh`, docs/LAUNCH_CHECKLIST.md |

## Legacy parity pass (from legacy/khanakhajana_v13.html)

| ID | Task | Status | Where / proof |
|---|---|---|---|
| P-01 | Owner-only registration; Manager 2222 / Captain 1111 / Kitchen 3333 created at setup; optional KHANAKHAJANA menu (186 dishes, photos), 26 tables, extras, notes | ✅ | `server/seed/`, `server/auth.js#setup`, `web/screens/setup.js`, `test/parity.test.js`, `test/server.test.js` |
| P-02 | Money = legacy calcTotals: taxes list, tax on delivery, delivery charge, complimentary, pct/fix discount caps, extras with own qty; whole-rupee split | ✅ | `server/domain/totals.js`, `test/totals*.test.js`, `test/bill.test.js` |
| P-03 | Menu: 3-letter code + number, Short Code box, search over group/sub-group/variation, available switch, favourites, ▲▼ order, bulk add, diet "No mark", allow extras | ✅ | `server/commands/admin.js`, `server/domain/codes.js`, `web/screens/order.js`, `web/screens/admin.js` |
| P-04 | Global extras (sides) with quantity, multi kitchen notes, notes for part of a quantity, open item setting | ✅ | `side.*`, `web/screens/order.js` |
| P-05 | Home (Dining / Delivery-App / Pickup), delivery & pickup lists with daily refs (ZM1, PK2), held orders, customer panel with lookup + tags, delivery charge | ✅ | `web/screens/{home,orders,order}.js`, `server/commands/order.js` |
| P-06 | Table view with sections, rows, seat pips, standing tables, states, KOT eye/print icons; layout builder (prefix, rows × cols, seats per row, start no) | ✅ | `web/screens/tables.js`, `layout.section.build` |
| P-07 | Bill: quick discounts, customer-tag discount, ask customer, unsent-items warning; settle Cash (given/return), Card, UPI, Due (name+mobile), Other types, Part, tip, settlement amount | ✅ | `web/screens/bill.js`, `server/commands/bill.js`, `test/settle.test.js` |
| P-08 | Reports for date ranges: tally check, cash counted vs expected, visitors, table time, most ordered, deleted items, CSV/print; Bill History + Bill No finder | ✅ | `server/reports.js`, `web/screens/{reports,bills}.js`, `test/reports.test.js`, `test/parity.test.js` |
| P-09 | Legacy KOT / bill print layout (KOT - n, Sides: x - n, [Note]; taxes list, paid-by, cash given/returned) | ✅ | `server/print/render.js`, `web/print.js` |
| P-10 | Browser E2E updated: default users, legacy menu, popup with variation/extra/note, discount, cash change, offline KOT | ✅ | `test/e2e/three-phones.e2e.js` |

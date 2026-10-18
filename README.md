# KhanaKhajana POS — offline restaurant POS on your own phones

Host-authoritative web POS for Indian restaurants. One Android phone runs Node.js inside Termux
(or any laptop runs the same code) and owns a SQLite database; every other phone is just Chrome on the
same Wi-Fi or hotspot. No PC, no internet, no cloud, no build step.

This repository implements **Part B** of *Offline Restaurant POS for India: Rewritten Plan and 25-Day Guide*
(docs/GUIDE.md); Part A is in docs/PLAN.md. Task-by-task status: docs/TASKS.md.

## Quick start (laptop)

```bash
npm ci              # only runtime dependency: ws  (also enables the git pre-commit guard)
npm run dev         # http://127.0.0.1:8080  — first run shows "set up this host"
npm test            # 94 tests: engine, KOT, rights matrix, auth, orders, billing, settlement, reports,
                    # printing, backups, importer, QR, HTTP+WebSocket integration, short soak
npm run typecheck   # tsc --noEmit over JSDoc (laptop only)
npm run soak -- --captains 3 --minutes 30
npm run test:e2e    # 3 browser "phones" (needs: npm i -D playwright)
```

Requires Node ≥ 22.13 (target 24 LTS) for built-in `node:sqlite`.

## On the restaurant's host phone (Termux)

```bash
bash scripts/install.sh            # or: bash install.sh khanakhajana-pos-1.0.0.tar.gz
```
Installs and holds `nodejs-lts`, `npm ci --omit=dev`, creates the runit service + Termux:Boot script, prints the
join QR and the hardening checklist (docs/HOST_CHECKLIST.md). Then open `http://127.0.0.1:8080` **on the host**
to create the owner, add the menu, and pair phones (Admin → Devices → Add device).

## How it works

```
 Captain phone ─┐                         ┌─ LAN printer :9100 (ESC/POS)
 Kitchen (KDS) ─┼── WebSocket /ws ── HOST ─┤
 Biller/Owner  ─┘   http://<ip>:8080   (Node + node:sqlite WAL)   └─ data/backups, data/images
```

- Commands `{t:'cmd', opId, type, payload}` → host checks rights → one transaction → event with global `seq`
  → broadcast. Duplicate `opId` returns the stored result (offline outbox replay is safe). See docs/PROTOCOL.md.
- Works on plain-HTTP LAN origins: own `uuid()`, localStorage outbox, no service worker/Wake Lock/Clipboard needed.
- Money: legacy `calcTotals` port in `server/domain/totals.js`, integer paise in storage, golden parity test.
- Bills `KK1/26-27/000123` (≤16 chars, consecutive per FY), KOT state machine, approvals by manager PIN,
  service charge opt-in only, composition → Bill of Supply.
- Printing: host → LAN printer, RawBT (`rawbt:base64,…`), or browser print 58/80 mm.

## Things only you can do (they were not in the PDF)

1. Copy the father's app to `legacy/khanakhajana_v13.html` and a real backup to `test/golden/backup_v13.json`.
2. Day 8: paste the legacy `calcTotals` verbatim into the marked block in `server/domain/totals.js`, run
   `node scripts/make-golden.js`, commit with `ALLOW_PROTECTED=1`. Until then the golden fixture is a
   **synthetic bootstrap** (the port checked against itself).
3. Check `docs/V13_FORMAT.md` against the real backup and adjust `server/import/v13.js` if fields differ.
4. Phone/printer/pilot checks: Day 4–5, 14, 18, 20–23 manual items in docs/TASKS.md.

## Layout

```
CLAUDE.md AGENTS.md .cursor/rules/ .claude/{settings.json,hooks/protect.sh} .githooks/pre-commit
docs/      PLAN GUIDE PROTOCOL TASKS LOG PILOT V13_FORMAT HOST_CHECKLIST OWNER_GUIDE INSTALL_SHEET TROUBLESHOOTING LAUNCH_CHECKLIST
legacy/    (read-only father's app goes here)
server/    server.js db.js engine.js rights.js auth.js model.js snapshot.js reports.js backup.js ip.js errors.js
           migrations/ commands/{kot,order,bill,admin,day,index}.js domain/totals.js print/{escpos,lan,render}.js import/v13.js
web/       index.html manifest.json sw.js style.css app.js net.js store.js h.js ui.js print.js sound.js session.js
           screens/{setup,pair,login,tables,order,kds,bills,bill,reports,admin,join,whoami,adopt}.js vendor/qr.js
test/      *.test.js golden/ (protected) e2e/three-phones.e2e.js
scripts/   start.sh install.sh ip.sh soak.js make-golden.js make-sample-backup.js release.sh
```

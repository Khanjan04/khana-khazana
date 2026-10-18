# GUIDE — 25-day step-by-step (Claude Code / Cursor)  ·  Part B

> Part B of the plan, with **where each piece lives in this repository** and how each day's exit check is
> proven. Task lines (D01-T1 …) are in docs/TASKS.md with their status.

## 1. Tool setup

**Laptop:** Node.js 24 LTS, Git, Cursor and/or Claude Code CLI, Chrome, Android platform-tools (`adb` only, for the
12L/13 phantom fix and `chrome://inspect`; no Android Studio). Optional Playwright for the multi-phone E2E
(`npm i -D playwright && npm run test:e2e`).

**Host phone:** Termux + Termux:API + Termux:Boot (same source: all F-Droid or all GitHub), then
`pkg update && pkg upgrade -y && pkg install nodejs-lts git termux-services termux-api -y && apt-mark hold nodejs-lts`
— or simply run `scripts/install.sh`, which does all of it idempotently.
**Client phones:** latest Chrome; RawBT on the Biller phone if using a Bluetooth printer.

## 2. Repository structure

| Path | Contents |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/` | agent instructions (§3a, §3b) |
| `.claude/settings.json`, `.claude/hooks/protect.sh` | PreToolUse hook blocking protected edits (§3c) |
| `.githooks/pre-commit` | same guard for every git client (enabled by `npm install`) |
| `docs/` | PLAN, GUIDE, PROTOCOL, TASKS, LOG, PILOT + owner guide, install sheet, troubleshooting, checklists |
| `legacy/` | `khanakhajana_v13.html` — the father's app, **read-only** (you copy it in; see legacy/README.md) |
| `server/` | `server.js` `db.js` `engine.js` `rights.js` `auth.js` `backup.js` `model.js` `snapshot.js` `reports.js` `ip.js` `migrations/` `commands/` `domain/totals.js` `print/` `import/v13.js` |
| `web/` | `index.html` `manifest.json` `app.js` `net.js` `store.js` `h.js` `ui.js` `print.js` `sound.js` `session.js` `screens/` `vendor/qr.js` `sw.js` |
| `test/` | `golden/` (protected) + unit/integration tests + `e2e/` |
| `scripts/` | `start.sh` `install.sh` `ip.sh` `soak.js` `make-golden.js` `make-sample-backup.js` `release.sh` |
| `package.json` | `"type":"module"`, only runtime dependency `ws` |

## 3. Agent instruction files

- **3a CLAUDE.md** — in the repo root (verbatim from the plan, plus the documented write-path exceptions).
- **3b Cursor rules** — `.cursor/rules/00-project.mdc` (alwaysApply) and `10-money.mdc` (globs: `server/domain/**/*.js`,
  `server/commands/bill.js`) repeating the rounding, golden-test and service-charge rules.
- **3c Hard guardrail** — `.claude/settings.json` registers `protect.sh` for `Edit|Write|MultiEdit|NotebookEdit`. Exit 2
  blocks the call and feeds stderr back to Claude. It needs `jq` and **fails closed** without it. Committed migrations are
  blocked; a *new* numbered migration is allowed. The git pre-commit hook rejects commits touching those paths unless *you*
  set `ALLOW_PROTECTED=1`.
- **3d Feeding the plan** — Part A is docs/PLAN.md, Part B is this file, one line per task in docs/TASKS.md.
  Session opener: *"Read CLAUDE.md, docs/PLAN.md §7, docs/PROTOCOL.md, docs/TASKS.md. We are on D08-T2. Restate the task
  and plan in ≤10 bullets, list files you will touch, then wait."* Plan mode first, approve, then execute.
  Size: one task ≈ one commit ≈ ≤300 diff lines ≈ ≤5 files.

**Prompt template**
```
TASK <ID>: <one-sentence goal>
Context: CLAUDE.md, docs/PROTOCOL.md, <files>. Legacy reference: <function> in legacy/khanakhajana_v13.html.
Do: 1) <change> 2) <change> 3) tests in test/<file>.test.js covering <cases>.
Don't: touch protected paths, add deps, change message shapes unless stated.
Verify: `npm run typecheck && npm test`; paste summary.
Stop after: changed files + test summary + open questions. Do not commit.
```

- **3e Commit and review loop** — (1) read the full `git diff`. Checklist: right check on host? inside `tx`? event emitted?
  opId idempotent? no secure-context-only APIs in web/? no new deps? tests assert behaviour? money touched → golden still 0?
  (2) run `npm test` yourself → `git commit -m "D08-T2: …"`; tag each day `day-NN`. (3) agent loops >2× on a failing test →
  `git restore .`, split the task or write it yourself. (4) second session as reviewer: *"Review HEAD~1 against CLAUDE.md hard
  constraints; list violations only."*

## 4. Day-by-day plan — and where it is implemented

Every day ends with all tests green, `git tag day-NN`, and five lines in docs/LOG.md.

### Phase 0 — POC (Days 1–5)

| Day | Plan | Implemented in | Exit check → proof |
|---|---|---|---|
| 1 | Repo, rules, skeleton; `/health {ok,seq,node,uptime}` | all top-level files, `server/server.js`, `server/db.js` | hook blocks `test/golden/x` (verified: exit 2); `test/health.test.js` |
| 2 | 001_init.sql + migration runner; engine (§5.2); kot.create + state machine | `server/migrations/001_init.sql`, `server/engine.js`, `server/commands/kot.js` | `test/engine.test.js` (1,000-op duplicate-opId fuzz), `test/kot.test.js` |
| 3 | WS hello/cmd/ack/evt/sync/synced, snapshot; `web/net.js`; captain + KDS screens on http LAN origin | `server/server.js`, `web/net.js`, `web/screens/order.js`, `web/screens/kds.js` | kill server mid-send → restart → no lost/duplicate KOT: `test/server.test.js` |
| 4 | `scripts/ip.sh` + `/join` QR (vendored pure-JS QR); known-hosts retry → "Scan host QR"; `/whoami` | `scripts/ip.sh`, `server/ip.js`, `web/vendor/qr.js`, `web/screens/join.js`, `web/screens/whoami.js`, `web/app.js` (failover) | **manual on phones:** KOT round-trip on router and hotspot; QR encoder verified bit-exact vs a reference (`test/qr.test.js`) |
| 5 | `scripts/soak.js`; manual screen-off / airplane / Termux restart | `scripts/soak.js`, `test/soak.test.js` | soak: N captains, random disconnects + host restarts → 0 lost/duplicate, contiguous seq. **Manual:** host screen-off 30 min; tag `v0.1-poc` |

### Phase 1 — Data foundation (Days 6–9)

| Day | Plan | Implemented in | Exit check → proof |
|---|---|---|---|
| 6 | 002_full.sql (every PLAN §7 table, INTEGER paise, FKs, indexes); rights.js (24 rights) | `server/migrations/002_full.sql`, `server/rights.js` | `test/rights.test.js` asserts PLAN §8 cell by cell. **You:** review the schema |
| 7 | `import/v13.js` | `server/import/v13.js`, `docs/V13_FORMAT.md` | `test/import.test.js` (counts equal source, re-run no-op, 5-order spot check). **You:** run on a real backup |
| 8 | Paste legacy `calcTotals` verbatim; `make-golden.js` via node:vm; golden test | `server/domain/totals.js` (marked block), `scripts/make-golden.js`, `test/totals.golden.test.js` | 0 differences. **You:** replace the stand-in with the verbatim legacy function and regenerate from the real HTML (see below) |
| 9 | Admin commands with legacy limits | `server/commands/admin.js` | `test/admin.test.js`; captain cannot call any admin command (`test/rights.test.js`) |

### Phase 2 — Operations (Days 10–15)

| Day | Plan | Implemented in | Exit check → proof |
|---|---|---|---|
| 10 | auth.js: pairing, login, scrypt, lockout, logout, revoke; login + pair screens | `server/auth.js`, `web/screens/{pair,login,setup}.js` | `test/auth.test.js`; revoked device disconnected < 1 s (`test/server.test.js`) |
| 11 | Order commands; approval `{userId,pin}` inside cmd | `server/commands/order.js`, engine approval path | biller void without approval fails (`test/order.test.js`) |
| 12 | app.js router, store.js, h.js; table view with colours + timers | `web/app.js`, `web/store.js`, `web/h.js`, `web/screens/tables.js` | table colour changes live on a second phone (E2E) |
| 13 | Order screen: groups/sub-groups, search, short codes, favourites, diet icons, variants/extras/notes, kitchen-note chips, open item | `web/screens/order.js` | **Manual:** father enters a 10-item order by short code |
| 14 | Full KDS: columns, 5/10-min age colours, 30 s repeat beep, reject reason, recall 2 min, toast + vibrate on Ready; KOT unacknowledged > 2 min → alert | `web/screens/kds.js`, `web/app.js`, `server/server.js` (alert timer) | **Manual:** 2-hour idle KDS still beeps |
| 15 | bill.print, FY series ≤16 chars, snapshot, reprint, discounts, comp, service charge opt-in, composition; 58/80 mm print CSS | `server/commands/bill.js`, `web/screens/bill.js`, `web/print.js`, `web/style.css` | `test/bill.test.js` (40 interleaved bills, 2 billers → consecutive). **Scope freeze after today.** |

### Phase 3 — Money, reports, printing, hardening (Days 16–20)

| Day | Plan | Implemented in | Exit check → proof |
|---|---|---|---|
| 16 | bill.settle, part payments, tip, waive-off, equal split, dues | `server/commands/bill.js` | 50 random settlements reconcile (`test/settle.test.js`) |
| 17 | Day-end tally, CSV; dayclose locks date + resets KOT counter | `server/reports.js`, `server/commands/day.js`, `web/screens/reports.js` | `test/reports.test.js`. **You:** match the legacy app for 3 dates |
| 18 | escpos.js, lan.js (3 s timeout, retry queue), per-station routing; client adapters host-lan/rawbt/browser | `server/print/*`, `web/print.js`, `/api/print/render` | `test/print.test.js` (fake TCP printer). **You:** real KOT + bill on paper |
| 19 | Nightly + day-close `VACUUM INTO` (keep 30), JSON export, restore; admin screens | `server/backup.js`, `/api/backups`, `/api/restore`, `web/screens/admin.js` | `test/backup.test.js`, restore in `test/server.test.js`. **You:** wipe data/, restore yesterday |
| 20 | manifest.json; optional sw.js only if isSecureContext; start.sh, runit, boot script, log rotation, /health with restarts + last backup | `web/manifest.json`, `web/sw.js`, `scripts/start.sh`, `scripts/install.sh` | **Manual:** reboot → up < 60 s; `kill -9` → back < 5 s (runit) |

### Phase 4 — Prove and package (Days 21–25)

- **Day 21 — Test marathon** (§7): `npm test`, `npm run soak -- --captains 3 --minutes 30`, overnight screen-off soak on the phone.
- **Day 22 — Pilot #1** (lunch), old app on standby; log in docs/PILOT.md.
- **Day 23 — Fixes + pilot #2** (8-hour dinner). Bug fixes only.
- **Day 24 — Installer + docs:** `scripts/install.sh`; docs/OWNER_GUIDE.md, docs/INSTALL_SHEET.md, docs/TROUBLESHOOTING.md.
- **Day 25 — Release v1.0:** docs/LAUNCH_CHECKLIST.md, `scripts/release.sh` (tarball + sha256), tag `v1.0.0`, demo video, friendly restaurant #2.

## Day 8 procedure (do this before trusting any bill)

1. Copy the father's file to `legacy/khanakhajana_v13.html` and a real backup to `test/golden/backup_v13.json`.
2. In `server/domain/totals.js`, replace the body between `BEGIN LEGACY calcTotals` / `END LEGACY` with the legacy
   function **verbatim**, only replacing globals with the `(o, s)` parameters. If legacy field names differ from
   `docs/V13_FORMAT.md`, adapt `legacyOrder()` in `server/commands/bill.js` and the importer — not the arithmetic.
3. `node scripts/make-golden.js` (no `--bootstrap`) — it loads the legacy function from the HTML via `node:vm`.
4. `ALLOW_PROTECTED=1 git commit -m "D08: golden fixture from legacy"`.
5. `npm run test:golden` must report 0 differences. Fix the port, never the fixture.

The repository currently ships a **synthetic** sample backup and an expected file generated with `--bootstrap`
(the port checked against itself) so CI is green on day zero. That proves the pipeline, not parity.

## 5. Code skeletons → actual files

| Plan § | File |
|---|---|
| 5.1 node:sqlite adapter | `server/db.js` (`Database ?? DatabaseSync`, WAL, `tx()` with BEGIN IMMEDIATE, migration runner) |
| 5.2 opId idempotency + global seq | `server/engine.js` |
| 5.3 golden parity test | `test/totals.golden.test.js` |
| 5.4 uuid, outbox, replay | `web/net.js` |
| 5.5 Termux start/supervision/autostart | `scripts/start.sh`, runit `$PREFIX/var/service/pos/run` + `~/.termux/boot/10-pos` (both written by `scripts/install.sh`). Fallback without runit: `while true; do node server/server.js; sleep 2; done` |

## 6. Cut list (drop in this order if behind)

1. Service worker / install polish (keep manifest) 2. Recall, age colouring, unacknowledged-KOT alerts (keep beep)
3. RawBT path (keep LAN + browser print), or the reverse 4. Table-time and visitors reports (keep tally + CSV)
5. Equal split (keep part payments) 6. Custom-roles UI (keep default roles) 7. Legacy import UI (keep CLI importer)
8. Customer CRM screens (keep phone + dues) 9. Composition mode (only if no composition customers)

**Never cut:** golden parity, opId idempotency, host-side numbering, host-side rights, backups, host hardening,
service-charge opt-in. *(Nothing was cut in this build.)*

## 7. Test plan

| Test | How | Pass | Automated here |
|---|---|---|---|
| Concurrency | 2 billers + 4 captains, same tables, 15 min | no duplicate numbers; consecutive bill series | `bill.test.js` (interleaved), `soak.js` |
| Idempotency / reconnect | resend each cmd 1–3×; captain offline 2 min sending 5 KOTs | one effect per opId; all 5 arrive once | `engine.test.js`, `server.test.js`, `soak.js` |
| Host crash / IP change | `kill -9` during 20 sends; toggle hotspot twice | back < 5 s, outboxes drain; QR re-join, no loss | `server.test.js` (restart), `soak.js` (restarts); hotspot = manual |
| Screen-off soak | host screen off 8 h, KOT every 10 min | 48/48 delivered | manual |
| KDS soak | kitchen phone on charger, Stay awake, 4 h | beep on every KOT | manual |
| 8-hour service | real dinner pilot | 0 data loss; tally = cash drawer | manual (Day 23) |
| Money / rights / restore | golden + 500 random orders; role × command; backup onto spare phone | 0 diffs; matches §8; counts match | `totals*.test.js`, `settle.test.js`, `rights.test.js`, `backup.test.js` |

## 8. Final launch checklist

See docs/LAUNCH_CHECKLIST.md.

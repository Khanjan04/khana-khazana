# Project: KhanaKhajana POS (offline restaurant POS, India)

## What this is
Host-authoritative web POS. One host (Node in Termux on Android, or a laptop) serves
web/ over plain HTTP on the LAN and owns SQLite. Phones are Chrome clients.
Read docs/PLAN.md and docs/PROTOCOL.md before any change.
legacy/khanakhajana_v13.html is the father's original — READ-ONLY reference.
When porting a feature, find the original function there and port behaviour exactly.

## Hard constraints (never violate)
1. Node >=22.13, target 24 LTS. Plain JavaScript ES modules + JSDoc + `// @ts-check`.
   NO TypeScript compile step, NO bundler, NO native npm modules (no better-sqlite3,
   bcrypt, bufferutil). Only runtime dependency: `ws`. Ask before adding any dependency.
2. Database: node:sqlite ONLY via server/db.js. All writes inside engine.js transactions.
   (Documented exceptions: auth.js pairing/login/session bookkeeping, the offline
   importer server/import/v13.js, backup/restore. Nothing else.)
3. Browser code must work on an INSECURE origin (http://192.168.x.y): do NOT use
   crypto.randomUUID, navigator.clipboard, Notification, wakeLock, navigator.serial,
   bluetooth or service-worker logic in core paths. Use uuid() from web/net.js.
   Feature-detect anything optional.
4. Protocol: client {t:'cmd',opId,type,payload}; host checks rights server-side, applies
   in ONE transaction, appends event with global seq, stores opId->result, broadcasts
   {t:'evt',seq,data:{changes}}. No client-to-client messaging. Bill/KOT/order numbers
   are assigned only on the host.
5. Money: server/domain/totals.js is an exact port of legacy calcTotals using
   r2 = Math.round((n+Number.EPSILON)*100)/100 and total = Math.round(raw).
   Do not "improve" rounding or tax logic without an explicit task.
6. PROTECTED (never edit, regenerate, delete or skip): test/golden/**,
   test/totals.golden.test.js, legacy/**, committed server/migrations/*.
   If a protected test fails, FIX THE CODE. If you think the test is wrong, STOP and ask.
7. Never use .skip/.only, weaken assertions, or swallow errors to make tests pass.
8. Service charge is never applied by default (CCPA). Opt-in per bill only.

## Commands
npm ci | npm run dev (port 8080) | npm test | npm run test:golden | npm run typecheck
npm run soak (Day 5 soak) | npm run test:e2e (laptop, needs Playwright)

## Definition of done (every task)
- `npm run typecheck && npm test` pass; golden parity = 0 differences.
- New command => handler in server/commands/, right in rights.js, tests in test/.
- docs/PROTOCOL.md updated if a message shape changed.
- One task, small diff, then STOP and print: files changed, commands run, test summary,
  open questions. Do not commit.

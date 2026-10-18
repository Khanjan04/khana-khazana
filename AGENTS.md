# AGENTS.md

Cursor, Codex and other agents: **CLAUDE.md in the repo root is the source of truth.**
Read it first, then docs/PLAN.md §7 (data model + protocol), docs/PROTOCOL.md and docs/TASKS.md.

Summary of the non-negotiables (details in CLAUDE.md):
- Plain JS ESM + JSDoc + `// @ts-check`; Node ≥22.13 (target 24 LTS); no build step, no bundler.
- `node:sqlite` only via `server/db.js`; only runtime dependency is `ws`; no native modules.
- Browser code must run on `http://<LAN-IP>` (insecure origin): no `crypto.randomUUID`,
  Async Clipboard, Notifications, Wake Lock, Web Serial/Bluetooth or service worker in core paths.
- Host-authoritative protocol; numbers (bill/KOT/order) only assigned on the host.
- Money = exact legacy port in `server/domain/totals.js`; golden parity must be 0.
- PROTECTED: `test/golden/**`, `test/totals.golden.test.js`, `legacy/**`, committed `server/migrations/*`.
- Service charge never on by default.
- One task per change; run `npm run typecheck && npm test`; do not commit.

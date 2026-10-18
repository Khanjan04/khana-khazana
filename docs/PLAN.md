# PLAN — Offline Restaurant POS (Web App, Phone-Hosted)  ·  Part A

> Condensed from *Offline Restaurant POS for India: Rewritten Plan and 25-Day Guide* (Part A).
> Agents: read §7 (data model + protocol) and §8 (rights) before any change.

**Bottom line.** A sellable, phones-only, offline restaurant POS web app: plain JavaScript (ES modules +
JSDoc), no build step, Node 24 LTS with built-in `node:sqlite` and the pure-JS `ws`, unchanged on a laptop
and inside Termux. Designed to work fully over plain HTTP on a LAN IP, so no HTTPS-only browser features
are needed. Not in 25 days: native APK, Swiggy/Zomato auto-integration, inventory/recipes, background push
on the kitchen screen, trusted local HTTPS.

## 1. Feasibility verdicts

| Question | Verdict | Why |
|---|---|---|
| Build without Android Studio / Kotlin? | Yes | Web app + Node in Termux. Nothing native. |
| AI agents as primary coders? | Yes, with guardrails | Plain JS + SQL + HTML; golden tests protect money; a hook blocks edits to them. |
| POC (2 phones, Captain→Kitchen, router or hotspot) in 5 days? | Yes | Days 1–5 restructure the existing POC into the production skeleton. |
| Sellable v1 in 25 days? | Yes for dine-in + takeaway + manual delivery entry | Inventory, aggregators, native app, multi-outlet, cloud deferred. |
| Fully offline, no cloud source of truth? | Yes | Host phone holds SQLite; clients talk only to the host. |
| One Android phone as reliable host? | Yes, conditionally | Needs the hardening checklist (§10); fallback host is part of the offer. |
| PWA install over plain HTTP on LAN IP? | Not reliably | Chrome requires HTTPS for installability; v1 = "Add to Home screen" + manifest. |

**Positioning:** "Runs on the phones you already own. No PC, no internet, no monthly cloud dependency."
(Contrast: Petpooja POS Local needs a Bridge Server on a dedicated computer.)

## 2. Architecture

Host-authoritative star; clients never talk to each other. The **host phone** (Termux → `node server/server.js`:
static HTTP + JSON API + WebSocket command engine + `node:sqlite` in WAL + ESC/POS sender + `data/backups`,
`data/images`). Clients on the same LAN (restaurant Wi-Fi router **or** the host's hotspot): Captain phones,
Kitchen (KDS) phone(s), Biller, Manager/Owner — each opens `http://<host-ip>:8080` and holds one WebSocket to
`/ws`. The host's own Chrome uses `http://127.0.0.1:8080` (a secure context). LAN thermal printer on the host
(TCP 9100); Bluetooth printer via the RawBT app.

- **Default host:** Android phone, Node.js LTS in Termux (F-Droid/GitHub builds — not Play Store).
- **Alternative host (state in every sale):** cheap laptop / mini-PC / old phone running the same code.
- Evaluated: Termux + Termux:Boot + Termux:API (chosen); PM2 (heavy; prefer `termux-services`/runit);
  nodejs-mobile (rejected: native build); Capacitor (client wrapper only, post-v1).

## 3. Tech stack (ADR-001)

| Decision | Choice | Reason |
|---|---|---|
| Runtime | Node 24 LTS (≥22.13) | `node:sqlite` RC without warning from 24.15; Node 26.11 renamed `DatabaseSync`→`Database` → adapter in `server/db.js`. Pin with `apt-mark hold nodejs-lts`. |
| Database | `node:sqlite`, WAL, foreign keys ON | No native addon (better-sqlite3 is a Termux risk). sql.js = emergency fallback. |
| Language | Plain JS ESM + JSDoc + `// @ts-check`; `tsc --noEmit` on laptop only | No build step. |
| HTTP | `node:http` + tiny router | Fewer deps. |
| WebSocket | `ws` (skip `bufferutil`) | Small, pure JS. |
| Tests | `node:test`; Playwright on laptop only | Built in; runs on the phone. |
| Frontend | Vanilla ES modules + tiny `h()` helper; no bundler | 1:1 port of working screens. |

## 4. Discovery and connectivity

| | (A) Restaurant Wi-Fi router (recommended) | (B) Host phone hotspot |
|---|---|---|
| Host IP stability | Stable with a DHCP reservation ("Use device MAC" for that SSID) | Android 11+ randomises the hotspot subnet each time |
| Discovery | QR on host admin page + printed QR with fixed IP | QR on host screen after each hotspot start; clients cache URLs, retry, then "Scan host QR" |

mDNS (`pos.local`) is post-v1. A web page cannot read the gateway IP. Chrome Local Network Access: our pages are
served *by* the host (private→private), so normal use is unaffected; test any page call to 127.0.0.1 on Day 4.

## 5. Secure-context limits and workarounds

| Need | Over `http://LAN-IP` | v1 approach |
|---|---|---|
| Unique opIds | `crypto.randomUUID` missing | own `uuid()` on `crypto.getRandomValues` |
| Offline outbox | localStorage/IndexedDB work | localStorage outbox |
| Real-time sync | WebSocket works | backoff reconnect + sync since lastSeq |
| App shell / install | service worker blocked | `manifest.json` + "Add to Home screen"; optional per-phone chrome://flags insecure-origin entry |
| Kitchen screen awake | Wake Lock blocked | Developer options → "Stay awake" + charger |
| Sound alerts | autoplay needs a gesture | mandatory "Start shift" tap unlocks AudioContext |
| Vibration | works | captain vibrates on "ready" |
| Background alerts | pages frozen after 5 min in background | KDS is the foreground tab on a dedicated charging phone; captains resync on resume |
| Bluetooth printing | Web Bluetooth/Serial secure-only | RawBT intent, or pair the printer to the host phone (127.0.0.1) |
| Clipboard | Async Clipboard blocked | `execCommand('copy')` fallback |

Not chosen for v1: local HTTPS with mkcert (CA install on every phone).

## 6. Printing

1. **LAN/Wi-Fi ESC/POS printer (port 9100) driven by the host** — recommended; per-station KOT routing.
2. **Bluetooth printer via RawBT** — `rawbt:base64,<ESC/POS>`.
3. **Browser print dialog** — `window.print()` + 58/80 mm `@page` CSS.
4. Post-v1: Web Serial over Bluetooth RFCOMM from the host's localhost page.

## 7. Data model and sync protocol

Normalized SQLite: settings, counters, ops, events, legacy_import, roles, role_rights, users, devices,
sessions, pair_codes, sections, dining_tables, menu_groups, menu_subgroups, items, variants, extras,
kitchen_notes, orders, order_lines, kots, kot_status_log, bills, bill_payments, customers, due_receipts,
void_log, day_close. Money uses the father's exact JS rounding (`r2 = Math.round((n+Number.EPSILON)*100)/100`,
`total = Math.round(raw)`); stored values are **integer paise**, converted only at the edge; the parity test is arbiter.

Protocol (full detail in docs/PROTOCOL.md):
- Client → `{t:'hello', deviceToken, sessionToken, lastSeq}`
- Client → `{t:'cmd', opId, type, payload}`. Host checks session and right, runs the handler in **one SQLite
  transaction**, appends `events(seq, opId, type, changes)`, stores `ops(opId → result)`, replies `{t:'ack', opId, …}`.
- Host → all: `{t:'evt', seq, data:{changes:[{entity,id,value}]}}`
- Reconnect → `{t:'sync', since}`; host replays events `> since` (or sends a snapshot), then `{t:'synced', seq}`.
- Duplicate opId → stored result returned, nothing reapplied.
- **Bill/KOT/order numbers only on the host.** GST Rule 46(b): consecutive serial ≤16 chars unique per FY;
  per-host prefix e.g. `KK1/26-27/000123`.
- **KOT state machine:** new → accepted → preparing → ready → served; new|accepted → rejected (reason);
  not served → cancelled (reason + approver). Lines on rejected/cancelled KOTs are voided with a void_log entry.

Importer (v13 backup → SQLite): hash PINs (scrypt), extract base64 images to `data/images/<sha1>.jpg`,
continue counters, import legacy KOTs as `accepted`, record `legacy_import` with the file hash. Re-running is a no-op.

## 8. Roles and permissions

Rights = father's 13 (`order, kot, bill, discount, delivery, void, history, reports, kitchen, layout, menu,
users, settings`) + new (`kitchen.status, serve, kot.reprint, table.transfer, bill.reprint, dayclose, approve,
stock, customers.due, device.manage, export`).

| Right | Owner | Manager | Biller | Captain | Kitchen | Accountant | Delivery |
|---|---|---|---|---|---|---|---|
| order, kot, serve, table.transfer | ✓ | ✓ | ✓ | ✓ | – | – | – |
| kitchen (view KDS) | ✓ | ✓ | ✓ | – | ✓ | – | – |
| kitchen.status, kot.reprint | ✓ | ✓ | reprint only | – | ✓ | – | – |
| bill, bill.reprint | ✓ | ✓ | ✓ | – | – | – | – |
| discount, void | ✓ | ✓ | approval | – | – | – | – |
| delivery | ✓ | ✓ | ✓ | – | – | – | ✓ |
| history, reports | ✓ | ✓ | ✓ | – | – | ✓ | – |
| export, customers.due | ✓ | ✓ | dues only | – | – | ✓ | – |
| dayclose, approve | ✓ | ✓ | – | – | – | – | – |
| layout, menu, stock | ✓ | ✓ | – | – | – | – | – |
| users, settings, device.manage | ✓ | – | – | – | – | – | – |

"approval" = the father's `need(right, cb)` flow: a user with `approve` enters their PIN on the same device and
the host records the approver. **All checks run on the host**; UI hiding is cosmetic.

## 9. Security

- **Pairing:** Owner taps "Add device" (device.manage). One-time 6-digit code (5-min TTL, 5 attempts) + QR to
  `http://<ip>:8080/pair`. The new phone posts code + kind (`staff`|`kds`) and receives a 256-bit device token
  (stored hashed on the host; kept in localStorage).
- **Login:** device token + PIN → session token (12 h, revocable). PINs hashed with `crypto.scrypt` (per-user
  salt), verified with `timingSafeEqual`. Lockout 15 min after 5 failures. Owner recovery code printed at setup.
- **LAN API protection:** every HTTP API and WS frame needs device token + session. Reject non-RFC1918 sources,
  rate-limit pairing, no CORS, `Content-Security-Policy: default-src 'self'`, never serve `data/`. Plain HTTP can
  be sniffed by anyone on the Wi-Fi → **advise a separate WPA2/3 staff SSID** (guest Wi-Fi isolated). State this honestly.
- **Audit:** every command is in `events` with user/device; voids, discounts, comps and reprints carry the approver.

## 10. Termux reliability (critical)

| Failure | Cause | Fix |
|---|---|---|
| `[Process completed (signal 9)]` | Android 12+ phantom process killer | 14+: Developer options → "Disable child process restrictions". 12L/13: `adb shell settings put global settings_enable_monitor_phantom_procs false` (+ `device_config set_sync_disabled_for_tests persistent`). 12: `max_phantom_processes` = 2147483647 via ADB. |
| Node dies with screen off | Doze | `termux-wake-lock`; Battery → Termux → Unrestricted |
| OEM killer | Xiaomi/Samsung/Realme/Oppo/Vivo/OnePlus | host checklist; re-verify after OS updates |
| Reboot / power cut | — | Termux:Boot: `~/.termux/boot/` runs `termux-wake-lock`, then runit services |
| Crash / OOM | bug | runit (`termux-services`, `sv-enable pos`) restarts |
| Hotspot turns off | auto-off timeout | disable "Turn off hotspot automatically"; prefer router |
| Host IP change | DHCP / hotspot randomisation | DHCP reservation; QR re-join; cached URL list |
| Node upgrade breaks app | `pkg upgrade` | `apt-mark hold nodejs-lts` |
| Corruption | power loss | WAL + `synchronous=NORMAL`; nightly backup + day-close export |

Host checklist: see docs/HOST_CHECKLIST.md.

## 11. Compliance (brief, verified Oct 2026 — not tax advice)

- **GST rate:** outside "specified premises" = 5% without ITC (CGST 2.5 + SGST 2.5, default); inside = 18% with ITC.
  "Specified premises (18%)" toggle, off by default.
- **Composition scheme:** Bill of Supply (no tax lines; composition legend).
- **Rule 46 fields:** supplier name/address/GSTIN, consecutive serial ≤16 chars unique per FY, date, SAC 996331,
  description, qty, value, taxable value, CGST/SGST rate and amount, place of supply, signature/footer.
- **E-invoicing:** only above ₹5 crore and B2B — out of scope.
- **Service charge:** CCPA guidelines upheld (Delhi HC, 28 Mar 2025). **Never default, never relabelled, opt-in per
  bill on customer consent, separate line, not added before GST.**

## 12. Market and pricing

Petpooja (cloud-first; POS Local needs a bridge PC), Zoho POS for Restaurants (cloud-first). Wedge: "No PC, no
internet, no per-device fees; works on a ₹8k phone; data never leaves the restaurant; runs through power cuts on
battery." Suggested: ₹4,999 setup + ₹299/month or ₹2,999/year per outlet; optional host kit at cost + ₹1,000;
first 10 restaurants free setup for testimonial + weekly feedback.

## 13. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | OEM ROM kills Termux mid-service | High | §10 checklist; runit; client outbox; fallback laptop host |
| 2 | Kitchen misses KOTs | High | charging KDS phone, Stay awake, foreground rule, repeat beep |
| 3 | Rounding mismatch vs father's app | High | golden parity; hook blocks test edits |
| 4 | AI agent changes business rules | High | CLAUDE.md + hook + one task per commit + review |
| 5 | Hotspot IP change / printer incompatibility | Med | router + DHCP reservation, QR re-join; LAN printer, RawBT, browser fallback |
| 6 | Data loss / plain-HTTP sniffing | High | nightly backup + restore drill; separate SSID |
| 7 | 25-day overrun | Med | cut list; scope freeze after Day 15 |

## 14. Deferred beyond 25 days

Native APK (Capacitor via CLI Gradle) · Swiggy/Zomato integration · inventory/recipes · multi-outlet cloud
dashboard · trusted local HTTPS · mDNS · regional-script raster printing · QR self-ordering ·
loyalty/SMS/WhatsApp · Tally export.

# PROTOCOL — host-authoritative command/event protocol

One host owns SQLite. Clients never talk to each other. Every change is a **command** sent
by a client, checked and applied by the host in **one SQLite transaction**, recorded as an
**event** with a global, strictly increasing `seq`, and broadcast to every connected client.

Update this file whenever a message shape changes (CLAUDE.md, definition of done).

## Transport

| Channel | Use |
|---|---|
| `GET /` (and `/join`, `/pair`, `/whoami`, `/setup`, `/login`) | the web app (`web/`), plain HTTP |
| `WS /ws` | commands, acks, events, sync |
| `POST /api/*`, `GET /api/*` | setup, pairing, login, reports, exports, backups, print render |

Every HTTP request and WS upgrade must come from loopback / RFC1918 / link-local / IPv6 ULA.
POST requests and WS upgrades with a foreign `Origin` are rejected. No CORS headers are sent.
`data/` is never served (only `/img/<sha1>.<ext>` item photos).
CSP: `default-src 'self'` (+ `connect-src` lists this host's other LAN origins and configured fallback hosts).

HTTP auth headers: `x-device-token` (from pairing) and `x-session-token` (from PIN login).

## WebSocket messages

### Client → host

```js
{ t: 'hello', deviceToken, sessionToken, lastSeq, epoch }   // first message, within 10 s
{ t: 'cmd', opId, type, payload }                            // opId = uuid() from web/net.js (≤64 chars)
{ t: 'sync', since, epoch }                                  // ask for replay after a detected gap
{ t: 'ping' }
```

### Host → client

```js
{ t: 'welcome', user: {id, name, roleId, rights: [...]}, device: {id, name, kind}, epoch, businessDate }
{ t: 'snapshot', seq, epoch, data: { entities: { <table>: [rows] }, settings, businessDate } }
{ t: 'evt', seq, data: { changes: [{ entity, id, value }] } }  // value === null => deleted
{ t: 'synced', seq, epoch }                                     // replay finished; client may flush its outbox
{ t: 'ack', opId, ok: true,  result, seq }                      // seq = 0 when the command changed nothing
{ t: 'ack', opId, ok: false, error: { code, msg } }
{ t: 'alert', kind: 'kot_unack', kotId, no, ageMin }            // KOT still "new" after 2 min (to bill/approve rights)
{ t: 'alert', kind: 'print', ok, label, error }                 // host LAN print result
{ t: 'pong', ts }
```

Close codes: `4000` hello timeout · `4001` device unknown/revoked (re-pair) · `4003` session
invalid/expired/logged out (re-login) · `4010` host restored a backup (reconnect, you will get a snapshot).

### Connect / reconnect

1. Client opens `/ws`, sends `hello` with its stored `lastSeq` and `epoch`.
2. Host validates device + session (else closes 4001/4003), sends `welcome`.
3. If `epoch` differs (fresh host DB, restore, import), `lastSeq ≤ 0`, `lastSeq > maxSeq`, or the gap
   is larger than 5,000 events → host sends one `snapshot`. Otherwise it replays
   `SELECT seq, changes FROM events WHERE seq > lastSeq ORDER BY seq` as `evt` messages.
4. Host sends `synced`. The client then re-sends **every** command still in its localStorage outbox.
5. Duplicate `opId` → the stored result is returned in the `ack`; nothing is re-applied.

The client reconnects with exponential backoff (0.5 s → 8 s), also on `visibilitychange` (Chrome freezes
background tabs) and on `online`. After 4 failures it probes the other known host origins
(`/health`, `no-cors`) and hands over device token, session and outbox via `/#/adopt?d=…`;
if none answers it shows **"Scan host QR"**.

Evt ordering: the client ignores `seq ≤ lastSeq` and sends `sync` when it sees `seq > lastSeq + 1`.

### Command processing on the host (`server/engine.js`)

```
exists ops[opId]?            -> return stored result (idempotent)
handler = handlers[type]      -> else UNKNOWN_CMD
base right (if any)           -> else FORBIDDEN
right = h.right(payload)      -> user lacks it?
    approvable(payload)?      -> payload.approval {userId, pin} of a user with `approve` + right
                                 else APPROVAL_REQUIRED / APPROVAL_DENIED / BAD_LOGIN / LOCKED
    not approvable            -> FORBIDDEN
BEGIN IMMEDIATE
  handler.run(...)            -> emits changes
  INSERT events(op_id,type,user_id,device_id,approver_id,changes,ts) RETURNING seq
  INSERT ops(op_id,...,result)
COMMIT                        -> broadcast {t:'evt'}; run after-commit hooks (printing, backup, disconnects)
```

A failing handler rolls back everything (no event, no op row); the client gets `ok:false` and the
command leaves its outbox.

## Entities (replicated tables)

`sections, dining_tables, menu_groups, menu_subgroups, items (+variants[], extras[]), kitchen_notes,
users (no PIN fields), roles (+rights[]), devices (no token), customers, orders, order_lines, kots,
bills (snapshot parsed), bill_payments` — rows are camelCased columns (`price_paise` → `pricePaise`).
Pseudo-entities: `settings` (id `settings`, full settings object), `meta` (id `businessDate`),
`day_close` (id = date).

Money is **integer paise** everywhere on the wire. Bills carry a frozen `snapshot` of what was printed.

## Commands

`right` = what the user needs. *(appr.)* = may instead carry `approval: {userId, pin}`.

| type | right | payload | result |
|---|---|---|---|
| `order.open` | order | `{type:'dine'\|'takeaway'\|'delivery', tableId?}` (dine reuses the table's active order) | `{orderId, no}` |
| `order.line.add` | order | `{orderId \| tableId \| type, lines:[Line]}` | `{orderId, lineIds}` |
| `order.line.update` | order | `{lineId, qty?, note?}` — unsent lines only | |
| `order.line.remove` | order | `{lineId}` — unsent lines only | |
| `order.line.void` | order + void *(appr.)* | `{lineId, reason, qty?}` (partial void splits the line) | `{lineId}` |
| `order.hold` | order | `{orderId, held}` | |
| `order.persons` | order | `{orderId, persons}` | |
| `order.comment` | order | `{orderId, comment}` | |
| `order.customer` | order | `{orderId, phone, name?, address?}` or `{orderId, customerId}` | `{customerId}` |
| `order.delivery` | delivery | `{orderId, platform:'Zomato'\|'Swiggy'\|'Phone'\|'Other', ref?}` | |
| `order.cancel` | order + void *(appr.)* | `{orderId, reason}` | |
| `table.transfer` | table.transfer | `{orderId, toTableId}` (target must be free) | |
| `kot.create` | kot | `{orderId \| tableId (+type), lines?:[Line], note?}` — sends all unsent lines, one KOT per station | `{orderId, orderNo, kots:[{id,no,station}]}` |
| `kot.status` | kitchen.status; `served` → serve; `cancelled` → void *(appr.)* | `{kotId, to, reason?}` (reason required for rejected/cancelled) | `{kotId, status}` |
| `kot.recall` | kitchen.status | `{kotId}` — undo last kitchen status within 2 min | `{kotId, status}` |
| `bill.print` | bill; with discount/complimentary → discount *(appr.)* | `{orderId, discount?:{type:'pct'\|'fixed', value, reason}, complimentary?: reason, serviceCharge?: true, print?: 'host-lan'}` | `{billId, no, totalPaise}` |
| `bill.reprint` | bill.reprint | `{billId, print?}` | `{billId, reprints}` |
| `bill.void` | bill + void *(appr.)* | `{billId, reason}` — unsettled bills; order re-opens | |
| `bill.settle` | bill; waive > 0 → discount *(appr.)* | `{billId, payments:[{mode:'cash'\|'card'\|'upi'\|'due'\|'other', amount, phone?}], tip?, waive?, waiveReason?}` — Σpayments must equal total + tip − waive (paise); `due` needs customers.due + customer | `{billId, paidPaise}` |
| `bill.split` | bill | `{billId, ways}` | `{parts:[paise]}` |
| `due.receive` | customers.due | `{customerId, amount, mode}` | `{duePaise}` |
| `dayclose` | dayclose | `{date?, force?}` — refuses with open orders unless `force` | `{date, next, summary}` |
| `print.kot` | kot.reprint | `{kotId}` | `{queued}` |
| `print.bill` | bill | `{billId}` | `{queued}` |
| `print.test` | settings | `{station}` | `{queued}` |
| `menu.group.save` / `.delete` | menu | `{id?, name, sort?}` / `{id}` (≤12 groups) | `{id}` |
| `menu.subgroup.save` / `.delete` | menu | `{id?, groupId, name, sort?}` / `{id}` (≤10 per group) | `{id}` |
| `menu.item.save` | menu | `{id?, name, code?, pricePaise, groupId, subgroupId?, diet, station?, favourite?, active?, sort?, variants?:[{name,pricePaise}], extras?:[{name,pricePaise}], imageData?: dataURL\|null}` (≤100 items) | `{id}` |
| `menu.item.delete` | menu | `{id}` (soft delete) | |
| `kitchen_note.save` / `.delete` | menu | `{id?, text}` / `{id}` | `{id}` |
| `layout.section.save` / `.delete` | layout | `{id?, name, sort?}` / `{id}` (≤10 sections) | `{id}` |
| `layout.table.save` / `.delete` | layout | `{id?, sectionId, name, seats?, sort?}` / `{id}` | `{id}` |
| `settings.update` | settings | `{patch:{<known keys>}}` | |
| `user.save` | users | `{id?, name, roleId, pin? (4–8 digits), active?}` (≤100) | `{id}` |
| `user.unlock` | users | `{id}` | |
| `role.save` | users | `{id?, name, rights:[...]}` (owner role immutable) | `{id}` |
| `pair.create` | device.manage | `{kind:'staff'\|'kds'}` | `{code, kind, expiresAt}` |
| `device.revoke` | device.manage | `{deviceId}` — sockets closed with 4001 immediately | |
| `device.rename` | device.manage | `{deviceId, name}` | |

`Line` = `{itemId, qty, variant?, extras?:[name], note?}` or open item `{name, pricePaise, qty, note?, station?}`.
Prices are always taken from the host's menu, never from the client.

### KOT state machine

```
new → accepted → preparing → ready → served
new | accepted → rejected   (reason)
anything not served/rejected → cancelled   (reason + approver)
```
Lines on rejected/cancelled KOTs are voided with a `void_log` entry.

### Numbering (host only)

- Orders and KOTs: daily counters keyed by **business date** (`dayStartHour`, default 04:00; day close
  moves the business date on, so counters restart at 1).
- Bills: `PREFIX/FY/NNNNNN`, e.g. `KK1/26-27/000123` (16 chars, GST Rule 46(b)), consecutive per Indian FY.

## HTTP API

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | – | `{ok, seq, node, version, uptime, restarts, lastBackup, clients, businessDate}` |
| `GET /api/info` | – | `{name, needsSetup, loopback, ips, port, epoch, version}` |
| `POST /api/setup` | loopback, first run only | `{ownerName, pin, restaurantName}` → device + session + `recoveryCode` |
| `POST /api/recover` | loopback | `{code, pin}` resets the owner PIN |
| `POST /api/pair/claim` | 10/min/IP | `{code, kind, name}` → `{deviceId, deviceToken, kind}` |
| `GET /api/users` | device | users for the login picker |
| `POST /api/login` | device | `{userId, pin}` → `{sessionToken, expiresAt (12 h), user}`; 5 failures → 15 min lock |
| `POST /api/logout` | session | revokes the session, closes its sockets |
| `POST /api/cmd` | session | same as a WS `cmd` (fallback / scripts) |
| `GET /api/print/render?kind=kot\|bill\|test&id=&cols=` | kot/bill rights | `{b64}` ESC/POS bytes for RawBT |
| `GET /api/print/jobs`, `POST /api/print/retry` | settings/bill | host LAN print queue |
| `GET /api/reports/day?date=` | reports | day-end tally |
| `GET /api/history?date=` | history | bills with snapshots + payments |
| `GET /api/export/csv?date=` | export | bills CSV |
| `GET /api/export/json` | export | owner JSON export (no PIN/token hashes) |
| `GET /api/backups`, `POST /api/backups`, `GET /api/backups/download?file=` | settings | |
| `POST /api/restore` | settings | `{file, confirm:'RESTORE'}` — takes a pre-restore backup, swaps the DB, new epoch |

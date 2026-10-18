-- 001_init.sql — Day 2 core: settings, counters, ops, events, users, devices,
-- orders, order_lines, kots, kot_status_log.
-- PROTECTED once committed: never edit; add a new numbered migration instead.
-- Money columns are INTEGER paise. Timestamps are INTEGER epoch milliseconds.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON
);

CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT ''    -- business date (daily) or FY (bills)
);

CREATE TABLE ops (
  op_id     TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  user_id   TEXT,
  device_id TEXT,
  result    TEXT NOT NULL,           -- JSON reply returned again on duplicate opId
  ts        INTEGER NOT NULL
);

CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id       TEXT NOT NULL,
  type        TEXT NOT NULL,
  user_id     TEXT,
  device_id   TEXT,
  approver_id TEXT,
  changes     TEXT NOT NULL,         -- JSON [{entity,id,value}]
  ts          INTEGER NOT NULL
);
CREATE INDEX events_op ON events(op_id);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  pin_hash     TEXT NOT NULL,
  pin_salt     TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  failed       INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('staff','kds','host')),
  token_hash TEXT NOT NULL UNIQUE,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  no            INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('dine','takeaway','delivery')),
  table_id      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('open','billed','closed','cancelled')),
  persons       INTEGER NOT NULL DEFAULT 0,
  comment       TEXT NOT NULL DEFAULT '',
  held          INTEGER NOT NULL DEFAULT 0,
  opened_by     TEXT,
  opened_at     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX orders_date ON orders(business_date);
CREATE INDEX orders_table_open ON orders(table_id, status);

CREATE TABLE order_lines (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  item_id     TEXT,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_paise  INTEGER NOT NULL CHECK (unit_paise >= 0),
  variant     TEXT NOT NULL DEFAULT '',
  extras      TEXT NOT NULL DEFAULT '[]',   -- JSON [{name,pricePaise}]
  note        TEXT NOT NULL DEFAULT '',
  kot_id      TEXT,
  voided      INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_kot ON order_lines(kot_id);

CREATE TABLE kots (
  id            TEXT PRIMARY KEY,
  no            INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  station       TEXT NOT NULL DEFAULT 'kitchen',
  status        TEXT NOT NULL CHECK (status IN ('new','accepted','preparing','ready','served','rejected','cancelled')),
  reason        TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  device_id     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (business_date, no, station)
);
CREATE INDEX kots_date ON kots(business_date);
CREATE INDEX kots_order ON kots(order_id);

CREATE TABLE kot_status_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kot_id      TEXT NOT NULL REFERENCES kots(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  user_id     TEXT,
  approver_id TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX kot_status_log_kot ON kot_status_log(kot_id);

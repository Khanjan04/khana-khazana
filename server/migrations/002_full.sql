-- 002_full.sql — Day 6: every remaining table from PLAN §7.
-- PROTECTED once committed: never edit; add a new numbered migration instead.

CREATE TABLE legacy_import (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  imported_at INTEGER NOT NULL,
  report      TEXT NOT NULL            -- JSON counts per entity
);

CREATE TABLE roles (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE role_rights (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  perm    TEXT NOT NULL,
  PRIMARY KEY (role_id, perm)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  device_id  TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_device ON sessions(device_id);

CREATE TABLE pair_codes (
  code_hash  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_by TEXT
);

CREATE TABLE sections (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dining_tables (
  id         TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  name       TEXT NOT NULL,
  seats      INTEGER NOT NULL DEFAULT 4,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX dining_tables_section ON dining_tables(section_id);

CREATE TABLE menu_groups (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE menu_subgroups (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES menu_groups(id),
  name     TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX menu_subgroups_group ON menu_subgroups(group_id);

CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES menu_groups(id),
  subgroup_id TEXT REFERENCES menu_subgroups(id),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  diet        TEXT NOT NULL DEFAULT 'veg' CHECK (diet IN ('veg','nonveg','egg')),
  station     TEXT NOT NULL DEFAULT 'kitchen',
  favourite   INTEGER NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',   -- sha1 of data/images/<sha1>.jpg
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX items_group ON items(group_id);
CREATE INDEX items_code ON items(code);

CREATE TABLE variants (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX variants_item ON variants(item_id);

CREATE TABLE extras (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX extras_item ON extras(item_id);

CREATE TABLE kitchen_notes (
  id   TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL UNIQUE,
  address    TEXT NOT NULL DEFAULT '',
  due_paise  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id);
ALTER TABLE orders ADD COLUMN platform TEXT NOT NULL DEFAULT '';      -- Zomato|Swiggy|Phone|Other
ALTER TABLE orders ADD COLUMN platform_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN legacy_id TEXT;

CREATE TABLE bills (
  id              TEXT PRIMARY KEY,
  no              TEXT NOT NULL UNIQUE CHECK (length(no) <= 16),
  fy              TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  business_date   TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open','settled','void')),
  subtotal_paise  INTEGER NOT NULL,
  discount_paise  INTEGER NOT NULL,
  taxable_paise   INTEGER NOT NULL,
  cgst_paise      INTEGER NOT NULL,
  sgst_paise      INTEGER NOT NULL,
  service_paise   INTEGER NOT NULL,
  roundoff_paise  INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  tip_paise       INTEGER NOT NULL DEFAULT 0,
  waived_paise    INTEGER NOT NULL DEFAULT 0,
  discount_type   TEXT NOT NULL DEFAULT '',
  discount_value  REAL NOT NULL DEFAULT 0,
  discount_reason TEXT NOT NULL DEFAULT '',
  complimentary   INTEGER NOT NULL DEFAULT 0,
  service_on      INTEGER NOT NULL DEFAULT 0,
  composition     INTEGER NOT NULL DEFAULT 0,
  approver_id     TEXT,
  snapshot        TEXT NOT NULL,          -- JSON: everything printed on the bill
  reprints        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  settled_at      INTEGER,
  UNIQUE (fy, seq)
);
CREATE INDEX bills_date ON bills(business_date);
CREATE INDEX bills_order ON bills(order_id);

CREATE TABLE bill_payments (
  id           TEXT PRIMARY KEY,
  bill_id      TEXT NOT NULL REFERENCES bills(id),
  mode         TEXT NOT NULL CHECK (mode IN ('cash','card','upi','due','other')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  customer_id  TEXT REFERENCES customers(id),
  user_id      TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX bill_payments_bill ON bill_payments(bill_id);

CREATE TABLE due_receipts (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  mode         TEXT NOT NULL,
  business_date TEXT NOT NULL,
  user_id      TEXT,
  ts           INTEGER NOT NULL
);

CREATE TABLE void_log (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',   -- JSON
  user_id     TEXT,
  approver_id TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX void_log_date ON void_log(business_date);

CREATE TABLE day_close (
  business_date TEXT PRIMARY KEY,
  closed_at     INTEGER NOT NULL,
  closed_by     TEXT,
  summary       TEXT NOT NULL              -- JSON tally
);

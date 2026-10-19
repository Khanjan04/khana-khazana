-- 003_legacy_parity.sql — features found in the father's app (legacy/khanakhajana_v13.html):
-- global extras ("sides") with quantities, 3-letter short code + short number, "available today",
-- "no mark" diet, table-layout builder (rows x cols, standing tables), order refs (PK1, ZM2…),
-- delivery charge, per-order customer details + tags, configurable tax list on bills,
-- complimentary value, cash tendered/change, other payment types, cash counted at day end.
-- PROTECTED once committed: never edit; add a new numbered migration instead.

-- items: rebuild to widen the diet CHECK ('none' = no mark) and add new columns
CREATE TABLE items_new (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES menu_groups(id),
  subgroup_id TEXT REFERENCES menu_subgroups(id),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',      -- 3 letters, e.g. PBM
  num         INTEGER NOT NULL DEFAULT 0,    -- short number, e.g. 42
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  diet        TEXT NOT NULL DEFAULT 'none' CHECK (diet IN ('veg','nonveg','egg','none')),
  station     TEXT NOT NULL DEFAULT 'kitchen',
  favourite   INTEGER NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = deleted
  available   INTEGER NOT NULL DEFAULT 1,    -- 0 = "Not available today"
  allow_sides INTEGER NOT NULL DEFAULT 0,    -- extras (chutney, curd…) allowed on this dish
  sort        INTEGER NOT NULL DEFAULT 0
);
INSERT INTO items_new(id,group_id,subgroup_id,name,code,num,price_paise,diet,station,favourite,image,active,available,allow_sides,sort)
  SELECT id,group_id,subgroup_id,name,code,0,price_paise,diet,station,favourite,image,active,1,0,sort FROM items;
DROP TABLE extras;           -- per-item extras replaced by global sides (legacy model)
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_group ON items(group_id);
CREATE INDEX items_code ON items(code);
CREATE INDEX items_num ON items(num);

CREATE TABLE sides (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  sort        INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE sections ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE sections ADD COLUMN rows_cfg INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sections ADD COLUMN cols_cfg INTEGER NOT NULL DEFAULT 4;
ALTER TABLE sections ADD COLUMN seats_cfg TEXT NOT NULL DEFAULT '4';
ALTER TABLE sections ADD COLUMN standing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sections ADD COLUMN start_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dining_tables ADD COLUMN row_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dining_tables ADD COLUMN standing INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN ref TEXT NOT NULL DEFAULT '';             -- table name / PK1 / ZM2 …
ALTER TABLE orders ADD COLUMN delivery_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cust_name TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cust_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cust_address TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cust_locality TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cust_tag TEXT NOT NULL DEFAULT '';

ALTER TABLE customers ADD COLUMN locality TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN tag TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN visits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN last_visit INTEGER;

ALTER TABLE bills ADD COLUMN delivery_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN taxes TEXT NOT NULL DEFAULT '[]';           -- JSON [{name, rate, amountPaise}]
ALTER TABLE bills ADD COLUMN comp_value_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN tendered_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN change_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_payments ADD COLUMN other_type TEXT NOT NULL DEFAULT '';

CREATE TABLE cash_counts (
  business_date TEXT PRIMARY KEY,
  counted_paise INTEGER NOT NULL,
  user_id       TEXT,
  ts            INTEGER NOT NULL
);

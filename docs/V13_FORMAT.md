# Legacy backup format (REAL — from legacy/khanakhajana_v13.html, DB_VER 13)

The father's app saves everything in one `localStorage` object and downloads it with
**Admin › Settings › Download backup** as a `.json` file. `server/import/v13.js` reads exactly this shape
(Admin › Backups › "Import from the old billing app", or `node server/import/v13.js <file>`).
`scripts/make-sample-backup.js` produces `test/golden/backup_v13.json` by *driving the real legacy code* in
`node:vm`, so the sample has the real field names and the real legacy totals.

```jsonc
{
  "v": 13,
  "settings": { "name", "address", "phone", "gstin", "fssai", "footer",
                "taxes": [{ "id", "name": "CGST", "rate": 2.5 }], "taxOnDelivery": true, "defaultDelivery": 40,
                "paper": 80, "askCustomer": true, "reasonAll": false, "allowOpenItem": true,
                "otherTypes": ["Google Pay", "PhonePe", …], "custTags": [{ "id", "name", "disc" }], … },
  "roles":  [{ "id", "name", "sys": true, "rights": ["order","kot","bill","discount","delivery","void","history","reports","kitchen","layout","menu","users","settings"] }],
  "users":  [{ "id", "loginId", "name", "pin": "1234", "roleId", "active" }],
  "layout": [{ "id", "name", "enabled", "cfg": { "prefix", "rows", "cols", "seats": "4,6", "standing", "startNo" },
               "rows": [[{ "id", "name", "seats", "standing" }]] }],
  "menu":   { "groups": [{ "id", "name", "subs": [{ "id", "name", "items": [{ "id", "name", "price" /* ₹ */,
               "diet": "v|n|e|''", "active", "extras" /* allow sides */, "fav", "code": "MLA", "num": 1,
               "variants": [{ "id", "name", "price" }], "img" }] }] }] },
  "extras": [{ "id", "name", "price" }],          // global sides, each with its own quantity on a line
  "notes":  ["Swaminarayan", "Jain", "Less Spicy", …],
  "orders": { "<id>": { "id", "type": "dine|pickup|delivery", "tableId", "tableName", "platform", "customer": {…},
               "lines": [{ "id", "itemId", "name", "variant", "price", "qty", "extras": [{ "id", "name", "price", "qty" }],
                           "notes": [], "text", "kot", "void" }], "kots": [...], "discount", "comp", "delivery", … } },
  "bills":  [{ "id", "no": 1, "type", "tableName", "platform", "customer", "persons", "startedAt", "closedAt", "by",
               "lines": [...], "discount": { "mode": "pct|fix", "value" }, "totals": { /* calcTotals output, ₹ */ },
               "pay": { "mode": "cash|card|upi|due|other|part", "parts": [...], "otherType", "tip", "given", "returned" },
               "splitNo", … }],
  "customers":   { "<phone>": { "phone", "name", "address", "locality", "tag", "due", "visits", "last" } },
  "voidLog":     [{ "time", "by", "approvedBy", "table", "item", "qty", "amount", "kot", "sent", "reason" }],
  "dueReceipts": [{ "time", "phone", "amount", "mode", "by" }],
  "dayClose":    { "YYYY-MM-DD": { "counted", "by", "time" } },
  "counters":    { "bill": 77, "kot": { "date", "n" }, "ord": { "date", "n": { "ZM": 1, "PK": 2 } } }
}
```

What the importer does: legacy ids become `L-<id>`; PINs are scrypt-hashed; photos go to `data/images/<sha1>`;
settled bills keep their stored totals exactly (test: every one of the 77 sample bills equals the legacy
`calcTotals` result); running orders come back open with their KOTs as `accepted`; bill, KOT and pickup /
delivery reference counters continue; re-importing the same file is a no-op (file hash in `legacy_import`).

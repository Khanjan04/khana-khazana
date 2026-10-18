# Legacy v13 backup format (ASSUMED)

The father's app (`legacy/khanakhajana_v13.html`) was not part of the plan document, so the importer
(`server/import/v13.js`) and the golden pipeline use the shape below. **On Day 7, open a real backup and
adjust `server/import/v13.js` (and `legacyOrder()` in `server/commands/bill.js` if line fields differ)** —
never the golden fixtures. `scripts/make-sample-backup.js` generates a synthetic file in this shape.

```jsonc
{
  "version": 13,
  "settings": { "name", "address", "phone", "gstin", "fssai", "cgst": 2.5, "sgst": 2.5,
                "serviceChargePct": 5, "compositionScheme": false, "specifiedPremises": false, "paper": 80, "footer" },
  "counters": { "kot": 57, "kotDate": "2026-10-17", "bill": 1290, "order": 30 },
  "groups":   [{ "id", "name", "subgroups": [{ "id", "name" }] }],
  "items":    [{ "id", "name", "code", "price" /* rupees */, "groupId", "subgroupId", "diet": "veg|nonveg|egg",
                 "fav", "station", "variants": [{ "name", "price" }], "extras": [{ "name", "price" }],
                 "img": "data:image/jpeg;base64,..." }],
  "sections": [{ "id", "name", "tables": [{ "id", "name", "seats" }] }],
  "users":    [{ "id", "name", "role": "owner|manager|biller|captain|kitchen|accountant|delivery", "pin": "1234" }],
  "notes":    ["Less spicy", "No onion"],
  "orders": [{
    "id", "no", "date": "YYYY-MM-DD", "time": 1760000000000, "type": "dine|takeaway|delivery", "tableId", "persons",
    "lines": [{ "itemId", "name", "price", "qty", "variant", "extras": [{ "name", "price" }], "note",
                "void": false, "voidReason", "kot": 12 }],
    "discount": { "type": "pct|fixed", "value", "reason" } | null,
    "complimentary": false, "serviceCharge": false,
    "billNo": "1234", "status": "open|billed|settled|cancelled",
    "payments": [{ "mode": "cash|card|upi|due|other", "amount" }],
    "customer": { "name", "phone", "address" } | null,
    "platform": "Zomato|Swiggy|Phone|Other", "platformRef"
  }]
}
```

`calcTotals(order, settings)` must accept these legacy orders directly (that is what the golden test feeds it).
Legacy ids become `L-<id>` in SQLite; legacy bill numbers are kept as-is and the bill counter continues from
`counters.bill` under the new `PREFIX/FY/NNNNNN` format.

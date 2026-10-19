# Owner guide (2 pages)

## Every day
1. **Morning:** the host phone stays on its charger with Termux running. Open Chrome on it at
   `http://127.0.0.1:8080` once to check the green dot.
2. **Kitchen phone:** on the charger, open the POS tab, tap **Start shift** (this turns on the beep).
3. **Staff phones:** open Chrome → the POS bookmark/home-screen icon → pick your name → PIN.
   Only the Owner registers on the host. **Manager (PIN 2222), Captain (PIN 1111) and Kitchen (PIN 3333)** are created
   automatically — change their PINs in Admin › Users on day one.
4. **Night:** Reports → Day-end tally (✓ Matches) → **Enter cash counted** → **Day close**. A backup is taken automatically.
   Reports also show Visitors, Table time, Most ordered and Deleted items for any dates, with Excel (CSV) and Print.

## Taking orders (captain)
Home → **Dining** (or Delivery-App / Pickup) → tap a table → tap dishes (★ Favorite Items), search
(“paneer tikka”) or type the **Short Code** (3 letters like `PBH` or the number `14`, Enter).
Dishes with variations / extras open a popup: choose the variation, extras with quantity, kitchen notes.
📝 on a line gives notes to only some of the quantity (2 Pav Bhaji: 1 less spicy).
👤 customer mobile (name/address fill in for known customers), 👥 guests, 📝 order note, 🛵 delivery charge.
**Save** keeps the order without sending; **KOT** sends to the kitchen; **KOT & Print** also prints; **Hold** parks it.
When food is ready your phone shows **READY** and vibrates; tap **Served**.
Change of mind after sending? ✕ on the line → reason (manager PIN if you don't have the "void" right).

## Billing (biller)
Open the order → **Bill & Payment** → discount 5/10/15/20 % or a customer-tag discount, ₹ amount or
Complimentary (manager PIN for billers) → **Print Bill** (asks customer name/mobile if that setting is on) →
choose **Cash** (type what the customer gave: the change is shown), **Card**, **UPI**, **Due**, **Other** (Google Pay…)
or **Part** (several modes, **Split equally**) → **Settle & Save** or **Settle & Print**.
"Settlement amount" (customer pays less) needs a manager PIN. **Service charge is OFF by default.**
Due/credit: mode **Due** + customer name + 10-digit mobile. Collect later in Bills › Dues or Reports.
Old bills: type the number in the top **Bill No** box, or Bills › Bill History (any dates).

## Admin (owner)
- **Menu:** groups (≤12), sub-groups (≤10 each), dishes (≤100 per sub-group) with 3-letter code + number, variations,
  "allow extras", photo; ▲▼ to reorder, ☆ favourite, "Available" switch for dishes finished today, **Bulk add** (paste
  "Paneer Tikka 220" lines). **Extras & notes:** paid sides (Cheese, Curd…) and kitchen notes.
- **Layout:** sections (≤10) on/off, prefix, rows × tables per row, seats per row ("4,6"), standing tables → **Build tables**;
  tap a table to rename / change seats / delete; + Table, + Row.
- **Import from the old billing app:** Admin › Backups → choose the old app's backup `.json` (menu, tables, staff,
  customers, dues and all old bills come across).
- **Users:** add staff with a role and a 4–8 digit PIN. Locked after 5 wrong PINs for 15 min (Unlock button).
- **Devices → Add device:** shows a 6-digit code + QR (valid 5 min, one use). Lost phone? **Revoke** — it is cut off instantly.
- **Settings:** GSTIN, FSSAI, address, bill prefix (≤3 chars), taxes list (CGST/SGST…), tax on delivery, default
  delivery charge, ask customer before bill, reason for every delete, open item, "Other" payment types, customer tags
  with discount %, "Specified premises 18%" and "Composition (Bill of Supply)" — confirm both with your CA.
  Printers: IP of each Wi-Fi printer (port 9100).
- **Backups:** automatic every night and at day close (last 30 kept). Download one to another device weekly.
  Restore: Admin → Backups → Restore → type RESTORE.

## If something goes wrong
- Red dot / "Host not reachable": is the host phone on and on the same Wi-Fi? See TROUBLESHOOTING.md.
- Hotspot was restarted: its address changed → on the host open **Join** and scan the QR on each phone.
- Forgot owner PIN: on the host phone open `http://127.0.0.1:8080`, use the recovery code printed at setup.

Keep the old app read-only for 2 weeks after go-live. Plain Wi-Fi can be sniffed: use a separate WPA2/3 staff SSID
(guest Wi-Fi isolated).

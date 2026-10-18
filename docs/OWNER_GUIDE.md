# Owner guide (2 pages)

## Every day
1. **Morning:** the host phone stays on its charger with Termux running. Open Chrome on it at
   `http://127.0.0.1:8080` once to check the green dot.
2. **Kitchen phone:** on the charger, open the POS tab, tap **Start shift** (this turns on the beep).
3. **Staff phones:** open Chrome → the POS bookmark/home-screen icon → pick your name → PIN.
4. **Night:** Reports → check the tally against the cash drawer → **Day close**. A backup is taken automatically.

## Taking orders (captain)
Tables → tap a table → tap items (★ = favourites) or type a short code (`3*12` = 3 × item 12) → **Send KOT**.
The kitchen screen beeps. When food is ready your phone shows **READY** and vibrates; tap **Served**.
Change of mind after sending? ✕ on the line → reason (manager PIN if you don't have the "void" right).

## Billing (biller)
Bills → open order → optional discount (needs manager PIN for billers) → **Print bill** →
enter payments (cash/UPI/card, split allowed, **Fill rest** helps) → **Settle**.
**Service charge is OFF by default.** Tick it only if the customer agrees; it prints as a separate optional line.
Due/credit: payment mode "DUE" + customer phone. Collect later in Bills → Dues.

## Admin (owner)
- **Menu / Layout:** groups (≤12), sub-groups (≤10 each), items (≤100) with short codes, variants, extras, photos; sections (≤10) and tables.
- **Users:** add staff with a role and a 4–8 digit PIN. Locked after 5 wrong PINs for 15 min (Unlock button).
- **Devices → Add device:** shows a 6-digit code + QR (valid 5 min, one use). Lost phone? **Revoke** — it is cut off instantly.
- **Settings:** GSTIN, FSSAI, address, bill prefix (≤3 chars), GST rates, "Specified premises 18%" and
  "Composition (Bill of Supply)" — confirm both with your CA. Printers: IP of each Wi-Fi printer (port 9100).
- **Backups:** automatic every night and at day close (last 30 kept). Download one to another device weekly.
  Restore: Admin → Backups → Restore → type RESTORE.

## If something goes wrong
- Red dot / "Host not reachable": is the host phone on and on the same Wi-Fi? See TROUBLESHOOTING.md.
- Hotspot was restarted: its address changed → on the host open **Join** and scan the QR on each phone.
- Forgot owner PIN: on the host phone open `http://127.0.0.1:8080`, use the recovery code printed at setup.

Keep the old app read-only for 2 weeks after go-live. Plain Wi-Fi can be sniffed: use a separate WPA2/3 staff SSID
(guest Wi-Fi isolated).

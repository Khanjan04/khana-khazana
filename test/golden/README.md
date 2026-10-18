# test/golden/ — PROTECTED

- `backup_v13.json` — currently a **SYNTHETIC** sample (`scripts/make-sample-backup.js`). Day 1: replace it
  with a real v13 backup from the father's app.
- `expected_totals.json` — currently generated with `node scripts/make-golden.js --bootstrap` (the port checked
  against itself, so it only proves the pipeline). Day 8: regenerate from `legacy/khanakhajana_v13.html`
  with `node scripts/make-golden.js`, commit with `ALLOW_PROTECTED=1`, and never edit it again.

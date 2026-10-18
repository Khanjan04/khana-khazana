# legacy/ — READ-ONLY

Put the father's original single-file app here as **`legacy/khanakhajana_v13.html`** (Day 1). It is the
reference for every port ("find the original function there and port behaviour exactly") and the source of
truth for money: `scripts/make-golden.js` loads its `calcTotals` with `node:vm` to generate
`test/golden/expected_totals.json`.

This folder is protected: the Claude Code hook blocks agent edits and the git pre-commit hook rejects
commits touching it unless you set `ALLOW_PROTECTED=1` yourself.

The file was not included in the plan document, so it is not in this repository yet.

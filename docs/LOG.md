# LOG — five lines per day

Template:
```
## day-NN (YYYY-MM-DD)
- Done:
- Tests: npm test = N pass / 0 fail; golden = 0 diffs
- Manual checks:
- Problems / decisions:
- Tomorrow:
```

## build-0 (2026-10-18) — repository generated from the plan
- Done: all Part B code tasks D01–D25 that do not need hardware or real data (see docs/TASKS.md).
- Tests: `npm test` = 94 pass / 0 fail; `npm run typecheck` clean; soak 15 s × 3 captains: 429 KOTs, 27 disconnects, 2 host restarts, 0 lost/duplicate; 3-phone browser E2E OK.
- Manual checks: none yet (no phones, printer, legacy file or real backup available while building).
- Decisions: §9 says "Owner/Manager taps Add device" but §8 gives device.manage to Owner only — kept §8 (owner); grant Manager via a custom role if wanted. Golden fixture is bootstrap (port vs itself) until Day 8 with the real legacy HTML. All writes go through engine.js except auth/pairing bookkeeping, importer and backup/restore (documented in CLAUDE.md).
- Next: Day 1 manual items — copy legacy/khanakhajana_v13.html and a real backup; Day 4 phones.

# v3 Migration Validation Report

Generated: 2026-08-02T17:23:12.960Z

Each project was copied to an isolated temp dir and migrated there; sources were never modified.

## tests/fixtures/migration/v2-complete

- Nodes: 10
- Duplicate-node rate: 0.000
- Preserved-user-edit rate: 1.000
- Orphan content count: 0
- Node/Deno output equality: true
- Idempotent: true
- Byte growth (total): 3117 → 5156 (Δ 2039)

| File | Before | After | Δ |
| --- | ---: | ---: | ---: |
| context-map.md | 1103 | 941 | -162 |
| HANDOFF.md | 841 | 0 | -841 |
| tasks.md | 261 | 0 | -261 |
| decisions.md | 263 | 0 | -263 |
| context.json | 649 | 1657 | 1008 |
| content/current-goal.md | 0 | 105 | 105 |
| content/current-status.md | 0 | 72 | 72 |
| content/tasks.md | 0 | 183 | 183 |
| content/decisions.md | 0 | 141 | 141 |
| content/open-questions.md | 0 | 70 | 70 |
| content/risks.md | 0 | 93 | 93 |
| content/knowledge-notes.md | 0 | 124 | 124 |
| content/excluded.md | 0 | 51 | 51 |
| views/HANDOFF.md | 0 | 1719 | 1719 |

Diagnostics:
- migrated handoff to v3.0.0 (sources: context-map.md, context.json; 3 task(s), 1 decision(s), 0 conflict(s))

## tests/fixtures/handoffs/map-only

- Nodes: 9
- Duplicate-node rate: 0.000
- Preserved-user-edit rate: 1.000
- Orphan content count: 0
- Node/Deno output equality: true
- Idempotent: true
- Byte growth (total): 520 → 4207 (Δ 3687)

| File | Before | After | Δ |
| --- | ---: | ---: | ---: |
| context-map.md | 520 | 787 | 267 |
| content/current-goal.md | 0 | 60 | 60 |
| content/current-status.md | 0 | 72 | 72 |
| content/tasks.md | 0 | 111 | 111 |
| content/decisions.md | 0 | 66 | 66 |
| content/open-questions.md | 0 | 61 | 61 |
| content/risks.md | 0 | 58 | 58 |
| content/knowledge-notes.md | 0 | 81 | 81 |
| content/excluded.md | 0 | 51 | 51 |
| views/HANDOFF.md | 0 | 1306 | 1306 |
| context.json | 0 | 1554 | 1554 |

Diagnostics:
- migrated handoff to v3.0.0 (sources: context-map.md; 2 task(s), 1 decision(s), 0 conflict(s))

## tests/fixtures/handoffs/legacy-1x

- Nodes: 9
- Duplicate-node rate: 0.000
- Preserved-user-edit rate: 1.000
- Orphan content count: 0
- Node/Deno output equality: true
- Idempotent: true
- Byte growth (total): 2949 → 5198 (Δ 2249)

| File | Before | After | Δ |
| --- | ---: | ---: | ---: |
| HANDOFF.md | 1000 | 0 | -1000 |
| tasks.md | 285 | 0 | -285 |
| decisions.md | 199 | 0 | -199 |
| context.json | 1465 | 1810 | 345 |
| context-map.md | 0 | 926 | 926 |
| content/current-goal.md | 0 | 61 | 61 |
| content/current-status.md | 0 | 63 | 63 |
| content/tasks.md | 0 | 232 | 232 |
| content/decisions.md | 0 | 172 | 172 |
| content/open-questions.md | 0 | 17 | 17 |
| content/risks.md | 0 | 60 | 60 |
| content/knowledge-notes.md | 0 | 129 | 129 |
| content/excluded.md | 0 | 11 | 11 |
| views/HANDOFF.md | 0 | 1717 | 1717 |

Diagnostics:
- migrated legacy handoff to v2.0.0 (sources: context.json, HANDOFF.md, tasks.md, decisions.md; 3 task(s), 1 decision(s), 0 conflict(s))
- migrated handoff to v3.0.0 (sources: context.json, HANDOFF.md, tasks.md, decisions.md; 3 task(s), 1 decision(s), 0 conflict(s))

## tests/fixtures/handoffs/migrated

- Nodes: 5
- Duplicate-node rate: 0.000
- Preserved-user-edit rate: 1.000
- Orphan content count: 0
- Node/Deno output equality: true
- Idempotent: true
- Byte growth (total): 1902 → 3563 (Δ 1661)

| File | Before | After | Δ |
| --- | ---: | ---: | ---: |
| context-map.md | 329 | 599 | 270 |
| HANDOFF.md | 622 | 0 | -622 |
| tasks.md | 166 | 0 | -166 |
| decisions.md | 103 | 0 | -103 |
| context.json | 682 | 1626 | 944 |
| content/current-goal.md | 0 | 51 | 51 |
| content/current-status.md | 0 | 58 | 58 |
| content/tasks.md | 0 | 44 | 44 |
| content/decisions.md | 0 | 12 | 12 |
| content/open-questions.md | 0 | 127 | 127 |
| content/risks.md | 0 | 8 | 8 |
| content/knowledge-notes.md | 0 | 22 | 22 |
| content/excluded.md | 0 | 11 | 11 |
| views/HANDOFF.md | 0 | 1005 | 1005 |

Diagnostics:
- migrated handoff to v3.0.0 (sources: context-map.md, context.json; 1 task(s), 0 decision(s), 0 conflict(s))

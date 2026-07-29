# Context Map

<!-- handoff-protocol:v2.0.0 — Human-editable context index. -->

## Current Goal

- Implement the context compiler for focused loads

## Current Status

- Compiler design approved

## Tasks

- [ ] **high** Wire compiler into load entry points
  - [ ] Parse focus and budget flags
- [x] Design the scoring heuristic

## Decisions

- Use keyword overlap scoring
  - Normalization lowercases node text
- Keep deterministic ordering

## Open Questions

- How should overflow be surfaced?

## Risks

- **high** Budget misestimation could truncate critical context
- Cosmetic wording issues in diagnostics

## Knowledge and Notes

- Token estimate uses a CJK-aware formula

## Excluded

- No tokenizer dependencies

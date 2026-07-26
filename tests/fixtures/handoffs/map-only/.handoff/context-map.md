# Context Map

## Current Goal

- Ship the v1.5 context map release

## Current Status

- Map-only handoff, no legacy files present

## Tasks

- [ ] **high** Verify map-only handoffs load without context.json
- [x] Design the context map format

## Decisions

- Map-first loading with legacy fallback

## Open Questions

- How should v3 rank branches?

## Risks

- Loaders older than v1.5 ignore the map

## Knowledge and Notes

- The map alone must be sufficient to resume work

## Excluded

- No vector database in v3

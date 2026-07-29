# Context Map

## Current Goal

- Ship semantic context diff

## Current Status

- Diff core implemented, CLI wiring in progress

## Tasks

- [x] Design snapshot layout <!-- agent -->
- [ ] Implement diff command <!-- agent -->
- [ ] Update user docs

## Decisions

- Compare normalized snapshots, not rendered markdown <!-- agent -->

## Open Questions

## Risks

- Moved nodes could be misread as remove+add
- CLI must never mutate snapshots

## Knowledge and Notes

- Snapshot ids embed a short content digest

## Excluded

- node_modules/

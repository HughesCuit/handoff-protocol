# Context Map

<!-- handoff-protocol:v1.5 — Human-editable context index. Your edits take priority over agent inference. Nodes ending with an agent marker are agent-managed and may be updated on save. -->

## Current Goal

- Ship the v1.5 context map release <!-- agent -->

## Current Status

- Implementation in progress, tests passing <!-- agent -->

## Tasks

- [ ] **high** Add fixture-based tests for both runtimes <!-- agent -->
- [x] Design context map format
- [ ] Write the migration guide

## Decisions

- Shared ESM module keeps Deno and Node behavior identical <!-- agent -->
- Keep the feature inside the existing handoff skill

## Open Questions

- Should v2 drop tasks.md entirely?

## Risks

- Deno may be missing on contributor machines <!-- agent -->
- Map growth may bloat load context

## Knowledge and Notes

- The parser maps localized headings back to fixed section keys <!-- agent -->

## Excluded

- Do not add a graph database

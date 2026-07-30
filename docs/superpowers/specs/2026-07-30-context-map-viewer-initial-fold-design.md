# Context Map Viewer Initial Fold Design

## Problem

Context Map Viewer currently opens with every node expanded at 100% zoom. Real
project maps can contain dozens or hundreds of nodes, so the initial canvas
extends far beyond the available side-browser viewport and is difficult to
navigate.

## Desired Behavior

On the first valid Context Map snapshot for a viewer binding:

1. Keep the root node visible and expanded.
2. Keep every top-level semantic section visible.
3. Fold every top-level semantic section that has children, hiding its
   descendants.
4. Fit the resulting overview to the current viewport.

The initial view therefore presents the map's semantic outline:

```text
Context Map
├── Current Goal
├── Current Status
├── Tasks
├── Decisions
├── Open Questions
├── Risks
├── Knowledge
└── Excluded
```

Users can expand any section by clicking it. Existing Expand, Collapse, Fit,
search, zoom, and pan controls remain unchanged.

## State Rules

- Apply the default fold state only once for each new `bindingId`.
- Do not reapply it on ordinary file refreshes for the same binding.
- Preserve user fold choices, search, zoom, pan, and viewport during same-map
  live refreshes.
- A genuine workspace/binding switch initializes the new map with the default
  folded overview.
- If the initial snapshot is missing, invalid, or empty, defer initialization
  until the first valid tree arrives.
- Search may temporarily reveal folded ancestors as it does today, without
  changing the stored fold choices.

## Shared Presentation

The behavior lives in the shared frontend lifecycle/model and applies equally
to:

- standalone side-browser mode;
- inline MCP App fallback.

No server, protocol, Context Map file format, or persistence changes are
required.

## Testing

Add deterministic frontend tests proving:

- initial valid tree folds every top-level section with children;
- root and semantic sections remain visible;
- the initial viewport is fit after folding;
- same-binding refresh preserves user-modified fold and viewport state;
- a new binding receives a fresh folded overview;
- an invalid or missing first snapshot does not consume initialization.

Manual acceptance uses a representative large Context Map in the Codex side
browser and verifies that the initial screen shows a readable section overview
without requiring an immediate Collapse or Fit action.

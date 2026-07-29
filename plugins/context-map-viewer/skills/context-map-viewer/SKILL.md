---
name: context-map-viewer
description: Open the current Codex workspace's Handoff `.handoff/context-map.md` as a live, read-only mind map. Use when the user asks to open, show, display, visualize, inspect, or refresh the Context Map, mind map, or Handoff map beside the conversation.
---

# Context Map Viewer

Use the Context Map Viewer MCP tools to display the active workspace's map.

## Open the viewer

1. Call `open_context_map` with no arguments.
2. Let the returned MCP App render the map. It requests picture-in-picture when
   the host supports it and otherwise remains inline.
3. Tell the user when the file is missing or invalid using the tool's safe
   status. Do not quote hidden source content from an error.

The widget refreshes itself. Do not repeatedly call the render tool merely to
update an already open viewer.

## Boundaries

- Treat the viewer as read-only.
- Never claim that folding, searching, zooming, or opening the viewer modifies
  Handoff state.
- Do not accept or invent another file path. The tool always reads the active
  workspace's `.handoff/context-map.md`.
- Use the separate Handoff skill when the user wants to save, load, or edit
  project context.

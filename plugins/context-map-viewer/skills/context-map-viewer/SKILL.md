---
name: context-map-viewer
description: Open the current Codex workspace's Handoff `.handoff/context-map.md` as a live, read-only mind map. Use when the user asks to open, show, display, visualize, inspect, or refresh the Context Map, mind map, or Handoff map beside the conversation.
---

# Context Map Viewer

Use the Context Map Viewer MCP tools to display the active workspace's map.

## Open the viewer

1. Call `create_context_map_browser_session` with `workspaceRoot` set to the
   current Codex task's exact absolute `cwd`. Do not ask the user to provide it
   when Codex already supplies it in the task environment.
2. Open the returned `viewerUrl` with the Codex in-app browser tool. Do not
   transform, reconstruct, persist, or reuse `viewerUrl` in another task.
3. If session creation or in-app browser navigation is unavailable, use the
   inline fallback: call `open_context_map` with the same `workspaceRoot` and
   let the returned MCP App render the map. It requests picture-in-picture when
   the host supports it and otherwise remains inline.
4. Tell the user when the file is missing or invalid using the tool's safe
   status. Do not quote hidden source content from an error.

Both views refresh themselves. Do not repeatedly reopen either view merely to
update an already open viewer.

## Boundaries

- Treat the viewer as read-only.
- Never claim that folding, searching, zooming, or opening the viewer modifies
  Handoff state.
- Pass only the active task's exact absolute `cwd` as `workspaceRoot`; never
  accept or invent another path. The tool always appends the fixed
  `.handoff/context-map.md` path.
- Use the separate Handoff skill when the user wants to save, load, or edit
  project context.

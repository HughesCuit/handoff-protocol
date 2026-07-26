# Handoff Protocol Context Map Roadmap

> **For agentic workers:** Implement this roadmap milestone by milestone. Complete and verify v1.5 before beginning v2, and complete v2 before beginning v3.

**Goal:** Evolve Handoff Protocol from a handoff snapshot format into a continuously maintained, editable session-state protocol backed by a Markdown context map.

**Architecture:** Add `.handoff/context-map.md` as a backwards-compatible context index in v1.5, make it the semantic source of truth in v2, and add selective branch loading in v3. Preserve the existing commands, storage modes, security filtering, and 1.x loading compatibility throughout the migration.

**Tech Stack:** Agent Skill Markdown, Markdown trees, TypeScript/Deno, JavaScript/Node.js, Git and Git submodules.

## Global Constraints

- Keep the feature inside the existing `handoff` skill; do not create a separate skill.
- Use a human-editable Markdown tree at `.handoff/context-map.md`.
- Preserve `/handoff save`, `/handoff load`, their modes, and their existing flags.
- Maintain both Deno and Node runtime implementations with equivalent behavior.
- Apply the existing sensitive-data filter before writing or displaying any Context Map content.
- Update the map only on stable state events, not after every conversational turn.
- Do not introduce a graph database, vector database, node IDs, cross-node references, or a dedicated UI in these milestones.

---

## Milestone 1: v1.5 — Backwards-compatible Context Map

### Protocol and skill behavior

- Add `.handoff/context-map.md` with these semantic sections:
  - Current Goal
  - Current Status
  - Tasks
  - Decisions
  - Open Questions
  - Risks
  - Knowledge and Notes
  - Excluded
- Permit localized section labels through an internal mapping to the fixed semantic section keys.
- Require each node to be a concise, independently understandable statement.
- Prefer updating or moving an existing node over appending a semantic duplicate.
- Treat direct user edits as higher priority than agent inference.
- Update the map when a goal or status changes, a task changes lifecycle, a stable decision or conclusion is reached, an open question or risk appears, a solution is explicitly excluded, or the user requests a node edit.
- Exclude greetings, transient speculation, chain-of-thought, secrets, and details with no future value.
- Support user CRUD through direct Markdown editing or natural-language requests; do not add a new slash command.

### Save and load behavior

- Make every `/handoff save` mode and verbosity generate or reconcile `context-map.md`.
- Continue generating `HANDOFF.md`, `context.json`, `tasks.md`, and `decisions.md` according to the existing compatibility rules.
- Make `/handoff load` read the Context Map first and supplement it with machine state from `context.json`.
- Preserve the existing fallback when the map is absent, empty, or malformed.
- Include `context-map.md` in submodule commits and pushes.
- Align all package, configuration, template, generated-output, documentation, and runtime version markers with the v1.5 release.

### Implementation areas

- Update `SKILL.md`, `README.md`, and `references/save.md` / `references/load.md`.
- Add a Context Map template under `assets/` and matching save/load examples.
- Add equivalent Context Map parsing, reconciliation, rendering, sanitization, and fallback behavior to both runtime implementations.
- Introduce fixture-based automated tests instead of relying only on manual examples.

### Acceptance tests

- A new save produces all expected sections in `context-map.md`.
- Low, medium, and high verbosity always preserve the Context Map.
- Repeated saves are idempotent and do not duplicate semantic nodes.
- A user-edited node is not overwritten by lower-priority inference.
- Old four-file handoffs still load without migration.
- Map-only and mixed-format handoffs load successfully.
- Direct and submodule storage both include the new file.
- Deno and Node produce equivalent results for shared fixtures.
- Secrets and credential-like values are filtered from map output.

## Milestone 2: v2 — Context Map as semantic source of truth

### State model

- Make `context-map.md` the only writable source for semantic state.
- Generate `HANDOFF.md`, `tasks.md`, and `decisions.md` as compatibility views from the map.
- Restrict `context.json` to protocol metadata, Git/environment state, timestamps, and any minimal structural index required by loaders.
- Mark generated Markdown views so users know to edit the Context Map instead.

### Migration and compatibility

- When loading a 1.x handoff without a Context Map, merge the legacy files into a new map.
- Apply this precedence:
  1. Explicit current user instructions and direct map edits.
  2. Structured legacy `context.json` values.
  3. Human-readable legacy files.
  4. Repository or agent inference.
- Preserve both conflicting values and report the conflict when a safe automatic resolution is unavailable.
- Never silently discard tasks, decisions, risks, open questions, or exclusion history.
- Continue reading 1.x handoffs and preserve all existing command-line interfaces.
- Upgrade the protocol/configuration version only after migration succeeds.

### Acceptance tests

- Legacy fixtures migrate without losing task status or decision rationale.
- Conflicts produce deterministic, visible diagnostics.
- Compatibility views are reproducibly generated from one map.
- Editing a generated view does not silently override the canonical map.
- Repeated migration and save operations are idempotent.
- Failed migration leaves the original handoff readable and unchanged.

## Milestone 3: v3 — Selective context compilation

### Loading policy

- Always load Current Goal, Current Status, active Tasks, and high-severity Risks.
- Select additional Decisions, Open Questions, Knowledge, and Excluded branches by matching the current task against heading paths and node text.
- Make `full` mode load the entire map.
- Fall back to the entire map when relevance cannot be established reliably.
- Report the loaded section paths and the number of omitted nodes.
- Do not introduce embeddings or external retrieval services in v3.

### Evaluation and acceptance

- Compare full conversation history, legacy handoff summaries, full Context Maps, and selective Context Maps.
- Measure input tokens, fact recall, stale-conflict rate, task-continuation accuracy, duplicate-node growth, and correct-node update rate.
- Verify core sections are never omitted.
- Verify task-relevant branches are included for representative fixtures.
- Verify unmatched tasks safely fall back to the full map.
- Verify `full` preserves the complete Context Map.

## Delivery Sequence

1. Implement and release v1.5 with fixtures and runtime parity.
2. Validate real-project map readability, duplicate rate, growth rate, and manual edit behavior.
3. Implement v2 only after the v1.5 map structure is stable.
4. Run legacy migration tests before changing the canonical state model.
5. Implement v3 only after v2 establishes a reliable source of truth.
6. Document evaluation results and any protocol compatibility exceptions at each release.

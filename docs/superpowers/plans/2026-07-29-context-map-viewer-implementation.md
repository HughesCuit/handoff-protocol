# Context Map Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Codex plugin that opens the active workspace's `.handoff/context-map.md` in a live, searchable, foldable SVG mind map.

**Architecture:** A bundled Node MCP server discovers the active workspace through MCP roots, validates the fixed Context Map path, parses it into a stable render DTO, and maintains a debounced filesystem watcher. An MCP Apps widget opens from a render tool, requests picture-in-picture presentation when supported, and polls a headless snapshot tool for watcher-produced versions while preserving ephemeral view state.

**Tech Stack:** Node.js 18+, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, Zod, esbuild, vanilla JavaScript, SVG, Node's built-in test runner.

## Global Constraints

- The plugin lives at `plugins/context-map-viewer/` and is independently versioned from Handoff Protocol.
- `.handoff/context-map.md` remains the only semantic source of truth.
- All plugin tools are read-only and may resolve only `<active-workspace>/.handoff/context-map.md`.
- The source limit is 2 MiB and the parsed-node limit is 2,000.
- No database, remote service, persistent search index, editing, export, arbitrary-file picker, Canvas, or Dataview support.
- Normal local changes must enter refresh processing within 500 ms.
- New UI uses the MCP Apps bridge and `_meta.ui.resourceUri`; OpenAI compatibility aliases may be included only as fallbacks.
- Tests are written before production code, and each task ends in a focused commit.

---

## File Structure

```text
.agents/plugins/marketplace.json
plugins/context-map-viewer/
  .codex-plugin/plugin.json
  .mcp.json
  README.md
  package.json
  package-lock.json
  scripts/build.mjs
  server/constants.mjs
  server/context-map-parser.mjs
  server/context-source.mjs
  server/context-store.mjs
  server/server.mjs
  web/app.mjs
  web/index.html
  web/styles.css
  tests/context-map-parser.test.mjs
  tests/context-source.test.mjs
  tests/context-store.test.mjs
  tests/server.test.mjs
  tests/web-model.test.mjs
  skills/context-map-viewer/SKILL.md
  dist/server.bundle.mjs
  dist/widget.html
```

`dist/` is committed because Codex loads a local marketplace plugin without
running package lifecycle scripts.

### Task 1: Plugin scaffold and reproducible build

**Files:**
- Create: `plugins/context-map-viewer/.codex-plugin/plugin.json`
- Create: `plugins/context-map-viewer/.mcp.json`
- Create: `plugins/context-map-viewer/package.json`
- Create: `plugins/context-map-viewer/scripts/build.mjs`
- Create: `plugins/context-map-viewer/web/index.html`
- Create: `plugins/context-map-viewer/web/styles.css`
- Create: `plugins/context-map-viewer/web/app.mjs`
- Create: `.agents/plugins/marketplace.json`

**Interfaces:**
- Produces: `npm run build`, which writes `dist/widget.html` and `dist/server.bundle.mjs`.
- Produces: MCP server command `node ./dist/server.bundle.mjs` with plugin-root `cwd`.

- [ ] **Step 1: Scaffold the repo plugin and marketplace entry**

Run from the plugin-creator skill directory:

```bash
python3 scripts/create_basic_plugin.py context-map-viewer \
  --path /Users/huanghe/Projects/handoff-protocol/plugins \
  --marketplace-path /Users/huanghe/Projects/handoff-protocol/.agents/plugins/marketplace.json \
  --with-skills --with-mcp --with-marketplace
```

Expected: manifest name and folder are `context-map-viewer`, and the repo
marketplace contains an `AVAILABLE`, `ON_INSTALL`, `Productivity` entry.

- [ ] **Step 2: Add the build-contract test**

Create `tests/server.test.mjs` with assertions that the manifest points to
`./.mcp.json`, `.mcp.json` launches `node ./dist/server.bundle.mjs` from `.`,
and the built widget contains `text/html;profile=mcp-app` bridge code.

- [ ] **Step 3: Run the test and confirm it fails**

Run:

```bash
node --test tests/server.test.mjs
```

Expected: FAIL because package metadata and build output are incomplete.

- [ ] **Step 4: Add package dependencies and deterministic build**

Use `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, and `zod` as
runtime dependencies and `esbuild` as a dev dependency. `scripts/build.mjs`
must:

1. bundle `server/server.mjs` to `dist/server.bundle.mjs`;
2. bundle `web/app.mjs` as an IIFE;
3. inline the bundled JavaScript and `web/styles.css` into `web/index.html`;
4. write a self-contained `dist/widget.html`.

- [ ] **Step 5: Build and rerun the test**

Run:

```bash
npm install
npm run build
node --test tests/server.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .agents/plugins/marketplace.json plugins/context-map-viewer
git commit -m "feat(viewer): scaffold Codex context map plugin"
```

### Task 2: Handoff-compatible parser and stable render DTO

**Files:**
- Create: `plugins/context-map-viewer/server/constants.mjs`
- Create: `plugins/context-map-viewer/server/context-map-parser.mjs`
- Create: `plugins/context-map-viewer/tests/context-map-parser.test.mjs`

**Interfaces:**
- Produces: `parseRenderTree(markdown: string): RenderSnapshotData`.
- Produces: `RenderNode = { id, section, text, taskState, risk, excluded, origin, children }`.
- Produces: error codes `EMPTY`, `INVALID`, and `TOO_MANY_NODES`.

- [ ] **Step 1: Write parser tests**

Cover:

- English and localized semantic headings from the core parser;
- nested unordered lists and task checkboxes;
- original section and child ordering;
- agent markers excluded from display text but mapped to `origin`;
- stable IDs across identical parses;
- deterministic occurrence suffixes for duplicate sibling text;
- rejection after 2,000 nodes;
- malformed or semantically empty content.

Use real Context Map strings rather than mocking the parser.

- [ ] **Step 2: Run the parser tests and confirm failure**

```bash
node --test tests/context-map-parser.test.mjs
```

Expected: FAIL because `parseRenderTree` does not exist.

- [ ] **Step 3: Implement the minimal parser**

Reuse the semantic labels and normalization rules from
`scripts/context-map.mjs`, but keep the installed plugin self-contained.
Generate IDs with SHA-256 over section, ancestor IDs, normalized display text,
and sibling occurrence. Return a synthetic root containing ordered semantic
section nodes.

- [ ] **Step 4: Run parser and core tests**

```bash
node --test tests/context-map-parser.test.mjs
npm test --prefix ../..
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/context-map-viewer/server plugins/context-map-viewer/tests
git commit -m "feat(viewer): parse Context Map into stable render tree"
```

### Task 3: Secure source resolution and live store

**Files:**
- Create: `plugins/context-map-viewer/server/context-source.mjs`
- Create: `plugins/context-map-viewer/server/context-store.mjs`
- Create: `plugins/context-map-viewer/tests/context-source.test.mjs`
- Create: `plugins/context-map-viewer/tests/context-store.test.mjs`

**Interfaces:**
- Produces: `resolveContextMap(rootUri, fsApi): Promise<ResolvedSource>`.
- Produces: `ContextMapStore.bind(rootUri): Promise<void>`.
- Produces: `ContextMapStore.snapshot(): RenderSnapshot`.
- Produces: `ContextMapStore.close(): Promise<void>`.
- `RenderSnapshot.status` is one of `synced`, `refreshing`, `missing`, `empty`, `invalid`, `too_large`, `too_many_nodes`, `access_denied`, or `watcher_unavailable`.

- [ ] **Step 1: Write source security tests**

Use temporary directories to cover:

- the fixed `.handoff/context-map.md` path;
- missing file;
- 2 MiB boundary and over-limit rejection;
- symlink to a file outside the workspace;
- a workspace URI with spaces and Unicode;
- safe relative diagnostics without source body content.

- [ ] **Step 2: Write store lifecycle tests**

Use a real temporary file and fake clock where needed to cover:

- create, modify, atomic rename, and delete;
- burst debouncing at no more than 150 ms;
- last-valid-snapshot retention after invalid content;
- version unchanged for unchanged content;
- old watcher disposal before workspace switch;
- watcher failure with stat-based refresh fallback.

- [ ] **Step 3: Run tests and confirm failure**

```bash
node --test tests/context-source.test.mjs tests/context-store.test.mjs
```

Expected: FAIL because source and store modules do not exist.

- [ ] **Step 4: Implement secure resolution and store**

Resolve MCP `file://` roots, compare real paths against the real workspace
root, and never accept a filename from tool input. Use `fs.watch` with a
150 ms debounce. Keep a content digest and the last valid parsed tree. Expose
`refresh()` so polling can verify state when watch delivery is unavailable.

- [ ] **Step 5: Run focused and core tests**

```bash
node --test tests/context-source.test.mjs tests/context-store.test.mjs
npm test --prefix ../..
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/context-map-viewer/server plugins/context-map-viewer/tests
git commit -m "feat(viewer): watch active workspace Context Map safely"
```

### Task 4: MCP tools and UI resource

**Files:**
- Create: `plugins/context-map-viewer/server/server.mjs`
- Modify: `plugins/context-map-viewer/tests/server.test.mjs`

**Interfaces:**
- Produces tool: `open_context_map(): RenderSnapshot`, linked to `ui://context-map/viewer.html`.
- Produces tool: `get_context_map(): RenderSnapshot`, without a UI resource.
- Consumes MCP client roots through `server.server.listRoots()`.

- [ ] **Step 1: Write MCP contract tests**

Test the server factory with injected root and store providers. Assert:

- `open_context_map` and `get_context_map` are read-only;
- both reject zero roots and multiple ambiguous roots with actionable codes;
- `open_context_map` declares `_meta.ui.resourceUri`;
- `get_context_map` has no resource URI;
- results include `structuredContent` and a short model-readable summary;
- the resource uses `text/html;profile=mcp-app`;
- no tool accepts a filesystem path argument.

- [ ] **Step 2: Run the test and confirm failure**

```bash
node --test tests/server.test.mjs
```

Expected: FAIL because the MCP server factory is absent.

- [ ] **Step 3: Implement the MCP server**

Use `registerAppResource` and `registerAppTool`. On each tool call:

1. request roots from the MCP client;
2. bind or refresh the store for the single active root;
3. return the latest structured snapshot.

Connect a `StdioServerTransport` in the executable entry point. Keep the
factory exportable without starting stdio so tests can inspect it.

- [ ] **Step 4: Build and run tests**

```bash
npm run build
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/context-map-viewer/server plugins/context-map-viewer/tests plugins/context-map-viewer/dist
git commit -m "feat(viewer): expose Context Map MCP App tools"
```

### Task 5: Pure-canvas SVG widget

**Files:**
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Modify: `plugins/context-map-viewer/web/index.html`
- Modify: `plugins/context-map-viewer/web/styles.css`
- Create: `plugins/context-map-viewer/tests/web-model.test.mjs`

**Interfaces:**
- Consumes: `RenderSnapshot` from `ui/notifications/tool-result` and `tools/call`.
- Produces pure functions `buildVisibleTree`, `layoutTree`, `matchSearch`, and `reconcileFoldState` for unit tests.

- [ ] **Step 1: Write widget-model tests**

Cover:

- visible layout excludes folded descendants;
- collapse-all retains root and first-level sections;
- search matches node text plus ancestor path;
- search temporarily reveals matching ancestors;
- stable fold state survives a refreshed snapshot;
- changed IDs fall back to expanded;
- horizontal layout order is deterministic.

- [ ] **Step 2: Run tests and confirm failure**

```bash
node --test tests/web-model.test.mjs
```

Expected: FAIL because pure widget functions are absent.

- [ ] **Step 3: Implement pure tree state and layout**

Use deterministic node widths, vertical subtree heights, cubic SVG links, and
section-aware node classes. Export pure functions before wiring DOM behavior.

- [ ] **Step 4: Implement the MCP Apps bridge and canvas controls**

The widget must:

- initialize from `ui/notifications/tool-result`;
- call `get_context_map` every 750 ms while visible;
- request `picture-in-picture` presentation when supported;
- preserve zoom, viewport, query, and stable fold state;
- support drag pan, wheel zoom, toolbar zoom, fit, expand-all, collapse-all,
  and node-click fold;
- show synchronized, refreshing, missing, empty, and parse-error states;
- keep the last valid map visible when a refresh fails;
- stop polling when the document is hidden and resume with an immediate refresh.

- [ ] **Step 5: Build and test**

```bash
npm run build
npm test
```

Expected: PASS and `dist/widget.html` is self-contained.

- [ ] **Step 6: Commit**

```bash
git add plugins/context-map-viewer/web plugins/context-map-viewer/tests plugins/context-map-viewer/dist
git commit -m "feat(viewer): add live SVG Context Map canvas"
```

### Task 6: Skill, documentation, validation, and local install

**Files:**
- Create: `plugins/context-map-viewer/skills/context-map-viewer/SKILL.md`
- Create: `plugins/context-map-viewer/README.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces the user workflow: ask to open/show the Context Map, then call `open_context_map`.

- [ ] **Step 1: Write the plugin skill**

The skill must tell the agent to call `open_context_map` only when the user
asks to open, show, visualize, or refresh the Context Map. It must state that
the plugin is read-only and must not imply that rendering updates Handoff
state.

- [ ] **Step 2: Document installation and behavior**

Document:

- repo marketplace installation;
- opening the viewer from a new Codex task;
- picture-in-picture capability fallback to inline UI;
- missing-file guidance;
- limits and privacy boundary;
- development build and test commands.

Add `plugins/context-map-viewer` to the root npm package files so published
Handoff packages retain the official companion plugin source.

- [ ] **Step 3: Validate all artifacts**

Run:

```bash
npm test
npm run build --prefix plugins/context-map-viewer
npm test --prefix plugins/context-map-viewer
python3 /Users/huanghe/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/context-map-viewer
python3 /Users/huanghe/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/context-map-viewer/skills/context-map-viewer
npm pack --dry-run --cache /private/tmp/context-map-viewer-npm-cache
git diff --check
```

Expected: every command passes, the root package contains the plugin, and no
temporary or source-map artifact is included unintentionally.

- [ ] **Step 4: Install from the repo marketplace**

Add the repo marketplace if it is not configured, then install:

```bash
codex plugin marketplace add /Users/huanghe/Projects/handoff-protocol
codex plugin add context-map-viewer@handoff-protocol
```

If the generated marketplace has a different top-level name, read that exact
name and use it instead.

- [ ] **Step 5: Smoke test in Codex**

Start a new task in this repository, ask “打开 Context Map”, and verify:

- the render tool opens the widget;
- picture-in-picture is requested when available;
- editing `.handoff/context-map.md` refreshes the map;
- search, fold, pan, zoom, and fit work;
- deleting the file shows the missing state without exposing another project.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json .agents/plugins/marketplace.json plugins/context-map-viewer
git commit -m "docs(viewer): package and document Context Map Viewer"
```

### Task 7: Final verification

**Files:**
- Modify only files required by verification findings.

- [ ] **Step 1: Run the complete verification matrix**

```bash
npm test
npm run build --prefix plugins/context-map-viewer
npm test --prefix plugins/context-map-viewer
python3 /Users/huanghe/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/context-map-viewer
python3 /Users/huanghe/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/context-map-viewer/skills/context-map-viewer
npm pack --dry-run --cache /private/tmp/context-map-viewer-final-npm-cache
git diff --check
git status --short
```

- [ ] **Step 2: Inspect the built plugin**

Confirm:

- `dist/server.bundle.mjs` has no runtime package dependency;
- `dist/widget.html` has no external network dependency;
- no arbitrary path input exists in MCP tool schemas;
- tool annotations are read-only;
- no Context Map body is logged;
- marketplace and manifest names match.

- [ ] **Step 3: Commit verification fixes if needed**

Use a focused fix commit only when Step 1 or Step 2 exposes a defect.

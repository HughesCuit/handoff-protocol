# Context Map Viewer Side-Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure standalone localhost mode that opens Context Map Viewer in Codex's side browser by default while retaining the inline MCP App fallback.

**Architecture:** The MCP process lazily owns a loopback-only HTTP server and an in-memory session manager. Each opaque session token is permanently bound to one validated workspace and `ContextMapStore`; the shared frontend selects either the existing MCP bridge transport or a same-origin HTTP polling transport.

**Tech Stack:** Node.js 18+ ESM, MCP SDK and MCP Apps extension, Zod, built-in `node:http` and `node:crypto`, esbuild, SVG, Node test runner.

## Global Constraints

- `.handoff/context-map.md` remains the only semantic source of truth.
- The feature is read-only and must not expose arbitrary files, directories, raw Markdown, absolute paths, or environment values.
- The listener binds only to literal IPv4 loopback `127.0.0.1` on an operating-system-assigned port.
- Session tokens contain at least 128 bits of cryptographically secure randomness.
- Keep at most eight live sessions and expire a session after 30 minutes without an HTTP request.
- Only token-scoped `GET` routes are supported; mutation methods return `405`.
- Existing `open_context_map` and `get_context_map` behavior remains compatible.
- Codex prefers the side browser; hosts without browser navigation fall back to the inline MCP App.
- No daemon, separate CLI, LAN access, remote authentication, database, or new runtime dependency.

## File Structure

- Create `plugins/context-map-viewer/server/browser-session-manager.mjs`: token generation, immutable workspace binding, expiry, LRU eviction, and store disposal.
- Create `plugins/context-map-viewer/server/loopback-viewer-server.mjs`: loopback listener, token-scoped routing, security headers, and safe shutdown.
- Create `plugins/context-map-viewer/web/transports.mjs`: MCP bridge and standalone HTTP snapshot transports behind one interface.
- Create `plugins/context-map-viewer/web/standalone.html`: standalone browser shell with an explicit HTTP transport marker.
- Modify `plugins/context-map-viewer/server/server.mjs`: register the browser-session MCP tool and connect MCP shutdown to loopback shutdown.
- Modify `plugins/context-map-viewer/web/app.mjs`: consume the transport abstraction instead of directly calling `window.parent`.
- Modify `plugins/context-map-viewer/web/index.html`: mark the inline page as MCP transport.
- Modify `plugins/context-map-viewer/scripts/build.mjs`: emit inline widget plus self-contained standalone browser assets.
- Modify `plugins/context-map-viewer/skills/context-map-viewer/SKILL.md`: prefer browser sessions and document inline fallback.
- Modify `plugins/context-map-viewer/README.md`: document both presentation modes and the localhost security model.
- Create `plugins/context-map-viewer/tests/browser-session-manager.test.mjs`.
- Create `plugins/context-map-viewer/tests/loopback-viewer-server.test.mjs`.
- Create `plugins/context-map-viewer/tests/transports.test.mjs`.
- Modify `plugins/context-map-viewer/tests/server.test.mjs` and `plugins/context-map-viewer/tests/web-model.test.mjs`.

---

### Task 1: Browser Session Lifecycle

**Files:**
- Create: `plugins/context-map-viewer/server/browser-session-manager.mjs`
- Create: `plugins/context-map-viewer/tests/browser-session-manager.test.mjs`

**Interfaces:**
- Consumes: `ContextMapStore` with `bind(rootUri)`, `snapshot()`, `refresh()`, and `close()`.
- Produces:
  - `BrowserSessionManager` constructor options `{ createStore?, randomBytes?, now?, idleTtlMs?, maxSessions? }`.
  - `create(workspaceRoot: string): Promise<{ token: string, sessionId: string, source: string }>`
  - `touch(token: string): Promise<{ token: string, sessionId: string, store: ContextMapStore, lastAccess: number } | null>`
  - `snapshot(token: string): Promise<object | null>`
  - `close(): Promise<void>`

- [ ] **Step 1: Write failing creation and immutable-binding tests**

```js
test("creates an opaque session permanently bound to one workspace", async () => {
  const calls = [];
  const stores = [];
  const manager = new BrowserSessionManager({
    randomBytes: () => Buffer.alloc(24, 7),
    createStore: () => {
      const store = fakeStore(calls);
      stores.push(store);
      return store;
    },
  });

  const created = await manager.create("/workspace/alpha");
  assert.match(created.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(created.source, ".handoff/context-map.md");
  assert.deepEqual(calls, [["bind", "file:///workspace/alpha"]]);
  assert.equal((await manager.touch(created.token)).store, stores[0]);
  assert.equal((await manager.touch(created.token)).workspaceRoot, undefined);
});

test("rejects a relative workspace before retaining a session", async () => {
  const manager = new BrowserSessionManager();
  await assert.rejects(() => manager.create("../alpha"), /absolute workspace/i);
  assert.equal(manager.size, 0);
});
```

- [ ] **Step 2: Run the creation tests and verify failure**

Run: `cd plugins/context-map-viewer && node --test tests/browser-session-manager.test.mjs --test-name-pattern="creates|relative"`

Expected: FAIL because `browser-session-manager.mjs` does not exist.

- [ ] **Step 3: Implement secure creation and lookup**

```js
export class BrowserSessionManager {
  constructor(options = {}) {
    this.createStore = options.createStore ?? (() => new ContextMapStore());
    this.randomBytes = options.randomBytes ?? randomBytes;
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 8;
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  async create(workspaceRoot) {
    if (!isAbsolute(workspaceRoot)) {
      throw new TypeError("An absolute workspace root is required.");
    }
    await this.prune();
    await this.evictForCapacity();
    let token;
    do {
      token = this.randomBytes(24).toString("base64url");
    } while (this.sessions.has(token));
    const store = this.createStore();
    try {
      await store.bind(pathToFileURL(resolve(workspaceRoot)).href);
    } catch (error) {
      await store.close();
      throw error;
    }
    const session = {
      token,
      sessionId: createHash("sha256").update(token).digest("hex").slice(0, 16),
      store,
      lastAccess: this.now(),
    };
    this.sessions.set(token, session);
    return {
      token,
      sessionId: session.sessionId,
      source: CONTEXT_MAP_RELATIVE_PATH,
    };
  }

  async touch(token) {
    await this.prune();
    const session = this.sessions.get(token);
    if (!session) return null;
    session.lastAccess = this.now();
    return session;
  }
}
```

- [ ] **Step 4: Add failing expiry, LRU, snapshot, and disposal tests**

```js
test("expires idle sessions and closes their stores", async () => {
  let now = 1_000;
  const closed = [];
  const manager = new BrowserSessionManager({
    now: () => now,
    idleTtlMs: 100,
    createStore: () => fakeStore([], closed),
  });
  const { token } = await manager.create("/workspace/alpha");
  now = 1_101;
  assert.equal(await manager.snapshot(token), null);
  assert.equal(closed.length, 1);
});

test("evicts the least recently accessed session at the cap", async () => {
  let now = 1;
  const manager = deterministicManager({ now: () => now, maxSessions: 2 });
  const first = await manager.create("/workspace/one");
  now = 2;
  const second = await manager.create("/workspace/two");
  now = 3;
  await manager.touch(first.token);
  now = 4;
  await manager.create("/workspace/three");
  assert.ok(await manager.touch(first.token));
  assert.equal(await manager.touch(second.token), null);
});
```

- [ ] **Step 5: Implement expiry, LRU eviction, safe snapshot, and close**

```js
async snapshot(token) {
  const session = await this.touch(token);
  if (!session) return null;
  await session.store.refresh();
  return {
    ...session.store.snapshot(),
    source: CONTEXT_MAP_RELATIVE_PATH,
  };
}

async remove(token) {
  const session = this.sessions.get(token);
  if (!session) return;
  this.sessions.delete(token);
  await session.store.close();
}

async close() {
  await Promise.all([...this.sessions.keys()].map((token) => this.remove(token)));
}
```

Implement `prune()` by removing every session whose idle duration is at least
`idleTtlMs`; implement `evictForCapacity()` by sorting live sessions by
`lastAccess`, then `sessionId`, and removing the first until
`size < maxSessions`.

- [ ] **Step 6: Run session-manager tests**

Run: `cd plugins/context-map-viewer && node --test tests/browser-session-manager.test.mjs`

Expected: PASS with creation, validation, expiry, LRU, snapshot, and close covered.

- [ ] **Step 7: Commit**

```bash
git add plugins/context-map-viewer/server/browser-session-manager.mjs plugins/context-map-viewer/tests/browser-session-manager.test.mjs
git commit -m "feat(viewer): add browser session lifecycle"
```

---

### Task 2: Secure Loopback HTTP Server

**Files:**
- Create: `plugins/context-map-viewer/server/loopback-viewer-server.mjs`
- Create: `plugins/context-map-viewer/tests/loopback-viewer-server.test.mjs`

**Interfaces:**
- Consumes: `BrowserSessionManager.create(workspaceRoot)`, `snapshot(token)`, and `close()`, plus assets `{ html, app, model, styles }`.
- Produces:
  - `LoopbackViewerServer` constructor options `{ sessionManager, assets, createServer? }`.
  - `start(): Promise<{ host: "127.0.0.1", port: number }>`
  - `createSession(workspaceRoot: string): Promise<{ viewerUrl: string, sessionId: string, source: string }>`
  - `close(): Promise<void>`

- [ ] **Step 1: Write failing listener and valid-route tests**

```js
test("binds to loopback and serves only token-scoped viewer content", async () => {
  const manager = fakeSessionManager();
  const viewer = new LoopbackViewerServer({
    sessionManager: manager,
    assets: {
      html: "<!doctype html><main>viewer</main>",
      app: "globalThis.viewer=true",
      model: "export const model=true",
      styles: "body{color:black}",
    },
  });
  const session = await viewer.createSession("/workspace/alpha");
  const address = viewer.address();
  assert.equal(address.host, "127.0.0.1");
  assert.match(session.viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/session\/[^/]+\/$/);

  const page = await fetch(session.viewerUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /viewer/);
  assert.equal(page.headers.get("cache-control"), "no-store");
});
```

- [ ] **Step 2: Run the listener test and verify failure**

Run: `cd plugins/context-map-viewer && node --test tests/loopback-viewer-server.test.mjs --test-name-pattern="binds"`

Expected: FAIL because `loopback-viewer-server.mjs` does not exist.

- [ ] **Step 3: Implement lazy loopback startup and exact route parsing**

```js
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

async start() {
  if (this.httpServer?.listening) return this.address();
  this.httpServer = this.createServer((request, response) =>
    this.handle(request, response).catch(() => safe500(response)));
  await listen(this.httpServer, { host: "127.0.0.1", port: 0 });
  return this.address();
}

async createSession(workspaceRoot) {
  const { port } = await this.start();
  const created = await this.sessionManager.create(workspaceRoot);
  return {
    viewerUrl: `http://127.0.0.1:${port}/session/${created.token}/`,
    sessionId: created.sessionId,
    source: created.source,
  };
}
```

Use `new URL(request.url, "http://127.0.0.1")`, decode no path components, and
accept only the exact regex
`^/session/([A-Za-z0-9_-]{22,})/(|app\\.mjs|model\\.mjs|styles\\.css|api/context-map)$`.
Before serving any route, call `await sessionManager.touch(token)`; return `404` when
absent.

- [ ] **Step 4: Write failing security, API, expiry, and shutdown tests**

```js
test("rejects invalid tokens, paths, and non-GET methods without disclosure", async () => {
  const { viewer, session } = await startedViewer();
  for (const suffix of ["../secret", "%2e%2e/secret", "api/context-map?file=x"]) {
    const response = await fetch(new URL(suffix, session.viewerUrl), { redirect: "manual" });
    assert.ok([400, 404].includes(response.status));
  }
  const post = await fetch(session.viewerUrl, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("serves safe snapshots and closes the listener and stores", async () => {
  const { viewer, session, manager } = await startedViewer();
  const response = await fetch(new URL("api/context-map", session.viewerUrl));
  assert.deepEqual(await response.json(), manager.expectedSnapshot);
  await viewer.close();
  assert.equal(manager.closed, true);
  await assert.rejects(() => fetch(session.viewerUrl));
});
```

- [ ] **Step 5: Implement route responses and safe shutdown**

Return exact content types:

```js
const ASSET_TYPES = {
  "": "text/html; charset=utf-8",
  "app.mjs": "text/javascript; charset=utf-8",
  "model.mjs": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};
```

For `api/context-map`, call `sessionManager.snapshot(token)` and serialize only
that returned DTO as JSON. Return `404` if it expires during the call. `close()`
must stop accepting connections, close idle/all sockets using the Node HTTP
server APIs available on Node 18+, await server closure, then await
`sessionManager.close()`.

- [ ] **Step 6: Run HTTP tests**

Run: `cd plugins/context-map-viewer && node --test tests/loopback-viewer-server.test.mjs`

Expected: PASS with route allowlisting, headers, API, expiry, and shutdown covered.

- [ ] **Step 7: Commit**

```bash
git add plugins/context-map-viewer/server/loopback-viewer-server.mjs plugins/context-map-viewer/tests/loopback-viewer-server.test.mjs
git commit -m "feat(viewer): serve token-scoped loopback sessions"
```

---

### Task 3: Shared MCP and HTTP Frontend Transports

**Files:**
- Create: `plugins/context-map-viewer/web/transports.mjs`
- Create: `plugins/context-map-viewer/web/standalone.html`
- Create: `plugins/context-map-viewer/tests/transports.test.mjs`
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Modify: `plugins/context-map-viewer/web/index.html`
- Modify: `plugins/context-map-viewer/tests/web-model.test.mjs`

**Interfaces:**
- Produces:
  - `createMcpTransport({ parentWindow, windowObject }): { initialSnapshot(), refresh(bindingId), dispose() }`
  - `createHttpTransport({ fetch, location, intervalMs? }): { initialSnapshot(), refresh(), dispose() }`
  - `createPageTransport(document, dependencies): transport`
- Consumes: Snapshot DTOs with `status`, `version`, `tree`, `nodeCount`, `diagnostic`, `bindingId`, and `source`.

- [ ] **Step 1: Write failing transport contract tests**

```js
test("HTTP transport reads only the same-origin session API", async () => {
  const calls = [];
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async (url, options) => {
      calls.push([String(url), options]);
      return new Response(JSON.stringify({ status: "synced", version: "v1" }));
    },
  });
  assert.deepEqual(await transport.initialSnapshot(), {
    status: "synced",
    version: "v1",
  });
  assert.equal(calls[0][0], "http://127.0.0.1:4312/session/token/api/context-map");
  assert.equal(calls[0][1].cache, "no-store");
});

test("HTTP transport reports an expired session without changing endpoint", async () => {
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async () => new Response("", { status: 404 }),
  });
  await assert.rejects(() => transport.refresh(), /SESSION_EXPIRED/);
});
```

- [ ] **Step 2: Run transport tests and verify failure**

Run: `cd plugins/context-map-viewer && node --test tests/transports.test.mjs`

Expected: FAIL because `transports.mjs` does not exist.

- [ ] **Step 3: Extract the MCP bridge and implement HTTP transport**

```js
export function createHttpTransport(options) {
  const endpoint = new URL("api/context-map", options.location);
  async function read() {
    const response = await options.fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (response.status === 404) throw new Error("SESSION_EXPIRED");
    if (!response.ok) throw new Error(`HTTP_SNAPSHOT_${response.status}`);
    return response.json();
  }
  return {
    initialSnapshot: read,
    refresh: read,
    dispose() {},
  };
}
```

Move the current JSON-RPC request ID, pending-map, `postMessage`, tool-result
unwrapping, and message listener from `app.mjs` into `createMcpTransport`.
`createPageTransport` reads:

```html
<meta name="context-map-viewer-transport" content="mcp">
```

or:

```html
<meta name="context-map-viewer-transport" content="http">
```

Only the exact values `mcp` and `http` are accepted; there is no injectable
endpoint value.

- [ ] **Step 4: Adapt the app to the shared transport**

Replace direct bridge calls with:

```js
const transport = createPageTransport(document, {
  parentWindow: window.parent,
  windowObject: window,
  fetch: window.fetch.bind(window),
  location: window.location,
});

async function refresh() {
  if (document.hidden) return;
  setStatus("refreshing");
  try {
    applySnapshot(await transport.refresh(snapshot?.bindingId));
  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      showTerminalEmptyState("This Viewer session expired. Reopen Context Map Viewer.");
      return;
    }
    setStatus(snapshot?.status ?? "invalid");
  }
}
```

At startup call `transport.initialSnapshot()`. Preserve the MCP
`ui/notifications/tool-result` behavior inside the MCP transport and preserve
picture-in-picture requests only in MCP mode. Register
`pagehide => transport.dispose()`.

- [ ] **Step 5: Add the standalone shell and mode markers**

`standalone.html` must link only same-origin assets:

```html
<meta name="context-map-viewer-transport" content="http">
<link rel="stylesheet" href="./styles.css">
<script type="module" src="./app.mjs"></script>
```

Add the corresponding `content="mcp"` marker to `index.html`. The toolbar,
canvas, SVG layers, empty state, and accessible labels must remain structurally
identical between both shells.

- [ ] **Step 6: Run frontend tests**

Run: `cd plugins/context-map-viewer && node --test tests/transports.test.mjs tests/web-model.test.mjs`

Expected: PASS, including MCP result unwrapping, HTTP same-origin fetching,
expired-session handling, and unchanged renderer model behavior.

- [ ] **Step 7: Commit**

```bash
git add plugins/context-map-viewer/web plugins/context-map-viewer/tests/transports.test.mjs plugins/context-map-viewer/tests/web-model.test.mjs
git commit -m "feat(viewer): share frontend across inline and browser modes"
```

---

### Task 4: MCP Browser-Session Tool and Packaged Assets

**Files:**
- Modify: `plugins/context-map-viewer/server/server.mjs`
- Modify: `plugins/context-map-viewer/scripts/build.mjs`
- Modify: `plugins/context-map-viewer/tests/server.test.mjs`
- Modify: `plugins/context-map-viewer/package.json`

**Interfaces:**
- Consumes: `LoopbackViewerServer.createSession(workspaceRoot)` and built assets `{ html, app, model, styles }`.
- Produces MCP tool:
  - `create_context_map_browser_session({ workspaceRoot: string })`
  - Result `{ status, viewerUrl, sessionId, source, fallback }`.

- [ ] **Step 1: Write failing MCP registration and handler tests**

```js
test("registers a read-only browser session tool with an explicit cwd", async () => {
  const calls = [];
  const browserViewer = {
    createSession: async (root) => {
      calls.push(root);
      return {
        viewerUrl: "http://127.0.0.1:4312/session/token/",
        sessionId: "session-1",
        source: ".handoff/context-map.md",
      };
    },
    close: async () => {},
  };
  const server = createContextMapServer({ browserViewer, widgetHtml: "<main/>" });
  const tool = server._registeredTools.create_context_map_browser_session;
  const result = await tool.handler({ workspaceRoot: "/workspace/project" });
  assert.deepEqual(calls, ["/workspace/project"]);
  assert.equal(result.structuredContent.status, "ready");
  assert.equal(result.structuredContent.fallback, "open_context_map");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta?.ui, undefined);
});
```

- [ ] **Step 2: Run the MCP test and verify failure**

Run: `cd plugins/context-map-viewer && node --test tests/server.test.mjs --test-name-pattern="browser session"`

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Register the tool and structured fallback error**

```js
server.registerTool(
  "create_context_map_browser_session",
  {
    title: "Open Context Map in Browser",
    description:
      "Create a read-only loopback Viewer session. Pass the current Codex task's absolute cwd as workspaceRoot.",
    inputSchema: z.object({ workspaceRoot: z.string().min(1) }),
    annotations: TOOL_ANNOTATIONS,
  },
  async ({ workspaceRoot }) => {
    if (!isAbsolute(workspaceRoot)) return browserSessionError("WORKSPACE_ROOT_REQUIRED");
    try {
      const session = await browserViewer.createSession(resolve(workspaceRoot));
      return {
        structuredContent: {
          status: "ready",
          ...session,
          fallback: "open_context_map",
        },
        content: [{ type: "text", text: "Context Map browser session is ready." }],
      };
    } catch {
      return browserSessionError("BROWSER_SESSION_UNAVAILABLE");
    }
  },
);
```

The error result must omit exception messages and absolute paths, set
`isError: true`, and include `fallback: "open_context_map"`.

- [ ] **Step 4: Extend the build and startup path**

Build:

1. bundle `web/app.mjs` as `dist/standalone/app.mjs` in ESM format while
   preserving `./model.mjs` as its single external import;
2. copy `web/model.mjs` to `dist/standalone/model.mjs`;
3. copy `styles.css`;
4. copy `standalone.html` to `dist/standalone/index.html`;
5. continue emitting the existing fully inlined `dist/widget.html`.

At startup, read the four actual standalone outputs into memory, instantiate
`BrowserSessionManager` and `LoopbackViewerServer`, pass the latter into
`createContextMapServer`, and register process cleanup:

```js
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await browserViewer.close();
    process.exitCode = 0;
  });
}
```

Also close it when the MCP transport closes; make shutdown idempotent so signal
and transport close cannot race.

- [ ] **Step 5: Add package/build assertions**

Extend the build test to assert:

```js
assert.match(standaloneHtml, /content="http"/);
assert.match(standaloneHtml, /src="\.\/app\.mjs"/);
assert.match(standaloneApp, /api\/context-map/);
assert.doesNotMatch(standaloneApp, /tools\/call/);
assert.match(widgetHtml, /tools\/call/);
```

Add a `pretest` script that runs `npm run build`, ensuring source and packaged
assets cannot drift:

```json
"scripts": {
  "build": "node scripts/build.mjs",
  "pretest": "npm run build",
  "test": "node --test \"tests/**/*.test.mjs\""
}
```

- [ ] **Step 6: Run server and build tests**

Run: `cd plugins/context-map-viewer && npm test`

Expected: PASS with the original tools, browser-session tool, inline widget,
standalone assets, and safe errors covered.

- [ ] **Step 7: Commit**

```bash
git add plugins/context-map-viewer/server/server.mjs plugins/context-map-viewer/scripts/build.mjs plugins/context-map-viewer/tests/server.test.mjs plugins/context-map-viewer/package.json plugins/context-map-viewer/dist
git commit -m "feat(viewer): expose standalone browser sessions"
```

---

### Task 5: Skill, Documentation, and End-to-End Acceptance

**Files:**
- Modify: `plugins/context-map-viewer/skills/context-map-viewer/SKILL.md`
- Modify: `plugins/context-map-viewer/README.md`
- Modify: `README.md`
- Modify: `plugins/context-map-viewer/tests/server.test.mjs`

**Interfaces:**
- Consumes: `create_context_map_browser_session` and `open_context_map`.
- Produces: Codex workflow that opens `viewerUrl` in the in-app browser and falls back inline.

- [ ] **Step 1: Write failing skill-contract assertions**

```js
test("skill prefers the side browser and retains inline fallback", async () => {
  const skill = await readFile(
    new URL("../skills/context-map-viewer/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /create_context_map_browser_session/);
  assert.match(skill, /in-app browser/i);
  assert.match(skill, /open_context_map/);
  assert.match(skill, /fallback/i);
  assert.match(skill, /absolute.*cwd/i);
});
```

- [ ] **Step 2: Run the skill test and verify failure**

Run: `cd plugins/context-map-viewer && node --test tests/server.test.mjs --test-name-pattern="skill prefers"`

Expected: FAIL because the skill still instructs inline-only opening.

- [ ] **Step 3: Update the skill with an exact host workflow**

Document this sequence:

```text
1. Call create_context_map_browser_session with workspaceRoot equal to the
   current task's exact absolute cwd.
2. Open the returned viewerUrl with the Codex in-app browser tool.
3. Do not transform, reconstruct, persist, or reuse viewerUrl in another task.
4. If session creation or browser navigation is unavailable, call
   open_context_map with the same workspaceRoot and use the inline MCP App.
5. Do not repeatedly reopen either view for live updates.
```

Keep all existing read-only, fixed-path, and Handoff-editing boundaries.

- [ ] **Step 4: Document operation and security**

Update plugin and repository documentation with:

- side browser as Codex's default presentation;
- inline MCP App as compatibility fallback;
- loopback-only, random-port, token-scoped, in-memory session behavior;
- automatic 750 ms polling and 30-minute idle expiry;
- explicit statement that the URL is local and temporary;
- reopening instructions after expiry;
- no effect on Handoff storage format.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
cd plugins/context-map-viewer
npm test
npm run build
git diff --check
cd ../..
npm test
deno test -A
npm pack --dry-run
```

Expected:

- every plugin test passes;
- all existing root Node and Deno tests pass;
- build outputs inline and standalone assets;
- `git diff --check` prints nothing;
- package dry-run contains the plugin source and generated standalone assets;
- `.handoff.config.json` remains untracked and unchanged.

- [ ] **Step 6: Perform manual Codex acceptance**

1. Install the plugin build from this repository.
2. Restart or open a fresh Codex task so the new MCP schema is loaded.
3. Invoke the Viewer skill in this repository.
4. Confirm the Viewer opens in the side browser and the URL uses
   `http://127.0.0.1:<random-port>/session/<opaque-token>/`.
5. Modify and atomically replace `.handoff/context-map.md`; confirm refresh
   without losing zoom, folds, search, or viewport.
6. Open a task for a second project; confirm neither tab changes workspace.
7. Disable or withhold browser navigation; confirm inline MCP App fallback.
8. Leave a test session idle under a short injected TTL; confirm the page asks
   to reopen after expiry.

- [ ] **Step 7: Commit**

```bash
git add plugins/context-map-viewer/skills/context-map-viewer/SKILL.md plugins/context-map-viewer/README.md README.md plugins/context-map-viewer/tests/server.test.mjs
git commit -m "docs(viewer): make side browser the Codex default"
```

---

## Final Review Gate

- [ ] Map every design-spec requirement to Tasks 1–5.
- [ ] Confirm no absolute path or raw Context Map content reaches the HTTP DTO.
- [ ] Confirm every session owns exactly one store and cannot be rebound.
- [ ] Confirm all listener paths require the opaque token.
- [ ] Confirm shutdown disposes watchers, polling timers, sockets, and sessions.
- [ ] Confirm inline MCP tools and picture-in-picture behavior remain intact.
- [ ] Confirm the skill opens the exact returned URL and never constructs one.
- [ ] Confirm `.handoff.config.json` is untouched.
- [ ] Request code review using `superpowers:requesting-code-review`.
- [ ] Address findings, rerun the full release gate, and only then claim completion.

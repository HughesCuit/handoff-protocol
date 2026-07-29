import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CONTEXT_MAP_RELATIVE_PATH } from "./constants.mjs";
import {
  ContextSourceError,
  readContextMapSource,
  resolveContextMap,
} from "./context-source.mjs";
import { ContextMapStore } from "./context-store.mjs";
import { BrowserSessionManager } from "./browser-session-manager.mjs";
import { LoopbackViewerServer } from "./loopback-viewer-server.mjs";

export const RESOURCE_URI = "ui://context-map/viewer.html";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function safeSummary(snapshot) {
  const count = Number(snapshot.nodeCount) || 0;
  if (snapshot.status === "synced") {
    return `Context Map is ready with ${count} nodes.`;
  }
  return `Context Map status: ${snapshot.status}.`;
}

function rootError() {
  return {
    isError: true,
    structuredContent: {
      status: "access_denied",
      version: null,
      tree: null,
      nodeCount: 0,
      diagnostic: "WORKSPACE_ROOT_REQUIRED",
      bindingId: "no-workspace",
      source: CONTEXT_MAP_RELATIVE_PATH,
    },
    content: [{
      type: "text",
      text: "Context Map Viewer requires one unambiguous workspace root containing a Context Map.",
    }],
  };
}

function browserSessionError(diagnostic) {
  return {
    isError: true,
    structuredContent: {
      status: "unavailable",
      diagnostic,
      fallback: "open_context_map",
    },
    content: [{
      type: "text",
      text: "Context Map browser session is unavailable. Use the Context Map tool instead.",
    }],
  };
}

function resultFor(snapshot) {
  return {
    structuredContent: snapshot,
    content: [{ type: "text", text: safeSummary(snapshot) }],
  };
}

function explicitRoot(workspaceRoot) {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return null;
  return { uri: pathToFileURL(resolve(workspaceRoot)).href };
}

export async function selectActiveRoot(
  roots,
  options = {},
) {
  const candidates = roots.filter((root) => root?.uri);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;

  const resolveSource = options.resolveSource ?? resolveContextMap;
  const readSource = options.readSource ?? readContextMapSource;
  const matches = [];
  for (const root of candidates) {
    try {
      const source = await resolveSource(root.uri);
      await readSource(source);
      matches.push(root);
    } catch (error) {
      if (error instanceof ContextSourceError && error.code === "TOO_LARGE") {
        matches.push(root);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function createContextMapServer(options = {}) {
  const server = new McpServer({
    name: "context-map-viewer",
    version: "0.1.0",
  });
  const store = options.store ?? new ContextMapStore();
  const widgetHtml = options.widgetHtml ?? "";
  const browserViewer = options.browserViewer;
  const rootProvider = options.rootProvider ??
    (async () => (await server.server.listRoots()).roots ?? []);
  const rootSelector = options.rootSelector ?? selectActiveRoot;

  registerAppResource(
    server,
    "context-map-viewer",
    RESOURCE_URI,
    {},
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: { ui: { prefersBorder: false } },
      }],
    }),
  );

  async function openHandler({ workspaceRoot } = {}) {
    let root = explicitRoot(workspaceRoot);
    if (!root) root = await rootSelector(await rootProvider());
    if (!root) return rootError();
    await store.bind(root.uri);
    const snapshot = {
      ...store.snapshot(),
      source: CONTEXT_MAP_RELATIVE_PATH,
    };
    return resultFor(snapshot);
  }

  async function refreshHandler({ bindingId } = {}) {
    const current = store.snapshot();
    if (!bindingId || current.bindingId !== bindingId) return rootError();
    await store.refresh();
    return resultFor({
      ...store.snapshot(),
      source: CONTEXT_MAP_RELATIVE_PATH,
    });
  }

  registerAppTool(
    server,
    "open_context_map",
    {
      title: "Open Context Map",
      description: "Open a read-only Handoff Context Map. In Codex, pass the current task's absolute cwd as workspaceRoot.",
      inputSchema: z.object({
        workspaceRoot: z.string().min(1).optional(),
      }),
      annotations: TOOL_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
        "openai/outputTemplate": RESOURCE_URI,
        "openai/toolInvocation/invoking": "Opening Context Map…",
        "openai/toolInvocation/invoked": "Context Map opened.",
      },
    },
    openHandler,
  );

  registerAppTool(
    server,
    "get_context_map",
    {
      title: "Refresh Context Map",
      description: "Refresh an open Context Map using its opaque bindingId.",
      inputSchema: z.object({
        bindingId: z.string().min(1).optional(),
      }),
      annotations: TOOL_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Refreshing Context Map…",
        "openai/toolInvocation/invoked": "Context Map refreshed.",
      },
    },
    refreshHandler,
  );

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

  return server;
}

export function createServerLifecycle({
  browserViewer,
  mcpServer,
  transport,
  processObject = process,
  exit = (code) => processObject.exit(code),
}) {
  let cleanupPromise = null;
  let terminationPromise = null;
  let exitRequested = false;
  const signalHandlers = new Map();

  function removeSignalHandlers() {
    for (const [signal, handler] of signalHandlers) {
      processObject.off(signal, handler);
    }
    signalHandlers.clear();
  }

  function close() {
    cleanupPromise ??= Promise.resolve().then(async () => {
      removeSignalHandlers();
      const closeMcp = typeof mcpServer?.close === "function"
        ? mcpServer.close()
        : transport?.close?.();
      await Promise.allSettled([
        browserViewer?.close?.(),
        closeMcp,
      ]);
    });
    return cleanupPromise;
  }

  function handleSignal() {
    terminationPromise ??= close().then(() => {
      if (exitRequested) return;
      exitRequested = true;
      exit(0);
    });
    return terminationPromise;
  }

  const previousTransportClose = transport.onclose;
  transport.onclose = () => {
    previousTransportClose?.();
    void close();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void handleSignal();
    };
    signalHandlers.set(signal, handler);
    processObject.once(signal, handler);
  }

  return {
    close,
    handleSignal,
    waitForShutdown() {
      return terminationPromise ?? cleanupPromise ?? Promise.resolve();
    },
  };
}

export async function startServer(options = {}) {
  const loadAssets = options.loadAssets ?? (async () => Promise.all([
    readFile(new URL("../dist/widget.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/standalone/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/standalone/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../dist/standalone/model.mjs", import.meta.url), "utf8"),
    readFile(new URL("../dist/standalone/styles.css", import.meta.url), "utf8"),
  ]));
  const [widgetHtml, html, app, model, styles] = await loadAssets();
  const browserViewer = options.browserViewer ?? new LoopbackViewerServer({
    sessionManager: new BrowserSessionManager(),
    assets: { html, app, model, styles },
  });
  const server = options.server ?? createContextMapServer({ widgetHtml, browserViewer });
  const transport = options.transport ?? new StdioServerTransport();
  const lifecycle = createServerLifecycle({
    browserViewer,
    mcpServer: server,
    transport,
    processObject: options.processObject,
    exit: options.exit,
  });
  try {
    await server.connect(transport);
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
  return lifecycle;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await startServer();

import { readFile } from "node:fs/promises";

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

  async function snapshotHandler() {
    const roots = await rootProvider();
    const root = await rootSelector(roots);
    if (!root) return rootError();
    await store.bind(root.uri);
    const snapshot = {
      ...store.snapshot(),
      source: CONTEXT_MAP_RELATIVE_PATH,
    };
    return {
      structuredContent: snapshot,
      content: [{ type: "text", text: safeSummary(snapshot) }],
    };
  }

  registerAppTool(
    server,
    "open_context_map",
    {
      title: "Open Context Map",
      description: "Open the current workspace's read-only Handoff Context Map viewer.",
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
        "openai/outputTemplate": RESOURCE_URI,
        "openai/toolInvocation/invoking": "Opening Context Map…",
        "openai/toolInvocation/invoked": "Context Map opened.",
      },
    },
    snapshotHandler,
  );

  registerAppTool(
    server,
    "get_context_map",
    {
      title: "Refresh Context Map",
      description: "Read the latest snapshot for an already open Context Map viewer.",
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Refreshing Context Map…",
        "openai/toolInvocation/invoked": "Context Map refreshed.",
      },
    },
    snapshotHandler,
  );

  return server;
}

export async function startServer() {
  const widgetHtml = await readFile(new URL("../dist/widget.html", import.meta.url), "utf8");
  const server = createContextMapServer({ widgetHtml });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] === new URL(import.meta.url).pathname) await startServer();

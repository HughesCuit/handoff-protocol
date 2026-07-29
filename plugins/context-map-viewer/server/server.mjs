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
      text: "Context Map Viewer requires exactly one active workspace root.",
    }],
  };
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
    if (roots.length !== 1 || !roots[0]?.uri) return rootError();
    await store.bind(roots[0].uri);
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

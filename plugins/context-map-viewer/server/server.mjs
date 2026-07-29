import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createServer() {
  return new McpServer({
    name: "context-map-viewer",
    version: "0.1.0",
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

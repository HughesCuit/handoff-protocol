import { createServer as createHttpServer } from "node:http";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const ASSET_TYPES = {
  "": "text/html; charset=utf-8",
  "app.mjs": "text/javascript; charset=utf-8",
  "model.mjs": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

const ROUTE_PATTERN = /^\/session\/([A-Za-z0-9_-]{22,})\/(|app\.mjs|model\.mjs|styles\.css|api\/context-map)$/;

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function safe500(response) {
  if (response.headersSent) return response.end();
  response.writeHead(500, SECURITY_HEADERS);
  response.end();
}

export class LoopbackViewerServer {
  constructor({ sessionManager, assets, createServer = createHttpServer }) {
    this.sessionManager = sessionManager;
    this.assets = assets;
    this.createServer = createServer;
    this.httpServer = null;
    this.starting = null;
    this.closing = null;
  }

  address() {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") return null;
    return { host: "127.0.0.1", port: address.port };
  }

  async start() {
    if (this.httpServer?.listening) return this.address();
    if (this.starting) return this.starting;
    const server = this.createServer((request, response) =>
      this.handle(request, response).catch(() => safe500(response)));
    this.httpServer = server;
    this.starting = listen(server, { host: "127.0.0.1", port: 0 })
      .then(() => this.address())
      .catch((error) => {
        if (this.httpServer === server) this.httpServer = null;
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
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

  async handle(request, response) {
    if (request.method !== "GET") {
      return this.reply(response, 405, "", { Allow: "GET" });
    }
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      return this.reply(response, 404);
    }
    const match = url.search ? null : ROUTE_PATTERN.exec(url.pathname);
    if (!match) return this.reply(response, 404);

    const [, token, resource] = match;
    if (!await this.sessionManager.touch(token)) return this.reply(response, 404);
    if (resource === "api/context-map") {
      const snapshot = await this.sessionManager.snapshot(token);
      if (!snapshot) return this.reply(response, 404);
      return this.reply(response, 200, JSON.stringify(snapshot), {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
    const asset = resource === "" ? "html" : resource.slice(0, resource.indexOf("."));
    return this.reply(response, 200, this.assets[asset], {
      "Content-Type": ASSET_TYPES[resource],
    });
  }

  reply(response, status, body = "", headers = {}) {
    response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    response.end(body);
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const starting = this.starting;
      if (starting) {
        try {
          await starting;
        } catch {
          // Startup errors are reported to the caller that requested startup.
        }
      }
      const server = this.httpServer;
      if (server?.listening) {
        const closed = closeServer(server);
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        await closed;
      }
      await this.sessionManager.close();
    })();
    return this.closing;
  }
}

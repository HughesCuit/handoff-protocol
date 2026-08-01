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
const ENCODED_PATH_CONTROL_PATTERN = /%(?:2e|2f|5c)/i;

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

function parseRoute(requestTarget) {
  if (typeof requestTarget !== "string" || ENCODED_PATH_CONTROL_PATTERN.test(requestTarget)) {
    return null;
  }
  try {
    const url = new URL(requestTarget, "http://127.0.0.1");
    if (url.search || url.hash) return null;
  } catch {
    return null;
  }
  return ROUTE_PATTERN.exec(requestTarget);
}

function closedError() {
  return new Error("The loopback viewer server is closed.");
}

export class LoopbackViewerServer {
  constructor({ sessionManager, assets, createServer = createHttpServer }) {
    this.sessionManager = sessionManager;
    this.assets = assets;
    this.createServer = createServer;
    this.httpServer = null;
    this.starting = null;
    this.closing = null;
    this.lifecycle = "new";
    this.creatingSessions = new Set();
  }

  address() {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") return null;
    return { host: "127.0.0.1", port: address.port };
  }

  async start() {
    this.assertOpen();
    if (this.httpServer?.listening) return this.address();
    if (this.starting) return this.starting;
    this.lifecycle = "starting";
    const server = this.createServer((request, response) =>
      this.handle(request, response).catch(() => safe500(response)));
    this.httpServer = server;
    this.starting = listen(server, { host: "127.0.0.1", port: 0 })
      .then(() => {
        if (this.lifecycle === "starting") this.lifecycle = "running";
        return this.address();
      })
      .catch((error) => {
        if (this.httpServer === server) this.httpServer = null;
        if (this.lifecycle === "starting") this.lifecycle = "new";
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async createSession(workspaceRoot) {
    this.assertOpen();
    const { port } = await this.start();
    this.assertOpen();
    const creation = Promise.resolve(this.sessionManager.create(workspaceRoot));
    this.creatingSessions.add(creation);
    let created;
    try {
      created = await creation;
    } finally {
      this.creatingSessions.delete(creation);
    }
    this.assertOpen();
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
    const match = parseRoute(request.url);
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

  assertOpen() {
    if (this.lifecycle === "closing" || this.lifecycle === "closed") throw closedError();
  }

  async close() {
    if (this.closing) return this.closing;
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closing";
    this.closing = (async () => {
      try {
        const starting = this.starting;
        if (starting) {
          try {
            await starting;
          } catch {
            // Startup errors are reported to the caller that requested startup.
          }
        }
        await Promise.allSettled([...this.creatingSessions]);
        const server = this.httpServer;
        if (server?.listening) {
          const closed = closeServer(server);
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          await closed;
        }
      } finally {
        try {
          await this.sessionManager.close();
        } finally {
          this.lifecycle = "closed";
        }
      }
    })();
    return this.closing;
  }
}

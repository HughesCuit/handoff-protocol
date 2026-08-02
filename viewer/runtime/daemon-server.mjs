import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

import { DAEMON_VERSION, SCHEMA_VERSION } from "./daemon-state.mjs";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const JSON_TYPE = { "Content-Type": "application/json; charset=utf-8" };

const ASSET_TYPES = {
  "": "text/html; charset=utf-8",
  "app.mjs": "text/javascript; charset=utf-8",
  "model.mjs": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

const VIEWER_ROUTE_PATTERN = /^\/session\/([A-Za-z0-9_-]{22,})\/(|app\.mjs|model\.mjs|styles\.css|api\/context-map)$/;
const CONTROL_ROUTE_PATTERN = /^\/control\/(health|session|shutdown)$/;
const ENCODED_PATH_CONTROL_PATTERN = /%(?:2e|2f|5c)/i;
const MAX_CONTROL_BODY_BYTES = 8192;

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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function safe500(response) {
  if (response.headersSent) return response.end();
  response.writeHead(500, SECURITY_HEADERS);
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        reject(new Error("BODY_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closedError() {
  return new Error("The daemon server is closed.");
}

export class DaemonServer {
  constructor({
    sessionManager,
    assets,
    controlToken,
    createServer = createHttpServer,
    onShutdownRequest,
    pid = process.pid,
  }) {
    if (!controlToken || typeof controlToken !== "string") {
      throw new TypeError("A control token is required.");
    }
    this.sessionManager = sessionManager;
    this.assets = assets;
    this.controlToken = controlToken;
    this.createServer = createServer;
    this.onShutdownRequest = onShutdownRequest;
    this.pid = pid;
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

  isAuthenticated(request) {
    const header = request.headers["authorization"];
    if (typeof header !== "string") return false;
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(this.controlToken);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  async handle(request, response) {
    if (typeof request.url !== "string" || ENCODED_PATH_CONTROL_PATTERN.test(request.url)) {
      return this.reply(response, 404);
    }
    let pathname;
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.hash) return this.reply(response, 404);
      pathname = url.pathname;
    } catch {
      return this.reply(response, 404);
    }

    if (pathname.startsWith("/control/")) {
      return this.handleControl(request, response, pathname);
    }
    return this.handleViewer(request, response, request.url);
  }

  async handleControl(request, response, pathname) {
    const match = CONTROL_ROUTE_PATTERN.exec(pathname);
    if (!match) return this.reply(response, 404);
    if (!this.isAuthenticated(request)) {
      return this.replyJson(response, 401, { error: "unauthorized" });
    }
    const route = match[1];

    if (route === "health") {
      if (request.method !== "GET") return this.reply(response, 405, "", { Allow: "GET" });
      return this.replyJson(response, 200, {
        status: "ok",
        pid: this.pid,
        schemaVersion: SCHEMA_VERSION,
        daemonVersion: DAEMON_VERSION,
      });
    }

    if (route === "session") {
      if (request.method !== "POST") return this.reply(response, 405, "", { Allow: "POST" });
      return this.handleCreateSession(request, response);
    }

    // route === "shutdown"
    if (request.method !== "POST") return this.reply(response, 405, "", { Allow: "POST" });
    this.replyJson(response, 200, { status: "shutting_down" });
    if (this.onShutdownRequest) {
      await this.onShutdownRequest();
    }
  }

  async handleCreateSession(request, response) {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch {
      return this.replyJson(response, 400, { error: "VIEW_SESSION_CREATE_FAILED" });
    }
    const workspaceRoot = parsed?.workspaceRoot;
    if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
      return this.replyJson(response, 400, { error: "VIEW_PROJECT_INACCESSIBLE" });
    }
    const idleMinutes = parsed?.idleMinutes ?? 30;
    const creation = Promise.resolve(this.sessionManager.create(workspaceRoot, { idleMinutes }));
    this.creatingSessions.add(creation);
    let created;
    try {
      created = await creation;
    } catch (error) {
      const code = error?.message === "VIEW_INVALID_IDLE_MINUTES"
        ? "VIEW_INVALID_IDLE_MINUTES"
        : "VIEW_SESSION_CREATE_FAILED";
      const status = code === "VIEW_INVALID_IDLE_MINUTES" ? 400 : 500;
      return this.replyJson(response, status, { error: code });
    } finally {
      this.creatingSessions.delete(creation);
    }
    const { port } = this.address();
    return this.replyJson(response, 200, {
      url: `http://127.0.0.1:${port}/session/${created.token}/`,
      sessionId: created.sessionId,
      source: created.source,
      idleMinutes: created.idleMinutes,
    });
  }

  async handleViewer(request, response, requestTarget) {
    if (request.method !== "GET") {
      return this.reply(response, 405, "", { Allow: "GET" });
    }
    const match = VIEWER_ROUTE_PATTERN.exec(requestTarget);
    if (!match) return this.reply(response, 404);

    const [, token, resource] = match;
    if (!(await this.sessionManager.touch(token))) return this.reply(response, 404);
    if (resource === "api/context-map") {
      const snapshot = await this.sessionManager.snapshot(token);
      if (!snapshot) return this.reply(response, 404);
      return this.reply(response, 200, JSON.stringify(snapshot), JSON_TYPE);
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

  replyJson(response, status, value) {
    this.reply(response, status, JSON.stringify(value), JSON_TYPE);
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

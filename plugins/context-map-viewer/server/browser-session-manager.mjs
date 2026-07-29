import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONTEXT_MAP_RELATIVE_PATH } from "./constants.mjs";
import { ContextMapStore } from "./context-store.mjs";

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
    return { token, sessionId: session.sessionId, source: CONTEXT_MAP_RELATIVE_PATH };
  }

  async touch(token) {
    await this.prune();
    const session = this.sessions.get(token);
    if (!session) return null;
    session.lastAccess = this.now();
    return session;
  }

  async snapshot(token) {
    const session = await this.touch(token);
    if (!session) return null;
    await session.store.refresh();
    return {
      ...session.store.snapshot(),
      source: CONTEXT_MAP_RELATIVE_PATH,
    };
  }

  async prune() {
    const now = this.now();
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => now - session.lastAccess >= this.idleTtlMs)
        .map((session) => this.remove(session.token)),
    );
  }

  async evictForCapacity() {
    const sessions = [...this.sessions.values()].sort((left, right) =>
      left.lastAccess - right.lastAccess || left.sessionId.localeCompare(right.sessionId));
    while (this.size >= this.maxSessions && sessions.length > 0) {
      await this.remove(sessions.shift().token);
    }
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
}

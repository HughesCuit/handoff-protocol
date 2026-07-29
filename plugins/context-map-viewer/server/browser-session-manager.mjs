import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONTEXT_MAP_RELATIVE_PATH } from "./constants.mjs";
import { ContextMapStore } from "./context-store.mjs";

const MAX_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_TOKEN_ATTEMPTS = 32;

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(minimum, Math.min(value, maximum));
}

export class BrowserSessionManager {
  constructor(options = {}) {
    this.createStore = options.createStore ?? (() => new ContextMapStore());
    this.randomBytes = options.randomBytes ?? randomBytes;
    this.now = options.now ?? Date.now;
    this.idleTtlMs = clamp(options.idleTtlMs ?? MAX_IDLE_TTL_MS, 0, MAX_IDLE_TTL_MS);
    this.maxSessions = clamp(options.maxSessions ?? MAX_SESSIONS, 1, MAX_SESSIONS);
    this.sessions = new Map();
    this.createTail = Promise.resolve();
  }

  get size() {
    return this.sessions.size;
  }

  async create(workspaceRoot) {
    if (!isAbsolute(workspaceRoot)) {
      throw new TypeError("An absolute workspace root is required.");
    }
    const creation = this.createTail.then(() => this.createSession(workspaceRoot));
    this.createTail = creation.catch(() => {});
    return creation;
  }

  async createSession(workspaceRoot) {
    let token;
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const bytes = this.randomBytes(24);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) {
        throw new TypeError("The random byte provider must return at least 16 bytes.");
      }
      token = Buffer.from(bytes).toString("base64url");
      if (!this.sessions.has(token)) break;
      token = undefined;
    }
    if (!token) {
      throw new Error("Unable to generate a unique session token.");
    }
    const store = this.createStore();
    try {
      await store.bind(pathToFileURL(resolve(workspaceRoot)).href);
      await this.prune();
      await this.evictForCapacity();
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

import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONTEXT_MAP_RELATIVE_PATH } from "./constants.mjs";
import { ContextMapStore } from "./context-store.mjs";

const MAX_SESSIONS = 8;
const MAX_TOKEN_ATTEMPTS = 32;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 1440;
const DEFAULT_IDLE_MINUTES = 30;

function validateIdleMinutes(value) {
  if (!Number.isInteger(value) || value < MIN_IDLE_MINUTES || value > MAX_IDLE_MINUTES) {
    throw new Error("VIEW_INVALID_IDLE_MINUTES");
  }
  return value;
}

export class SessionManager {
  constructor(options = {}) {
    this.createStore = options.createStore ?? (() => new ContextMapStore());
    this.randomBytes = options.randomBytes ?? randomBytes;
    this.fsApi = options.fsApi ?? { realpath, stat };
    this.now = options.now ?? Date.now;
    this.maxSessions = Math.min(options.maxSessions ?? MAX_SESSIONS, MAX_SESSIONS);
    this.sessions = new Map();
    this.projectStores = new Map();
    this.createTail = Promise.resolve();
  }

  get hasSessions() {
    return this.sessions.size > 0;
  }

  get size() {
    return this.sessions.size;
  }

  async create(workspaceRoot, { idleMinutes = DEFAULT_IDLE_MINUTES } = {}) {
    validateIdleMinutes(idleMinutes);
    const creation = this.createTail.then(() => this.createSession(workspaceRoot, idleMinutes));
    this.createTail = creation.catch(() => {});
    return creation;
  }

  async createSession(workspaceRoot, idleMinutes) {
    if (!isAbsolute(workspaceRoot)) {
      throw new TypeError("An absolute workspace root is required.");
    }
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
    const canonicalRoot = await this.fsApi.realpath(resolve(workspaceRoot));
    const rootInfo = await this.fsApi.stat(canonicalRoot);
    if (!rootInfo.isDirectory()) {
      throw new TypeError("Workspace root must be an accessible directory.");
    }
    let entry = this.projectStores.get(canonicalRoot);
    if (!entry) {
      const store = this.createStore();
      try {
        await store.bind(pathToFileURL(canonicalRoot).href);
      } catch (error) {
        await store.close();
        throw error;
      }
      entry = { store, refCount: 0 };
      this.projectStores.set(canonicalRoot, entry);
    }
    entry.refCount += 1;
    await this.prune();
    await this.evictForCapacity();
    const session = {
      token,
      sessionId: createHash("sha256").update(token).digest("hex").slice(0, 16),
      store: entry.store,
      entry,
      canonicalRoot,
      idleDeadlineMs: idleMinutes * 60_000,
      lastAccess: this.now(),
    };
    this.sessions.set(token, session);
    return { token, sessionId: session.sessionId, source: CONTEXT_MAP_RELATIVE_PATH, idleMinutes };
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
        .filter((session) => now - session.lastAccess >= session.idleDeadlineMs)
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
    const entry = session.entry;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.projectStores.delete(session.canonicalRoot);
      await entry.store.close();
    }
  }

  async close() {
    await Promise.all([...this.sessions.keys()].map((token) => this.remove(token)));
  }
}

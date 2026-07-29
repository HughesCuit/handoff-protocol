import { createHash } from "node:crypto";
import { watch } from "node:fs";

import {
  ContextMapParseError,
  parseRenderTree,
} from "./context-map-parser.mjs";
import {
  ContextSourceError,
  readContextMapSource,
  resolveContextMap,
} from "./context-source.mjs";
import { WATCH_DEBOUNCE_MS } from "./constants.mjs";

const STATUS_BY_CODE = {
  MISSING: "missing",
  EMPTY: "empty",
  INVALID: "invalid",
  TOO_LARGE: "too_large",
  TOO_MANY_NODES: "too_many_nodes",
  ACCESS_DENIED: "access_denied",
};

function emptyState() {
  return {
    status: "missing",
    version: null,
    tree: null,
    nodeCount: 0,
    diagnostic: null,
    watchMode: "none",
    watchDiagnostic: null,
    bindingId: null,
  };
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export class ContextMapStore {
  constructor(options = {}) {
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.watch = options.watch ?? watch;
    this.resolveSource = options.resolveSource ?? resolveContextMap;
    this.readSource = options.readSource ?? readContextMapSource;
    this.parse = options.parse ?? parseRenderTree;
    this.rootUri = null;
    this.source = null;
    this.watcher = null;
    this.timer = null;
    this.pollTimer = null;
    this.state = emptyState();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async bind(rootUri) {
    if (this.rootUri === rootUri && (this.watcher || this.pollTimer)) {
      await this.refresh();
      return;
    }
    await this.close();
    this.state = { ...emptyState(), bindingId: digest(rootUri).slice(0, 16) };
    this.rootUri = rootUri;
    this.source = await this.resolveSource(rootUri);
    await this.refresh();
    this.startWatcher();
  }

  startWatcher() {
    try {
      this.watcher = this.watch(this.source.handoffDir, () => this.scheduleRefresh());
      this.state = {
        ...this.state,
        watchMode: "watch",
        watchDiagnostic: null,
      };
      this.watcher.on?.("error", () => {
        this.watcher?.close();
        this.watcher = null;
        this.state = {
          ...this.state,
          watchMode: "polling",
          watchDiagnostic: "WATCHER_UNAVAILABLE",
        };
        this.startPolling();
      });
    } catch {
      this.watcher = null;
      this.state = {
        ...this.state,
        watchMode: "polling",
        watchDiagnostic: "WATCHER_UNAVAILABLE",
      };
      this.startPolling();
    }
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.pollIntervalMs);
  }

  scheduleRefresh() {
    if (this.timer) clearTimeout(this.timer);
    this.state = { ...this.state, status: "refreshing", diagnostic: null };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(() => {});
    }, this.debounceMs);
  }

  async refresh() {
    if (!this.rootUri) return this.snapshot();
    try {
      this.source = await this.resolveSource(this.rootUri);
      const content = await this.readSource(this.source);
      const version = digest(content);
      if (version === this.state.version && this.state.tree) {
        this.state = { ...this.state, status: "synced", diagnostic: null };
        return this.snapshot();
      }
      const tree = this.parse(content);
      this.state = {
        ...this.state,
        status: "synced",
        version,
        tree,
        nodeCount: tree.nodeCount,
        diagnostic: null,
      };
    } catch (error) {
      const code = error instanceof ContextSourceError ||
          error instanceof ContextMapParseError
        ? error.code
        : "ACCESS_DENIED";
      this.state = {
        ...this.state,
        status: STATUS_BY_CODE[code] ?? "invalid",
        diagnostic: code,
      };
    }
    return this.snapshot();
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.rootUri = null;
    this.source = null;
  }
}

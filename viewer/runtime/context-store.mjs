import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { join } from "node:path";

import { CONTENT_DIR } from "../../scripts/content-files.mjs";
import {
  ContextMapParseError,
  isV3ContextMap,
  parseRenderTree,
  parseV3RenderTree,
} from "./context-map-parser.mjs";
import { ContentIndex } from "./content-index.mjs";
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
    layout: null,
    contentVersion: null,
    contentDiagnostics: [],
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
    this.parseV3 = options.parseV3 ?? parseV3RenderTree;
    this.createContentIndex =
      options.createContentIndex ??
      (({ handoffDir, rootPath }) => new ContentIndex({ handoffDir, rootPath }));
    this.contentIndex = null;
    this.rootUri = null;
    this.source = null;
    this.watcher = null;
    this.contentWatcher = null;
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
    try {
      this.source = await this.resolveSource(rootUri);
    } catch {
      this.state = {
        ...this.state,
        status: "access_denied",
        diagnostic: "ACCESS_DENIED",
      };
      return;
    }
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
        this.disposeContentWatcher();
        this.state = {
          ...this.state,
          watchMode: "polling",
          watchDiagnostic: "WATCHER_UNAVAILABLE",
        };
        this.startPolling();
      });
      this.ensureContentWatcher();
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

  /**
   * Watch `.handoff/content/` in its own right. A watcher on the handoff dir
   * is not guaranteed to observe nested changes on every platform (directory
   * watches are non-recursive on Linux), and v3 bodies live one level down.
   * The content dir may not exist yet (v2 or pre-migration); the handoff-dir
   * watcher observes its creation and the next v3 refresh retries.
   */
  ensureContentWatcher() {
    if (!this.watcher || this.contentWatcher || !this.source) return;
    try {
      const watcher = this.watch(join(this.source.handoffDir, CONTENT_DIR), () =>
        this.scheduleRefresh(),
      );
      this.contentWatcher = watcher;
      watcher.on?.("error", () => {
        watcher.close();
        if (this.contentWatcher === watcher) this.contentWatcher = null;
      });
    } catch {
      this.contentWatcher = null;
    }
  }

  disposeContentWatcher() {
    this.contentWatcher?.close();
    this.contentWatcher = null;
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
        // The directory (map) is unchanged, but v3 bodies live in separate
        // content files that may have changed on their own. Refresh the
        // content index so contentVersion/contentDiagnostics still move and
        // the Viewer's node-detail cache is invalidated.
        if (this.state.layout === "v3") {
          await this.refreshContentIndex();
          this.state = {
            ...this.state,
            status: "synced",
            diagnostic: null,
            contentVersion: this.contentIndex.version,
            contentDiagnostics: [...this.contentIndex.diagnostics],
          };
          this.ensureContentWatcher();
        } else {
          this.state = { ...this.state, status: "synced", diagnostic: null };
        }
        return this.snapshot();
      }
      if (isV3ContextMap(content)) {
        const tree = this.parseV3(content);
        await this.refreshContentIndex();
        this.state = {
          ...this.state,
          status: "synced",
          version,
          tree,
          nodeCount: tree.nodeCount,
          diagnostic: null,
          layout: "v3",
          contentVersion: this.contentIndex.version,
          contentDiagnostics: [...this.contentIndex.diagnostics],
        };
        this.ensureContentWatcher();
      } else {
        this.contentIndex = null;
        const tree = this.parse(content);
        this.state = {
          ...this.state,
          status: "synced",
          version,
          tree,
          nodeCount: tree.nodeCount,
          diagnostic: null,
          layout: "v2",
          contentVersion: null,
          contentDiagnostics: [],
        };
      }
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

  async refreshContentIndex() {
    const index = this.contentIndex ??
      this.createContentIndex({
        handoffDir: this.source.handoffDir,
        rootPath: this.source.rootPath,
      });
    this.contentIndex = index;
    await index.refresh();
    return index;
  }

  /**
   * Lazily resolved node detail for a v3 layout. Unknown IDs return null;
   * v2 layouts report MIGRATION_REQUIRED instead of reading arbitrary root
   * files.
   */
  async nodeDetail(nodeId) {
    const index = this.contentIndex;
    if (!index) {
      return { error: "MIGRATION_REQUIRED" };
    }
    await index.refresh();
    const detail = index.get(nodeId);
    if (!detail) return null;
    return { ...detail, version: index.version };
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
    this.disposeContentWatcher();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.rootUri = null;
    this.source = null;
    this.contentIndex = null;
  }
}

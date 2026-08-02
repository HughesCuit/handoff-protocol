import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseContextMapV3 } from "../../scripts/context-map.mjs";
import { CONTENT_DIR, CONTENT_FILES } from "../../scripts/content-files.mjs";
import { indexContextMap, parseContentFile } from "../../scripts/handoff-state.mjs";

/**
 * Validated in-memory index over a v3 handoff directory: the parsed Context
 * Map (directory) joined with the eight section content files (bodies).
 *
 * Safety contract:
 * - The index is built ONLY from parsed Context Map IDs and the fixed
 *   content-file registry — request text is never concatenated into a
 *   filesystem path.
 * - A body entry is resolved only through the file of the node's CURRENT
 *   section; misplaced or duplicate bodies are diagnosed, never guessed.
 * - Content files are parsed once per version (a SHA-256 over the source
 *   bytes); unchanged bytes keep the cache, changed bytes rebuild it.
 */
export class ContentIndex {
  constructor({ handoffDir, readFile: readFn } = {}) {
    if (!handoffDir) throw new TypeError("ContentIndex requires a handoffDir");
    this.handoffDir = handoffDir;
    this.readFile = readFn ?? readFile;
    this._version = null;
    this._byId = new Map();
    this.diagnostics = [];
  }

  get version() {
    return this._version;
  }

  async refresh() {
    let mapRaw = null;
    try {
      mapRaw = await this.readFile(join(this.handoffDir, "context-map.md"), "utf-8");
    } catch {
      mapRaw = null;
    }
    const blobs = new Map();
    for (const name of Object.values(CONTENT_FILES)) {
      try {
        blobs.set(name, await this.readFile(join(this.handoffDir, CONTENT_DIR, name), "utf-8"));
      } catch {
        blobs.set(name, null);
      }
    }

    const hash = createHash("sha256");
    hash.update(mapRaw ?? "");
    for (const name of Object.values(CONTENT_FILES)) {
      hash.update("").update(blobs.get(name) ?? "");
    }
    const version = hash.digest("hex");
    if (version === this._version) return this;

    const byId = new Map();
    const diagnostics = [];
    const map = mapRaw ? parseContextMapV3(mapRaw) : null;
    const index = map ? indexContextMap(map) : { byId: new Map(), duplicates: [], invalid: [] };
    for (const id of index.duplicates) diagnostics.push(`ID_DUPLICATE: ${id}`);
    for (const id of index.invalid) diagnostics.push(`ID_INVALID: ${id}`);

    const bodiesBySection = new Map();
    const bodyLocation = new Map();
    for (const [key, name] of Object.entries(CONTENT_FILES)) {
      const raw = blobs.get(name);
      const entries = raw == null ? [] : parseContentFile(raw, key);
      bodiesBySection.set(key, entries);
      for (const entry of entries) {
        if (bodyLocation.has(entry.id)) diagnostics.push(`CONTENT_DUPLICATE: ${entry.id}`);
        else bodyLocation.set(entry.id, key);
      }
    }

    for (const [id, loc] of index.byId) {
      const detail = {
        id,
        section: loc.sectionKey,
        label: loc.node.label,
        summary: "",
        body: "",
        diagnostic: null,
      };
      const fileKey = bodyLocation.get(id);
      if (fileKey === loc.sectionKey) {
        const entry = bodiesBySection.get(fileKey).find((e) => e.id === id);
        detail.summary = entry.summary;
        detail.body = entry.body;
      } else {
        // Missing or misplaced: the body is never guessed from another file.
        detail.diagnostic = "CONTENT_MISSING";
        diagnostics.push(fileKey ? `CONTENT_MISPLACED: ${id}` : `CONTENT_MISSING: ${id}`);
      }
      byId.set(id, detail);
    }
    for (const id of bodyLocation.keys()) {
      if (!index.byId.has(id)) diagnostics.push(`CONTENT_ORPHAN: ${id}`);
    }

    this._version = version;
    this._byId = byId;
    this.diagnostics = diagnostics;
    return this;
  }

  /** Node detail for a parsed Map ID, or null when the ID is not in the Map. */
  get(nodeId) {
    return this._byId.get(nodeId) ?? null;
  }
}
